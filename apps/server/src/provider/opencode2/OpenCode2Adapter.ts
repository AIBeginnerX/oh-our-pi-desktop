/**
 * OpenCode2Adapter — OpenCode 2 sessions behind OOP's provider adapter contract.
 *
 * OpenCode 2 replaced the 1.x API with one authenticated event stream and
 * inbox-style prompts. Each OOP session owns its own OpenCode 2 server, like
 * the 1.x adapter, so closing the session scope stops that server.
 *
 * @module provider/opencode2/OpenCode2Adapter
 */
import * as NodeURL from "node:url";

import {
  type ApprovalRequestId,
  EventId,
  type OpenCodeSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type TurnTokenUsage,
  type UserInputQuestion,
} from "@t3tools/contracts";
import type { FormInfo1, OpenCodeEvent, PermissionAsked } from "@opencode/client/promise";
import {
  isFormNotFoundError,
  isPermissionNotFoundError,
  isSessionNotFoundError,
} from "@opencode/client/promise";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import {
  makeOpenCode2Client,
  retryWhileActivating,
  type OpenCode2Client,
} from "./OpenCode2Client.ts";

const PROVIDER = ProviderDriverKind.make("opencode");
const RESUME_VERSION = 1 as const;
/** The OOP MCP server keeps the name the 1.x adapter registers. */
const MCP_SERVER_NAME = "t3-code";
const INSTRUCTIONS_KEY = "oop";
const INTERRUPT_GRACE = "10 seconds";
const DECLINED = "The user declined this request.";

type Rule = {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
};
type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { readonly type: T }>;

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect });

/** Session rules layer over the agent's own rules; full access allows everything. */
export function openCode2PermissionRules(input: {
  readonly runtimeMode: RuntimeMode;
  readonly mcp: boolean;
}): ReadonlyArray<Rule> {
  return [
    ...(input.runtimeMode === "full-access"
      ? [rule("*", "allow")]
      : [
          rule("shell", "ask"),
          rule("edit", input.runtimeMode === "auto-accept-edits" ? "allow" : "ask"),
          rule("external_directory", "ask"),
        ]),
    ...(input.mcp ? [rule(MCP_SERVER_NAME + "_*", "allow")] : []),
  ];
}

export function openCode2ToolItemType(name: string): ToolLifecycleItemType {
  const tool = name.toLowerCase();
  if (tool === "shell" || tool.includes("bash")) return "command_execution";
  if (tool === "edit" || tool === "write" || tool.includes("patch")) return "file_change";
  if (tool.includes("web")) return "web_search";
  if (tool === "subagent" || tool === "task") return "collab_agent_tool_call";
  if (tool.startsWith(MCP_SERVER_NAME + "_") || tool.includes("mcp")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function permissionRequestType(
  action: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" {
  if (action === "read") return "file_read_approval";
  if (action === "edit") return "file_change_approval";
  // Every OpenCode permission needs an actionable approval in each client.
  return "command_execution_approval";
}

const nonEmpty = (value: string | undefined | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** Questions OOP can show, or the reason it cannot show this form. */
export function openCode2FormQuestions(
  form: FormInfo1,
): { readonly questions: ReadonlyArray<UserInputQuestion> } | { readonly unsupported: string } {
  const questions: Array<UserInputQuestion> = [];
  for (const [index, field] of form.fields.entries()) {
    if (field.type !== "string" && field.type !== "multiselect") {
      return {
        unsupported: field.type === "external" ? "a link to open" : "a " + field.type + " value",
      };
    }
    if (field.hidden === true) return { unsupported: "a hidden field" };
    if ((field.when?.length ?? 0) > 0) return { unsupported: "a field that depends on another" };
    const header = nonEmpty(field.title) ?? nonEmpty(form.title) ?? "Question " + (index + 1);
    const options = (field.options ?? []).map((option) => {
      const label = nonEmpty(option.label) ?? nonEmpty(option.value) ?? "Option";
      return { label, description: nonEmpty(option.description) ?? label, value: option.value };
    });
    questions.push({
      id: field.key,
      header,
      question: nonEmpty(field.description) ?? header,
      options,
      multiSelect: field.type === "multiselect",
      allowCustomAnswer: field.custom === true || options.length === 0,
    });
  }
  return { questions };
}

export function openCode2FormAnswer(form: FormInfo1, answers: ProviderUserInputAnswers) {
  const answer: Record<string, string | ReadonlyArray<string>> = {};
  for (const field of form.fields) {
    const raw = answers[field.key];
    const values = (Array.isArray(raw) ? raw : [raw]).filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (values.length > 0)
      answer[field.key] = field.type === "multiselect" ? values : values.join(", ");
  }
  return answer;
}

interface TurnUsage {
  steps: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly usage: TurnUsage;
  readonly toolNames: Map<string, string>;
  readonly text: Map<string, string>;
  interrupted: boolean;
  interruptFiber: Fiber.Fiber<void, never> | undefined;
}

type PendingRequest =
  | {
      readonly type: "permission";
      readonly sessionId: string;
      readonly nativeId: string;
      readonly requestType: ReturnType<typeof permissionRequestType>;
    }
  | { readonly type: "form"; readonly sessionId: string; readonly form: FormInfo1 };

interface SessionContext {
  session: ProviderSession;
  readonly threadId: ThreadId;
  readonly client: OpenCode2Client;
  readonly server: OpenCodeServerConnection;
  readonly scope: Scope.Closeable;
  readonly sessionId: string;
  readonly directory: string;
  readonly mcp: boolean;
  /** This session and the subagent sessions it started. */
  readonly sessionIds: Set<string>;
  readonly pending: Map<string, PendingRequest>;
  readonly turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
  readonly abort: AbortController;
  active: ActiveTurn | undefined;
  model:
    | { readonly providerID: string; readonly id: string; readonly variant?: string }
    | undefined;
  agent: string | undefined;
  sentInstructions: string | undefined;
  stopped: boolean;
}

function parseResume(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const cursor = raw as { schemaVersion?: unknown; sessionId?: unknown };
  return cursor.schemaVersion === RESUME_VERSION && typeof cursor.sessionId === "string"
    ? cursor.sessionId
    : undefined;
}

function eventSessionId(event: OpenCodeEvent): string | undefined {
  const data = (event as { readonly data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const record = data as { sessionID?: unknown; form?: { sessionID?: unknown } };
  if (typeof record.sessionID === "string") return record.sessionID;
  return typeof record.form?.sessionID === "string" ? record.form.sessionID : undefined;
}

function toolText(
  content: ReadonlyArray<{ readonly type: string; readonly text?: string }> | undefined,
) {
  return (content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("\n");
}

function tokenUsage(usage: TurnUsage, complete: boolean): TurnTokenUsage {
  if (usage.steps === 0) {
    return { usageStatus: "unavailable", usageScope: "main_agent", hasSubagents: false };
  }
  return {
    usageStatus: complete ? "complete" : "partial",
    usageScope: "main_agent",
    inputTokens: usage.input,
    cachedInputTokens: usage.cached,
    cacheCreationTokens: usage.cacheWrite,
    outputTokens: usage.output,
    reasoningTokens: Math.min(usage.output, usage.reasoning),
    hasSubagents: false,
  };
}

export interface OpenCode2AdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  /** Tests replace the HTTP client; production always uses `makeOpenCode2Client`. */
  readonly makeClient?: typeof makeOpenCode2Client;
}

export function makeOpenCode2Adapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCode2AdapterOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, SessionContext>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode runtime identifier.",
            cause,
          }),
      ),
    );
    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const base = (input: {
      readonly threadId: ThreadId;
      readonly turnId?: TurnId | undefined;
      readonly itemId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly raw?: unknown;
    }) =>
      Effect.all({ eventId: randomUUIDv4.pipe(Effect.orDie), createdAt: nowIso }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId: EventId.make(eventId),
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? { raw: { source: "opencode.sdk.event" as const, payload: input.raw } }
            : {}),
        })),
      );

    const requestError = (method: string, cause: unknown) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: openCodeRuntimeErrorDetail(cause),
        cause,
      });

    const requireSession = (threadId: ThreadId) => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const updateSession = (
      context: SessionContext,
      patch: Partial<ProviderSession>,
      clearTurn = false,
    ) =>
      Effect.gen(function* () {
        const { activeTurnId: _activeTurnId, ...rest } = context.session;
        context.session = {
          ...(clearTurn ? rest : context.session),
          ...patch,
          updatedAt: yield* nowIso,
        };
      });

    /** Closes an open approval or question card in every client. */
    const resolvePending = (context: SessionContext, requestId: string, raw?: unknown) =>
      Effect.gen(function* () {
        const pending = context.pending.get(requestId);
        if (pending === undefined) return;
        context.pending.delete(requestId);
        const eventBase = yield* base({
          threadId: context.threadId,
          turnId: context.active?.turnId,
          requestId,
          raw,
        });
        if (pending.type === "permission") {
          yield* emit({
            ...eventBase,
            type: "request.resolved",
            payload: { requestType: pending.requestType },
          });
        } else {
          yield* emit({ ...eventBase, type: "user-input.resolved", payload: { answers: {} } });
        }
      });

    const finishTurn = (
      context: SessionContext,
      state: "completed" | "failed" | "interrupted",
      errorMessage?: string,
      raw?: unknown,
    ) =>
      Effect.gen(function* () {
        const turn = context.active;
        if (turn === undefined) return;
        context.active = undefined;
        if (turn.interruptFiber) yield* Fiber.interrupt(turn.interruptFiber);
        yield* updateSession(
          context,
          { status: "ready", ...(errorMessage ? { lastError: errorMessage } : {}) },
          true,
        );
        yield* emit({
          ...(yield* base({ threadId: context.threadId, turnId: turn.turnId, raw })),
          type: "turn.completed",
          payload: {
            state,
            ...(nonEmpty(errorMessage) ? { errorMessage: nonEmpty(errorMessage) } : {}),
            tokenUsage: tokenUsage(turn.usage, state === "completed"),
          },
        });
      });

    const emitTool = (
      context: SessionContext,
      turn: ActiveTurn,
      toolId: string,
      type: "item.started" | "item.updated" | "item.completed",
      status: "inProgress" | "completed" | "failed",
      extra: { readonly input?: Readonly<Record<string, unknown>>; readonly output?: string },
      raw: unknown,
    ) =>
      Effect.gen(function* () {
        const name = turn.toolNames.get(toolId) ?? "tool";
        const itemType = openCode2ToolItemType(name);
        const command =
          typeof extra.input?.["command"] === "string" ? extra.input["command"] : undefined;
        const detail = nonEmpty(command ?? (status === "completed" ? undefined : extra.output));
        yield* emit({
          ...(yield* base({
            threadId: context.threadId,
            turnId: turn.turnId,
            itemId: toolId,
            raw,
          })),
          type,
          payload: {
            itemType,
            status,
            title: name,
            ...(detail ? { detail: detail.slice(0, 2000) } : {}),
            data: {
              tool: name,
              ...(extra.input ? { input: extra.input } : {}),
              ...(command ? { command } : {}),
              ...(extra.output !== undefined ? { result: extra.output } : {}),
            },
          },
        });
      });

    const onPermissionAsked = (
      context: SessionContext,
      data: PermissionAsked["data"],
      raw: unknown,
    ) =>
      Effect.gen(function* () {
        if (context.session.runtimeMode === "full-access") {
          // Subagent sessions do not inherit the session rules; full access already granted this.
          yield* runOpenCodeSdk("permission.reply", (signal) =>
            context.client.permission.reply(
              { sessionID: data.sessionID, requestID: data.id, decision: "once" },
              { signal },
            ),
          ).pipe(Effect.ignore);
          return;
        }
        const requestType = permissionRequestType(data.action);
        context.pending.set(data.id, {
          type: "permission",
          sessionId: data.sessionID,
          nativeId: data.id,
          requestType,
        });
        const detail =
          nonEmpty(data.resources.filter((resource) => resource !== "*").join("\n")) ??
          nonEmpty(data.message) ??
          data.action;
        yield* emit({
          ...(yield* base({
            threadId: context.threadId,
            turnId: context.active?.turnId,
            requestId: data.id,
            raw,
          })),
          type: "request.opened",
          payload: {
            requestType,
            detail,
            args: data.metadata,
            options: [
              { decision: "accept", label: "Allow once" },
              ...((data.save?.length ?? 0) > 0
                ? [
                    {
                      decision: "acceptForSession" as const,
                      label: "Always allow " + (data.save ?? []).join(", "),
                    },
                  ]
                : []),
              { decision: "decline", label: "Deny" },
            ],
          },
        });
      });

    const onFormCreated = (context: SessionContext, form: FormInfo1, raw: unknown) =>
      Effect.gen(function* () {
        const mapped = openCode2FormQuestions(form);
        if ("unsupported" in mapped) {
          yield* runOpenCodeSdk("session.form.cancel", (signal) =>
            context.client.session.form.cancel(
              { sessionID: form.sessionID, formID: form.id },
              { signal },
            ),
          ).pipe(Effect.ignore);
          yield* emit({
            ...(yield* base({ threadId: context.threadId, turnId: context.active?.turnId, raw })),
            type: "runtime.warning",
            payload: {
              message:
                "OpenCode asked for " +
                mapped.unsupported +
                ", which OOP can't show. The question was declined.",
            },
          });
          return;
        }
        context.pending.set(form.id, { type: "form", sessionId: form.sessionID, form });
        yield* emit({
          ...(yield* base({
            threadId: context.threadId,
            turnId: context.active?.turnId,
            requestId: form.id,
            raw,
          })),
          type: "user-input.requested",
          payload: { questions: mapped.questions },
        });
      });

    const onEvent = (context: SessionContext, event: OpenCodeEvent) =>
      Effect.gen(function* () {
        if (event.type === "session.created") {
          const created = event as EventOf<"session.created">;
          const parent = (created.data as { parentID?: string }).parentID;
          const id = (created.data as { sessionID?: string; info?: { id?: string } }).sessionID;
          if (parent !== undefined && context.sessionIds.has(parent) && id !== undefined) {
            context.sessionIds.add(id);
          }
          return;
        }
        const sessionId = eventSessionId(event);
        if (sessionId === undefined || !context.sessionIds.has(sessionId)) return;

        if (event.type === "permission.asked") {
          return yield* onPermissionAsked(context, (event as PermissionAsked).data, event);
        }
        if (event.type === "form.created") {
          return yield* onFormCreated(context, (event as EventOf<"form.created">).data.form, event);
        }
        if (event.type === "permission.replied") {
          const data = (event as EventOf<"permission.replied">).data;
          const pending = context.pending.get(data.requestID);
          if (pending?.type !== "permission") return;
          context.pending.delete(data.requestID);
          return yield* emit({
            ...(yield* base({
              threadId: context.threadId,
              turnId: context.active?.turnId,
              requestId: data.requestID,
              raw: event,
            })),
            type: "request.resolved",
            payload: {
              requestType: pending.requestType,
              decision:
                data.reply === "reject"
                  ? "decline"
                  : data.reply === "always"
                    ? "acceptForSession"
                    : "accept",
            },
          });
        }
        if (event.type === "form.replied" || event.type === "form.cancelled") {
          const formId =
            (event.data as { id?: string; formID?: string }).id ??
            (event.data as { formID?: string }).formID;
          if (formId === undefined || context.pending.get(formId)?.type !== "form") return;
          context.pending.delete(formId);
          return yield* emit({
            ...(yield* base({
              threadId: context.threadId,
              turnId: context.active?.turnId,
              requestId: formId,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: {
              answers:
                event.type === "form.replied"
                  ? ((event.data as { answer?: Record<string, unknown> }).answer ?? {})
                  : {},
            },
          });
        }

        // Everything below belongs to this thread's own turn, not its subagents.
        const turn = context.active;
        if (turn === undefined || sessionId !== context.sessionId) return;
        switch (event.type) {
          case "session.text.delta":
          case "session.reasoning.delta": {
            const data = event.data;
            if (data.delta.length === 0) return;
            const itemId =
              data.assistantMessageID +
              ":" +
              (event.type === "session.text.delta" ? "text" : "reasoning") +
              ":" +
              data.ordinal;
            if (event.type === "session.text.delta")
              turn.text.set(itemId, (turn.text.get(itemId) ?? "") + data.delta);
            return yield* emit({
              ...(yield* base({
                threadId: context.threadId,
                turnId: turn.turnId,
                itemId,
                raw: event,
              })),
              type: "content.delta",
              payload: {
                streamKind:
                  event.type === "session.text.delta" ? "assistant_text" : "reasoning_text",
                delta: data.delta,
              },
            });
          }
          case "session.text.ended": {
            const data = event.data;
            const itemId = data.assistantMessageID + ":text:" + data.ordinal;
            const streamed = turn.text.get(itemId) ?? "";
            turn.text.delete(itemId);
            // A provider that skips deltas still delivers the full text here.
            if (data.text.length > streamed.length && data.text.startsWith(streamed)) {
              yield* emit({
                ...(yield* base({
                  threadId: context.threadId,
                  turnId: turn.turnId,
                  itemId,
                  raw: event,
                })),
                type: "content.delta",
                payload: { streamKind: "assistant_text", delta: data.text.slice(streamed.length) },
              });
            }
            const detail = nonEmpty(data.text);
            return yield* emit({
              ...(yield* base({
                threadId: context.threadId,
                turnId: turn.turnId,
                itemId,
                raw: event,
              })),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                ...(detail ? { detail } : {}),
              },
            });
          }
          case "session.tool.input.started": {
            // Questions arrive as forms; the tool call itself is not shown.
            if (event.data.name === "question") return;
            turn.toolNames.set(event.data.id, event.data.name);
            return yield* emitTool(
              context,
              turn,
              event.data.id,
              "item.started",
              "inProgress",
              {},
              event,
            );
          }
          case "session.tool.called": {
            if (!turn.toolNames.has(event.data.id)) return;
            return yield* emitTool(
              context,
              turn,
              event.data.id,
              "item.updated",
              "inProgress",
              { input: event.data.input },
              event,
            );
          }
          case "session.tool.success": {
            if (!turn.toolNames.has(event.data.id)) return;
            yield* emitTool(
              context,
              turn,
              event.data.id,
              "item.completed",
              "completed",
              { output: toolText(event.data.content) },
              event,
            );
            turn.toolNames.delete(event.data.id);
            return;
          }
          case "session.tool.failed": {
            if (!turn.toolNames.has(event.data.id)) return;
            yield* emitTool(
              context,
              turn,
              event.data.id,
              "item.completed",
              "failed",
              { output: event.data.error.message },
              event,
            );
            turn.toolNames.delete(event.data.id);
            return;
          }
          case "session.step.ended":
          case "session.step.failed": {
            const tokens = (
              event.data as { tokens?: EventOf<"session.step.ended">["data"]["tokens"] }
            ).tokens;
            if (tokens === undefined) return;
            turn.usage.steps += 1;
            turn.usage.input += tokens.input + tokens.cache.read + tokens.cache.write;
            turn.usage.cached += tokens.cache.read;
            turn.usage.cacheWrite += tokens.cache.write;
            turn.usage.output += tokens.output + tokens.reasoning;
            turn.usage.reasoning += tokens.reasoning;
            return;
          }
          case "session.retry.scheduled":
            return yield* emit({
              ...(yield* base({ threadId: context.threadId, turnId: turn.turnId, raw: event })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode is retrying the request (attempt " + event.data.attempt + ").",
                detail: event.data.error.message,
              },
            });
          case "session.execution.succeeded":
            return yield* finishTurn(
              context,
              turn.interrupted ? "interrupted" : "completed",
              undefined,
              event,
            );
          case "session.execution.interrupted":
            return yield* finishTurn(context, "interrupted", undefined, event);
          case "session.execution.failed":
            return yield* finishTurn(
              context,
              turn.interrupted ? "interrupted" : "failed",
              event.data.error.message,
              event,
            );
          default:
            return;
        }
      });

    const stopContext = (context: SessionContext) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;
        if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
        for (const requestId of [...context.pending.keys()]) {
          yield* resolvePending(context, requestId);
        }
        if (context.active) yield* finishTurn(context, "interrupted");
        if (context.mcp && !context.server.external) {
          yield* runOpenCodeSdk("mcp.remove", (signal) =>
            context.client.mcp.remove(
              { server: MCP_SERVER_NAME, location: { directory: context.directory } },
              { signal },
            ),
          ).pipe(Effect.timeout("5 seconds"), Effect.ignore);
        }
        context.abort.abort();
        yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
        yield* emit({
          ...(yield* base({ threadId: context.threadId })),
          type: "session.exited",
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("OpenCode2.startSession")(
      function* (input) {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Expected provider '" + PROVIDER + "' but received '" + input.provider + "'.",
          });
        }
        const directory = input.cwd ?? serverConfig.cwd;
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopContext(existing);

        const scope = yield* Scope.make();
        const started = yield* Effect.gen(function* () {
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const server = yield* openCodeRuntime.connectToOpenCodeServer({
            binaryPath: openCodeSettings.binaryPath,
            directory,
            serverUrl: openCodeSettings.serverUrl,
            ...(openCodeSettings.serverPassword
              ? { serverPassword: openCodeSettings.serverPassword }
              : {}),
            environment: McpProviderSession.withAgentDeviceEnvironment(
              options?.environment ?? process.env,
              mcpSession,
            ),
            protocol: "v2",
          });
          const client = (options?.makeClient ?? makeOpenCode2Client)({
            baseUrl: server.url,
            password: server.serverPassword ?? "",
          });
          const location = { directory };
          // Sessions in a fresh location fail until its plugins finish activating.
          yield* runOpenCodeSdk("model.list", (signal) =>
            retryWhileActivating(() => client.model.list({ location }, { signal })),
          );
          const mcp = mcpSession !== undefined && !server.external;
          if (mcp) {
            yield* runOpenCodeSdk("mcp.add", (signal) =>
              client.mcp.add(
                {
                  server: MCP_SERVER_NAME,
                  location,
                  config: {
                    type: "remote",
                    url: mcpSession.endpoint,
                    headers: { Authorization: mcpSession.authorizationHeader },
                  },
                },
                { signal },
              ),
            );
          }
          const permissions = openCode2PermissionRules({ runtimeMode: input.runtimeMode, mcp });
          const resumeId = parseResume(input.resumeCursor);
          const resumed = resumeId
            ? yield* runOpenCodeSdk("session.get", (signal) =>
                client.session.get({ sessionID: resumeId }, { signal }),
              ).pipe(
                Effect.map(
                  (info) => info as { id: string; location: { directory: string } } | undefined,
                ),
                Effect.catchIf(
                  (cause) => isSessionNotFoundError(cause.cause),
                  () => Effect.succeed(undefined),
                ),
              )
            : undefined;
          if (resumed) {
            if (resumed.location.directory !== directory) {
              yield* runOpenCodeSdk("session.move", (signal) =>
                client.session.move({ sessionID: resumed.id, directory }, { signal }),
              );
            }
            yield* runOpenCodeSdk("session.update", (signal) =>
              client.session.update({ sessionID: resumed.id, permissions }, { signal }),
            );
            return { server, client, sessionId: resumed.id, mcp };
          }
          const parsed = parseOpenCodeModelSlug(input.modelSelection?.model);
          const created = yield* runOpenCodeSdk("session.create", (signal) =>
            client.session.create(
              {
                location,
                permissions,
                ...(parsed ? { model: { providerID: parsed.providerID, id: parsed.modelID } } : {}),
                ...(input.title ? { title: input.title } : {}),
              },
              { signal },
            ),
          );
          return { server, client, sessionId: created.id, mcp };
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit))),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ),
        );

        const createdAt = yield* nowIso;
        const context: SessionContext = {
          session: {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd: directory,
            ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
            threadId: input.threadId,
            resumeCursor: { schemaVersion: RESUME_VERSION, sessionId: started.sessionId },
            createdAt,
            updatedAt: createdAt,
          },
          threadId: input.threadId,
          client: started.client,
          server: started.server,
          scope,
          sessionId: started.sessionId,
          directory,
          mcp: started.mcp,
          sessionIds: new Set([started.sessionId]),
          pending: new Map(),
          turns: [],
          abort: new AbortController(),
          active: undefined,
          model: undefined,
          agent: undefined,
          sentInstructions: undefined,
          stopped: false,
        };
        sessions.set(input.threadId, context);

        const connected = yield* Deferred.make<void>();
        yield* Stream.fromAsyncIterable(
          started.client.event.subscribe({ signal: context.abort.signal }),
          (cause) => cause,
        ).pipe(
          Stream.runForEach((event) =>
            event.type === "server.connected"
              ? Deferred.succeed(connected, undefined).pipe(Effect.asVoid)
              : onEvent(context, event),
          ),
          Effect.onExit((exit) =>
            context.stopped
              ? Deferred.succeed(connected, undefined)
              : Effect.gen(function* () {
                  yield* Deferred.succeed(connected, undefined);
                  yield* Effect.logError("OpenCode 2 event stream ended.", {
                    cause: Exit.isFailure(exit) ? exit.cause : "closed by the server",
                  });
                  yield* finishTurn(context, "failed", "The OpenCode event stream disconnected.");
                  // Stopping closes the scope this fiber runs in, so it runs outside it.
                  yield* Effect.forkDetach(stopContext(context));
                }),
          ),
          Effect.forkIn(scope),
        );
        // OpenCode does not replay events published before the stream connects.
        yield* Deferred.await(connected).pipe(Effect.timeout("10 seconds"), Effect.ignore);
        if (context.stopped) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: "The OpenCode event stream closed while the session was starting.",
          });
        }

        yield* emit({
          ...(yield* base({ threadId: input.threadId })),
          type: "session.started",
          payload: { message: "OpenCode session started" },
        });
        yield* emit({
          ...(yield* base({ threadId: input.threadId })),
          type: "thread.started",
          payload: { providerThreadId: started.sessionId },
        });
        return context.session;
      },
    );

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("OpenCode2.sendTurn")(
      function* (input) {
        const context = yield* requireSession(input.threadId);
        // Steering into a run that is being cancelled would silently drop the message.
        if (context.active?.interrupted) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.prompt",
            detail: "The previous OpenCode turn is still stopping. Try again in a moment.",
          });
        }
        const modelSelection =
          input.modelSelection ??
          (context.session.model
            ? { instanceId: boundInstanceId, model: context.session.model }
            : undefined);
        if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue:
              "OpenCode model selection is bound to instance '" +
              modelSelection.instanceId +
              "', expected '" +
              boundInstanceId +
              "'.",
          });
        }
        const parsed = parseOpenCodeModelSlug(modelSelection?.model);
        if (!parsed) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode model selection must use the 'provider/model' format.",
          });
        }
        const text = input.input?.trim() ?? "";
        const files: Array<{ uri: string; name: string }> = [];
        if (!context.server.external) {
          for (const attachment of input.attachments ?? []) {
            // Other files reach the agent through the path line in the prompt.
            if (attachment.type !== "image") continue;
            const path = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!path) continue;
            // OpenCode rejects the whole prompt if an attached file is missing.
            if (yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false))) {
              files.push({ uri: NodeURL.pathToFileURL(path).href, name: attachment.name });
            }
          }
        }
        if (text.length === 0 && files.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode turns require text input or at least one attachment.",
          });
        }
        const sessionID = context.sessionId;
        const client = context.client;

        const variant = getModelSelectionStringOptionValue(modelSelection, "variant");
        const model = {
          providerID: parsed.providerID,
          id: parsed.modelID,
          ...(variant ? { variant } : {}),
        };
        if (
          context.model?.providerID !== model.providerID ||
          context.model.id !== model.id ||
          context.model.variant !== model.variant
        ) {
          yield* runOpenCodeSdk("session.switchModel", (signal) =>
            client.session.switchModel({ sessionID, model }, { signal }),
          ).pipe(Effect.mapError((cause) => requestError("session.switchModel", cause)));
          context.model = model;
        }
        const agent =
          getModelSelectionStringOptionValue(modelSelection, "agent") ??
          (input.interactionMode === "plan" ? "plan" : "build");
        if (context.agent !== agent) {
          yield* runOpenCodeSdk("session.switchAgent", (signal) =>
            client.session.switchAgent({ sessionID, agent }, { signal }),
          ).pipe(Effect.mapError((cause) => requestError("session.switchAgent", cause)));
          context.agent = agent;
        }
        const instructions = buildRuntimeInstructions({
          harness: "OpenCode",
          model: parsed.providerID + "/" + parsed.modelID,
        });
        if (context.sentInstructions !== instructions) {
          yield* runOpenCodeSdk("session.instructions.entry.put", (signal) =>
            client.session.instructions.entry.put(
              { sessionID, key: INSTRUCTIONS_KEY, value: instructions },
              { signal },
            ),
          ).pipe(Effect.ignore);
          context.sentInstructions = instructions;
        }

        // A send while a turn runs is a steer: OpenCode folds it into the running work.
        const steering = context.active;
        const turnId = steering?.turnId ?? TurnId.make("opencode-turn-" + (yield* randomUUIDv4));
        if (steering === undefined) {
          context.active = {
            turnId,
            usage: { steps: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
            toolNames: new Map(),
            text: new Map(),
            interrupted: false,
            interruptFiber: undefined,
          };
          yield* updateSession(context, {
            status: "running",
            activeTurnId: turnId,
            model: modelSelection?.model ?? context.session.model,
          });
          yield* emit({
            ...(yield* base({ threadId: input.threadId, turnId })),
            type: "turn.started",
            payload: { model: modelSelection?.model ?? context.session.model },
          });
        }

        const command = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
        const commandName = command
          ? (yield* runOpenCodeSdk("command.list", (signal) =>
              client.command.list({ location: { directory: context.directory } }, { signal }),
            ).pipe(
              Effect.orElseSucceed(() => ({ data: [] as ReadonlyArray<{ name: string }> })),
            )).data.find((entry) => entry.name === command[1])?.name
          : undefined;
        const submitted = yield* (
          commandName !== undefined
            ? runOpenCodeSdk("session.command", (signal) =>
                client.session.command(
                  {
                    sessionID,
                    name: commandName,
                    text: command?.[2] ?? "",
                    ...(files.length > 0 ? { files } : {}),
                    ...(steering ? { delivery: "steer" as const } : {}),
                  },
                  { signal },
                ),
              )
            : runOpenCodeSdk("session.prompt", (signal) =>
                client.session.prompt(
                  {
                    sessionID,
                    text,
                    ...(files.length > 0 ? { files } : {}),
                    ...(steering ? { delivery: "steer" as const } : {}),
                  },
                  { signal },
                ),
              )
        ).pipe(Effect.timeout("15 seconds"), Effect.exit);
        if (Exit.isFailure(submitted)) {
          const failure = requestError("session.prompt", submitted.cause);
          if (steering === undefined && context.active?.turnId === turnId) {
            const turn = context.active;
            context.active = undefined;
            yield* updateSession(context, { status: "ready", lastError: failure.detail }, true);
            yield* emit({
              ...(yield* base({ threadId: input.threadId, turnId })),
              type: "turn.aborted",
              payload: {
                reason: failure.detail || "OpenCode did not accept the prompt.",
                tokenUsage: tokenUsage(turn.usage, false),
              },
            });
          }
          return yield* failure;
        }
        const record = context.turns.find((turn) => turn.id === turnId);
        if (record) record.items.push({ text, files });
        else context.turns.push({ id: turnId, items: [{ text, files }] });
        return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
      },
    );

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const turn = context.active;
        if (turn === undefined) return;
        turn.interrupted = true;
        // The interrupted execution normally ends the turn; never leave it running if it does not.
        if (turn.interruptFiber === undefined) {
          turn.interruptFiber = yield* Effect.sleep(INTERRUPT_GRACE).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                turn.interruptFiber = undefined;
                return context.active === turn ? finishTurn(context, "interrupted") : Effect.void;
              }),
            ),
            Effect.forkIn(context.scope),
          );
        }
        for (const [requestId, pending] of [...context.pending]) {
          if (pending.type === "form") {
            yield* runOpenCodeSdk("session.form.cancel", (signal) =>
              context.client.session.form.cancel(
                { sessionID: pending.sessionId, formID: pending.form.id },
                { signal },
              ),
            ).pipe(Effect.ignore);
          }
          yield* resolvePending(context, requestId);
        }
        yield* runOpenCodeSdk("session.interrupt", (signal) =>
          context.client.session.interrupt({ sessionID: context.sessionId }, { signal }),
        ).pipe(
          Effect.timeout(INTERRUPT_GRACE),
          Effect.mapError((cause) => requestError("session.interrupt", cause)),
        );
      });

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pending.get(requestId);
        if (pending?.type !== "permission") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "permission.reply",
            detail: "Unknown pending approval request: " + requestId,
          });
        }
        const reply =
          decision === "accept"
            ? ({ decision: "once" } as const)
            : decision === "acceptForSession" || decision === "acceptAlways"
              ? ({ decision: "always" } as const)
              : decision === "decline"
                ? ({ decision: "reject", message: DECLINED } as const)
                : // A rejection without a message stops the whole execution, which is Cancel.
                  ({ decision: "reject" } as const);
        yield* runOpenCodeSdk("permission.reply", (signal) =>
          context.client.permission.reply(
            { sessionID: pending.sessionId, requestID: pending.nativeId, ...reply },
            { signal },
          ),
        ).pipe(
          Effect.catchIf(
            (cause) => isPermissionNotFoundError(cause.cause),
            () => resolvePending(context, requestId),
          ),
          Effect.mapError((cause) => requestError("permission.reply", cause)),
        );
      });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pending.get(requestId);
        if (pending?.type !== "form") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.form.reply",
            detail: "Unknown pending user-input request: " + requestId,
          });
        }
        const answer = openCode2FormAnswer(pending.form, answers);
        yield* runOpenCodeSdk("session.form.reply", (signal) =>
          Object.keys(answer).length === 0
            ? context.client.session.form.cancel(
                { sessionID: pending.sessionId, formID: pending.form.id },
                { signal },
              )
            : context.client.session.form.reply(
                { sessionID: pending.sessionId, formID: pending.form.id, answer },
                { signal },
              ),
        ).pipe(
          Effect.catchIf(
            (cause) => isFormNotFoundError(cause.cause),
            () => resolvePending(context, requestId),
          ),
          Effect.mapError((cause) => requestError("session.form.reply", cause)),
        );
      });

    const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* stopContext(context);
      });

    const readThread: OpenCodeAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns }));

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "OpenCode 2 sessions do not support provider-side rollback in OOP yet.",
        });
      });

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.forEach(
        [...sessions.values()],
        (context) => Effect.ignoreCause(stopContext(context)),
        {
          discard: true,
        },
      );

    yield* Effect.addFinalizer(() => Effect.ignore(stopAll()));

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.sync(() => [...sessions.values()].map((context) => ({ ...context.session }))),
      hasSession: (threadId) => Effect.sync(() => sessions.get(threadId)?.stopped === false),
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
