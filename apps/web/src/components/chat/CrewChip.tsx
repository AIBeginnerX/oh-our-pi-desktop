import {
  CREW_ROLES,
  type CrewThreadOverride,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  applyCrewChange,
  crewAsDefault,
  CREW_ROLE_LABEL,
  crewModelOptions,
  recommendCrew,
  resolveCrew,
  type CrewChange,
} from "@t3tools/shared/crew";
import { UsersRoundIcon } from "lucide-react";
import { useMemo } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { crewLeadAvailability } from "./CrewChip.logic";
import { CrewEditor } from "./CrewEditor";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The crew for this chat at a glance, and the place to change it: one click for a preset, one
 * more for any single role. A change belongs to this chat alone (a chat not yet started keeps it
 * until its first message); "Use this crew for new chats" (or Settings) edits the default every
 * other chat falls back to, and "Use the default crew" hands this chat back to it.
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
                {CREW_ROLE_LABEL[role].slice(0, 1)}
              </span>
            ))}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80">
        <div className="flex flex-col gap-3">
          <CrewEditor
            crew={crew}
            options={options}
            autoPicks={autoPicks}
            onChange={write}
            note={
              <>
                <div className="text-xs text-muted-foreground">
                  This chat's model leads; the crew takes the work it hands out.
                </div>
                <div className="text-2xs text-muted-foreground">
                  {crew.source === "thread"
                    ? "This chat has its own crew."
                    : "Using the default crew. A change here applies to this chat only."}
                </div>
              </>
            }
            brainLabel="this chat's model"
          />

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
