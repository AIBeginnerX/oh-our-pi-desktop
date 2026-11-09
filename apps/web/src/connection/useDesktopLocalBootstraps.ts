import type { DesktopBridge, DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

export type DesktopBootstrapsRefresh =
  | {
      readonly _tag: "Subscribe";
      readonly subscribe: (listener: () => void) => () => void;
    }
  | {
      readonly _tag: "Poll";
      readonly intervalMs: number;
    };

/**
 * Decide how the hook refreshes the topology. A bridge carrying the
 * bootstraps-changed push event re-reads only on that event; an older desktop
 * shell without it (and plain web) falls back to the interval poll so mixed
 * versions keep working.
 */
export function resolveDesktopBootstrapsRefresh(
  bridge: Pick<DesktopBridge, "onLocalEnvironmentBootstrapsChange"> | undefined,
): DesktopBootstrapsRefresh {
  const subscribe = bridge?.onLocalEnvironmentBootstrapsChange;
  if (typeof subscribe === "function") {
    return { _tag: "Subscribe", subscribe };
  }
  return { _tag: "Poll", intervalMs: DESKTOP_LOCAL_BOOTSTRAP_POLL_MS };
}

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). Reads once on mount, then re-reads only when the main process
 * pushes a bootstraps-changed event; a bridge without that event falls back to
 * re-reading on an interval. Failed reads retain the latest successful
 * snapshot, while a successful empty read clears it. Use this instead of
 * polling the bridge ad hoc so every renderer consumer reads the same
 * topology.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const [bootstraps, setBootstraps] = useState<ReadonlyArray<DesktopEnvironmentBootstrap>>(
    readDesktopSecondaryBootstraps,
  );

  useEffect(() => {
    const read = () => setBootstraps(readDesktopSecondaryBootstraps());
    read();
    const refresh = resolveDesktopBootstrapsRefresh(window.desktopBridge);
    if (refresh._tag === "Subscribe") {
      return refresh.subscribe(read);
    }
    const interval = setInterval(read, refresh.intervalMs);
    return () => clearInterval(interval);
  }, []);

  return bootstraps;
}
