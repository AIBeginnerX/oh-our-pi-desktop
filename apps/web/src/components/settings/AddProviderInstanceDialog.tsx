"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { PROVIDER_PRESETS, type ProviderPresetId } from "@t3tools/client-runtime/provider-presets";
import { ProviderInstanceId, ProviderDriverKind, type EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Button } from "../ui/button";
import { ChatGptConnectionButton } from "./ChatGptConnectionButton";
import { ACPRegistryIcon, Gemini, GithubCopilotIcon, PiAgentIcon, type Icon } from "../Icons";
import { Dialog } from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { WizardPanel, WizardPopup, WizardHeader, WizardFooter } from "../ui/wizard";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  createProviderInstanceFromWizard,
  resolveWizardNavigation,
  type PresetFormDraft,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { AddManagedCodexAccountDialog } from "./CodexSetupSection";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

/**
 * Normalize a user-provided label into a slug suffix for the instance id.
 * The full id is formed by prefixing the driver slug — e.g. label "Work" on
 * driver "codex" becomes `codex_work`. Output is trimmed to 48 chars so the
 * final composed id stays under the 64-char slug cap enforced by
 * `ProviderInstanceId` in `@t3tools/contracts`.
 */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function deriveInstanceId(driver: ProviderDriverKind, label: string): string {
  const slug = slugifyLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const DEFAULT_DRIVER_OPTION = DRIVER_OPTIONS[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
const PRESET_IDS = ["zai", "minimax"] as const satisfies readonly ProviderPresetId[];

function isProviderPresetId(value: string): value is ProviderPresetId {
  return value === "zai" || value === "minimax";
}

function initialPresetDraft(presetId: ProviderPresetId): PresetFormDraft {
  const preset = PROVIDER_PRESETS[presetId];
  const service = preset.services.find((entry) => entry.value === preset.defaultService)!;
  return {
    apiKey: "",
    service: preset.defaultService,
    model: service.defaultModel,
    binaryPath: "",
  };
}
interface ComingSoonDriverOption {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
}

const COMING_SOON_DRIVER_OPTIONS: readonly ComingSoonDriverOption[] = [
  {
    value: ProviderDriverKind.make("githubCopilot"),
    label: "Github Copilot",
    icon: GithubCopilotIcon,
  },
  {
    value: ProviderDriverKind.make("gemini"),
    label: "Gemini",
    icon: Gemini,
  },
  {
    value: ProviderDriverKind.make("acpRegistry"),
    label: "ACP Registry",
    icon: ACPRegistryIcon,
  },
  {
    value: ProviderDriverKind.make("piAgent"),
    label: "Pi Agent",
    icon: PiAgentIcon,
  },
];

/**
 * Validate an instance id against the same slug rules the server applies in
 * `ProviderInstanceId` (see `packages/contracts/src/providerInstance.ts`).
 * Returns a user-facing error string, or `null` if valid.
 */
function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  onOpenChange,
}: AddProviderInstanceDialogProps) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  const [wizardStep, setWizardStep] = useState(0);
  const [addingChatGptAccount, setAddingChatGptAccount] = useState(false);
  const [selection, setSelection] = useState<string>(DEFAULT_DRIVER_KIND);
  const [label, setLabel] = useState("");
  const [accentColor, setAccentColor] = useState<string>("");
  const [instanceIdOverride, setInstanceIdOverride] = useState<string | null>(null);
  // Driver-specific config drafts keyed by driver so toggling between drivers
  // during the same dialog session does not lose in-progress input.
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  const [presetDrafts, setPresetDrafts] = useState<
    Partial<Record<ProviderPresetId, PresetFormDraft>>
  >({});
  const [presetValidationError, setPresetValidationError] = useState<string | null>(null);
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const presetId = isProviderPresetId(selection) ? selection : null;
  const preset = presetId ? PROVIDER_PRESETS[presetId] : null;
  const driver = presetId
    ? ProviderDriverKind.make("opencode")
    : ProviderDriverKind.make(selection);
  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
  const presetDraft = presetId ? (presetDrafts[presetId] ?? initialPresetDraft(presetId)) : null;
  const updatePresetDraft = (patch: Partial<PresetFormDraft>) => {
    if (!presetId) return;
    setPresetValidationError(null);
    setPresetDrafts((existing) => ({
      ...existing,
      [presetId]: { ...(existing[presetId] ?? initialPresetDraft(presetId)), ...patch },
    }));
  };
  const instanceId =
    instanceIdOverride ??
    (preset && label.trim().length === 0
      ? preset.suggestedInstanceId
      : deriveInstanceId(driver, label));
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const previewLabel = label.trim() || (preset?.label ?? `${driverOption.label} Workspace`);
  const wizardStepSummaries = [preset?.label ?? driverOption.label, previewLabel, null] as const;

  const configDraft = configByDriver[selection] ?? EMPTY_CONFIG_DRAFT;
  const setConfigDraft = (config: Record<string, unknown> | undefined) => {
    setConfigByDriver((existing) => {
      const next = { ...existing };
      if (config === undefined || Object.keys(config).length === 0) {
        delete next[selection];
      } else {
        next[selection] = config;
      }
      return next;
    });
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    setWizardStep(navigation.step);
  };

  const navigateToStep = (requestedStep: number) => {
    applyWizardNavigation(
      resolveWizardNavigation(wizardStep, requestedStep, ADD_PROVIDER_WIZARD_STEPS.length, {
        instanceIdError,
      }),
    );
  };

  const handleSave = () => {
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null) return;
    if (presetId && !presetDraft?.apiKey.trim()) return;

    try {
      const nextInstance = createProviderInstanceFromWizard({
        driver,
        presetId,
        presetDraft,
        label,
        accentColor: normalizeProviderAccentColor(accentColor),
        configDraft: configByDriver[selection] ?? EMPTY_CONFIG_DRAFT,
      });
      // Keep the branded routing key consistent with the server's slug rules.
      const brandedId = ProviderInstanceId.make(instanceId);
      const nextMap = {
        ...settings.providerInstances,
        [brandedId]: nextInstance,
      };
      updateSettings({ providerInstances: nextMap });
      setPresetValidationError(null);
      toastManager.add({
        type: "success",
        title: "Provider instance added",
        description: `${preset?.label ?? driverOption.label} instance '${instanceId}' was added.`,
      });
      onOpenChange(false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Update failed.";
      if (presetId) setPresetValidationError(detail);
      toastManager.add({
        type: "error",
        title: "Could not add provider instance",
        description: detail,
      });
    }
  };

  if (addingChatGptAccount) {
    return (
      <AddManagedCodexAccountDialog
        environmentId={environmentId}
        onClose={() => onOpenChange(false)}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WizardPopup size="wide">
        <WizardHeader
          title="Add provider instance"
          description={<>Add an account or configure a provider on {environmentLabel}.</>}
        >
          <AddProviderInstanceWizardSteps
            currentStep={wizardStep}
            summaries={wizardStepSummaries}
            instanceIdError={instanceIdError}
            onNavigation={applyWizardNavigation}
          />
        </WizardHeader>

        <WizardPanel>
          <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
            <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
              Driver
            </div>
            <RadioGroup
              value={selection}
              onValueChange={setSelection}
              aria-labelledby="add-instance-driver-label"
              className="grid grid-cols-1 sm:grid-cols-2"
            >
              {DRIVER_OPTIONS.map((option) => {
                const IconComponent = option.icon;
                return (
                  <RadioPrimitive.Root
                    key={option.value}
                    value={option.value}
                    className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
                  >
                    <IconComponent className="size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {option.label}
                    </span>
                    <RadioPrimitive.Indicator
                      className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                      aria-hidden
                    >
                      <CheckIcon className="size-3.5 shrink-0" />
                    </RadioPrimitive.Indicator>
                    {option.badgeLabel ? (
                      <Badge variant="warning" size="sm">
                        {option.badgeLabel}
                      </Badge>
                    ) : null}
                  </RadioPrimitive.Root>
                );
              })}
              {PRESET_IDS.map((id) => {
                const option = PROVIDER_PRESETS[id];
                return (
                  <RadioPrimitive.Root
                    key={id}
                    value={id}
                    className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
                  >
                    <span
                      className="grid size-4 shrink-0 place-items-center text-xs font-bold"
                      aria-hidden
                    >
                      {id === "zai" ? "Z" : "M"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {option.label}
                      </span>
                      <span className="block text-2xs text-muted-foreground">
                        {option.subtitle}
                      </span>
                    </span>
                    <RadioPrimitive.Indicator
                      className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                      aria-hidden
                    >
                      <CheckIcon className="size-3.5 shrink-0" />
                    </RadioPrimitive.Indicator>
                  </RadioPrimitive.Root>
                );
              })}
              {COMING_SOON_DRIVER_OPTIONS.map((option) => {
                const IconComponent = option.icon;
                return (
                  <RadioPrimitive.Root
                    key={option.value}
                    value={option.value}
                    disabled
                    className={cn(
                      "relative flex cursor-not-allowed items-center gap-3 rounded-lg bg-card/60 px-3 py-3 text-left opacity-64 outline-none ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5",
                    )}
                  >
                    <IconComponent className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {option.label}
                    </span>
                    <Badge variant="warning" size="sm">
                      Coming Soon
                    </Badge>
                  </RadioPrimitive.Root>
                );
              })}
            </RadioGroup>
          </div>

          <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
            <span className="text-xs font-medium text-foreground">Label</span>
            <Input
              placeholder="e.g. Work"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <span className="text-2xs text-muted-foreground">
              Shown in the provider list. Optional.
            </span>
          </label>

          <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
            <span className="text-xs font-medium text-foreground">Instance ID</span>
            <Input
              placeholder={preset?.suggestedInstanceId ?? `${driver}_work`}
              value={instanceId}
              onChange={(event) => {
                setInstanceIdOverride(event.target.value);
              }}
              aria-invalid={showInstanceIdError}
            />
            {showInstanceIdError ? (
              <span className="text-2xs text-destructive">{instanceIdError}</span>
            ) : (
              <span className="text-2xs text-muted-foreground">
                Routing key used by threads and sessions. Letters, digits, '-', or '_'.
              </span>
            )}
          </label>

          <div className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
            <span className="text-xs font-medium text-foreground">Accent color</span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ProviderAccentColorPicker
                displayName={label || preset?.label || driverOption.label}
                value={accentColor || undefined}
                onCommit={setAccentColor}
                layout="inline"
              />
              <div className="flex flex-wrap gap-1.5">
                {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
                  const selected = accentColor.toLowerCase() === swatch;
                  return (
                    <button
                      key={swatch}
                      type="button"
                      className={cn(
                        "size-6 cursor-pointer rounded-full border transition",
                        selected
                          ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                          : "border-black/10 hover:scale-105 dark:border-white/20",
                      )}
                      style={{ backgroundColor: swatch }}
                      onClick={() => setAccentColor(swatch)}
                      aria-label={`Use ${swatch} accent`}
                    />
                  );
                })}
              </div>
              {accentColor ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => setAccentColor("")}
                >
                  Clear
                </Button>
              ) : null}
            </div>
            <span className="text-2xs text-muted-foreground">
              Optional marker shown in the picker.
            </span>
          </div>

          {preset && presetDraft ? (
            <div className={cn("grid gap-4", wizardStep !== 2 && "hidden")}>
              <p className="text-xs text-muted-foreground">
                {preset.label} runs through OpenCode 1.14.19 or newer on {environmentLabel}. Install
                it there first; the API key is stored as a sensitive variable for this instance.
              </p>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">API key</span>
                <Input
                  type="password"
                  autoComplete="off"
                  value={presetDraft.apiKey}
                  onChange={(event) => updatePresetDraft({ apiKey: event.target.value })}
                  aria-invalid={hasAttemptedSubmit && !presetDraft.apiKey.trim()}
                  spellCheck={false}
                />
                {hasAttemptedSubmit && !presetDraft.apiKey.trim() ? (
                  <span className="text-2xs text-destructive">API key is required.</span>
                ) : null}
              </label>
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Service</span>
                <Select
                  value={presetDraft.service}
                  onValueChange={(value) => {
                    if (value !== "api" && value !== "coding") return;
                    const previousDefault = preset.services.find(
                      (entry) => entry.value === presetDraft.service,
                    )?.defaultModel;
                    const nextDefault =
                      preset.services.find((entry) => entry.value === value)?.defaultModel ?? "";
                    updatePresetDraft({
                      service: value,
                      ...(presetDraft.model === previousDefault ? { model: nextDefault } : {}),
                    });
                  }}
                >
                  <SelectTrigger size="sm" className="w-full" aria-label="Service">
                    <SelectValue>
                      {preset.services.find((entry) => entry.value === presetDraft.service)?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {preset.services.map((service) => (
                      <SelectItem key={service.value} value={service.value}>
                        {service.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <span className="text-2xs text-muted-foreground">
                  {presetDraft.service === "api"
                    ? "General API usage is billed through the provider's API account."
                    : presetId === "minimax"
                      ? "Token Plan (M Plan) uses a subscription key; some preview models are available only on this plan."
                      : "Coding Plan uses its subscription key and coding-plan endpoint."}
                </span>
              </div>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Model</span>
                <Input
                  value={presetDraft.model}
                  onChange={(event) => updatePresetDraft({ model: event.target.value })}
                  spellCheck={false}
                />
                <span className="text-2xs text-muted-foreground">
                  You can change this to a model available to your account.
                </span>
                {presetValidationError ? (
                  <span className="text-2xs text-destructive">{presetValidationError}</span>
                ) : null}
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">OpenCode binary path</span>
                <Input
                  value={presetDraft.binaryPath}
                  onChange={(event) => updatePresetDraft({ binaryPath: event.target.value })}
                  placeholder="opencode"
                  spellCheck={false}
                />
                <span className="text-2xs text-muted-foreground">
                  Advanced; leave blank when OpenCode is on PATH.
                </span>
              </label>
            </div>
          ) : driverSettingsFields.length > 0 ? (
            <div className={cn("grid gap-4", wizardStep !== 2 && "hidden")}>
              <ProviderSettingsForm
                definition={driverOption}
                value={configDraft}
                idPrefix={`add-provider-${driver}`}
                variant="dialog"
                onChange={setConfigDraft}
              />
            </div>
          ) : wizardStep === 2 ? (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">
                This driver has no required configuration. You can add the instance now.
              </p>
            </div>
          ) : null}
        </WizardPanel>

        <WizardFooter>
          <Button
            variant={wizardStep === 0 ? "ghost-muted" : "outline"}
            onClick={() => {
              if (wizardStep === 0) {
                onOpenChange(false);
                return;
              }
              setWizardStep((step) => Math.max(0, step - 1));
            }}
          >
            {wizardStep === 0 ? "Cancel" : "Back"}
          </Button>
          {wizardStep === 0 && driver === "codex" ? (
            <>
              <Button variant="outline" onClick={() => navigateToStep(1)}>
                Configure manually
              </Button>
              <ChatGptConnectionButton onClick={() => setAddingChatGptAccount(true)} />
            </>
          ) : wizardStep < ADD_PROVIDER_WIZARD_STEPS.length - 1 ? (
            <Button onClick={() => navigateToStep(wizardStep + 1)}>Next</Button>
          ) : (
            <Button onClick={handleSave}>Add instance</Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
