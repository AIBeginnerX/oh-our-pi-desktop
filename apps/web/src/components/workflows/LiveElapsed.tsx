import { nodeElapsedMs, shortDuration } from "@t3tools/client-runtime/workflow-graph";
import { useEffect, useRef } from "react";

// One timer serves every running card; it stops when the last one unmounts.
const tickers = new Set<() => void>();
let timer: number | undefined;

function subscribeToSecondTick(update: () => void): () => void {
  tickers.add(update);
  timer ??= window.setInterval(() => {
    for (const tick of tickers) tick();
  }, 1_000);
  return () => {
    tickers.delete(update);
    if (tickers.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

type Span = {
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
};

function elapsedText({ startedAt, completedAt }: Span): string {
  const elapsed = nodeElapsedMs(
    {
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(completedAt === undefined ? {} : { completedAt }),
    },
    Date.now(),
  );
  return elapsed === undefined ? "" : shortDuration(elapsed);
}

/** Whether a node has an elapsed time to show. */
export function hasElapsed(info: Span): boolean {
  return elapsedText(info) !== "";
}

/**
 * Elapsed time of a node. While it runs the text ticks by DOM writes, so the parent never
 * re-renders for the clock; once it settles the time is frozen at its end.
 */
export function LiveElapsed({ info, live }: { info: Span; live: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { startedAt, completedAt } = info;
  useEffect(() => {
    if (!live) return;
    return subscribeToSecondTick(() => {
      if (ref.current) ref.current.textContent = elapsedText({ startedAt, completedAt });
    });
  }, [live, startedAt, completedAt]);
  const text = elapsedText({ startedAt, completedAt });
  return text === "" ? null : (
    <span ref={ref} className="tabular-nums">
      {text}
    </span>
  );
}
