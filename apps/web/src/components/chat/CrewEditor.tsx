import {
  CREW_FALLBACK_LIMIT,
  CREW_ROLES,
  type CrewPreset,
  type CrewRole,
  type ModelSelection,
} from "@t3tools/contracts";
import { type CrewChange, type CrewModelOption, type ResolvedCrew } from "@t3tools/shared/crew";
import { CheckIcon, MinusIcon, SparklesIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

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
import { PopoverTitle } from "../ui/popover";
import { SelectButton } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { crewFallbackCandidates } from "./CrewChip.logic";

export const CREW_PRESETS: ReadonlyArray<{ value: CrewPreset; label: string; hint: string }> = [
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
 * The crew editor body the chat's Crew chip and the Settings default share: the switch, the
 * presets, and one row per role with its fallbacks. The caller owns what it is bound to —
 * `onChange` hands back the complete change to apply to a chat's own crew or to the defaults —
 * along with the copy that names the place (the header lines and, in a chat, what leads).
 */
export function CrewEditor(props: {
  readonly crew: ResolvedCrew;
  readonly options: ReadonlyArray<CrewModelOption>;
  readonly autoPicks: Record<CrewRole, CrewModelOption | null>;
  readonly onChange: (change: CrewChange) => void;
  /** Header lines under the title, e.g. whose crew this is. */
  readonly note?: ReactNode;
  /** The brain line in the roles block; omitted where there is no chat to name. */
  readonly brainLabel?: string;
}) {
  const { crew } = props;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <PopoverTitle>OOP Crew</PopoverTitle>
          {props.note}
        </div>
        <Switch
          checked={crew.enabled}
          onCheckedChange={(checked) => props.onChange({ enabled: checked })}
          aria-label="Use OOP Crew"
        />
      </div>

      <div className="grid grid-cols-4 gap-1">
        {CREW_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            aria-pressed={crew.preset === preset.value}
            aria-label={`${preset.label}: ${preset.hint}`}
            onClick={() => props.onChange({ preset: preset.value })}
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
            onClick={() => props.onChange({ pins: { worker: null, expert: null, auditor: null } })}
          >
            <SparklesIcon />
            Auto all
          </Button>
        </div>
        <div className="text-2xs text-muted-foreground">
          A change applies to work handed out from now on, even in a running turn. Tasks already
          running keep the model they started with.
        </div>
        {props.brainLabel ? (
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">Brain</span>
            <span className="truncate text-muted-foreground">{props.brainLabel}</span>
          </div>
        ) : null}
        {CREW_ROLES.map((role) => (
          <CrewRoleRow
            key={role}
            role={role}
            options={props.options}
            current={crew.roles[role]}
            autoPick={props.autoPicks[role]}
            pinned={crew.pinned.has(role)}
            onChange={(selection) => props.onChange({ pins: { [role]: selection } })}
            fallbacks={crew.fallbackSelections[role]}
            onFallbacksChange={(selections) =>
              props.onChange({ fallbacks: { [role]: selections } })
            }
          />
        ))}
      </div>
    </div>
  );
}

function CrewRoleRow(props: {
  readonly role: CrewRole;
  readonly options: ReadonlyArray<CrewModelOption>;
  readonly current: CrewModelOption | null;
  readonly autoPick: CrewModelOption | null;
  readonly pinned: boolean;
  readonly onChange: (selection: ModelSelection | null) => void;
  readonly fallbacks: ReadonlyArray<ModelSelection>;
  readonly onFallbacksChange: (selections: ReadonlyArray<ModelSelection>) => void;
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
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium">{label}</span>
            <CrewFallbackPicker
              label={label}
              options={props.options}
              assigned={props.current}
              listed={props.fallbacks}
              onChange={props.onFallbacksChange}
            />
          </div>
          <div className="truncate text-2xs text-muted-foreground">
            {ROLE_COPY[props.role].hint}
          </div>
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
      <CrewFallbackList
        options={props.options}
        listed={props.fallbacks}
        onChange={props.onFallbacksChange}
      />
    </div>
  );
}

/**
 * The small "Fallback" button next to a role's name: opens a model picker and appends the choice
 * to the role's fallback list (the order added is the order the server tries them). Disabled with
 * a reason when the list is full or no other model is left to offer.
 */
function CrewFallbackPicker(props: {
  readonly label: string;
  readonly options: ReadonlyArray<CrewModelOption>;
  readonly assigned: CrewModelOption | null;
  readonly listed: ReadonlyArray<ModelSelection>;
  readonly onChange: (selections: ReadonlyArray<ModelSelection>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const byKey = useMemo(
    () => new Map(props.options.map((option) => [keyOf(option.selection), option])),
    [props.options],
  );
  const candidates = useMemo(
    () => crewFallbackCandidates(props.options, props.assigned, props.listed),
    [props.options, props.assigned, props.listed],
  );
  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return candidates
      .filter((option) =>
        `${option.label} ${option.providerLabel} ${option.selection.model} ${TIER_MARK[option.tier]}`
          .toLowerCase()
          .includes(needle),
      )
      .map((option) => keyOf(option.selection));
  }, [candidates, query]);
  const disabledReason =
    props.listed.length >= CREW_FALLBACK_LIMIT
      ? `Up to ${CREW_FALLBACK_LIMIT} fallback models`
      : candidates.length === 0
        ? "No other models to add"
        : null;

  const picker = (
    <Combobox
      items={items}
      filteredItems={items}
      autoHighlight
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      value={null}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        const option = byKey.get(next);
        if (option === undefined) return;
        props.onChange([...props.listed, option.selection]);
        setOpen(false);
      }}
    >
      <ComboboxTrigger
        aria-label={`Add fallback model for ${props.label}`}
        disabled={disabledReason !== null}
        render={<Button size="micro" variant="outline" />}
      >
        Fallback
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="flex w-72 flex-col">
        <ComboboxSearchInput
          placeholder="Search models…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No models left to add.</ComboboxEmpty>
        <ComboboxList className="max-h-56">
          {items.map((item, index) => {
            const option = byKey.get(item);
            if (option === undefined) return null;
            return (
              <ComboboxItem hideIndicator index={index} key={item} value={item}>
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{option.label}</div>
                  <div className="truncate text-2xs text-muted-foreground">
                    {option.providerLabel} · {TIER_MARK[option.tier]}
                  </div>
                </div>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );

  if (disabledReason === null) return picker;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex cursor-not-allowed" tabIndex={0} />}>
        {picker}
      </TooltipTrigger>
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A role's fallback models, one line each with a remove button; nothing when there are none. A
 * saved model whose provider is away stays listed, muted, and is skipped until it is back.
 */
function CrewFallbackList(props: {
  readonly options: ReadonlyArray<CrewModelOption>;
  readonly listed: ReadonlyArray<ModelSelection>;
  readonly onChange: (selections: ReadonlyArray<ModelSelection>) => void;
}) {
  const byKey = useMemo(
    () => new Map(props.options.map((option) => [keyOf(option.selection), option])),
    [props.options],
  );
  if (props.listed.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 ps-2">
      {props.listed.map((selection, index) => {
        const option = byKey.get(keyOf(selection));
        const label = option?.label ?? selection.model;
        return (
          <li key={keyOf(selection)} className="flex items-center justify-between gap-2 text-2xs">
            <span
              className={cn(
                "min-w-0 truncate",
                option === undefined ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {label}
              {option === undefined ? " · unavailable, skipped until it is back" : ""}
            </span>
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label={`Remove fallback ${label}`}
              onClick={() => props.onChange(props.listed.filter((_, at) => at !== index))}
            >
              <MinusIcon />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
