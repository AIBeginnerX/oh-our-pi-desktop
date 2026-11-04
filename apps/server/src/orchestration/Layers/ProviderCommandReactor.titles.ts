import { type ChatAttachment, CommandId, type ProjectId, ThreadId } from "@t3tools/contracts";
import { normalizeProjectMemoryReferenceLabels } from "@t3tools/shared/composerContextReferences";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import type * as SqlError from "effect/unstable/sql/SqlError";
import type { OrchestrationProjectShell, OrchestrationThreadShell } from "@t3tools/contracts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { formatThreadTitleContext } from "../../textGeneration/ThreadTitleContext.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  type ProviderIntentEvent,
  buildGeneratedWorktreeBranchName,
} from "./ProviderCommandReactor.helpers.ts";

type ThreadDetail = Option.Option.Value<
  Effect.Success<ReturnType<ProjectionSnapshotQuery["Service"]["getThreadDetailById"]>>
>;

export interface ThreadTitleOperationsDeps {
  readonly orchestrationEngine: OrchestrationEngineService["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly providerRegistry: ProviderRegistry["Service"];
  readonly gitWorkflow: GitWorkflowService["Service"];
  readonly vcsStatusBroadcaster: VcsStatusBroadcaster["Service"];
  readonly textGeneration: TextGeneration["Service"];
  readonly serverSettingsService: ServerSettingsService["Service"];
  readonly providerDiagnosticText: (
    threadId: ThreadId,
    raw: () => string,
  ) => Effect.Effect<string, SqlError.SqlError>;
  readonly projectSettingsForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Effect.Success<ServerSettingsService["Service"]["getSettings"]>,
    Effect.Error<ServerSettingsService["Service"]["getSettings"]>
  >;
  readonly serverCommandId: (tag: string) => Effect.Effect<CommandId, PlatformError.PlatformError>;
  readonly resolveProject: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationProjectShell | undefined, ProjectionRepositoryError>;
  readonly resolveThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThreadShell | undefined, ProjectionRepositoryError>;
  readonly resolveThreadDetail: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadDetail | undefined, ProjectionRepositoryError>;
}

export const makeThreadTitleOperations = ({
  orchestrationEngine,
  projectionSnapshotQuery,
  providerRegistry,
  gitWorkflow,
  vcsStatusBroadcaster,
  textGeneration,
  serverSettingsService,
  providerDiagnosticText,
  projectSettingsForThread,
  serverCommandId,
  resolveProject,
  resolveThreadShell,
  resolveThreadDetail,
}: ThreadTitleOperationsDeps) => {
  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* projectSettingsForThread(input.threadId);
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
      readonly expectedTitle: string;
      readonly expectedVersion: CommandId | null;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } = yield* projectSettingsForThread(
          input.threadId,
        );

        const generated = yield* textGeneration
          .generateThreadTitle({
            cwd: input.cwd,
            message: input.messageText,
            ...(attachments.length > 0 ? { attachments } : {}),
            modelSelection,
          })
          .pipe(
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("2 seconds"),
            }),
          );
        if (!generated) return;

        const thread = yield* resolveThreadShell(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.title.generate.complete",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title === DEFAULT_THREAD_TITLE ? input.expectedTitle : generated.title,
          expectedTitle: input.expectedTitle,
          expectedVersion: input.expectedVersion,
          needsRefinement:
            generated.needsRefinement === true || generated.title === DEFAULT_THREAD_TITLE,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          providerDiagnosticText(input.threadId, () => Cause.pretty(cause)).pipe(
            Effect.flatMap((causeText) =>
              Effect.logWarning(
                "provider command reactor failed to generate or rename thread title",
                {
                  threadId: input.threadId,
                  cwd: input.cwd,
                  cause: causeText,
                },
              ),
            ),
          ),
        ),
      );
    },
  );

  const maybeRefineThreadTitle = Effect.fn("maybeRefineThreadTitle")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (
      !thread?.titleState?.needsRefinement ||
      thread.titleState.source !== "generated" ||
      thread.titleRegeneration != null ||
      thread.latestTurn?.state !== "completed" ||
      thread.session?.status !== "ready"
    )
      return;
    const detail = yield* resolveThreadDetail(threadId);
    if (!detail || detail.messages.filter((message) => message.role === "user").length !== 1)
      return;
    yield* orchestrationEngine.dispatch({
      type: "thread.title.refine",
      commandId: yield* serverCommandId("thread-title-refine"),
      threadId,
      expectedVersion: thread.titleState.version,
    });
  });

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    // Memory labels are normalized on an ephemeral copy only: assistant/system
    // rows and the persisted thread stay untouched, and no envelope is built.
    const { message, attachments } = formatThreadTitleContext(
      thread.messages.map((entry) =>
        entry.role === "user"
          ? {
              ...entry,
              text: normalizeProjectMemoryReferenceLabels({
                text: entry.text,
                records: entry.context?.records ?? [],
              }),
            }
          : entry,
      ),
    );
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
      yield* serverSettingsService.getSettings,
      thread.projectId,
    ).settings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThreadShell(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findPendingThreadTitles = Effect.fn("findPendingThreadTitles")(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return {
      interruptedRegenerations: readModel.threads.flatMap((thread) => {
        const requestId = thread.titleRegeneration?.requestId;
        return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
      }),
      refinementThreadIds: readModel.threads
        .filter((thread) => thread.titleState?.needsRefinement)
        .map((thread) => thread.id),
    };
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return providerDiagnosticText(threadId, () => Cause.pretty(cause)).pipe(
              Effect.flatMap((causeText) =>
                Effect.logWarning(
                  "provider command reactor failed to clear interrupted title regeneration",
                  {
                    threadId,
                    cause: causeText,
                  },
                ),
              ),
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            providerDiagnosticText(event.payload.threadId, () => Cause.pretty(cause)).pipe(
              Effect.flatMap((causeText) =>
                Effect.logWarning("provider command reactor failed to regenerate thread title", {
                  threadId: event.payload.threadId,
                  cause: causeText,
                }),
              ),
              Effect.as({ _tag: "Completed", title: undefined } as const),
            ),
        ),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            providerDiagnosticText(event.payload.threadId, () => Cause.pretty(cause)).pipe(
              Effect.flatMap((causeText) =>
                Effect.logWarning(
                  "provider command reactor retrying title regeneration completion",
                  {
                    threadId: event.payload.threadId,
                    cause: causeText,
                  },
                ),
              ),
              Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)),
            ),
        ),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            providerDiagnosticText(event.payload.threadId, () => Cause.pretty(cause)).pipe(
              Effect.flatMap((causeText) =>
                Effect.logWarning(
                  "provider command reactor failed to complete title regeneration",
                  {
                    threadId: event.payload.threadId,
                    cause: causeText,
                  },
                ),
              ),
            ),
        ),
      ),
  );

  return {
    maybeGenerateAndRenameWorktreeBranchForFirstTurn,
    maybeGenerateThreadTitleForFirstTurn,
    maybeRefineThreadTitle,
    findPendingThreadTitles,
    clearInterruptedThreadTitleRegenerations,
    processThreadTitleRegenerationSafely,
  };
};
