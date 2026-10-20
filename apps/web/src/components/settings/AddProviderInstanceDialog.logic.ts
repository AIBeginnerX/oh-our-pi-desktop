import {
  createPresetProviderInstance,
  type ProviderPresetId,
  type ProviderPresetService,
} from "@t3tools/client-runtime/provider-presets";
import { type ProviderDriverKind, type ProviderInstanceConfig } from "@t3tools/contracts";

export interface PresetFormDraft {
  readonly apiKey: string;
  readonly service: ProviderPresetService;
  readonly model: string;
  readonly binaryPath: string;
}

/** Builds either a standard driver instance or an OpenCode-backed service preset. */
export function createProviderInstanceFromWizard(input: {
  readonly driver: ProviderDriverKind;
  readonly presetId: ProviderPresetId | null;
  readonly presetDraft: PresetFormDraft | null;
  readonly label: string;
  readonly accentColor: string | undefined;
  readonly configDraft: Record<string, unknown>;
}): ProviderInstanceConfig {
  const displayName = input.label.trim();
  if (input.presetId !== null) {
    if (!input.presetDraft) throw new Error("Preset settings are required.");
    return {
      ...createPresetProviderInstance({
        presetId: input.presetId,
        service: input.presetDraft.service,
        apiKey: input.presetDraft.apiKey,
        ...(input.presetDraft.model.trim() ? { model: input.presetDraft.model.trim() } : {}),
        ...(input.presetDraft.binaryPath.trim()
          ? { binaryPath: input.presetDraft.binaryPath.trim() }
          : {}),
      }),
      ...(displayName ? { displayName } : {}),
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    };
  }
  const config =
    input.driver === "codex" ? { ...input.configDraft, setupMode: "existing" } : input.configDraft;
  return {
    driver: input.driver,
    enabled: true,
    ...(displayName ? { displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(Object.keys(config).length ? { config } : {}),
  };
}

export type WizardNavigation =
  | { readonly kind: "navigate"; readonly step: number }
  | { readonly kind: "blocked"; readonly step: number; readonly error: string };

const IDENTITY_STEP = 1;

export const ADD_PROVIDER_WIZARD_STEPS = ["Driver", "Identity", "Config"] as const;

/**
 * Resolve navigation within the add-provider wizard.
 *
 * Moving forward past Identity requires a valid instance id, whether the user
 * advances one step at a time or skips directly to Config from a step header.
 * A blocked skip lands on Identity so its existing inline validation is
 * visible. Backward navigation is always preserved.
 */
export function resolveWizardNavigation(
  currentStep: number,
  requestedStep: number,
  stepCount: number,
  validation: { readonly instanceIdError: string | null },
): WizardNavigation {
  const lastStep = Math.max(0, stepCount - 1);
  const targetStep = Math.max(0, Math.min(lastStep, requestedStep));
  const movesForwardPastIdentity = currentStep <= IDENTITY_STEP && targetStep > IDENTITY_STEP;

  if (movesForwardPastIdentity && validation.instanceIdError !== null) {
    return {
      kind: "blocked",
      step: Math.min(IDENTITY_STEP, lastStep),
      error: validation.instanceIdError,
    };
  }

  return { kind: "navigate", step: targetStep };
}
