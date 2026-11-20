import { WS_METHODS, type CrewScorecard, type EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useT } from "../../i18n";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

const getScorecard = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:crew-scorecard:get",
  tag: WS_METHODS.crewScorecard,
});

const ROLE_LABELS = { worker: "Worker", expert: "Expert", auditor: "Auditor" } as const;

export function CrewScorecardSetting({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const t = useT();
  const get = useAtomCommand(getScorecard, { reportFailure: false, reportDefect: false });
  const started = useRef(false);
  const [scorecard, setScorecard] = useState<CrewScorecard | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async () => {
    setPending(true);
    const result = await get({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Success") setScorecard(result.value);
    setFailed(result._tag !== "Success");
  }, [environmentId, get]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void refresh();
  }, [refresh]);

  // Nothing loaded yet, or a server without the scorecard: the section stays out of the way.
  if (scorecard === null) return null;
  return (
    <div className="min-w-0 space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{t("Crew scorecard · Last 30 days")}</h3>
          <p className="text-xs break-words text-muted-foreground">{environmentLabel}</p>
        </div>
        <Button variant="outline" size="xs" disabled={pending} onClick={() => void refresh()}>
          {t("Refresh scorecard")}
        </Button>
      </div>
      {failed && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("Could not load the crew scorecard.")}
        </p>
      )}
      {scorecard.rows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("No finished crew work in this period.")}
        </p>
      )}
      <ul className="space-y-2">
        {scorecard.rows.map((row) => (
          <li key={`${row.role}:${row.model}`} className="min-w-0 text-xs break-words">
            <p className="font-medium">
              {t(ROLE_LABELS[row.role])} · {row.model}
            </p>
            <p className="text-muted-foreground">
              {row.role === "auditor" ? (
                t(
                  "{audits} audits · {changes} asked for changes · {proven} with proven blockers · {unreadable} unreadable",
                  {
                    audits: row.audits,
                    changes: row.needsChanges,
                    proven: row.provenBlocking,
                    unreadable: row.unreadable,
                  },
                )
              ) : (
                <>
                  {t("{completed} completed · {failed} failed · {verified} of {tasks} verified", {
                    completed: row.completed,
                    failed: row.failed,
                    verified: row.verified,
                    tasks: row.tasks,
                  })}
                  {row.tasks >= 10 &&
                    ` (${new Intl.NumberFormat(undefined, { style: "percent" }).format(row.verified / row.tasks)})`}
                </>
              )}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
