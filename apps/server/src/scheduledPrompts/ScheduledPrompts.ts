import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ScheduledPrompt,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  nextScheduledPromptAt,
  scheduledPromptOccurrence,
  SCHEDULED_PROMPT_LATE_LIMIT_MS,
} from "@t3tools/shared/scheduledPrompts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";

// A timer does not advance while the machine sleeps, so the scheduler never waits on one for
// longer than this before it reads the clock again.
const MAX_SLEEP_MS = 60_000;

export function resolveModelSelection(
  selection: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  // Use the same instance and model priorities as the web's new-thread picker.
  const selectable = providers.filter(
    (provider) => provider.enabled && provider.availability !== "unavailable",
  );
  if (selection && selectable.some((provider) => provider.instanceId === selection.instanceId)) {
    return selection;
  }
  const provider =
    selectable.find((provider) => provider.status === "ready") ??
    selectable.find((provider) => provider.status !== "error");
  const model =
    provider?.models.find((entry) => entry.isDefault && !entry.isCustom)?.slug ??
    provider?.models.find((entry) => !entry.isCustom)?.slug ??
    provider?.models[0]?.slug ??
    (provider ? DEFAULT_MODEL_BY_PROVIDER[provider.driver] : undefined);
  // Keep the server bootstrap fallback when provider discovery has no usable default.
  return provider && model
    ? { instanceId: provider.instanceId, model }
    : (selection ?? { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL });
}

export const runOccurrence = Effect.fn("ScheduledPrompts.runOccurrence")(function* (
  entry: ScheduledPrompt,
  settings: ServerSettings,
  targetMillis: number,
) {
  if (!entry.enabled) return;
  const snapshots = yield* ProjectionSnapshotQuery;
  const project = yield* snapshots.getProjectShellById(entry.projectId);
  if (Option.isNone(project)) return "project-missing" as const;

  const engine = yield* OrchestrationEngineService;
  const registry = yield* ProviderRegistry;
  const defaults = resolveProjectSettings(settings, entry.projectId, project.value).settings;
  const modelSelection = resolveModelSelection(
    defaults.defaultModelSelection,
    yield* registry.getProviders,
  );
  const runtimeMode = defaults.defaultRuntimeMode;
  const interactionMode = DEFAULT_PROVIDER_INTERACTION_MODE;
  const occurrence = `scheduled-prompt:${entry.id}:${scheduledPromptOccurrence(targetMillis)}`;
  const threadId = ThreadId.make(occurrence);
  const createdAt = DateTime.formatIso(yield* DateTime.now);

  // The engine returns the accepted receipt when the same command targets the
  // same aggregate. A retry after create can therefore continue to the turn.
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`server:create:${occurrence}`),
    threadId,
    projectId: entry.projectId,
    title: entry.title,
    modelSelection,
    runtimeMode,
    interactionMode,
    branch: null,
    worktreePath: null,
    createdAt,
  });
  yield* engine.dispatch({
    type: "thread.meta.update",
    commandId: CommandId.make(`server:title:${occurrence}`),
    threadId,
    title: entry.title,
  });
  yield* engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`server:turn:${occurrence}`),
    threadId,
    message: {
      messageId: MessageId.make(occurrence),
      role: "user",
      text: entry.prompt,
      attachments: [],
    },
    runtimeMode,
    interactionMode,
    createdAt,
  });
  yield* engine.dispatch({
    type: "thread.activity.append",
    commandId: CommandId.make(`server:activity:${occurrence}`),
    threadId,
    activity: {
      id: EventId.make(occurrence),
      kind: "scheduled-prompt.started",
      tone: "info",
      summary: `Scheduled prompt: ${entry.title}`,
      payload: { scheduleId: entry.id, title: entry.title },
      turnId: null,
      createdAt,
    },
    createdAt,
  });
});

/** @public Layer construction is part of the canonical Effect module API. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const changes = yield* settingsService.subscribeChanges;
    const waitForChange = Stream.runDrain(Stream.take(Stream.concat(changes, Stream.never), 1));

    yield* forkParked(
      Effect.gen(function* () {
        let plannedAfter: number | undefined;
        while (true) {
          const settings = yield* settingsService.getSettings.pipe(Effect.option);
          const now = yield* Clock.currentTimeMillis;
          const pending =
            Option.getOrUndefined(settings)
              ?.scheduledPrompts.filter((entry) => entry.enabled)
              .map((entry) => ({
                entry,
                target: nextScheduledPromptAt(plannedAfter ?? now, entry.hour, entry.minute),
              })) ?? [];
          if (pending.length === 0) {
            plannedAfter = undefined;
            yield* waitForChange;
            continue;
          }
          const earliest = Math.min(...pending.map(({ target }) => target));
          yield* Effect.race(
            Effect.sleep(Duration.millis(Math.min(Math.max(0, earliest - now), MAX_SLEEP_MS))),
            waitForChange,
          );

          const wokeAt = yield* Clock.currentTimeMillis;
          for (const { entry, target } of pending) {
            if (target > wokeAt) continue;
            if (wokeAt - target > SCHEDULED_PROMPT_LATE_LIMIT_MS) {
              yield* Effect.logWarning("Scheduled prompt skipped, more than an hour late", {
                scheduleId: entry.id,
              });
              continue;
            }
            yield* Effect.gen(function* () {
              const latest = yield* settingsService.getSettings;
              const current = latest.scheduledPrompts.find(({ id }) => id === entry.id);
              if (!current || current.hour !== entry.hour || current.minute !== entry.minute)
                return;
              const outcome = yield* runOccurrence(current, latest, target);
              // A deleted project never comes back, and nothing in the settings shows its
              // entries, so they would otherwise count against the limit for good.
              if (outcome === "project-missing") {
                yield* settingsService.updateSettings({
                  scheduledPromptOperations: [
                    { type: "removeProject", projectId: current.projectId },
                  ],
                });
              }
            }).pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning("Scheduled prompt run failed", { scheduleId: entry.id, cause }),
              ),
            );
          }
          // Planning from the wake time keeps what came due while this batch was dispatched.
          // An entry added or moved to a time that already passed today waits for tomorrow.
          plannedAfter = wokeAt;
        }
      }),
    );
  }),
);
