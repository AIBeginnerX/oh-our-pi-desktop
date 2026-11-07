import { displayLimitWindows, formatDuration, type LimitPool } from "@t3tools/shared/usageLimits";

import { Fragment } from "react";

import { useT } from "~/i18n";
import { barColor } from "./UsageLimits";

/**
 * A provider's limit windows as thin bars under its usage summary: used share
 * and the soonest reset, so spend and quota read together without opening the
 * Limits tab. `now` is advanced by the page on refresh, never by a ticking clock.
 */
export function ProviderLimitGauges({
  pool,
  now,
}: {
  readonly pool: LimitPool;
  readonly now: number;
}) {
  const t = useT();
  const color = barColor(pool.driver);
  const windows = displayLimitWindows(pool);
  if (windows.length === 0) return null;
  return (
    <div className="mt-1 grid grid-cols-[minmax(0,5.5rem)_minmax(2rem,1fr)_auto] items-center gap-x-3 gap-y-1">
      {windows.map((window) => {
        const resetsAt = window.resets[0]?.at;
        const reset =
          resetsAt === undefined
            ? ""
            : resetsAt <= now
              ? t("resets now")
              : t("resets in {time}", { time: formatDuration(resetsAt - now) });
        const used = t("{percent}% used", { percent: window.usedPercent });
        return (
          <Fragment key={`${window.kind}:${window.id}`}>
            <span className="truncate text-2xs text-muted-foreground">{window.label}</span>
            <div
              role="img"
              aria-label={`${window.label}: ${used}${reset ? `, ${reset}` : ""}`}
              className="h-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${window.usedPercent}%`, backgroundColor: color }}
              />
            </div>
            <span className="text-right text-2xs whitespace-nowrap text-muted-foreground tabular-nums">
              {used}
              {reset ? ` · ${reset}` : ""}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
