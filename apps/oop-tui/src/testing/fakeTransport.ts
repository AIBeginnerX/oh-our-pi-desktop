import type {
  ClientOrchestrationCommand,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeShellInput,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadStreamItem,
  ServerConfig,
  ServerConfigStreamEvent,
  ServerProvider,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";

import type { LinkStatus } from "../link/client.ts";
import type { StreamHandlers, Transport, TransportSession } from "../link/transport.ts";
import { makeConfig } from "./fixtures.ts";

export interface Subscription<Input, Item> {
  readonly input: Input;
  readonly handlers: StreamHandlers<Item>;
  cancelled: boolean;
}

export interface FakeSession {
  readonly session: TransportSession;
  readonly shell: Array<
    Subscription<OrchestrationSubscribeShellInput, OrchestrationShellStreamItem>
  >;
  readonly threads: Array<
    Subscription<OrchestrationSubscribeThreadInput, OrchestrationThreadStreamItem>
  >;
  readonly dispatched: ClientOrchestrationCommand[];
  /** Config stream subscriptions; a test pushes events through `handlers.onItem`. */
  readonly configs: Array<Subscription<null, ServerConfigStreamEvent>>;
  /** Patches sent with `updateSettings`, in order. */
  readonly patches: ServerSettingsPatch[];
  /** What `getSettings` answers and `updateSettings` merges into. */
  settings: Record<string, unknown>;
  /** Makes the next settings, provider or crew calls fail with this error. */
  rpcError: Error | null;
  readonly refreshes: Array<{ instanceId?: string; refreshModels?: boolean }>;
  readonly retries: Array<{ leadThreadId: string; taskId: string }>;
  /** Older-turn pages asked for, in order. */
  readonly olderRequests: Array<{ threadId: string; beforeCursor: string; turnLimit: number }>;
  /** What `loadOlderTurns` answers, by the cursor it is asked about. */
  readonly olderPages: Record<string, OrchestrationThreadDetailSnapshot>;
  /** The turn ranges asked of `getCheckpointDiff`, in order. */
  readonly diffRequests: Array<{ threadId: string; fromTurnCount: number; toTurnCount: number }>;
  /** What `getCheckpointDiff` answers. */
  diff: string;
  closedByClient: boolean;
  /** The socket went away. */
  readonly drop: (reason: string) => void;
}

/**
 * `lateClose` makes `close()` leave the socket "closed" promise pending, as a real socket does for a
 * moment after it was told to shut down; the test resolves it later with `drop`.
 */
export const makeFakeSession = (
  config: ServerConfig = makeConfig(),
  options: { readonly lateClose?: boolean } = {},
): FakeSession => {
  let drop: (reason: string) => void = () => undefined;
  const closed = new Promise<string>((resolve) => {
    drop = resolve;
  });
  const fake: FakeSession = {
    shell: [],
    threads: [],
    dispatched: [],
    configs: [],
    patches: [],
    settings: {},
    rpcError: null,
    refreshes: [],
    retries: [],
    olderRequests: [],
    olderPages: {},
    diffRequests: [],
    diff: "",
    closedByClient: false,
    drop,
    session: {
      config,
      subscribeShell: (input, handlers) => {
        const subscription = { input, handlers, cancelled: false };
        fake.shell.push(subscription);
        return { cancel: () => void (subscription.cancelled = true) };
      },
      subscribeThread: (input, handlers) => {
        const subscription = { input, handlers, cancelled: false };
        fake.threads.push(subscription);
        return { cancel: () => void (subscription.cancelled = true) };
      },
      subscribeConfig: (handlers) => {
        const subscription = { input: null, handlers, cancelled: false };
        fake.configs.push(subscription);
        return { cancel: () => void (subscription.cancelled = true) };
      },
      dispatch: async (command) => {
        fake.dispatched.push(command);
      },
      getSettings: async () => {
        if (fake.rpcError !== null) throw fake.rpcError;
        return fake.settings as unknown as ServerSettings;
      },
      updateSettings: async (patch) => {
        if (fake.rpcError !== null) throw fake.rpcError;
        fake.patches.push(patch);
        fake.settings = { ...fake.settings, ...patch };
        return fake.settings as unknown as ServerSettings;
      },
      refreshProviders: async (input) => {
        if (fake.rpcError !== null) throw fake.rpcError;
        fake.refreshes.push({ ...input });
        return [] as ReadonlyArray<ServerProvider>;
      },
      retryCrewTask: async (input) => {
        if (fake.rpcError !== null) throw fake.rpcError;
        fake.retries.push({ ...input });
      },
      loadOlderTurns: async (input) => {
        fake.olderRequests.push({ ...input });
        const page = fake.olderPages[input.beforeCursor];
        if (page === undefined) throw new Error("no such page");
        return page;
      },
      getCheckpointDiff: async (input) => {
        if (fake.rpcError !== null) throw fake.rpcError;
        fake.diffRequests.push({ ...input });
        return fake.diff;
      },
      closed,
      close: async () => {
        fake.closedByClient = true;
        if (options.lateClose !== true) drop("closed");
      },
    },
  };
  return fake;
};

/** A transport that hands out the queued sessions or errors, one per `open`. */
export const makeFakeTransport = (
  outcomes: Array<FakeSession | Error>,
): Transport & { opens: number } => {
  const transport = {
    opens: 0,
    open: async () => {
      transport.opens += 1;
      const next = outcomes.shift();
      if (next === undefined) throw new Error("no more fake sessions");
      if (next instanceof Error) throw next;
      return next.session;
    },
  };
  return transport;
};

/** Records link status changes and lets a test await a particular one without sleeping. */
export const statusWatcher = () => {
  const seen: LinkStatus[] = [];
  const waiters: Array<{ matches: (status: LinkStatus) => boolean; resolve: () => void }> = [];
  return {
    seen,
    record: (status: LinkStatus) => {
      seen.push(status);
      const ready = waiters.filter((waiter) => waiter.matches(status));
      for (const waiter of ready) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    until: (matches: (status: LinkStatus) => boolean) =>
      seen.some(matches)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ matches, resolve })),
  };
};

/** A sleep the test completes by hand, recording the delay it was asked for. */
export const manualSleep = () => {
  const delays: number[] = [];
  const resolvers: Array<() => void> = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return new Promise<void>((resolve) => resolvers.push(resolve));
    },
    release: () => resolvers.splice(0).forEach((resolve) => resolve()),
  };
};
