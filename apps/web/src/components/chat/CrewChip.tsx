import {
  CREW_ROLES,
  type CrewPreset,
  type CrewRole,
  type CrewThreadOverride,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  applyCrewChange,
  crewAsDefault,
  crewModelOptions,
  recommendCrew,
  resolveCrew,
  type CrewChange,
  type CrewModelOption,
} from "@t3tools/shared/crew";
import { CheckIcon, SparklesIcon, UsersRoundIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SelectButton } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { crewLeadAvailability } from "./CrewChip.logic";

const PRESETS: ReadonlyArray<{ value: CrewPreset; label: string; hint: string }> = [
  { value: "recommended", label: "OOP pick", hint: "Balanced team chosen by OOP" },
  { value: "speed", label: "Speed", hint: "Fast models everywhere" },
  { value: "quality", label: "Quality", hint: "Strongest models for hard work" },
  { value: "budget", label: "Budget", hint: "Cheapest models that can do it" },
];

const ROLE_COPY: Record<CrewRole, { label: string; hint: string }> = {
  worker: { label: "Worker", hint: "Searches, edits, tests" },
  expert: { label: "Expert", hint: "Hard implementation" },
  auditor: { label: "Auditor", hint: "Reviews changed files" },
};

const TIER_MARK = { 1: "fast", 2: "balanced", 3: "strong" } as const;
const AUTO = "auto";

const keyOf = (selection: ModelSelection) => `${selection.instanceId}\u0000${selection.model}`;

/**
 * The crew for this chat at a glance, and the place to change it: one click for a preset, one
 * more for any single role. A change belongs to this chat alone (a chat not yet started keeps it
 * until its first message); only "Use this crew for new chats" edits the default every other chat
 * falls back to, and "Use the default crew" hands this chat back to it.
 */
export function CrewChip(props: {
  readonly environmentId: EnvironmentId;
  readonly target: ComposerThreadTarget;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly brain: ModelSelection;
  readonly disabled?: boolean;
}) {
  const defaults = useEnvironmentSettings(props.environmentId, (value) => value.crew);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const setThreadCrew = useAtomCommand(threadEnvironment.setCrew, "thread crew set");
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  // A chat exists on the server once it has a shell; until then its crew waits in the draft.
  const shell = useThreadShell(typeof props.target === "string" ? null : props.target);
  const draftCrew = useComposerDraftStore((store) =>
    typeof props.target === "string"
      ? store.getDraftSession(props.target)?.crew
      : store.getDraftSessionByRef(props.target)?.crew,
  );
  const ownCrew: CrewThreadOverride | null | undefined = shell === null ? draftCrew : shell.crew;
  const options = useMemo(() => crewModelOptions(props.providers), [props.providers]);
  const crew = useMemo(
    () =>
      resolveCrew({
        settings: defaults,
        override: ownCrew,
        providers: props.providers,
        brain: props.brain,
      }),
    [defaults, ownCrew, props.providers, props.brain],
  );
  const autoPicks = useMemo(
    () => recommendCrew(options, props.brain, crew.preset),
    [options, props.brain, crew.preset],
  );

  /** Stores the chat's complete next crew; null hands the chat back to the default. */
  const setOwnCrew = (next: CrewThreadOverride | null) => {
    if (shell !== null && typeof props.target !== "string") {
      void setThreadCrew({
        environmentId: props.environmentId,
        input: { threadId: props.target.threadId, crew: next },
      });
      return;
    }
    setDraftThreadContext(props.target, { crew: next });
  };
  const write = (change: CrewChange) => setOwnCrew(applyCrewChange(ownCrew, change));

  const makeDefault = () => updateSettings({ crew: crewAsDefault(defaults, crew) });

  // Only a Claude or Codex model can lead; the server decides, and a chat on another provider
  // gets a chip that says why instead of a crew that would never be told about its tools.
  const lead = crewLeadAvailability(props.providers, props.brain);
  if (!lead.canLead) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="inline-flex shrink-0 cursor-not-allowed" tabIndex={0} />}
        >
          <ComposerControl disabled aria-label={`OOP Crew unavailable: ${lead.reason}`}>
            <ComposerControlIcon icon={UsersRoundIcon} />
            <span className="text-xs text-muted-foreground">Crew</span>
          </ComposerControl>
        </TooltipTrigger>
        <TooltipPopup side="top">{lead.reason}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        disabled={props.disabled}
        render={
          <ComposerControl
            aria-label={crew.enabled ? "OOP Crew on, change crew" : "OOP Crew off, set up crew"}
            className="shrink-0"
          />
        }
      >
        <ComposerControlIcon icon={UsersRoundIcon} />
        <span className={cn("text-xs", crew.enabled ? "text-foreground" : "text-muted-foreground")}>
          Crew
        </span>
        {crew.enabled ? (
          <span className="flex items-center gap-0.5" aria-hidden>
            {CREW_ROLES.map((role) => (
              <span
                key={role}
                className={cn(
                  "flex size-4 items-center justify-center rounded-full border text-2xs leading-none",
                  crew.roles[role] === null
                    ? "border-dashed border-muted-foreground/50 text-muted-foreground"
                    : "border-primary/50 bg-primary/10 text-foreground",
                )}
              >
                {ROLE_COPY[role].label.slice(0, 1)}
              </span>
            ))}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <PopoverTitle>OOP Crew</PopoverTitle>
              <div className="text-xs text-muted-foreground">
                This chat's model leads; the crew takes the work it hands out.
              </div>
              <div className="text-2xs text-muted-foreground">
                {crew.source === "thread"
                  ? "This chat has its own crew."
                  : "Using the default crew. A change here applies to this chat only."}
              </div>
            </div>
            <Switch
              checked={crew.enabled}
              onCheckedChange={(checked) => write({ enabled: checked })}
              aria-label="Use OOP Crew"
            />
          </div>

          <div className="grid grid-cols-4 gap-1">
            {PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                aria-pressed={crew.preset === preset.value}
                aria-label={`${preset.label}: ${preset.hint}`}
                onClick={() => write({ preset: preset.value })}
                className={cn(
                  "rounded-md border px-1.5 py-1 text-2xs transition-colors",
                  crew.preset === preset.value
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border/70 text-muted-foreground hover:text-foreground",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium">Roles</span>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={crew.pinned.size === 0}
                onClick={() => write({ pins: { worker: null, expert: null, auditor: null } })}
              >
                <SparklesIcon />
                Auto all
              </Button>
            </div>
            <div className="text-2xs text-muted-foreground">
              A change applies to work handed out from now on, even in a running turn. Tasks already
              running keep the model they started with.
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium">Brain</span>
              <span className="truncate text-muted-foreground">this chat's model</span>
            </div>
            {CREW_ROLES.map((role) => (
              <CrewRoleRow
                key={role}
                role={role}
                options={options}
                current={crew.roles[role]}
                autoPick={autoPicks[role]}
                pinned={crew.pinned.has(role)}
                onChange={(selection) => write({ pins: { [role]: selection } })}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {crew.source === "thread" ? (
              <button
                type="button"
                onClick={() => setOwnCrew(null)}
                className="text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Use the default crew
              </button>
            ) : null}
            <button
              type="button"
              onClick={makeDefault}
              className="text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Use this crew for new chats
            </button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function CrewRoleRow(props: {
  readonly role: CrewRole;
  readonly options: ReadonlyArray<CrewModelOption>;
  readonly current: CrewModelOption | null;
  readonly autoPick: CrewModelOption | null;
  readonly pinned: boolean;
  readonly onChange: (selection: ModelSelection | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const value = props.pinned && props.current !== null ? keyOf(props.current.selection) : AUTO;
  const byKey = useMemo(
    () => new Map(props.options.map((option) => [keyOf(option.selection), option])),
    [props.options],
  );
  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = props.options.filter((option) =>
      `${option.label} ${option.providerLabel} ${option.selection.model} ${TIER_MARK[option.tier]}`
        .toLowerCase()
        .includes(needle),
    );
    const showAuto = needle.length === 0 || "auto recommended".includes(needle);
    return [...(showAuto ? [AUTO] : []), ...matches.map((option) => keyOf(option.selection))];
  }, [props.options, query]);
  const label = ROLE_COPY[props.role].label;

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="text-xs font-medium">{label}</div>
        <div className="truncate text-2xs text-muted-foreground">{ROLE_COPY[props.role].hint}</div>
      </div>
      <Combobox
        items={items}
        filteredItems={items}
        autoHighlight
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
        value={value}
        onValueChange={(next) => {
          if (typeof next !== "string") return;
          if (next === AUTO) {
            props.onChange(null);
          } else {
            const option = byKey.get(next);
            if (option === undefined) return;
            props.onChange(option.selection);
          }
          setOpen(false);
        }}
      >
        <ComboboxTrigger
          aria-label={`${label} model`}
          render={<SelectButton size="sm" className="w-44" />}
        >
          <span className="min-w-0 truncate">
            {props.current === null
              ? "No model"
              : `${props.pinned ? "" : "Auto · "}${props.current.label}`}
          </span>
        </ComboboxTrigger>
        <ComboboxPopup align="end" className="flex w-72 flex-col">
          <ComboboxSearchInput
            placeholder="Search models…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>No models found.</ComboboxEmpty>
          <ComboboxList className="max-h-72">
            {items.map((item, index) => {
              const option = item === AUTO ? null : byKey.get(item);
              return (
                <ComboboxItem hideIndicator index={index} key={item} value={item}>
                  <div className="flex w-full min-w-0 items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium">
                        {option == null ? "Auto" : option.label}
                      </div>
                      <div className="truncate text-2xs text-muted-foreground">
                        {option == null
                          ? props.autoPick === null
                            ? "No model available"
                            : `Recommended: ${props.autoPick.label} · ${props.autoPick.providerLabel}`
                          : `${option.providerLabel} · ${TIER_MARK[option.tier]}`}
                      </div>
                    </div>
                    {item === value ? (
                      <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : null}
                  </div>
                </ComboboxItem>
              );
            })}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
