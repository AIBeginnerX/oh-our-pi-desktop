import type {
  ClientOrchestrationCommand,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  ServerConfig,
  ServerConfigStreamEvent,
  ServerProvider,
  ServerSettings,
  ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";
import { applyShellStreamEvent } from "@t3tools/client-runtime/state/shell-reducer";
import * as Option from "effect/Option";

import {
  type StreamHandle,
  type Transport,
  type TransportSession,
  TransportError,
} from "./transport.ts";
import { applyServerConfigProjection, type ServerConfigProjection } from "./configFold.ts";
import { applyThreadItem, emptyThreadMirror, type ThreadMirrorState } from "./threadMirror.ts";
import { t } from "../i18n/index.ts";

export type LinkPhase = "connecting" | "online" | "reconnecting" | "blocked" | "stopped";

export interface LinkStatus {
  readonly phase: LinkPhase;
  /** Consecutive failed attempts; 0 while online. */
  readonly attempt: number;
  /** Epoch milliseconds of the next attempt while reconnecting. */
  readonly retryAt: number | null;
  readonly detail: string | null;
  /** Set with a `blocked` phase when the connection layer named the cause; the fix depends on it. */
  readonly reason?: string;
}

export interface LinkEvents {
  readonly status: (status: LinkStatus) => void;
  readonly shell: (snapshot: OrchestrationShellSnapshot) => void;
  readonly thread: (state: ThreadMirrorState) => void;
  /** The server's config changed (settings, providers, ...); `LinkClient.config` already holds it. */
  readonly config?: (config: ServerConfig) => void;
  /** The server refused the open thread's subscription; the link stays up and the thread is closed. */
  readonly threadFailed: (threadId: ThreadId, message: string) => void;
}

export interface LinkOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** 0..1, used only to spread reconnect attempts. */
  readonly random?: () => number;
  /** Windowed thread loads when the server supports them. */
  readonly turnLimit?: number;
}

/** Turns in a page of older ones when the link was not given a window size. */
const DEFAULT_OLDER_TURNS = 20;
const BACKOFF_FIRST_MS = 500;
const BACKOFF_CAP_MS = 10_000;
/** A session shorter than this counts as a failed attempt, so a server that drops us at once is not hammered. */
const STABLE_SESSION_MS = 10_000;

export const backoffDelay = (attempt: number, random: () => number): number => {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + 0.4 * random()));
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Keeps one WebSocket session alive and mirrors the shell and the open thread from it. When the
 * session ends for any reason it is replaced after a backoff, and both subscriptions resume from the
 * last sequence applied, so a brief outage costs a few replayed events rather than a full reload.
 */
export class LinkClient {
  private current: TransportSession | null = null;
  /** The newest config: the session's first snapshot, then every update the config stream brings. */
  private lastConfig: ServerConfig | null = null;
  private configProjection: Option.Option<ServerConfigProjection> = Option.none();
  private configHandle: StreamHandle | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  /** Ends the current session. Each session gets its own, so a late report from an old one is inert. */
  private onSessionLost: ((reason: string) => void) | null = null;
  private shellHandle: StreamHandle | null = null;
  private threadHandle: StreamHandle | null = null;
  private shellSnapshot: OrchestrationShellSnapshot | null = null;
  private mirror: ThreadMirrorState = emptyThreadMirror;
  private activeThread: ThreadId | null = null;
  private statusValue: LinkStatus = {
    phase: "connecting",
    attempt: 0,
    retryAt: null,
    detail: null,
  };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private loop: Promise<void> | null = null;

  private readonly transport: Transport;
  private readonly events: LinkEvents;
  private readonly options: LinkOptions;

  constructor(transport: Transport, events: LinkEvents, options: LinkOptions = {}) {
    this.transport = transport;
    this.events = events;
    this.options = options;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get status(): LinkStatus {
    return this.statusValue;
  }

  get shell(): OrchestrationShellSnapshot | null {
    return this.shellSnapshot;
  }

  get config(): ServerConfig | null {
    return this.lastConfig;
  }

  get thread(): ThreadMirrorState {
    return this.mirror;
  }

  start(): Promise<void> {
    this.loop ??= this.run();
    return this.loop;
  }

  /** Subscribes to a thread's detail stream, replacing the previous one. */
  openThread(threadId: ThreadId): void {
    this.threadHandle?.cancel();
    this.threadHandle = null;
    this.activeThread = threadId;
    this.mirror = emptyThreadMirror;
    this.events.thread(this.mirror);
    if (this.current !== null) this.subscribeThread(this.current);
  }

  closeThread(): void {
    this.threadHandle?.cancel();
    this.threadHandle = null;
    this.activeThread = null;
    this.mirror = emptyThreadMirror;
  }

  async dispatch(command: ClientOrchestrationCommand): Promise<void> {
    const session = this.current;
    if (session === null) throw new Error(t("link.notConnected"));
    await session.dispatch(command);
  }

  /** The server's settings as they are now, read from the server rather than from the config copy. */
  async getSettings(): Promise<ServerSettings> {
    return this.session().getSettings();
  }

  /** Sends a settings patch. Keys that hold a whole record (`threadGoals`, `crew`, ...) replace it. */
  async updateSettings(patch: ServerSettingsPatch): Promise<ServerSettings> {
    const session = this.session();
    const settings = await session.updateSettings(patch);
    // The server announces the change on the config stream too; applying the answer now means the
    // caller sees its own change at once, even before that announcement arrives.
    if (this.current === session) {
      this.foldConfig({ version: 1, type: "settingsUpdated", payload: { settings } });
    }
    return settings;
  }

  async refreshProviders(input?: {
    readonly instanceId?: string;
    readonly cwd?: string;
    readonly refreshModels?: boolean;
  }): Promise<ReadonlyArray<ServerProvider>> {
    return this.session().refreshProviders(input);
  }

  async retryCrewTask(input: {
    readonly leadThreadId: ThreadId;
    readonly taskId: string;
  }): Promise<void> {
    return this.session().retryCrewTask(input);
  }

  /** The page of older turns before `beforeCursor`, the same size as the window the thread opened with. */
  async loadOlderTurns(
    threadId: ThreadId,
    beforeCursor: string,
  ): Promise<OrchestrationThreadDetailSnapshot> {
    return this.session().loadOlderTurns({
      threadId,
      beforeCursor,
      turnLimit: this.options.turnLimit ?? DEFAULT_OLDER_TURNS,
    });
  }

  /** The patch of one turn, read from the server's checkpoints. */
  async getCheckpointDiff(input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  }): Promise<string> {
    return this.session().getCheckpointDiff(input);
  }

  private session(): TransportSession {
    if (this.current === null) throw new Error(t("link.notConnected"));
    return this.current;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    this.threadHandle?.cancel();
    this.shellHandle?.cancel();
    this.configHandle?.cancel();
    const session = this.current;
    this.current = null;
    this.setStatus({ phase: "stopped", attempt: 0, retryAt: null, detail: null });
    await session?.close().catch(() => undefined);
    await this.loop?.catch(() => undefined);
  }

  private setStatus(status: LinkStatus): void {
    this.statusValue = status;
    this.events.status(status);
  }

  private subscribeConfig(session: TransportSession): void {
    const lose = this.onSessionLost;
    this.configProjection = Option.some({
      config: session.config,
      latestEvent: { version: 1, type: "snapshot", config: session.config },
      source: "live",
    });
    this.configHandle = session.subscribeConfig({
      onItem: (event) => {
        if (this.current === session) this.foldConfig(event);
      },
      onEnd: (error) => lose?.(error ?? t("link.configEnded")),
    });
  }

  private foldConfig(event: ServerConfigStreamEvent): void {
    const next = applyServerConfigProjection(this.configProjection, event);
    if (Option.isNone(next)) return;
    this.configProjection = next;
    this.lastConfig = next.value.config;
    this.events.config?.(next.value.config);
  }

  private subscribeShell(session: TransportSession): void {
    const lose = this.onSessionLost;
    const resumeFrom = this.shellSnapshot?.snapshotSequence;
    this.shellHandle = session.subscribeShell(
      {
        ...(resumeFrom !== undefined ? { afterSequence: resumeFrom } : {}),
        ...(session.config.shellResumeCompletionMarker === true
          ? { requestCompletionMarker: true }
          : {}),
      },
      {
        onItem: (item) => {
          if (item.kind === "snapshot") this.shellSnapshot = item.snapshot;
          else if (item.kind === "synchronized" || this.shellSnapshot === null) return;
          else this.shellSnapshot = applyShellStreamEvent(this.shellSnapshot, item);
          this.events.shell(this.shellSnapshot);
        },
        onEnd: (error) => lose?.(error ?? t("link.listEnded")),
      },
    );
  }

  private subscribeThread(session: TransportSession): void {
    const threadId = this.activeThread;
    if (threadId === null) return;
    const lose = this.onSessionLost;
    const resumeFrom = this.mirror.thread !== null ? this.mirror.sequence : null;
    this.threadHandle = session.subscribeThread(
      {
        threadId,
        ...(resumeFrom !== null ? { afterSequence: resumeFrom } : {}),
        ...(session.config.threadResumeCompletionMarker === true
          ? { requestCompletionMarker: true }
          : {}),
        ...(session.config.reasoningMessages === true ? { reasoningMessages: true } : {}),
        ...(session.config.threadSnapshotPagination === true && this.options.turnLimit !== undefined
          ? { turnLimit: this.options.turnLimit }
          : {}),
      },
      {
        onItem: (item) => {
          if (this.activeThread !== threadId) return;
          this.mirror = applyThreadItem(this.mirror, item);
          this.events.thread(this.mirror);
        },
        onEnd: (error, rejected) => {
          if (this.activeThread !== threadId) return;
          if (rejected === true) {
            this.closeThread();
            this.events.threadFailed(threadId, error ?? t("link.threadOpenFailed"));
            return;
          }
          lose?.(error ?? t("link.threadEnded"));
        },
      },
    );
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      this.setStatus({
        phase: attempt === 0 ? "connecting" : "reconnecting",
        attempt,
        retryAt: null,
        detail: this.statusValue.detail,
      });

      let session: TransportSession;
      try {
        session = await this.transport.open();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (cause instanceof TransportError && cause.kind === "blocked") {
          this.setStatus({
            phase: "blocked",
            attempt,
            retryAt: null,
            detail: message,
            ...(cause.reason !== null ? { reason: cause.reason } : {}),
          });
          return;
        }
        attempt += 1;
        if (!(await this.waitBeforeRetry(attempt, message))) return;
        continue;
      }
      if (this.stopped) {
        await session.close().catch(() => undefined);
        return;
      }

      this.current = session;
      this.lastConfig = session.config;
      const startedAt = this.now();
      const lost = new Promise<string>((resolve) => {
        this.onSessionLost = resolve;
      });
      const lose = this.onSessionLost;
      void session.closed.then((reason) => lose?.(reason));
      this.subscribeConfig(session);
      this.subscribeShell(session);
      this.subscribeThread(session);
      this.setStatus({ phase: "online", attempt: 0, retryAt: null, detail: null });

      const reason = await Promise.race([lost, this.stopSignal()]);
      this.onSessionLost = null;
      this.shellHandle?.cancel();
      this.threadHandle?.cancel();
      this.configHandle?.cancel();
      this.shellHandle = null;
      this.threadHandle = null;
      this.configHandle = null;
      this.current = null;
      await session.close().catch(() => undefined);
      if (this.stopped) return;

      attempt = this.now() - startedAt >= STABLE_SESSION_MS ? 1 : attempt + 1;
      if (!(await this.waitBeforeRetry(attempt, reason ?? t("link.connectionLost")))) return;
    }
  }

  private stopSignal(): Promise<null> {
    return new Promise<null>((resolve) => {
      this.wake = () => resolve(null);
    });
  }

  private async waitBeforeRetry(attempt: number, detail: string): Promise<boolean> {
    const delay = backoffDelay(attempt, this.random);
    this.setStatus({ phase: "reconnecting", attempt, retryAt: this.now() + delay, detail });
    await Promise.race([this.sleep(delay), this.stopSignal()]);
    return !this.stopped;
  }
}
