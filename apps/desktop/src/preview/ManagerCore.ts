import { BrowserWindow, webContents } from "electron";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { RECORDING_CURSOR_CHANNEL, RECORDING_CONTROLLER_CHANNEL } from "./GuestProtocol.ts";
import {
  CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS,
  CAPTURE_PAGE_RETRY_ATTEMPTS,
  CAPTURE_PAGE_RETRY_DELAY_MS,
  type FrameCaptureConsumer,
  type PreviewOperationContext,
  type PreviewTabState,
  attempt,
  currentIso,
  replaceMap,
} from "./ManagerSupport.ts";
import {
  PreviewArtifactPathOutsideDirectoryError,
  PreviewOperationError,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  PreviewWebviewNotInitializedError,
  isPreviewOperationError,
} from "./ManagerErrors.ts";
import { type PreviewNativeState } from "./ManagerState.ts";

export const makePreviewNativeCore = (ctx: PreviewNativeState) => {
  const {
    path,
    resolvedArtifactDirectory,
    mainWindowRef,
    tabsRef,
    listenersRef,
    frameCaptureSessionsRef,
    tabLifecycleLocks,
  } = ctx;

  const capturePageWithRetry = Effect.fn("PreviewManager.capturePageWithRetry")(function* (
    errorContext: PreviewOperationContext,
    tabId: string,
    wc: Electron.WebContents,
  ) {
    const requireCurrentGuest = Effect.gen(function* () {
      const tabs = yield* SynchronizedRef.get(tabsRef);
      if (wc.isDestroyed() || tabs.get(tabId)?.webContentsId !== wc.id) {
        return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId: wc.id });
      }
    });
    const capture = Effect.gen(function* () {
      // Check after the retry delay, and again before accepting its result.
      yield* requireCurrentGuest;
      const image = yield* Effect.tryPromise({
        // An abort-signal parameter makes a stalled promise interruptible.
        try: (_signal) => wc.capturePage(),
        catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
      }).pipe(
        Effect.timeout(CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS),
        Effect.catchTags({
          TimeoutError: (cause) =>
            Effect.fail(new PreviewOperationError({ ...errorContext, cause })),
        }),
      );
      yield* requireCurrentGuest;
      return image;
    });
    return yield* capture.pipe(
      Effect.retry({
        times: CAPTURE_PAGE_RETRY_ATTEMPTS - 1,
        schedule: Schedule.spaced(CAPTURE_PAGE_RETRY_DELAY_MS),
        while: isPreviewOperationError,
      }),
    );
  });

  const withTabLifecycleLock = <A, E, R>(
    tabId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const lifecycle = tabLifecycleLocks.get(tabId) ?? {
        semaphore: Semaphore.makeUnsafe(1),
        users: 0,
      };
      lifecycle.users += 1;
      tabLifecycleLocks.set(tabId, lifecycle);
      return lifecycle.semaphore.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lifecycle.users -= 1;
            if (lifecycle.users === 0 && tabLifecycleLocks.get(tabId) === lifecycle) {
              tabLifecycleLocks.delete(tabId);
            }
          }),
        ),
      );
    });

  const setWindowBackgroundThrottling = Effect.fnUntraced(function* (
    window: BrowserWindow,
    enabled: boolean,
  ) {
    if (window.isDestroyed()) return;
    yield* attempt({ operation: "frameCapture.setBackgroundThrottling" }, () =>
      window.webContents.setBackgroundThrottling(enabled),
    );
  });

  const setFrameCaptureBackgroundThrottling = Effect.fnUntraced(function* (enabled: boolean) {
    const mainWindow = yield* Ref.get(mainWindowRef);
    if (Option.isNone(mainWindow)) return;
    yield* setWindowBackgroundThrottling(mainWindow.value, enabled);
  });

  const setFrameCaptureWebContentsBackgroundThrottling = Effect.fnUntraced(function* (
    wc: Electron.WebContents,
    enabled: boolean,
  ) {
    if (wc.isDestroyed()) return;
    yield* attempt(
      {
        operation: "frameCapture.setBackgroundThrottling",
        webContentsId: wc.id,
      },
      () => wc.setBackgroundThrottling(enabled),
    );
  });

  const restoreFrameCaptureWebContentsBackgroundThrottling = Effect.fnUntraced(function* (
    webContentsIds: ReadonlySet<number>,
  ) {
    yield* Effect.forEach(
      webContentsIds,
      (webContentsId) => {
        const wc = webContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed()) return Effect.void;
        return setFrameCaptureWebContentsBackgroundThrottling(wc, true).pipe(
          Effect.retry({ times: 2 }),
          Effect.catch((error) =>
            Effect.logWarning("Failed to restore preview webview frame capture throttling.", {
              webContentsId,
              error,
            }),
          ),
        );
      },
      { concurrency: "unbounded", discard: true },
    );
  });

  const keepFrameCaptureWebContentsUnthrottled = Effect.fnUntraced(function* (
    tabId: string,
    wc: Electron.WebContents,
  ) {
    yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) => {
      const current = sessions.get(tabId);
      if (!current || current.unthrottledWebContentsIds.has(wc.id)) {
        return Effect.succeed([undefined, sessions] as const);
      }
      return setFrameCaptureWebContentsBackgroundThrottling(wc, false).pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            if (!current.consumers.has("recording")) return;
            const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
            yield* attempt({ operation: "recording.cursor", tabId, webContentsId: wc.id }, () =>
              wc.send(
                RECORDING_CURSOR_CHANNEL,
                true,
                current.recordingInputOptions,
                tab?.controller,
              ),
            );
          }),
        ),
        Effect.map(
          () =>
            [
              undefined,
              replaceMap(sessions, (copy) => {
                copy.set(tabId, {
                  ...current,
                  unthrottledWebContentsIds: new Set([...current.unthrottledWebContentsIds, wc.id]),
                });
              }),
            ] as const,
        ),
      );
    });
  });

  const stopFrameCapture = Effect.fn("PreviewManager.stopFrameCapture")(function* (
    tabId: string,
    consumer: FrameCaptureConsumer,
  ) {
    yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) =>
      Effect.gen(function* () {
        const current = sessions.get(tabId);
        if (!current || !current.consumers.has(consumer)) {
          return [undefined, sessions] as const;
        }
        if (consumer === "recording") {
          yield* Effect.forEach(current.unthrottledWebContentsIds, (id) =>
            attempt({ operation: "recording.cursor", tabId, webContentsId: id }, () => {
              const contents = webContents.fromId(id);
              if (contents && !contents.isDestroyed())
                contents.send(RECORDING_CURSOR_CHANNEL, false);
            }).pipe(Effect.ignore),
          );
        }
        const consumers = new Set(current.consumers);
        consumers.delete(consumer);
        if (consumers.size > 0) {
          return [
            consumer === "picture-in-picture" ? current.scope : undefined,
            replaceMap(sessions, (copy) => {
              copy.set(tabId, {
                ...current,
                scope: consumer === "picture-in-picture" ? null : current.scope,
                consumers,
                lastPictureInPictureFrame:
                  consumer === "picture-in-picture" ? null : current.lastPictureInPictureFrame,
              });
            }),
          ] as const;
        }
        const remainingSessions = replaceMap(sessions, (copy) => {
          copy.delete(tabId);
        });
        yield* restoreFrameCaptureWebContentsBackgroundThrottling(
          current.unthrottledWebContentsIds,
        );
        if (remainingSessions.size === 0) {
          yield* setFrameCaptureBackgroundThrottling(true).pipe(
            Effect.retry({ times: 2 }),
            Effect.catch((error) =>
              Effect.logWarning("Failed to restore preview frame capture throttling.", { error }),
            ),
          );
        }
        return [current.scope, remainingSessions] as const;
      }),
    ).pipe(
      Effect.flatMap((captureScope) =>
        captureScope ? Scope.close(captureScope, Exit.void).pipe(Effect.ignore) : Effect.void,
      ),
      Effect.uninterruptible,
    );
  });

  const deliverEvent = (
    eventKind: "state-change" | "recording-frame" | "recording-input" | "pointer-event",
    tabId: string,
    delivery: () => Effect.Effect<void>,
  ) =>
    Effect.suspend(delivery).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.logWarning("Desktop preview event listener failed.", {
            eventKind,
            tabId,
            cause,
          }),
      ),
    );

  const emit = Effect.fn("PreviewManager.emit")(function* (tabId: string, state: PreviewTabState) {
    const listeners = yield* Ref.get(listenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("state-change", tabId, () => listener(tabId, state)),
      { discard: true },
    );
  });

  const emitIfCurrent = Effect.fn("PreviewManager.emitIfCurrent")(function* (
    tabId: string,
    state: PreviewTabState,
  ) {
    if ((yield* SynchronizedRef.get(tabsRef)).get(tabId) === state) {
      yield* emit(tabId, state);
    }
  });

  const update = Effect.fn("PreviewManager.update")(function* (
    tabId: string,
    patch: Partial<PreviewTabState>,
    humanPoint?: { readonly x: number; readonly y: number },
  ) {
    const updatedAt = yield* currentIso;
    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (!current) return [Option.none<PreviewTabState>(), tabs] as const;
      const state: PreviewTabState = { ...current, ...patch, updatedAt };
      return [
        Option.some(state),
        replaceMap(tabs, (copy) => {
          copy.set(tabId, state);
        }),
      ] as const;
    });
    // emitIfCurrent, not emit: an event-driven writer such as syncTabAudible
    // can commit between the modify above and here, and republishing this
    // snapshot would roll the UI back to a value that writer will not send
    // again because it suppresses unchanged audibility.
    if (Option.isSome(next)) {
      if (patch.controller !== undefined && next.value.webContentsId != null) {
        const capture = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
        const webContentsId = next.value.webContentsId;
        if (capture?.consumers.has("recording")) {
          yield* attempt({ operation: "recording.controller", tabId }, () => {
            const contents = webContents.fromId(webContentsId);
            if (contents && !contents.isDestroyed())
              contents.send(RECORDING_CONTROLLER_CHANNEL, patch.controller, humanPoint);
          }).pipe(Effect.ignore);
        }
      }
      yield* emitIfCurrent(tabId, next.value);
    }
  });

  /**
   * Pushes a tab's zoom factor onto whichever guest it currently owns, reading
   * both at call time. Anything that applies zoom after an await goes through
   * here: a snapshot taken before the await can be older than a zoom action that
   * landed in between, and re-applying it would roll that action back.
   */
  const assertTabZoom = Effect.fn("PreviewManager.assertTabZoom")(function* (tabId: string) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab || tab.webContentsId == null) return;
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc || wc.isDestroyed()) return;
    yield* attempt({ operation: "assertTabZoom", tabId, webContentsId: wc.id }, () =>
      wc.setZoomFactor(tab.zoomFactor),
    ).pipe(Effect.ignore);
  });

  /**
   * Mute counterpart to {@link assertTabZoom}: pushes the tab's committed mute
   * onto whichever guest it currently owns, reading both at call time so an
   * older snapshot can never roll back a mute action that landed after it.
   *
   * Failures propagate so the user-facing setter can roll its commit back.
   * Reconciliation callers, where a guest going away mid-attach is expected,
   * discard the error at their own call site.
   */
  const assertTabAudioMuted = Effect.fn("PreviewManager.assertTabAudioMuted")(function* (
    tabId: string,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab || tab.webContentsId == null) return;
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc || wc.isDestroyed()) return;
    yield* attempt({ operation: "assertTabAudioMuted", tabId, webContentsId: wc.id }, () =>
      wc.setAudioMuted(tab.audioMuted),
    );
  });

  /**
   * Publishes an observed audibility value for the guest that reported it.
   * Shared by the `audio-state-changed` handler and the post-attach reconcile
   * so both drop values from a guest the tab no longer owns, and both skip
   * unchanged values: Chromium re-emits per media element, and republishing
   * would cost an IPC push per element rather than per real transition.
   */
  const syncTabAudible = Effect.fn("PreviewManager.syncTabAudible")(function* (
    tabId: string,
    wc: Electron.WebContents,
    audible: boolean,
  ) {
    if (wc.isDestroyed()) return;
    const updatedAt = yield* currentIso;
    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (
        !current ||
        current.webContentsId !== wc.id ||
        webContents.fromId(wc.id) !== wc ||
        current.audible === audible
      ) {
        return [Option.none<PreviewTabState>(), tabs] as const;
      }
      const state: PreviewTabState = { ...current, audible, updatedAt };
      return [
        Option.some(state),
        replaceMap(tabs, (copy) => {
          copy.set(tabId, state);
        }),
      ] as const;
    });
    if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value);
  });

  const requireWebContents = Effect.fn("PreviewManager.requireWebContents")(function* (
    tabId: string,
  ) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    const tab = tabs.get(tabId);
    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    if (tab.webContentsId == null) {
      return yield* new PreviewWebviewNotInitializedError({ tabId });
    }
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc) {
      return yield* new PreviewWebContentsNotFoundError({
        tabId,
        webContentsId: tab.webContentsId,
      });
    }
    return wc;
  });

  const resolveArtifactPath = (artifactPath: string) =>
    attempt({ operation: "resolveArtifactPath", artifactPath }, () => {
      const resolvedPath = path.resolve(artifactPath);
      const relativePath = path.relative(resolvedArtifactDirectory, resolvedPath);
      if (
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        return null;
      }
      return resolvedPath;
    }).pipe(
      Effect.filterOrFail(
        (resolvedPath) => resolvedPath !== null,
        () =>
          new PreviewArtifactPathOutsideDirectoryError({
            artifactPath,
            artifactDirectory: resolvedArtifactDirectory,
          }),
      ),
    );

  const tabIdForWebContents = Effect.fnUntraced(function* (webContentsId: number) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    return (
      Array.from(tabs.entries()).find(([, tab]) => tab.webContentsId === webContentsId)?.[0] ?? null
    );
  });

  return {
    capturePageWithRetry,
    withTabLifecycleLock,
    setWindowBackgroundThrottling,
    setFrameCaptureBackgroundThrottling,
    setFrameCaptureWebContentsBackgroundThrottling,
    keepFrameCaptureWebContentsUnthrottled,
    stopFrameCapture,
    deliverEvent,
    emit,
    emitIfCurrent,
    update,
    assertTabZoom,
    assertTabAudioMuted,
    syncTabAudible,
    requireWebContents,
    resolveArtifactPath,
    tabIdForWebContents,
  };
};

export type PreviewNativeCore = ReturnType<typeof makePreviewNativeCore>;
