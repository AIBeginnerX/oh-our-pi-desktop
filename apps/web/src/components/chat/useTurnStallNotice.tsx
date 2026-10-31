import { ClockIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useT } from "../../i18n";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { TURN_STALL_MS, deriveTurnStallDueAt } from "./turnStall.logic";

export const selectTurnStallNoticeEnabled = (settings: { turnStallNoticeEnabled: boolean }) =>
  settings.turnStallNoticeEnabled;

interface UseTurnStallNoticeInput {
  /** The `turnStallNoticeEnabled` client setting; off does nothing at all. */
  readonly enabled: boolean;
  readonly runningTurnId: string | null;
  readonly waitingOnUser: boolean;
  readonly backgroundWorkLive: boolean;
  readonly workLogEntries: Parameters<typeof deriveTurnStallDueAt>[0]["workLogEntries"];
  readonly activities: Parameters<typeof deriveTurnStallDueAt>[0]["activities"];
  readonly messages: Parameters<typeof deriveTurnStallDueAt>[0]["messages"];
  readonly turnStartedAt: string | null;
  readonly sessionUpdatedAt: string | null;
  /** The thread's existing interrupt; null when the turn cannot be stopped from here. */
  readonly onStop: (() => void) | null;
}

/**
 * A passive notice for a turn that has been silent for {@link TURN_STALL_MS} with nothing
 * legitimate to wait on. It only reads the thread's own timestamps and arms one timeout for the
 * moment the turn would count as quiet; it never interrupts, retries, or sends anything.
 */
export function useTurnStallNotice(input: UseTurnStallNoticeInput): ComposerBannerStackItem | null {
  const t = useT();
  const {
    enabled,
    runningTurnId,
    waitingOnUser,
    backgroundWorkLive,
    workLogEntries,
    activities,
    messages,
    turnStartedAt,
    sessionUpdatedAt,
    onStop,
  } = input;

  const dueAt = useMemo(
    () =>
      deriveTurnStallDueAt({
        enabled,
        runningTurnId,
        waitingOnUser,
        backgroundWorkLive,
        workLogEntries,
        activities,
        messages,
        turnStartedAt,
        sessionUpdatedAt,
      }),
    [
      activities,
      backgroundWorkLive,
      enabled,
      messages,
      runningTurnId,
      sessionUpdatedAt,
      turnStartedAt,
      waitingOnUser,
      workLogEntries,
    ],
  );

  // Both are keyed by the due time, which moves on every new activity, so the notice clears
  // itself when the turn speaks again and a dismissal lasts only for the current silence.
  const [reachedDueAt, setReachedDueAt] = useState<number | null>(null);
  const [dismissedDueAt, setDismissedDueAt] = useState<number | null>(null);
  useEffect(() => {
    if (dueAt === null) return;
    const timeout = setTimeout(() => setReachedDueAt(dueAt), Math.max(0, dueAt - Date.now()));
    return () => clearTimeout(timeout);
  }, [dueAt]);

  return useMemo(() => {
    if (dueAt === null || reachedDueAt !== dueAt || dismissedDueAt === dueAt) return null;
    return {
      id: `turn-stall:${runningTurnId}`,
      variant: "info",
      priority: "notice",
      icon: <ClockIcon />,
      title: t("This turn has been quiet for a while"),
      description: t("No activity for {minutes} minutes. The agent may still be working.", {
        minutes: TURN_STALL_MS / 60_000,
      }),
      actions:
        onStop === null ? undefined : (
          <Button size="xs" variant="ghost" onClick={onStop}>
            {t("Stop")}
          </Button>
        ),
      dismissLabel: t("Dismiss quiet turn notice"),
      onDismiss: () => setDismissedDueAt(dueAt),
    } satisfies ComposerBannerStackItem;
  }, [dismissedDueAt, dueAt, onStop, reachedDueAt, runningTurnId, t]);
}
