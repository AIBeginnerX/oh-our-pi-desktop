// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  type PermissionMode,
  type SettingSource,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ProviderInstanceId, type ProviderSendTurnInput } from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  getModelSelectionStringOptionValue,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { planClaudeSkillDispatch } from "../Drivers/ClaudeSkillDispatch.ts";
import {
  type ClaudeModelCatalog,
  getClaudeCatalogModelCapabilities,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelSlug,
} from "../ClaudeModelCatalog.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { type ClaudeSessionContext, PROVIDER } from "./ClaudeAdapter.state.ts";
import { getEffectiveClaudeAgentEffort } from "./ClaudeAdapter.results.ts";

export const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/**
 * "oop-claude-route/v1" — the OOP-observed Claude SDK control profile a
 * publish-step admission reports as `routeConfigSha256`: SHA-256 lowercase
 * hex of the whitespace-free UTF-8 JSON of this flat object with keys
 * sorted lexicographically. Every key is present; an optional value absent
 * at launch is null. Only fields the adapter can actually prove belong here
 * — credentials, environment, paths, session/task identity, native files
 * and MCP configuration are deliberately excluded.
 */
export const CLAUDE_ROUTE_PROFILE_KEYS = [
  "alwaysThinkingEnabled",
  "apiModel",
  "argumentThinkingDisplay",
  "autoCompactWindow",
  "driver",
  "fastMode",
  "launchEffort",
  "permissionMode",
  "promptInjectedEffort",
  "providerInstanceId",
  "queryThinkingDisplay",
  "settingSources",
  "showThinkingSummaries",
  "subagentDefaultEffort",
  "systemPromptAppendSha256",
  "systemPromptPreset",
  "ultracode",
  "v",
] as const;

export type ClaudeRouteProfileValue = string | number | boolean | null | ReadonlyArray<string>;

export type ClaudeRouteProfile = Record<
  (typeof CLAUDE_ROUTE_PROFILE_KEYS)[number],
  ClaudeRouteProfileValue
>;

/**
 * The launch-fixed half of the route profile, snapshotted immutably from
 * the constructed query options and settings at session start — never
 * recomputed from later state. The volatile fields `apiModel`,
 * `permissionMode`, `subagentDefaultEffort` and `promptInjectedEffort` are
 * filled per admission from the publishing context's post-setter state.
 */
export interface ClaudeRouteProfileSeed {
  readonly launchEffort: string | null;
  readonly queryThinkingDisplay: string | null;
  readonly argumentThinkingDisplay: string | null;
  readonly alwaysThinkingEnabled: boolean | null;
  readonly showThinkingSummaries: boolean | null;
  readonly fastMode: boolean | null;
  readonly ultracode: boolean | null;
  readonly autoCompactWindow: number | null;
  readonly settingSources: ReadonlyArray<string>;
  readonly systemPromptPreset: string | null;
  readonly systemPromptAppendSha256: string | null;
}

/**
 * With no configured window, a model with a larger context compacts here. Measured on a real
 * install: API calls whose context passed 300k tokens carried over half of all input tokens,
 * because every call in a long turn re-reads the whole context.
 */
export const DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW = 300_000;

export const sha256HexUtf8 = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

export function claudeRouteConfigSha256(profile: ClaudeRouteProfile): string {
  // undefined, non-finite numbers and non-string array elements are
  // unsupported values: a profile that cannot prove a field produces no
  // digest rather than a silently wrong one.
  for (const key of CLAUDE_ROUTE_PROFILE_KEYS) {
    const value = profile[key];
    if (
      value === undefined ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      (Array.isArray(value) && value.some((item) => typeof item !== "string"))
    ) {
      throw new Error(`Unsupported Claude route profile value for '${key}'.`);
    }
  }
  // The property-list replacer pins every declared key in sorted order.
  return sha256HexUtf8(JSON.stringify(profile, [...CLAUDE_ROUTE_PROFILE_KEYS]));
}

/**
 * The prompt-injected effort a send of `input` resolves to — shared by the
 * setter-target projection, the read-only preview, the published candidate,
 * and the actual prompt text builder. Out-of-instance selections inject
 * nothing.
 */
export const resolveClaudePromptInjectedEffort = (
  modelCatalog: ClaudeModelCatalog,
  input: ProviderSendTurnInput,
  boundInstanceId: ProviderInstanceId,
): string | null => {
  const selectedModel =
    input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
      ? input.modelSelection
      : undefined;
  return resolvePromptInjectedEffort(
    getClaudeCatalogModelCapabilities(modelCatalog, selectedModel?.model),
    getModelSelectionStringOptionValue(selectedModel, "effort"),
  );
};

/**
 * The post-setter route controls a send of `input` would leave behind on
 * `context`: the api model, permission mode, session effort, and
 * prompt-injected effort the send's own setter step would produce. Pure —
 * sendTurn computes its setter targets from it before calling the SDK, and
 * the read-only preview runs the same projection with no setter at all.
 */
export const projectClaudeSendControls = (
  context: Pick<
    ClaudeSessionContext,
    "currentApiModelId" | "currentPermissionMode" | "currentEffort" | "basePermissionMode"
  >,
  input: ProviderSendTurnInput,
  modelCatalog: ClaudeModelCatalog,
  boundInstanceId: ProviderInstanceId,
): {
  readonly apiModel: string | undefined;
  readonly permissionMode: PermissionMode | undefined;
  readonly effort: string | undefined;
  readonly promptInjectedEffort: string | null;
} => {
  const selectedModel =
    input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
      ? input.modelSelection
      : undefined;
  const modelSelection = selectedModel
    ? { ...selectedModel, model: resolveClaudeModelSlug(modelCatalog, selectedModel.model) }
    : undefined;
  const apiModel = modelSelection?.model
    ? resolveClaudeCatalogApiModelId(modelCatalog, modelSelection)
    : context.currentApiModelId;
  const effort = modelSelection?.model
    ? (getEffectiveClaudeAgentEffort(
        modelCatalog,
        resolveClaudeCatalogEffort(
          modelCatalog,
          modelSelection.model,
          getModelSelectionStringOptionValue(modelSelection, "effort"),
        ) ?? null,
        modelSelection.model,
      ) ?? undefined)
    : context.currentEffort;
  const permissionMode =
    input.interactionMode === "plan"
      ? "plan"
      : input.interactionMode === "default"
        ? (context.basePermissionMode ?? "default")
        : context.currentPermissionMode;
  const promptInjectedEffort = resolveClaudePromptInjectedEffort(
    modelCatalog,
    input,
    boundInstanceId,
  );
  return { apiModel, permissionMode, effort, promptInjectedEffort };
};

/**
 * The single canonical assembly of the observed route profile hashed into
 * every submission candidate. Publish feeds it post-setter context state;
 * the read-only preview feeds it the same send's projected controls.
 */
export const buildClaudeRouteProfile = (input: {
  readonly seed: ClaudeRouteProfileSeed;
  readonly providerInstanceId: ProviderInstanceId;
  readonly apiModel: string;
  readonly permissionMode: string;
  readonly subagentDefaultEffort: string | null;
  readonly promptInjectedEffort: string | null;
}): ClaudeRouteProfile => ({
  v: "oop-claude-route/v1",
  driver: PROVIDER,
  providerInstanceId: input.providerInstanceId,
  apiModel: input.apiModel,
  permissionMode: input.permissionMode,
  launchEffort: input.seed.launchEffort,
  subagentDefaultEffort: input.subagentDefaultEffort,
  promptInjectedEffort: input.promptInjectedEffort,
  queryThinkingDisplay: input.seed.queryThinkingDisplay,
  argumentThinkingDisplay: input.seed.argumentThinkingDisplay,
  alwaysThinkingEnabled: input.seed.alwaysThinkingEnabled,
  showThinkingSummaries: input.seed.showThinkingSummaries,
  fastMode: input.seed.fastMode,
  ultracode: input.seed.ultracode,
  autoCompactWindow: input.seed.autoCompactWindow,
  settingSources: input.seed.settingSources,
  systemPromptPreset: input.seed.systemPromptPreset,
  systemPromptAppendSha256: input.seed.systemPromptAppendSha256,
});

export function buildPromptText(
  input: ProviderSendTurnInput,
  boundInstanceId: ProviderInstanceId,
  catalog: ClaudeModelCatalog,
): string {
  const promptEffort = resolveClaudePromptInjectedEffort(catalog, input, boundInstanceId);
  return applyClaudePromptEffortPrefix(input.input?.trim() ?? "", promptEffort);
}

export function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent as unknown as SDKUserMessage["message"]["content"],
    },
  } as SDKUserMessage;
}

export function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

export const buildUserMessageEffect = Effect.fn("buildUserMessageEffect")(function* (
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
    readonly boundInstanceId: ProviderInstanceId;
    readonly modelCatalog: ClaudeModelCatalog;
    /** Names of the skills Claude Code can run for this session's cwd. */
    readonly skillNames: ReadonlySet<string>;
  },
) {
  const text = buildPromptText(input, dependencies.boundInstanceId, dependencies.modelCatalog);
  const sdkContent: Array<Record<string, unknown>> = [];

  // Claude Code expands a skill only from the LAST text block, and only when
  // `/name` is its first character. A `$skill` chip anywhere in the prompt is
  // therefore split into [leading text, "/name trailing text"] so the CLI
  // runs it natively and the prose around it survives. See ClaudeSkillDispatch.
  const dispatch = planClaudeSkillDispatch(text, dependencies.skillNames);
  if (dispatch?.leadingText !== undefined) {
    sdkContent.push({ type: "text", text: dispatch.leadingText });
  }

  for (const attachment of input.attachments ?? []) {
    // Claude ingests images only. Generic files reach the agent through the
    // path line ProviderService puts in the prompt.
    if (attachment.type !== "image") {
      continue;
    }

    if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
      });
    }

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: dependencies.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }

    const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: "Failed to read attachment file.",
            cause,
          }),
      ),
    );

    sdkContent.push(
      buildClaudeImageContentBlock({
        mimeType: attachment.mimeType,
        bytes,
      }),
    );
  }

  // The final text block goes last on purpose. The Claude CLI only reads a
  // streamed user message as a slash-command invocation when the last content
  // block is text; image blocks ahead of it ride along as preceding input.
  // Leading with the text made every image-carrying turn fall back to a plain
  // prompt, so a hand-typed `/skill args` reached the agent unexpanded.
  if (dispatch) {
    sdkContent.push({ type: "text", text: dispatch.commandText });
  } else if (text.length > 0) {
    sdkContent.push({ type: "text", text });
  }

  return buildUserMessage({ sdkContent });
});
