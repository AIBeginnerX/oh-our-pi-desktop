import { Button } from "../ui/button";
import { useParams, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ProviderContextBreakdownResult, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/unstable/reactivity";
import { useT } from "~/i18n";
import {
  type ContextWindowSnapshot,
  formatContextWindowTokens,
  shapeContextBreakdown,
} from "~/lib/contextWindow";
import { threadEnvironment, useIsClaudeThread } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { resolveThreadRouteRef } from "~/threadRoutes";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  formatContextWindowCompactionMessage,
  resolveContextWindowSeverity,
} from "./ContextWindowMeter.logic";
import { MessageSquarePlusIcon, Minimize2Icon } from "lucide-react";
import { cn } from "~/lib/utils";
import { composerFloatingLayerProps } from "./composerEventScope";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

type ContextWindowMeterProps = {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
  /** Set when the provider cannot compact and the window is nearly full; offers a fresh start. */
  onContinueInNewThread?: (() => void) | undefined;
};

export function ContextWindowMeter(props: ContextWindowMeterProps) {
  const router = useRouter({ warn: false });
  return router ? <RoutedContextWindowMeter {...props} /> : <Meter {...props} />;
}

function RoutedContextWindowMeter(props: ContextWindowMeterProps) {
  const params = useParams({
    strict: false,
    select: ({ environmentId, threadId }) => ({ environmentId, threadId }),
    structuralSharing: true,
  });
  const threadRef = useMemo(() => resolveThreadRouteRef(params), [params]);
  const isClaude = useIsClaudeThread(threadRef);
  return <Meter {...props} breakdownThread={isClaude ? threadRef : null} />;
}

function Meter(props: ContextWindowMeterProps & { breakdownThread?: ScopedThreadRef | null }) {
  const {
    breakdownThread,
    usage,
    modelDisplayName,
    onCompact,
    compactDisabled,
    compactDisabledReason,
    onContinueInNewThread,
  } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const severity = resolveContextWindowSeverity(normalizedPercentage);
  const showPercentageLabel =
    usage.maxTokens !== null && (severity !== "normal" || onContinueInNewThread !== undefined);
  const usageColor =
    severity === "critical"
      ? "var(--color-error)"
      : severity === "warning"
        ? "var(--color-warning)"
        : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact || onContinueInNewThread || breakdownThread ? 150 : 0}
        render={
          <Button
            size={showPercentageLabel ? "sm" : "icon-sm"}
            variant="ghost-muted"
            className={showPercentageLabel ? undefined : "size-7"}
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  className="stroke-muted-foreground/24"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
            {showPercentageLabel && usedPercentage ? (
              <span
                className={cn(
                  "text-2xs font-medium tabular-nums",
                  severity === "critical" ? "text-error-foreground" : "text-warning-foreground",
                )}
              >
                {usedPercentage}
              </span>
            ) : null}
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="sm"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-2xs tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-2xs tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {breakdownThread ? (
            <ContextBreakdown key={scopedThreadKey(breakdownThread)} threadRef={breakdownThread} />
          ) : null}
          {onContinueInNewThread ? (
            <>
              <div className="mt-1 text-pretty text-secondary-label text-2xs">
                Context is getting full and this provider does not compact it. A new thread can
                start from a short summary of this one.
              </div>
              <Button
                size="xs"
                variant="outline"
                className="w-full justify-center"
                onClick={onContinueInNewThread}
              >
                <MessageSquarePlusIcon aria-hidden="true" />
                Continue in new thread
              </Button>
            </>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-2xs">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ContextBreakdown({ threadRef }: { threadRef: ScopedThreadRef }) {
  const t = useT();
  const request = useAtomCommand(threadEnvironment.getContextBreakdown, {
    reportFailure: false,
    reportDefect: false,
  });
  const [state, setState] = useState<ProviderContextBreakdownResult | "loading" | null>(null);

  async function showBreakdown() {
    setState("loading");
    try {
      const result = await request({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      setState(AsyncResult.isSuccess(result) ? result.value : { status: "unavailable" });
    } catch {
      setState({ status: "unavailable" });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button size="xs" variant="outline" disabled={state === "loading"} onClick={showBreakdown}>
        {state === "loading" ? t("Loading breakdown…") : t("Show breakdown")}
      </Button>
      {state && state !== "loading" ? (
        state.status === "available" ? (
          <ContextBreakdownTable usage={state} />
        ) : (
          <p role="status" className="text-secondary-label text-2xs">
            {t("Breakdown is available while a Claude session is open.")}
          </p>
        )
      ) : null}
    </div>
  );
}

function ContextBreakdownTable({
  usage,
}: {
  usage: Extract<ProviderContextBreakdownResult, { status: "available" }>;
}) {
  const t = useT();
  const { rows, usedTokens, usedShare } = shapeContextBreakdown(usage.categories, usage.maxTokens);
  const orderedRows = [
    ...rows.used,
    ...(rows.used.length > 0
      ? [
          {
            key: "subtotal",
            name: t("Used subtotal"),
            tokens: usedTokens,
            share: usedShare,
            kind: "subtotal",
          },
        ]
      : []),
    ...rows.free,
    ...rows.buffer,
    ...rows.deferred,
  ];
  return (
    <div className="max-h-56 overflow-y-auto">
      <table className="w-full text-2xs tabular-nums">
        <thead className="text-secondary-label">
          <tr>
            <th scope="col" className="text-left">
              {t("Category")}
            </th>
            <th scope="col" className="pl-2 text-right">
              {t("Tokens")}
            </th>
            <th scope="col" className="pl-2 text-right">
              {t("Share of window")}
            </th>
          </tr>
        </thead>
        <tbody>
          {orderedRows.map((row) => (
            <tr
              key={row.key}
              className={cn(
                row.kind === "deferred" && "text-muted-foreground",
                row.kind === "subtotal" && "border-t font-medium",
              )}
            >
              <th scope="row" className="break-all py-0.5 text-left font-normal">
                {row.name}
              </th>
              <td className="whitespace-nowrap pl-2 text-right">{row.tokens.toLocaleString()}</td>
              <td className="pl-2 text-right">{formatPercentage(row.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Holds the meter's footprint while a thread's activities are still loading. */
export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}
