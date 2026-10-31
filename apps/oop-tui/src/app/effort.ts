import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerConfig,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

export interface EffortChoice {
  /** The server's id for the value (`low`, `high`, `ultrathink`, ...); this is what is typed and sent. */
  readonly value: string;
  readonly label: string;
}

/** The reasoning-effort control a model offers, as the desktop app's traits menu reads it. */
export interface EffortControl {
  readonly descriptorId: string;
  readonly choices: ReadonlyArray<EffortChoice>;
  /** Values the agent receives in the prompt (`ultrathink`) instead of as an option. */
  readonly promptInjected: ReadonlyArray<string>;
}

/** Option ids a model selection may carry its effort under when the server gave no descriptor. */
const EFFORT_OPTION_IDS = ["effort", "reasoningEffort", "reasoning", "variant"] as const;

/** The effort a model selection carries, read from its options alone ("high", "max"). */
export const reasoningEffortOf = (selection: ModelSelection | null | undefined): string | null => {
  const options: unknown = selection?.options;
  if (!Array.isArray(options)) return null;
  for (const id of EFFORT_OPTION_IDS) {
    for (const option of options as ReadonlyArray<{
      readonly id?: unknown;
      readonly value?: unknown;
    }>) {
      if (option?.id === id && typeof option.value === "string") return option.value;
    }
  }
  return null;
};

const modelOf = (
  config: ServerConfig | null,
  selection: { readonly instanceId: string; readonly model: string },
): { readonly driver: string; readonly model: ServerProviderModel | undefined } | null => {
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  if (provider === undefined) return null;
  return {
    driver: provider.driver,
    model: provider.models.find(
      (candidate) =>
        candidate.slug === selection.model || (candidate.aliases ?? []).includes(selection.model),
    ),
  };
};

/** The first select option of the model, which is its reasoning effort (or Antigravity's variant). */
const primaryDescriptor = (
  config: ServerConfig | null,
  selection: ModelSelection,
  picked?: ProviderOptionSelection,
): SelectDescriptor | null => {
  const caps = modelOf(config, selection)?.model?.capabilities;
  if (!caps) return null;
  const first = getProviderOptionDescriptors({ caps }).find(
    (descriptor): descriptor is SelectDescriptor => descriptor.type === "select",
  );
  if (first === undefined) return null;
  // The pick replaces the selection's own value for the same option.
  const selections = picked
    ? [...(selection.options ?? []).filter((option) => option.id !== first.id), picked]
    : selection.options;
  return (
    getProviderOptionDescriptors({ caps, selections }).find(
      (descriptor): descriptor is SelectDescriptor =>
        descriptor.type === "select" && descriptor.id === first.id,
    ) ?? null
  );
};

/** What `/effort` can offer for the model; null when it has no effort control. */
export const effortControl = (
  config: ServerConfig | null,
  selection: ModelSelection,
): EffortControl | null => {
  const descriptor = primaryDescriptor(config, selection);
  if (descriptor === null || descriptor.options.length === 0) return null;
  return {
    descriptorId: descriptor.id,
    choices: descriptor.options.map((option) => ({ value: option.id, label: option.label })),
    promptInjected: descriptor.promptInjectedValues ?? [],
  };
};

export interface ResolvedEffort {
  /** The selection a turn sends: the model, with the effort that is shown as an option. */
  readonly selection: ModelSelection;
  /** A value the agent is told in the prompt, such as `ultrathink`; null when none. */
  readonly promptEffort: string | null;
  /** What the status bar shows; null when the model has no effort and its options name none. */
  readonly shown: string | null;
}

/**
 * The model selection with its effort settled: `pick` (from `/effort`) wins over the selection's
 * own value, which wins over the server's default. What is shown is what is sent, as in the
 * desktop app, which always sends the displayed options. A model without an effort control is
 * sent as it is.
 */
export const resolveEffort = (
  config: ServerConfig | null,
  selection: ModelSelection,
  pick: string | null,
): ResolvedEffort => {
  const control = effortControl(config, selection);
  if (control === null) {
    return { selection, promptEffort: null, shown: reasoningEffortOf(selection) };
  }
  const valid = pick !== null && control.choices.some((choice) => choice.value === pick);
  const picked = valid ? { id: control.descriptorId, value: pick } : undefined;
  const descriptor = primaryDescriptor(config, selection, picked);
  const value = descriptor ? getProviderOptionCurrentValue(descriptor) : undefined;
  const promptEffort = valid && control.promptInjected.includes(pick) ? pick : null;
  if (typeof value !== "string") return { selection, promptEffort, shown: promptEffort };
  const options = [
    ...(selection.options ?? []).filter((option) => option.id !== control.descriptorId),
    { id: control.descriptorId, value },
  ];
  return {
    selection: { ...selection, options } as ModelSelection,
    promptEffort,
    shown: promptEffort ?? value,
  };
};

/** The pick still means something for `selection`: its value is one of the model's effort values. */
export const effortStillValid = (
  config: ServerConfig | null,
  selection: ModelSelection,
  pick: string,
): boolean =>
  effortControl(config, selection)?.choices.some((choice) => choice.value === pick) === true;

/** Why `/effort` has nothing to offer for the model, as a sentence for the user. */
export const noEffortReason = (
  config: ServerConfig | null,
  selection: { readonly instanceId: string; readonly model: string },
): string => {
  const found = modelOf(config, selection);
  if (found === null || found.model === undefined) {
    return "서버 목록에 없는 모델이라 리저닝 강도를 알 수 없습니다.";
  }
  if (found.driver === "antigravity") {
    return "Antigravity는 모델 이름이 곧 강도입니다. /model 에서 고르세요.";
  }
  return "이 모델은 리저닝 강도를 바꿀 수 없습니다.";
};

/** The message text with the effort the agent reads from its prompt (`Ultrathink:`), when one was picked. */
export const withPromptEffort = (text: string, promptEffort: string | null): string =>
  applyClaudePromptEffortPrefix(text, promptEffort);
