import * as NodeCrypto from "node:crypto";
import type {
  DesktopPreviewPointerEvent,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { clipboard, webContents } from "electron";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { RECORDING_POINTER_CHANNEL, RECORDING_KEY_CHANNEL } from "./GuestProtocol.ts";
import {
  makePreviewAutomationKeySequence,
  makePreviewAutomationNativeKeySequence,
  previewAutomationEditingCommandExpression,
} from "./PreviewKeyboard.ts";
import {
  AGENT_CURSOR_CLICK_LEAD_MS,
  AGENT_CURSOR_MOVE_MS,
  MAX_EVALUATION_BYTES,
  MAX_INTERACTIVE_ELEMENTS,
  MAX_INTERACTIVE_ELEMENT_NAME_LENGTH,
  MAX_SCREENSHOT_WIDTH,
  MAX_VISIBLE_TEXT_LENGTH,
  attempt,
  attemptPromise,
  currentIso,
  currentMillis,
  encodeJson,
  nextCounter,
} from "./ManagerSupport.ts";
import {
  PreviewAutomationCoordinatesOutsideViewportError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationTargetNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewManagerError,
  PreviewOperationError,
} from "./ManagerErrors.ts";
import { type PreviewNativeState } from "./ManagerState.ts";
import { type PreviewNativeCore } from "./ManagerCore.ts";
import { type PreviewNativeControl, type SendCommand } from "./ManagerControl.ts";

export const makePreviewNativeAutomation = (
  ctx: PreviewNativeState & PreviewNativeCore & PreviewNativeControl,
) => {
  const {
    hostPlatform,
    tabsRef,
    pointerEventListenersRef,
    diagnosticsRef,
    actionTimelineRef,
    pointerSequenceRef,
    frameCaptureSessionsRef,
    capturePageWithRetry,
    deliverEvent,
    requireWebContents,
    prepareAutomationInput,
    automationSelectorDiagnostics,
    withControlSession,
    evaluateWithDebugger,
    automationLocator,
    ensurePlaywrightInjected,
    expectAgentInput,
  } = ctx;

  const automationStatus = Effect.fn("PreviewManager.automationStatus")(function* (tabId: string) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab || tab.webContentsId == null) {
      const navStatus = tab?.navStatus;
      return {
        available: false,
        visible: true,
        tabId,
        url: !navStatus || navStatus.kind === "Idle" ? null : navStatus.url,
        title: !navStatus || navStatus.kind === "Idle" ? null : navStatus.title,
        loading: navStatus?.kind === "Loading",
      };
    }
    const wc = webContents.fromId(tab.webContentsId);
    return !wc || wc.isDestroyed()
      ? {
          available: false,
          visible: true,
          tabId,
          url: null,
          title: null,
          loading: false,
        }
      : {
          available: true,
          visible: true,
          tabId,
          url: wc.getURL() || null,
          title: wc.getTitle() || null,
          loading: wc.isLoading(),
        };
  });

  const captureAutomationSnapshot = Effect.fn("PreviewManager.captureAutomationSnapshot")(
    function* (tabId: string, wc: Electron.WebContents, send: SendCommand) {
      yield* Effect.all([send("Runtime.enable"), send("Accessibility.enable")], {
        concurrency: 2,
        discard: true,
      });
      const page = yield* evaluateWithDebugger<{
        url: string;
        title: string;
        loading: boolean;
        visibleText: string;
        interactiveElements: PreviewAutomationSnapshot["interactiveElements"];
      }>(
        tabId,
        send,
        `(() => {
          const selectorFor = (element) => {
            if (element.id) return "#" + CSS.escape(element.id);
            for (const attribute of ["data-testid", "name"]) {
              const value = element.getAttribute(attribute);
              if (value) return element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
            }
            const buildParts = (current, parts = []) => {
              if (!current || current.nodeType !== Node.ELEMENT_NODE || parts.length >= 8) {
                return parts;
              }
              const parent = current.parentElement;
              const siblings = parent
                ? Array.from(parent.children).filter((child) => child.tagName === current.tagName)
                : [];
              const base = current.tagName.toLowerCase();
              const part = siblings.length > 1
                ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")"
                : base;
              return buildParts(parent, [part, ...parts]);
            };
            return buildParts(element).join(" > ");
          };
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          };
          const elements = Array.from(document.querySelectorAll(
            "a[href],button,input,textarea,select,[role],[tabindex]"
          )).filter(visible).slice(0, ${MAX_INTERACTIVE_ELEMENTS}).map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              name: (element.getAttribute("aria-label") || element.innerText || element.getAttribute("name") || "").slice(0, ${MAX_INTERACTIVE_ELEMENT_NAME_LENGTH}),
              selector: selectorFor(element),
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            };
          });
          return {
            url: location.href,
            title: document.title,
            loading: document.readyState !== "complete",
            visibleText: (document.body?.innerText || "").slice(0, ${MAX_VISIBLE_TEXT_LENGTH}),
            interactiveElements: elements
          };
        })()`,
        true,
      );
      const [accessibility, sourceImage, diagnostics, timelines] = yield* Effect.all([
        send("Accessibility.getFullAXTree"),
        capturePageWithRetry(
          {
            operation: "automationSnapshot.capturePage",
            tabId,
            webContentsId: wc.id,
          },
          tabId,
          wc,
        ),
        Ref.get(diagnosticsRef),
        Ref.get(actionTimelineRef),
      ]);
      const sourceSize = sourceImage.getSize();
      const image =
        sourceSize.width > MAX_SCREENSHOT_WIDTH
          ? sourceImage.resize({ width: MAX_SCREENSHOT_WIDTH })
          : sourceImage;
      const size = image.getSize();
      const browserDiagnostics = diagnostics.get(wc.id);
      return {
        ...page,
        accessibilityTree: accessibility,
        consoleEntries: [...(browserDiagnostics?.consoleEntries ?? [])],
        networkEntries: [...(browserDiagnostics?.networkEntries ?? [])],
        actionTimeline: [...(timelines.get(tabId) ?? [])],
        screenshot: {
          mimeType: "image/png" as const,
          data: image.toPNG().toString("base64"),
          width: size.width,
          height: size.height,
        },
      };
    },
  );

  const automationSnapshot = Effect.fn("PreviewManager.automationSnapshot")(function* (
    tabId: string,
  ) {
    const wc = yield* requireWebContents(tabId);
    return yield* withControlSession(tabId, wc, "snapshot", (send) =>
      captureAutomationSnapshot(tabId, wc, send),
    );
  });

  const resolveClickPoint = Effect.fn("PreviewManager.resolveClickPoint")(function* (
    tabId: string,
    send: SendCommand,
    input: PreviewAutomationClickInput,
  ) {
    if (!("selector" in input) && !("locator" in input)) {
      return { x: input.x!, y: input.y! };
    }
    const locator = automationLocator(input)!;
    yield* ensurePlaywrightInjected(tabId, send);
    const locatorJson = yield* encodeJson(
      { operation: "automationClick.encodeLocator", tabId },
      locator,
    );
    const point = yield* evaluateWithDebugger<
      { x: number; y: number } | { invalidSelector: true; message: string } | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
          try {
            const injected = globalThis.__t3PlaywrightInjected;
            const parsed = injected.parseSelector(${locatorJson});
            const element = injected.querySelector(parsed, document, true);
            if (!element) return { notFound: true };
            const visible = injected.elementState(element, "visible");
            const enabled = injected.elementState(element, "enabled");
            if (!visible.matches || !enabled.matches) return { notFound: true };
            element.scrollIntoView({ block: "center", inline: "center" });
            const rect = element.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      true,
    );
    if ("invalidSelector" in point) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "click",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: point.message.length,
        cause: point,
      });
    }
    if ("notFound" in point) {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "click",
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
    return point;
  });

  const emitPointerEvent = Effect.fn("PreviewManager.emitPointerEvent")(function* (
    event: DesktopPreviewPointerEvent,
  ) {
    const recording = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(event.tabId);
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(event.tabId);
    const webContentsId = tab?.webContentsId;
    if (recording?.consumers.has("recording") && webContentsId != null) {
      yield* attempt({ operation: "recording.pointer", tabId: event.tabId }, () => {
        const contents = webContents.fromId(webContentsId);
        if (contents && !contents.isDestroyed()) contents.send(RECORDING_POINTER_CHANNEL, event);
      });
    }
    const listeners = yield* Ref.get(pointerEventListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("pointer-event", event.tabId, () => listener(event)),
      { discard: true },
    );
  });

  const performAutomationClick = Effect.fn("PreviewManager.performAutomationClick")(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
    send: SendCommand,
  ) {
    yield* prepareAutomationInput(send, true);
    const point = yield* resolveClickPoint(tabId, send, input);
    const viewport = yield* evaluateWithDebugger<{ width: number; height: number }>(
      tabId,
      send,
      "({ width: window.innerWidth, height: window.innerHeight })",
      true,
    );
    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) {
      return yield* new PreviewAutomationCoordinatesOutsideViewportError({
        tabId,
        x: point.x,
        y: point.y,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      });
    }
    const moveSequence = yield* nextCounter(pointerSequenceRef);
    const moveCreatedAt = yield* currentIso;
    yield* emitPointerEvent({
      tabId,
      phase: "move",
      ...point,
      sequence: moveSequence,
      createdAt: moveCreatedAt,
    });
    yield* Effect.sleep(AGENT_CURSOR_MOVE_MS);
    const clickSequence = yield* nextCounter(pointerSequenceRef);
    const clickCreatedAt = yield* currentIso;
    yield* emitPointerEvent({
      tabId,
      phase: "click",
      ...point,
      sequence: clickSequence,
      createdAt: clickCreatedAt,
    });
    yield* Effect.sleep(AGENT_CURSOR_CLICK_LEAD_MS);
    yield* expectAgentInput(tabId, { kind: "pointer", ...point, button: 0 });
    yield* send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
    yield* send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    });
  });

  const automationClick = Effect.fn("PreviewManager.automationClick")(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "click", (send) =>
      performAutomationClick(tabId, input, send),
    );
  });

  const typeIntoAutomationTarget = Effect.fn("PreviewManager.typeIntoAutomationTarget")(function* (
    tabId: string,
    send: SendCommand,
    input: PreviewAutomationTypeInput,
  ) {
    const locator = automationLocator(input);
    if (locator) yield* ensurePlaywrightInjected(tabId, send);
    const locatorJson = locator
      ? yield* encodeJson({ operation: "automationType.encodeLocator", tabId }, locator)
      : null;
    const textJson = yield* encodeJson(
      { operation: "automationType.encodeText", tabId },
      input.text,
    );
    const result = yield* evaluateWithDebugger<
      | { ok: true }
      | { invalidSelector: true; message: string }
      | { notEditable: true }
      | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
          try {
            const element = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : "document.activeElement"};
            if (!element) return { notFound: true };
            const textControl =
              element instanceof HTMLTextAreaElement ||
              (element instanceof HTMLInputElement &&
                !new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]).has(element.type));
            const editable = textControl || element.isContentEditable;
            if (!editable || element.disabled || element.readOnly) return { notEditable: true };
            element.focus();
            if (document.activeElement !== element) return { notEditable: true };
            const clear = ${input.clear ?? false};
            if (clear) {
              if (textControl) {
                element.select();
              } else {
                const range = document.createRange();
                range.selectNodeContents(element);
                const selection = document.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
              }
            }
            const text = ${textJson};
            let inserted = true;
            if (text.length > 0) {
              inserted = document.execCommand("insertText", false, text);
            } else if (clear) {
              document.execCommand("delete", false);
              const cleared = textControl
                ? element.value.length === 0
                : (element.textContent ?? "").length === 0;
              if (!cleared) {
                if (textControl) {
                  const prototype = element instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
                  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
                  if (valueSetter) valueSetter.call(element, "");
                  else element.value = "";
                } else {
                  element.replaceChildren();
                }
                element.dispatchEvent(new InputEvent("input", {
                  bubbles: true,
                  inputType: "deleteContentBackward",
                }));
              }
            }
            if (!inserted) return { notEditable: true };
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      true,
    );
    if ("invalidSelector" in result) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "type",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: result.message.length,
        cause: result,
      });
    }
    if ("notFound" in result) {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "type",
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
    if ("notEditable" in result) {
      return yield* new PreviewAutomationTargetNotEditableError({
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
  });

  const performAutomationType = Effect.fn("PreviewManager.performAutomationType")(function* (
    tabId: string,
    input: PreviewAutomationTypeInput,
    send: SendCommand,
  ) {
    // CDP Input.insertText silently drops text until Electron has activated a hidden
    // guest WebContents with a pointer event. Editing in the page runtime keeps
    // background automation deterministic without stealing foreground app focus.
    yield* typeIntoAutomationTarget(tabId, send, input);
  });

  const automationType = Effect.fn("PreviewManager.automationType")(function* (
    tabId: string,
    input: PreviewAutomationTypeInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "type", (send) =>
      performAutomationType(tabId, input, send),
    );
  });

  const withNativeKeyReceipt = Effect.fn("PreviewManager.withNativeKeyReceipt")(function* (
    tabId: string,
    wc: Electron.WebContents,
    dispatch: Effect.Effect<void, PreviewManagerError>,
    checkControl: Effect.Effect<void, PreviewManagerError>,
  ) {
    const context = { operation: "automationPress.awaitNativeKey", tabId, webContentsId: wc.id };
    const evaluate = (frame: Electron.WebFrameMain, expression: string) =>
      attemptPromise(context, () => frame.executeJavaScript(expression));
    const { frames, receiptKey } = yield* Effect.acquireRelease(
      attempt(context, () => ({
        frames: wc.mainFrame.framesInSubtree,
        receiptKey: JSON.stringify(`__t3NativeKey_${NodeCrypto.randomUUID()}`),
      })),
      ({ frames, receiptKey }) =>
        Effect.forEach(
          frames,
          (frame) =>
            evaluate(frame, `globalThis[${receiptKey}]?.dispose()`).pipe(
              Effect.timeoutOption(1_000),
              Effect.ignore,
            ),
          { concurrency: "unbounded", discard: true },
        ),
    );
    yield* Effect.gen(function* () {
      for (const frame of frames) {
        yield* checkControl;
        yield* evaluate(
          frame,
          `(() => {
              const receiptKey = ${receiptKey};
              const counts = performance.eventCounts;
              if (!counts) throw new Error("Native key delivery counters are unavailable.");
              const keyUpsBefore = counts.get("keyup") ?? 0;
              const keyDownsBefore = counts.get("keydown") ?? 0;
              let settle;
              let animationFrame = 0;
              const promise = new Promise(resolve => { settle = resolve; });
              const finish = delivered => {
                cancelAnimationFrame(animationFrame);
                window.removeEventListener("pagehide", onPageHide, true);
                settle(delivered);
              };
              // Chromium counts trusted keys before dispatching page listeners,
              // so stopImmediatePropagation cannot hide completed input.
              const observe = () => {
                if ((counts.get("keyup") ?? 0) > keyUpsBefore) finish(true);
                else animationFrame = requestAnimationFrame(observe);
              };
              const onPageHide = () => finish(
                (counts.get("keyup") ?? 0) > keyUpsBefore ||
                (counts.get("keydown") ?? 0) > keyDownsBefore,
              );
              globalThis[receiptKey] = { promise, dispose: () => {
                finish(false);
                delete globalThis[receiptKey];
              }};
              window.addEventListener("pagehide", onPageHide, true);
              animationFrame = requestAnimationFrame(observe);
            })()`,
        );
      }
      yield* checkControl;
      yield* dispatch;
      yield* attemptPromise(context, () =>
        Promise.any(
          frames.map(async (frame) => {
            const delivered: unknown = await frame.executeJavaScript(
              `globalThis[${receiptKey}]?.promise`,
            );
            if (delivered !== true)
              throw new Error(
                "The preview document changed before native key delivery was confirmed.",
              );
          }),
        ),
      );
      yield* checkControl;
    }).pipe(
      Effect.timeout(5_000),
      Effect.catchTags({
        TimeoutError: () =>
          Effect.fail(new PreviewAutomationTimeoutError({ tabId, timeoutMs: 5_000 })),
      }),
    );
  }, Effect.scoped);

  const resolveKeyboardTarget = Effect.fn("PreviewManager.resolveKeyboardTarget")(function* (
    tabId: string,
    send: SendCommand,
    sendCleanup: SendCommand,
    checkControl: Effect.Effect<void, PreviewManagerError>,
  ) {
    const context = { operation: "automationPress.resolveFocusedFrame", tabId };
    let sessionId: string | undefined;
    let contextId: number | undefined;
    while (true) {
      const evaluated = (yield* send(
        "Runtime.evaluate",
        {
          expression: `(() => {
            let element = document.activeElement;
            while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
            return element?.tagName === "IFRAME" ? element : null;
          })()`,
          ...(contextId === undefined ? {} : { contextId }),
        },
        sessionId,
      )) as { result?: { objectId?: string; subtype?: string } };
      if (evaluated.result?.subtype === "null") break;
      const objectId = evaluated.result?.objectId;
      if (!objectId)
        return yield* new PreviewOperationError({
          ...context,
          cause: new Error("The focused preview frame could not be resolved."),
        });
      const described = (yield* send("DOM.describeNode", { objectId }, sessionId).pipe(
        Effect.ensuring(
          sendCleanup("Runtime.releaseObject", { objectId }, sessionId).pipe(Effect.ignore),
        ),
      )) as { node?: { frameId?: string } };
      const frameId = described.node?.frameId;
      if (!frameId)
        return yield* new PreviewOperationError({
          ...context,
          cause: new Error("The focused preview iframe is unavailable."),
        });
      const targets = (yield* send("Target.getTargets")) as {
        targetInfos?: ReadonlyArray<{ targetId: string; type: string }>;
      };
      if (
        targets.targetInfos?.some(
          (target) => target.type === "iframe" && target.targetId === frameId,
        )
      ) {
        yield* checkControl;
        // Register cleanup before checking the epoch again: a successful
        // attach must be released even when human input interrupts its reply.
        sessionId = yield* Effect.acquireRelease(
          sendCleanup("Target.attachToTarget", { targetId: frameId, flatten: true }).pipe(
            Effect.flatMap((response) =>
              attempt(context, () => {
                const attached = response as { sessionId?: string };
                if (!attached.sessionId)
                  throw new Error("The focused preview iframe could not be attached.");
                return attached.sessionId;
              }),
            ),
          ),
          (attachedSessionId) =>
            sendCleanup("Target.detachFromTarget", { sessionId: attachedSessionId }).pipe(
              Effect.ignore,
            ),
        );
        yield* checkControl;
        contextId = undefined;
      } else {
        const world = (yield* send(
          "Page.createIsolatedWorld",
          {
            frameId,
            worldName: "t3-preview-key-target",
          },
          sessionId,
        )) as { executionContextId?: number };
        if (typeof world.executionContextId !== "number")
          return yield* new PreviewOperationError({
            ...context,
            cause: new Error("The focused preview iframe context is unavailable."),
          });
        contextId = world.executionContextId;
      }
    }
    return { sessionId, contextId };
  });

  const performAutomationPress = Effect.fn("PreviewManager.performAutomationPress")(function* (
    tabId: string,
    wc: Electron.WebContents,
    input: PreviewAutomationPressInput,
    send: SendCommand,
    sendCleanup: SendCommand,
    checkControl: Effect.Effect<void, PreviewManagerError>,
  ) {
    yield* prepareAutomationInput(send, false);
    const keySequence = makePreviewAutomationNativeKeySequence(input, {
      isMac: hostPlatform === "darwin",
    });
    const recording = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
    if (recording?.consumers.has("recording") && recording.recordingInputOptions?.showKeyPresses) {
      yield* attempt({ operation: "recording.key", tabId, webContentsId: wc.id }, () =>
        wc.send(RECORDING_KEY_CHANNEL, {
          key: keySequence.signal.key || input.key,
          metaKey: input.modifiers?.includes("Meta") ?? false,
          ctrlKey: input.modifiers?.includes("Control") ?? false,
          altKey: input.modifiers?.includes("Alt") ?? false,
          shiftKey: input.modifiers?.includes("Shift") ?? false,
        }),
      );
    }
    // CDP keyboard dispatch follows the embedder's focused renderer, and
    // WebContents.focus() is a no-op for webview guests. Native input targets
    // this guest's widget directly, so Enter cannot submit the host composer.
    yield* Effect.gen(function* () {
      const { sessionId, contextId } = yield* resolveKeyboardTarget(
        tabId,
        send,
        sendCleanup,
        checkControl,
      );
      // Only descendant renderer sessions bypass Chromium's desktop focus lookup.
      if (sessionId) {
        const keys = makePreviewAutomationKeySequence(input, { isMac: hostPlatform === "darwin" });
        yield* Effect.acquireRelease(Effect.void, () =>
          sendCleanup("Emulation.setFocusEmulationEnabled", { enabled: false }, sessionId).pipe(
            Effect.ignore,
          ),
        );
        yield* send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
        yield* Effect.acquireRelease(Effect.void, () =>
          sendCleanup("Input.dispatchKeyEvent", keys.keyUp, sessionId).pipe(Effect.ignore),
        );
        yield* send("Input.dispatchKeyEvent", keys.keyDown, sessionId);
        return;
      }
      if (keySequence.commands?.length) {
        const context = {
          operation: "automationPress.editFocusedFrame",
          tabId,
          webContentsId: wc.id,
        };
        const evaluate = (expression: string, cleanup = false) =>
          evaluateWithDebugger(
            tabId,
            (method, params) =>
              (cleanup ? sendCleanup : send)(method, {
                ...params,
                ...(contextId === undefined ? {} : { contextId }),
              }),
            expression,
            true,
          );
        const clipboardData = keySequence.commands.includes("paste")
          ? yield* attemptPromise(context, async () => {
              const formats: Array<{ type: string; data: string }> = [];
              for (const item of await clipboard.read()) {
                for (const type of item.types) {
                  if (type.startsWith("electron ")) continue;
                  const blob = await item.getType(type);
                  if (!("arrayBuffer" in blob)) continue;
                  formats.push({
                    type,
                    data: type.startsWith("text/")
                      ? await blob.text()
                      : Buffer.from(await blob.arrayBuffer()).toString("base64"),
                  });
                }
              }
              return formats;
            })
          : [];
        yield* checkControl;
        const expression = previewAutomationEditingCommandExpression(
          input,
          keySequence,
          clipboardData,
        );
        const selectionKey = yield* encodeJson(
          context,
          `__t3EditingSelection_${NodeCrypto.randomUUID()}`,
        );
        // Editing requires an active document. Preserve the target
        // and selection across focus handlers without focusing the desktop.
        yield* Effect.acquireUseRelease(
          evaluate(`(() => {
            let element = document.activeElement;
            while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
            const selection = document.getSelection();
            const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
            const backward = selection?.direction === "backward";
            const start = element?.selectionStart;
            const end = element?.selectionEnd;
            const direction = element?.selectionDirection;
            globalThis[${selectionKey}] = () => {
              element?.focus({ preventScroll: true });
              if (typeof start === "number") element.setSelectionRange(start, end, direction);
              else {
                selection?.removeAllRanges();
                if (range && backward) selection.setBaseAndExtent(
                  range.endContainer, range.endOffset, range.startContainer, range.startOffset,
                );
                else if (range) selection.addRange(range);
              }
            };
          })()`),
          () =>
            Effect.gen(function* () {
              yield* send("Emulation.setFocusEmulationEnabled", { enabled: true });
              yield* evaluate(`globalThis[${selectionKey}]();${expression}`);
            }),
          () => evaluate(`delete globalThis[${selectionKey}]`, true).pipe(Effect.ignore),
        );
        yield* checkControl;
        return;
      }
      yield* send("Emulation.setFocusEmulationEnabled", { enabled: true });
      yield* withNativeKeyReceipt(
        tabId,
        wc,
        Effect.gen(function* () {
          yield* expectAgentInput(tabId, keySequence.signal);
          yield* attempt(
            { operation: "automationPress.sendInputEvent", tabId, webContentsId: wc.id },
            () => {
              try {
                wc.sendInputEvent(keySequence.keyDown);
                if (keySequence.char) wc.sendInputEvent(keySequence.char);
              } finally {
                wc.sendInputEvent(keySequence.keyUp);
              }
            },
          );
        }),
        checkControl,
      );
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        sendCleanup("Emulation.setFocusEmulationEnabled", { enabled: false }).pipe(Effect.ignore),
      ),
    );
  });

  const automationPress = Effect.fn("PreviewManager.automationPress")(function* (
    tabId: string,
    input: PreviewAutomationPressInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "press", (send, sendCleanup, checkControl) =>
      performAutomationPress(tabId, wc, input, send, sendCleanup, checkControl),
    );
  });

  const performAutomationScroll = Effect.fn("PreviewManager.performAutomationScroll")(function* (
    tabId: string,
    input: PreviewAutomationScrollInput,
    send: SendCommand,
  ) {
    yield* send("Runtime.enable");
    const locator = automationLocator(input);
    if (locator) yield* ensurePlaywrightInjected(tabId, send);
    const locatorJson = locator
      ? yield* encodeJson({ operation: "automationScroll.encodeLocator", tabId }, locator)
      : null;
    const result = yield* evaluateWithDebugger<
      { ok: true } | { invalidSelector: true; message: string } | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
        try {
          const target = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : "window"};
          if (!target) return { notFound: true };
          target.scrollBy({ left: ${input.deltaX ?? 0}, top: ${input.deltaY ?? 0}, behavior: "instant" });
          return { ok: true };
        } catch (error) {
          return { invalidSelector: true, message: String(error) };
        }
      })()`,
      true,
    );
    if ("invalidSelector" in result) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "scroll",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: result.message.length,
        cause: result,
      });
    }
    if ("notFound" in result) {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "scroll",
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
  });

  const automationScroll = Effect.fn("PreviewManager.automationScroll")(function* (
    tabId: string,
    input: PreviewAutomationScrollInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "scroll", (send) =>
      performAutomationScroll(tabId, input, send),
    );
  });

  const performAutomationEvaluate = Effect.fn("PreviewManager.performAutomationEvaluate")(
    function* (tabId: string, input: PreviewAutomationEvaluateInput, send: SendCommand) {
      yield* send("Runtime.enable");
      const value = yield* evaluateWithDebugger(
        tabId,
        send,
        input.expression,
        input.returnByValue ?? true,
        input.awaitPromise ?? true,
      );
      const serialized = yield* encodeJson(
        { operation: "automationEvaluate.encodeResult", tabId },
        value,
      );
      const actualBytes = Buffer.byteLength(serialized, "utf8");
      if (actualBytes > MAX_EVALUATION_BYTES) {
        return yield* new PreviewAutomationResultTooLargeError({
          tabId,
          actualBytes,
          maximumBytes: MAX_EVALUATION_BYTES,
        });
      }
      return value;
    },
  );

  const automationEvaluate = Effect.fn("PreviewManager.automationEvaluate")(function* (
    tabId: string,
    input: PreviewAutomationEvaluateInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    return yield* withControlSession(tabId, wc, "evaluate", (send) =>
      performAutomationEvaluate(tabId, input, send),
    );
  });

  const performAutomationWaitFor = Effect.fn("PreviewManager.performAutomationWaitFor")(function* (
    tabId: string,
    input: PreviewAutomationWaitForInput,
    send: SendCommand,
  ) {
    const timeoutMs = input.timeoutMs ?? 15_000;
    yield* send("Runtime.enable");
    const locator = automationLocator(input);
    if (locator) yield* ensurePlaywrightInjected(tabId, send);
    const [locatorJson, textJson, urlIncludesJson] = yield* Effect.all([
      locator
        ? encodeJson({ operation: "automationWaitFor.encodeLocator", tabId }, locator)
        : Effect.succeed(null),
      input.text
        ? encodeJson({ operation: "automationWaitFor.encodeText", tabId }, input.text)
        : Effect.succeed(null),
      input.urlIncludes
        ? encodeJson({ operation: "automationWaitFor.encodeUrl", tabId }, input.urlIncludes)
        : Effect.succeed(null),
    ]);
    const deadline = (yield* currentMillis) + timeoutMs;
    while ((yield* currentMillis) <= deadline) {
      const result = yield* evaluateWithDebugger<
        { matched: boolean } | { invalidSelector: true; message: string }
      >(
        tabId,
        send,
        `(() => {
              try {
                const selectorMatched = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, false) !== null; })()` : "true"};
                const textMatched = ${
                  textJson ? `(document.body?.innerText || "").includes(${textJson})` : "true"
                };
                const urlMatched = ${
                  urlIncludesJson ? `location.href.includes(${urlIncludesJson})` : "true"
                };
                return { matched: selectorMatched && textMatched && urlMatched };
              } catch (error) {
                return { invalidSelector: true, message: String(error) };
              }
            })()`,
        true,
      );
      if ("invalidSelector" in result) {
        return yield* new PreviewAutomationInvalidSelectorError({
          operation: "waitFor",
          tabId,
          ...automationSelectorDiagnostics(input),
          reasonLength: result.message.length,
          cause: result,
        });
      }
      if (result.matched) return;
      yield* Effect.sleep(100);
    }
    return yield* new PreviewAutomationTimeoutError({
      tabId,
      timeoutMs,
    });
  });

  const automationWaitFor = Effect.fn("PreviewManager.automationWaitFor")(function* (
    tabId: string,
    input: PreviewAutomationWaitForInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "waitFor", (send) =>
      performAutomationWaitFor(tabId, input, send),
    );
  });

  return {
    automationStatus,
    automationSnapshot,
    automationClick,
    automationType,
    automationPress,
    automationScroll,
    automationEvaluate,
    automationWaitFor,
  };
};
