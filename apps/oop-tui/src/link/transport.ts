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
  ThreadId,
} from "@t3tools/contracts";

/** Why a connection attempt failed. `blocked` will not fix itself (bad token); `transient` will retry. */
export class TransportError extends Error {
  readonly kind: "blocked" | "transient";
  /** Why a `blocked` attempt was refused ("authentication", "unsupported", ...), when the connection layer said. */
  readonly reason: string | null;

  constructor(kind: "blocked" | "transient", message: string, reason: string | null = null) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
    this.reason = reason;
  }
}

/**
 * The server read a command and answered it with a typed refusal. Unlike a dropped connection,
 * nothing was half-done, so there is nothing to resend: the user has to change the request.
 */
export class CommandRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandRejectedError";
  }
}

export interface StreamHandlers<Item> {
  readonly onItem: (item: Item) => void;
  /**
   * The stream ended. `error` is null for a clean end. Unless `rejected`, the session should be
   * replaced; `rejected` means the server answered this subscription with an error of its own (such
   * as an unknown thread), so the session itself is fine.
   */
  readonly onEnd: (error: string | null, rejected?: boolean) => void;
}

export interface StreamHandle {
  readonly cancel: () => void;
}

/** One live WebSocket session. Everything the app needs from the server goes through it. */
export interface TransportSession {
  readonly config: ServerConfig;
  readonly subscribeShell: (
    input: OrchestrationSubscribeShellInput,
    handlers: StreamHandlers<OrchestrationShellStreamItem>,
  ) => StreamHandle;
  readonly subscribeThread: (
    input: OrchestrationSubscribeThreadInput,
    handlers: StreamHandlers<OrchestrationThreadStreamItem>,
  ) => StreamHandle;
  /**
   * The server's config stream: a snapshot first, then updates (settings, providers, ...). It is the
   * one source of truth for `config` after the session opened; the session's own `config` is only
   * the first snapshot.
   */
  readonly subscribeConfig: (handlers: StreamHandlers<ServerConfigStreamEvent>) => StreamHandle;
  readonly dispatch: (command: ClientOrchestrationCommand) => Promise<void>;
  /** The server's current settings. A typed refusal rejects with `CommandRejectedError`. */
  readonly getSettings: () => Promise<ServerSettings>;
  /** Applies a patch; the answer is the settings as stored. Top-level keys in a patch replace whole. */
  readonly updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
  /**
   * Re-checks providers (all, or one instance) and answers with the refreshed list. With `cwd` and
   * an instance, the server lists that instance's commands and skills for the folder instead.
   */
  readonly refreshProviders: (input?: {
    readonly instanceId?: string;
    readonly cwd?: string;
    readonly refreshModels?: boolean;
  }) => Promise<ReadonlyArray<ServerProvider>>;
  /**
   * One page of a thread's older turns, read over HTTP: the `turnLimit` user turns before the
   * cursor a snapshot or an earlier page handed out. The thread inside holds only that page.
   */
  readonly loadOlderTurns: (input: {
    readonly threadId: ThreadId;
    readonly beforeCursor: string;
    readonly turnLimit: number;
  }) => Promise<OrchestrationThreadDetailSnapshot>;
  /** Asks the crew of a lead thread to run a failed task again. */
  readonly retryCrewTask: (input: {
    readonly leadThreadId: ThreadId;
    readonly taskId: string;
  }) => Promise<void>;
  /**
   * The patch of one turn: what changed between the checkpoints after `fromTurnCount` and after
   * `toTurnCount` turns (0 is the state before the thread's first turn). A typed refusal rejects
   * with `CommandRejectedError`.
   */
  readonly getCheckpointDiff: (input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  }) => Promise<string>;
  /** Resolves with a reason once the socket is gone. */
  readonly closed: Promise<string>;
  readonly close: () => Promise<void>;
}

export interface Transport {
  readonly open: () => Promise<TransportSession>;
}
