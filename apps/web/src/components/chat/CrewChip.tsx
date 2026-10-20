import {
  CREW_ROLES,
  type CrewPreset,
  type CrewRole,
  type CrewSettings,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import {
  crewModelOptions,
  recommendCrew,
  resolveCrew,
  type CrewModelOption,
} from "@t3tools/shared/crew";
import { CheckIcon, SparklesIcon, UsersRoundIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";

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
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

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
 * The crew for this thread at a glance, and the place to change it: one click for a preset,
 * one more for any single role. Changes apply to this thread; a draft changes the default.
 */
export function CrewChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly brain: ModelSelection;
  readonly disabled?: boolean;
}) {
  const settings = useEnvironmentSettings(props.environmentId, (value) => value.crew);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const options = useMemo(() => crewModelOptions(props.providers), [props.providers]);
  const crew = useMemo(
    () =>
      resolveCrew({
        settings,
        threadId: props.threadId,
        providers: props.providers,
        brain: props.brain,
      }),
    [settings, props.threadId, props.providers, props.brain],
  );
  const override = props.threadId === null ? undefined : settings.threads[props.threadId];
  const autoPicks = useMemo(
    () => recommendCrew(options, props.brain, crew.preset),
    [options, props.brain, crew.preset],
  );

  /**
   * In a thread the change lands in its override, where a null pin means Auto even if the
   * defaults pin that role; without a thread it changes the defaults themselves.
   */
  const write = (change: {
    enabled?: boolean;
    preset?: CrewPreset;
    pins?: Partial<Record<CrewRole, ModelSelection | null>>;
  }) => {
    const scoped = {
      ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      ...(change.preset === undefined ? {} : { preset: change.preset }),
    };
    if (props.threadId === null) {
      let pinned: CrewSettings["pinned"] = { ...settings.pinned };
      for (const role of CREW_ROLES) {
        const selection = change.pins?.[role];
        if (selection === undefined) continue;
        if (selection === null) {
          const { [role]: _cleared, ...rest } = pinned;
          pinned = rest;
        } else {
          pinned = { ...pinned, [role]: selection };
        }
      }
      updateSettings({ crew: { ...settings, ...scoped, pinned } });
      return;
    }
    updateSettings({
      crew: {
        ...settings,
        threads: {
          ...settings.threads,
          [props.threadId]: {
            ...override,
            ...scoped,
            pinned: { ...override?.pinned, ...change.pins },
          },
        },
      },
    });
  };

  const makeDefault = () => {
    if (props.threadId === null) return;
    let pinned: CrewSettings["pinned"] = {};
    for (const role of CREW_ROLES) {
      const option = crew.roles[role];
      if (crew.pinned.has(role) && option !== null)
        pinned = { ...pinned, [role]: option.selection };
    }
    updateSettings({
      crew: { ...settings, enabled: crew.enabled, preset: crew.preset, pinned },
    });
  };

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

          {props.threadId !== null ? (
            <button
              type="button"
              onClick={makeDefault}
              className="self-start text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Use this crew for new chats
            </button>
          ) : null}
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
