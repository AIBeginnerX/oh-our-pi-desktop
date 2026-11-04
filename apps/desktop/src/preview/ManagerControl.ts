import type {
  DesktopPreviewRecordingFrame,
  PreviewAutomationActionEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  type BrowserControlSession,
  type CdpEvaluationResult,
  type PreviewInputSignal,
  attempt,
  attemptPromise,
  currentIso,
  currentMillis,
  inputSignalsMatch,
  nextCounter,
  pushBounded,
  replaceMap,
} from "./ManagerSupport.ts";
import {
  PreviewAutomationControlInterruptedError,
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationDevToolsOpenError,
  PreviewAutomationEvaluationError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationSelectorKind,
  PreviewManagerError,
  PreviewOperationError,
  isPreviewAutomationControlInterruptedError,
  isPreviewAutomationEvaluationError,
  isPreviewAutomationInvalidSelectorError,
  isPreviewOperationError,
  previewAutomationEvaluationDetail,
} from "./ManagerErrors.ts";
import { type PreviewNativeState } from "./ManagerState.ts";
import { type PreviewNativeCore } from "./ManagerCore.ts";

export type SendCommand = (
  method: string,
  commandParams?: Record<string, unknown>,
  sessionId?: string,
) => Effect.Effect<unknown, PreviewManagerError>;

export const makePreviewNativeControl = (ctx: PreviewNativeState & PreviewNativeCore) => {
  const {
    parentScope,
    runFork,
    playwrightInstallExpression,
    tabsRef,
    recordingFrameListenersRef,
    pickSessionsRef,
    controlSessionsRef,
    diagnosticsRef,
    expectedAgentInputsRef,
    controlEpochRef,
    actionTimelineRef,
    actionSequenceRef,
    frameCaptureSessionsRef,
    deliverEvent,
    update,
    tabIdForWebContents,
  } = ctx;

  const captureDiagnosticMessage = Effect.fnUntraced(function* (
    webContentsId: number,
    method: string,
    params: Record<string, unknown>,
  ) {
    const timestamp = yield* currentIso;
    yield* Ref.update(diagnosticsRef, (allDiagnostics) => {
      const current = allDiagnostics.get(webContentsId);
      if (!current) return allDiagnostics;
      const requestId = typeof params["requestId"] === "string" ? params["requestId"] : null;
      const next = (() => {
        if (method === "Runtime.consoleAPICalled") {
          const args = Array.isArray(params["args"]) ? params["args"] : [];
          const text = args
            .map((arg) => {
              if (typeof arg !== "object" || arg === null) return String(arg);
              const value = arg as Record<string, unknown>;
              return String(value["value"] ?? value["description"] ?? "");
            })
            .join(" ");
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: typeof params["type"] === "string" ? params["type"] : "log",
              text,
              timestamp,
              source: "console",
            }),
          };
        }
        if (method === "Runtime.exceptionThrown") {
          const details =
            typeof params["exceptionDetails"] === "object" && params["exceptionDetails"] !== null
              ? (params["exceptionDetails"] as Record<string, unknown>)
              : {};
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: "error",
              text: String(details["text"] ?? "Uncaught exception"),
              timestamp,
              source: "exception",
            }),
          };
        }
        if (method === "Log.entryAdded") {
          const entry =
            typeof params["entry"] === "object" && params["entry"] !== null
              ? (params["entry"] as Record<string, unknown>)
              : {};
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: typeof entry["level"] === "string" ? entry["level"] : "info",
              text: String(entry["text"] ?? ""),
              timestamp,
              source: typeof entry["source"] === "string" ? entry["source"] : "log",
            }),
          };
        }
        if (method === "Network.requestWillBeSent" && requestId) {
          const request =
            typeof params["request"] === "object" && params["request"] !== null
              ? (params["request"] as Record<string, unknown>)
              : {};
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) => {
              copy.set(requestId, {
                url: String(request["url"] ?? ""),
                method: String(request["method"] ?? "GET"),
              });
            }),
          };
        }
        if (method === "Network.responseReceived" && requestId) {
          const request = current.requests.get(requestId);
          const response =
            typeof params["response"] === "object" && params["response"] !== null
              ? (params["response"] as Record<string, unknown>)
              : {};
          const status = typeof response["status"] === "number" ? response["status"] : null;
          return request && status !== null && status >= 400
            ? {
                ...current,
                networkEntries: pushBounded(current.networkEntries, {
                  ...request,
                  status,
                  failed: true,
                  timestamp,
                }),
              }
            : current;
        }
        if (method === "Network.loadingFailed" && requestId) {
          const request = current.requests.get(requestId);
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) => {
              copy.delete(requestId);
            }),
            networkEntries: request
              ? pushBounded(current.networkEntries, {
                  ...request,
                  status: null,
                  failed: true,
                  errorText: String(params["errorText"] ?? "Network request failed"),
                  timestamp,
                })
              : current.networkEntries,
          };
        }
        if (method === "Network.loadingFinished" && requestId) {
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) => {
              copy.delete(requestId);
            }),
          };
        }
        return current;
      })();
      return replaceMap(allDiagnostics, (copy) => {
        copy.set(webContentsId, next);
      });
    });
  });

  const detachControlSession = Effect.fn("PreviewManager.detachControlSession")(function* (
    webContentsId: number,
  ) {
    const control = yield* SynchronizedRef.modify(controlSessionsRef, (sessions) => [
      sessions.get(webContentsId),
      replaceMap(sessions, (copy) => {
        copy.delete(webContentsId);
      }),
    ]);
    if (control) {
      yield* Scope.close(control.scope, Exit.void).pipe(Effect.ignore);
      return;
    }
    yield* Ref.update(diagnosticsRef, (diagnostics) =>
      replaceMap(diagnostics, (copy) => {
        copy.delete(webContentsId);
      }),
    );
  });

  const ensureControlSession = Effect.fn("PreviewManager.ensureControlSession")(function* (
    wc: Electron.WebContents,
  ) {
    return yield* SynchronizedRef.modifyEffect(
      controlSessionsRef,
      (
        sessions,
      ): Effect.Effect<
        readonly [BrowserControlSession, ReadonlyMap<number, BrowserControlSession>],
        PreviewManagerError
      > => {
        const existing = sessions.get(wc.id);
        if (existing) return Effect.succeed([existing, sessions] as const);
        if (wc.isDevToolsOpened()) {
          return Effect.fail(
            new PreviewAutomationDevToolsOpenError({
              webContentsId: wc.id,
            }),
          );
        }
        if (wc.debugger.isAttached()) {
          return Effect.fail(
            new PreviewAutomationDebuggerAttachedError({
              webContentsId: wc.id,
            }),
          );
        }
        const createControlSession = Effect.fn("PreviewManager.createControlSession")(function* () {
          const semaphore = yield* Semaphore.make(1);
          const scope = yield* Scope.fork(parentScope, "sequential");
          const wcDebugger = wc.debugger;
          const handleDebuggerMessage = Effect.fnUntraced(function* (
            method: string,
            params: Record<string, unknown>,
          ) {
            if (method === "Page.screencastFrame") {
              const sessionId = params["sessionId"];
              if (typeof sessionId === "number") {
                yield* attemptPromise(
                  {
                    operation: "ackScreencastFrame",
                    webContentsId: wc.id,
                  },
                  () => wcDebugger.sendCommand("Page.screencastFrameAck", { sessionId }),
                ).pipe(Effect.ignore);
              }
              const tabId = yield* tabIdForWebContents(wc.id);
              const metadata =
                typeof params["metadata"] === "object" && params["metadata"] !== null
                  ? (params["metadata"] as Record<string, unknown>)
                  : {};
              if (tabId && typeof params["data"] === "string") {
                const captureSession = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(
                  tabId,
                );
                if (captureSession?.consumers.has("recording")) {
                  const receivedAt = yield* currentIso;
                  const listeners = yield* Ref.get(recordingFrameListenersRef);
                  const frame: DesktopPreviewRecordingFrame = {
                    tabId,
                    data: params["data"],
                    width:
                      typeof metadata["deviceWidth"] === "number" ? metadata["deviceWidth"] : 0,
                    height:
                      typeof metadata["deviceHeight"] === "number" ? metadata["deviceHeight"] : 0,
                    receivedAt,
                  };
                  yield* Effect.forEach(
                    listeners,
                    (listener) =>
                      deliverEvent("recording-frame", frame.tabId, () => listener(frame)),
                    { discard: true },
                  );
                }
              }
            }
            yield* captureDiagnosticMessage(wc.id, method, params);
          });
          const onMessage: BrowserControlSession["onMessage"] = (_event, method, params) => {
            runFork(handleDebuggerMessage(method, params));
          };
          yield* Scope.addFinalizer(
            scope,
            Effect.all(
              [
                Ref.update(diagnosticsRef, (diagnostics) =>
                  replaceMap(diagnostics, (copy) => {
                    copy.delete(wc.id);
                  }),
                ),
                attempt({ operation: "detachControlSession", webContentsId: wc.id }, () => {
                  wcDebugger.off("message", onMessage);
                  if (wcDebugger.isAttached()) wcDebugger.detach();
                }).pipe(Effect.ignore),
              ],
              { discard: true },
            ),
          );
          const control: BrowserControlSession = {
            webContentsId: wc.id,
            debugger: wcDebugger,
            semaphore,
            scope,
            onMessage,
          };
          const initialize = Effect.fn("PreviewManager.initializeControlSession")(function* () {
            yield* Ref.update(diagnosticsRef, (diagnostics) =>
              replaceMap(diagnostics, (copy) => {
                copy.set(wc.id, {
                  consoleEntries: [],
                  networkEntries: [],
                  requests: new Map(),
                });
              }),
            );
            yield* attempt({ operation: "attachDebuggerListeners", webContentsId: wc.id }, () => {
              wcDebugger.on("message", onMessage);
              wcDebugger.attach("1.3");
            });
            yield* Effect.forEach(
              ["Runtime.enable", "Accessibility.enable", "Network.enable", "Log.enable"],
              (method) =>
                attemptPromise(
                  { operation: `initializeDebugger.${method}`, webContentsId: wc.id },
                  () => wcDebugger.sendCommand(method),
                ),
              { concurrency: "unbounded", discard: true },
            );
            return [
              control,
              replaceMap(sessions, (copy) => {
                copy.set(wc.id, control);
              }),
            ] as const;
          });
          return yield* initialize().pipe(
            Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
          );
        });
        return createControlSession();
      },
    );
  });

  const pushAction = (tabId: string, event: PreviewAutomationActionEvent) =>
    Ref.update(actionTimelineRef, (timelines) =>
      replaceMap(timelines, (copy) => {
        copy.set(tabId, [...(timelines.get(tabId) ?? []), event].slice(-200));
      }),
    );

  const replaceAction = (tabId: string, event: PreviewAutomationActionEvent) =>
    Ref.update(actionTimelineRef, (timelines) => {
      const timeline = timelines.get(tabId);
      if (!timeline) return timelines;
      return replaceMap(timelines, (copy) => {
        copy.set(
          tabId,
          timeline.map((candidate) => (candidate.id === event.id ? event : candidate)),
        );
      });
    });

  const prepareAutomationInput = Effect.fn("PreviewManager.prepareAutomationInput")(function* (
    send: SendCommand,
    enableRuntime: boolean,
  ) {
    yield* Effect.all(
      [
        ...(enableRuntime ? [send("Runtime.enable")] : []),
        send("Input.setIgnoreInputEvents", { ignore: false }),
      ],
      { concurrency: 2, discard: true },
    );
  });

  const withControlSession = Effect.fn("PreviewManager.withControlSession")(function* <A>(
    tabId: string,
    wc: Electron.WebContents,
    action: string,
    use: (
      send: SendCommand,
      sendCleanup: SendCommand,
      checkControl: Effect.Effect<void, PreviewManagerError>,
    ) => Effect.Effect<A, PreviewManagerError>,
  ) {
    const sequence = yield* nextCounter(actionSequenceRef);
    const startedAt = yield* currentIso;
    const millis = yield* currentMillis;
    const actionEvent: PreviewAutomationActionEvent = {
      id: `browser-action-${millis.toString(36)}-${sequence.toString(36)}`,
      action,
      status: "running",
      startedAt,
    };
    yield* pushAction(tabId, actionEvent);
    const epoch = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0;
    const control = yield* ensureControlSession(wc);
    const execute = Effect.fn("PreviewManager.executeControlAction")(function* () {
      yield* update(tabId, { controller: "agent" });
      const checkControl = Effect.gen(function* () {
        const currentEpoch = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0;
        if (currentEpoch !== epoch) {
          return yield* new PreviewAutomationControlInterruptedError({
            operation: action,
            tabId,
            webContentsId: wc.id,
          });
        }
      });
      const send: SendCommand = Effect.fn("PreviewManager.sendCommand")(
        function* (method, commandParams, sessionId) {
          yield* checkControl;
          const result = yield* attemptPromise(
            { operation: `${action}.${method}`, tabId, webContentsId: wc.id },
            () =>
              sessionId === undefined
                ? control.debugger.sendCommand(method, commandParams)
                : control.debugger.sendCommand(method, commandParams, sessionId),
          );
          yield* checkControl;
          return result;
        },
      );
      // Cleanup commands must still run after human input invalidates the action's
      // control epoch. Otherwise a partially dispatched input can leave Chromium
      // with a held key or focus emulation enabled for subsequent actions.
      const sendCleanup: SendCommand = Effect.fn("PreviewManager.sendCleanupCommand")(
        function* (method, commandParams, sessionId) {
          return yield* attemptPromise(
            {
              operation: `${action}.cleanup.${method}`,
              tabId,
              webContentsId: wc.id,
            },
            () =>
              sessionId === undefined
                ? control.debugger.sendCommand(method, commandParams)
                : control.debugger.sendCommand(method, commandParams, sessionId),
          );
        },
      );
      return yield* use(send, sendCleanup, checkControl);
    });
    const finalize = Effect.fn("PreviewManager.finalizeControlAction")(function* (
      exit: Exit.Exit<A, PreviewManagerError>,
    ) {
      const completedAt = yield* currentIso;
      if (exit._tag === "Success") {
        yield* replaceAction(tabId, {
          ...actionEvent,
          status: "succeeded",
          completedAt,
        });
      } else {
        const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
        const interrupted = isPreviewAutomationControlInterruptedError(error);
        const errorMessage = isPreviewOperationError(error)
          ? PreviewOperationError.toTimelineMessage(error)
          : isPreviewAutomationEvaluationError(error)
            ? PreviewAutomationEvaluationError.toTimelineMessage(error)
            : isPreviewAutomationInvalidSelectorError(error)
              ? PreviewAutomationInvalidSelectorError.toTimelineMessage(error)
              : error instanceof Error
                ? error.message
                : String(error);
        yield* replaceAction(tabId, {
          ...actionEvent,
          status: interrupted ? "interrupted" : "failed",
          completedAt,
          error: errorMessage,
        });
      }
      const tabs = yield* SynchronizedRef.get(tabsRef);
      if (tabs.has(tabId)) yield* update(tabId, { controller: "none" });
    });
    return yield* control.semaphore.withPermit(execute().pipe(Effect.onExit(finalize)));
  });

  const evaluateWithDebugger = <A = unknown>(
    tabId: string,
    send: SendCommand,
    expression: string,
    returnByValue: boolean,
    awaitPromise = true,
  ): Effect.Effect<A, PreviewManagerError> =>
    send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    }).pipe(
      Effect.flatMap((rawResponse) => {
        const response = rawResponse as CdpEvaluationResult;
        if (!response.exceptionDetails) {
          return Effect.succeed(response.result?.value as A);
        }
        const detail = previewAutomationEvaluationDetail(response.exceptionDetails);
        return Effect.fail(
          new PreviewAutomationEvaluationError({
            tabId,
            detailKind: detail.detailKind,
            detailLength: detail.detail?.length ?? 0,
            cause: response.exceptionDetails,
          }),
        );
      }),
    );

  const automationLocator = (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
  }): string | null => input.locator ?? (input.selector ? `css=${input.selector}` : null);

  const automationSelectorDiagnostics = (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
  }): {
    readonly selectorKind: PreviewAutomationSelectorKind;
    readonly selectorLength?: number;
  } => {
    if (input.locator !== undefined) {
      return { selectorKind: "locator", selectorLength: input.locator.length };
    }
    if (input.selector !== undefined) {
      return { selectorKind: "selector", selectorLength: input.selector.length };
    }
    return { selectorKind: "focused-element" };
  };

  const ensurePlaywrightInjected = Effect.fn("PreviewManager.ensurePlaywrightInjected")(function* (
    tabId: string,
    send: SendCommand,
  ) {
    const installed = yield* evaluateWithDebugger<boolean>(
      tabId,
      send,
      "Boolean(globalThis.__t3PlaywrightInjected)",
      true,
    );
    if (installed) return;
    const expression = yield* playwrightInstallExpression.pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "ensurePlaywrightInjected",
            tabId,
            cause,
          }),
      ),
    );
    yield* evaluateWithDebugger(tabId, send, expression, true);
  });

  const cancelPickElement = Effect.fn("PreviewManager.cancelPickElement")(function* (
    tabId: string,
  ) {
    const session = (yield* Ref.get(pickSessionsRef)).get(tabId);
    if (session) yield* session.cancel;
  });

  const consumeExpectedAgentInput = Effect.fn("PreviewManager.consumeExpectedAgentInput")(
    function* (tabId: string, signal: PreviewInputSignal) {
      const now = yield* currentMillis;
      return yield* Ref.modify(expectedAgentInputsRef, (allExpected) => {
        const pending = (allExpected.get(tabId) ?? []).filter(
          (expected) => expected.expiresAt > now,
        );
        const index = pending.findIndex((expected) => inputSignalsMatch(expected.signal, signal));
        const matched = index >= 0;
        const nextPending = matched
          ? pending.filter((_, pendingIndex) => pendingIndex !== index)
          : pending;
        return [
          matched,
          replaceMap(allExpected, (copy) => {
            if (nextPending.length === 0) copy.delete(tabId);
            else copy.set(tabId, nextPending);
          }),
        ] as const;
      });
    },
  );

  const expectAgentInput = Effect.fn("PreviewManager.expectAgentInput")(function* (
    tabId: string,
    signal: PreviewInputSignal,
  ) {
    const now = yield* currentMillis;
    yield* Ref.update(expectedAgentInputsRef, (allExpected) =>
      replaceMap(allExpected, (copy) => {
        const pending = (allExpected.get(tabId) ?? []).filter(
          (expected) => expected.expiresAt > now,
        );
        copy.set(tabId, [...pending, { signal, expiresAt: now + 1_000 }]);
      }),
    );
  });

  return {
    detachControlSession,
    ensureControlSession,
    prepareAutomationInput,
    automationSelectorDiagnostics,
    withControlSession,
    evaluateWithDebugger,
    automationLocator,
    ensurePlaywrightInjected,
    cancelPickElement,
    consumeExpectedAgentInput,
    expectAgentInput,
  };
};

export type PreviewNativeControl = ReturnType<typeof makePreviewNativeControl>;
