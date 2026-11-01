import {
  ApprovalRequestId,
  type ClientOrchestrationCommand,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerConfig,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlanId,
} from "@t3tools/contracts";
import { t } from "../i18n/index.ts";

export { reasoningEffortOf } from "./effort.ts";

export interface CommandContext {
  readonly uuid: () => string;
  readonly now: () => Date;
}

const stamp = (context: CommandContext) => ({
  commandId: CommandId.make(context.uuid()),
  createdAt: context.now().toISOString(),
});

const TITLE_LIMIT = 60;

/** Thread title from the first line of the first message, cut on a grapheme boundary. */
export const titleFromMessage = (text: string): string => {
  const first =
    text
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? "";
  if (first === "") return t("session.title.untitled");
  const characters = Array.from(first);
  return characters.length <= TITLE_LIMIT
    ? first
    : `${characters.slice(0, TITLE_LIMIT - 1).join("")}…`;
};

/** What `/model` search looks at besides the label; absent for a model the server does not list. */
export interface ModelSearchFields {
  readonly name: string;
  readonly shortName?: string;
  readonly subProvider?: string;
  readonly driver: string;
  readonly providerName: string;
}

export interface ModelChoice {
  readonly instanceId: string;
  readonly model: string;
  readonly label: string;
  readonly search?: ModelSearchFields;
}

/** Models the server can actually run, grouped by provider instance order. */
export const availableModels = (config: ServerConfig | null): ReadonlyArray<ModelChoice> =>
  (config?.providers ?? [])
    .filter(
      (provider) =>
        provider.enabled && provider.installed && provider.availability !== "unavailable",
    )
    .flatMap((provider) =>
      provider.models.map((model) => ({
        instanceId: provider.instanceId,
        model: model.slug,
        label: `${provider.displayName ?? provider.instanceId} / ${model.name}`,
        search: {
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          driver: provider.driver,
          providerName: provider.displayName ?? provider.instanceId,
        },
      })),
    );

/**
 * Whether a provider that is on is still being looked at for the first time: the server lists it
 * as not installed with a warning and auth still unknown until its first probe answers. A provider
 * set up by the app (managed Codex) stays a warning after the probe, unauthenticated, so the warning
 * alone would wait forever. A message to a new thread waits for the probe instead of giving up.
 */
export const providersPending = (config: ServerConfig | null): boolean =>
  (config?.providers ?? []).some(
    (provider) =>
      provider.enabled &&
      !provider.installed &&
      provider.status === "warning" &&
      provider.auth.status === "unknown" &&
      provider.availability !== "unavailable",
  );

/**
 * Why `availableModels` is empty, in a few words: each provider that is on but cannot run says what
 * is missing (its program is not installed, the server marks it unavailable, it lists no model).
 * Empty when a model is available.
 */
export const noModelCause = (config: ServerConfig | null): string => {
  if (config === null) return t("session.noModel.noConfig");
  if (availableModels(config).length > 0) return "";
  const on = config.providers.filter((provider) => provider.enabled);
  if (on.length === 0) return t("session.noModel.noProvider");
  const reasons = on.map((provider) => {
    const name = provider.displayName ?? provider.instanceId;
    if (!provider.installed) return t("session.noModel.notInstalled", { name });
    if (provider.availability === "unavailable") return t("session.noModel.unavailable", { name });
    return t("session.noModel.noModels", { name });
  });
  return reasons.length <= 3
    ? reasons.join(", ")
    : t("session.noModel.more", {
        list: reasons.slice(0, 3).join(", "),
        count: reasons.length - 3,
      });
};

/** What to tell a user who cannot send because no model can run, and where to go from here. */
export const noModelNotice = (config: ServerConfig | null): string =>
  t("session.noModel.notice", { cause: noModelCause(config) });

/**
 * Models a thread that has already run may switch to: the same provider driver (and continuation
 * group, when the provider names one), as in the desktop app. A provider that cannot change model in
 * place keeps only the model the thread already uses.
 */
export const compatibleModels = (
  config: ServerConfig | null,
  current: { readonly instanceId: string; readonly model: string },
): ReadonlyArray<ModelChoice> => {
  const providers = config?.providers ?? [];
  const home = providers.find((provider) => provider.instanceId === current.instanceId);
  if (home === undefined) return [];
  const group = home.continuation?.groupKey;
  const sticky = home.requiresNewThreadForModelChange === true;
  return availableModels(config).filter((choice) => {
    const provider = providers.find((candidate) => candidate.instanceId === choice.instanceId);
    if (provider === undefined || provider.driver !== home.driver) return false;
    if (group !== undefined && provider.continuation?.groupKey !== group) return false;
    return !sticky || (choice.instanceId === current.instanceId && choice.model === current.model);
  });
};

export const modelSelectionOf = (choice: {
  instanceId: string;
  model: string;
}): ModelSelection => ({
  instanceId: ProviderInstanceId.make(choice.instanceId),
  model: choice.model,
});

/** What a brand-new thread runs on: the project's default, else the first provider's default model. */
export const defaultModelSelection = (
  project: OrchestrationProjectShell | undefined,
  config: ServerConfig | null,
): ModelSelection | null => {
  if (project?.defaultModelSelection) return project.defaultModelSelection;
  for (const provider of config?.providers ?? []) {
    if (!provider.enabled || !provider.installed || provider.availability === "unavailable")
      continue;
    const model =
      provider.models.find((candidate) => candidate.isDefault === true) ?? provider.models[0];
    if (model) return modelSelectionOf({ instanceId: provider.instanceId, model: model.slug });
  }
  return null;
};

export const newThreadId = (context: CommandContext): ThreadId => ThreadId.make(context.uuid());

export const turnStartCommand = (
  context: CommandContext,
  input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly modelSelection?: ModelSelection;
    /** The words the title is made from, when they are not `text` (which may carry an effort prefix). */
    readonly titleText?: string;
    /** The proposed plan this turn builds; the server marks it as built. */
    readonly sourceProposedPlan?: {
      readonly threadId: ThreadId;
      readonly planId: OrchestrationProposedPlanId;
    };
    /** Present only for the first message of a new thread. */
    readonly create?: {
      readonly projectId: ProjectId;
      readonly modelSelection: ModelSelection;
    };
  },
): ClientOrchestrationCommand => {
  const { commandId, createdAt } = stamp(context);
  const interactionMode = input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
  return {
    type: "thread.turn.start",
    commandId,
    threadId: input.threadId,
    message: {
      messageId: MessageId.make(context.uuid()),
      role: "user",
      text: input.text,
      attachments: [],
    },
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    runtimeMode: input.runtimeMode,
    interactionMode,
    ...(input.sourceProposedPlan ? { sourceProposedPlan: input.sourceProposedPlan } : {}),
    ...(input.create
      ? {
          titleSeed: titleFromMessage(input.titleText ?? input.text),
          bootstrap: {
            createThread: {
              projectId: input.create.projectId,
              title: titleFromMessage(input.titleText ?? input.text),
              modelSelection: input.create.modelSelection,
              runtimeMode: input.runtimeMode,
              interactionMode,
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
        }
      : {}),
    createdAt,
  };
};

/** The same command for a thread that now exists, so a resend does not try to create it again. */
export const withoutBootstrap = (
  command: ClientOrchestrationCommand,
): ClientOrchestrationCommand => {
  if (command.type !== "thread.turn.start") return command;
  const { bootstrap: _bootstrap, titleSeed: _titleSeed, ...rest } = command;
  return rest;
};

/** Changes the permission mode of a thread that exists; a turn start does not (it is ignored there). */
export const runtimeModeCommand = (
  context: CommandContext,
  input: { readonly threadId: ThreadId; readonly runtimeMode: RuntimeMode },
): ClientOrchestrationCommand => ({
  type: "thread.runtime-mode.set",
  threadId: input.threadId,
  runtimeMode: input.runtimeMode,
  ...stamp(context),
});

export const interactionModeCommand = (
  context: CommandContext,
  input: { readonly threadId: ThreadId; readonly interactionMode: ProviderInteractionMode },
): ClientOrchestrationCommand => ({
  type: "thread.interaction-mode.set",
  threadId: input.threadId,
  interactionMode: input.interactionMode,
  ...stamp(context),
});

export const interruptCommand = (
  context: CommandContext,
  threadId: ThreadId,
): ClientOrchestrationCommand => ({
  type: "thread.turn.interrupt",
  threadId,
  ...stamp(context),
});

/** Pins a thread; `orderKey` puts it at a place in the pinned block, none leaves it after the arranged ones. */
export const pinCommand = (
  context: CommandContext,
  input: { readonly threadId: ThreadId; readonly orderKey?: string | undefined },
): ClientOrchestrationCommand => ({
  type: "thread.pin",
  threadId: input.threadId,
  ...(input.orderKey === undefined ? {} : { orderKey: input.orderKey }),
  commandId: CommandId.make(context.uuid()),
});

export const unpinCommand = (
  context: CommandContext,
  threadId: ThreadId,
): ClientOrchestrationCommand => ({
  type: "thread.unpin",
  threadId,
  commandId: CommandId.make(context.uuid()),
});

/**
 * Rewinds a thread to the state after `turnCount` turns. With `restoreFiles` the folder goes back to
 * that checkpoint too; without it only the conversation does (the desktop app's "keep changes").
 */
export const revertCommand = (
  context: CommandContext,
  input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly restoreFiles: boolean;
  },
): ClientOrchestrationCommand => ({
  type: input.restoreFiles ? "thread.checkpoint.revert" : "thread.conversation.revert",
  threadId: input.threadId,
  turnCount: input.turnCount,
  ...stamp(context),
});

export const approvalCommand = (
  context: CommandContext,
  input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly decision: ProviderApprovalDecision;
  },
): ClientOrchestrationCommand => ({
  type: "thread.approval.respond",
  threadId: input.threadId,
  requestId: ApprovalRequestId.make(input.requestId),
  decision: input.decision,
  ...stamp(context),
});

export const userInputCommand = (
  context: CommandContext,
  input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly answers: Record<string, string | ReadonlyArray<string>>;
  },
): ClientOrchestrationCommand => ({
  type: "thread.user-input.respond",
  threadId: input.threadId,
  requestId: ApprovalRequestId.make(input.requestId),
  answers: input.answers,
  ...stamp(context),
});

export const dismissUserInputCommand = (
  context: CommandContext,
  input: { readonly threadId: ThreadId; readonly requestId: string },
): ClientOrchestrationCommand => ({
  type: "thread.user-input.dismiss",
  threadId: input.threadId,
  requestId: ApprovalRequestId.make(input.requestId),
  ...stamp(context),
});
