import {
  DesktopPreviewRecordingInputSchema,
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
} from "@t3tools/contracts";
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewColorScheme,
  DesktopPreviewFavicon,
  DesktopPreviewPointerEvent,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  DesktopPreviewRecordingFrame,
  DesktopPreviewRecordingInputEvent,
  PreviewAutomationConsoleEntry,
  PreviewAutomationNetworkEntry,
} from "@t3tools/contracts";
import { BrowserWindow } from "electron";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { type RecordingInputOptions } from "./RecordingInput.ts";
import { PreviewManagerError, PreviewOperationError } from "./ManagerErrors.ts";

export type PreviewNavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | {
      kind: "LoadFailed";
      url: string;
      title: string;
      code: number;
      description: string;
    };

export interface PreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  /** User intent to silence this tab. Re-applied to each guest that attaches. */
  audioMuted: boolean;
  /** Observed from Chromium. Stays true while a muted tab keeps playing. */
  audible: boolean;
  controller: "human" | "agent" | "none";
  favicon?: DesktopPreviewFavicon;
  updatedAt: string;
}

/** Discrete zoom levels mirroring Chrome's preset list. */
export const ZOOM_LEVELS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

export const DEFAULT_ZOOM_FACTOR = 1.0;

export const ZOOM_EPSILON = 0.001;

export const MAX_EVALUATION_BYTES = 64_000;

export const MAX_VISIBLE_TEXT_LENGTH = 20_000;

export const MAX_INTERACTIVE_ELEMENTS = 200;

/**
 * A `[role]` container's innerText is its whole subtree, which turned one
 * snapshot's element list into 60 KB of repeated page text. Names are labels,
 * not content, so cap them where they are read.
 */
export const MAX_INTERACTIVE_ELEMENT_NAME_LENGTH = 200;

export const MAX_SCREENSHOT_WIDTH = 1280;

/** How long an armed tab keeps the exclusive display-media slot before another tab may take it. */
export const RECORDING_ARM_GRACE_MS = 10_000;

export const PICTURE_IN_PICTURE_FRAME_INTERVAL_MS = Math.ceil(1_000 / 12);

export const PICTURE_IN_PICTURE_JPEG_QUALITY = 80;

/**
 * Cold guests can reject capturePage with UnknownVizError or never settle it.
 * Bound each attempt so snapshots release control even when Chromium stalls.
 */
export const CAPTURE_PAGE_RETRY_ATTEMPTS = 3;

export const CAPTURE_PAGE_RETRY_DELAY_MS = 120;

export const CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS = 1_000;

export const PICTURE_IN_PICTURE_INITIAL_WIDTH = 480;

export const PICTURE_IN_PICTURE_INITIAL_HEIGHT = 320;

export const PICTURE_IN_PICTURE_MIN_WIDTH = 240;

export const PICTURE_IN_PICTURE_MIN_HEIGHT = 160;

export const PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON = 0.002;

export const DIAGNOSTIC_BUFFER_LIMIT = 200;

export const MAX_ARTIFACT_SITE_SLUG_LENGTH = 80;

export const AGENT_CURSOR_MOVE_MS = 160;

export const AGENT_CURSOR_CLICK_LEAD_MS = 40;

export const requestRecordingCaptureExpression = (tabId: string): string =>
  `globalThis[${JSON.stringify(DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER)}]?.(${JSON.stringify(tabId)}) === true`;

export const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const DEFAULT_ANNOTATION_THEME: DesktopPreviewAnnotationTheme = {
  colorScheme: "light",
  radius: "0.625rem",
  background: "white",
  foreground: "oklch(0.269 0 0)",
  popover: "white",
  popoverForeground: "oklch(0.269 0 0)",
  primary: "oklch(0.488 0.217 264)",
  primaryForeground: "white",
  muted: "rgb(0 0 0 / 4%)",
  mutedForeground: "oklch(0.556 0 0)",
  accent: "rgb(0 0 0 / 4%)",
  accentForeground: "oklch(0.269 0 0)",
  border: "rgb(0 0 0 / 8%)",
  input: "rgb(0 0 0 / 10%)",
  ring: "oklch(0.488 0.217 264)",
  fontSans: "system-ui, sans-serif",
  fontMono: "ui-monospace, monospace",
};

export const buildPreviewPictureInPictureDataUrl = (): string => {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    >
    <meta name="color-scheme" content="dark">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #111; }
      body { display: grid; place-items: center; }
      img { width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
    </style>
  </head>
  <body>
    <img id="preview-frame" alt="Live browser preview">
    <script>
      const frame = document.getElementById("preview-frame");
      window.previewPictureInPicture.onFrame((next) => {
        frame.src = "data:image/jpeg;base64," + next.data;
      });
    </script>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

export const fitPictureInPictureContentSize = (
  current: ReadonlyArray<number>,
  aspectRatio: number,
): readonly [width: number, height: number] => {
  const currentWidth = Math.max(1, current[0] ?? PICTURE_IN_PICTURE_INITIAL_WIDTH);
  const currentHeight = Math.max(1, current[1] ?? PICTURE_IN_PICTURE_INITIAL_HEIGHT);
  const currentArea = currentWidth * currentHeight;
  let width = Math.sqrt(currentArea * aspectRatio);
  let height = width / aspectRatio;
  const minimumScale = Math.max(
    1,
    PICTURE_IN_PICTURE_MIN_WIDTH / width,
    PICTURE_IN_PICTURE_MIN_HEIGHT / height,
  );
  width *= minimumScale;
  height *= minimumScale;
  return [Math.round(width), Math.round(height)];
};

export const recordingFileExtension = (mimeType: string): string => {
  const subtype = mimeType.split(";", 1)[0]?.trim().toLowerCase().split("/")[1] ?? "";
  const extension = subtype.replace(/^x-/, "").replace(/[^a-z0-9]/g, "");
  return extension || "video";
};

export const artifactSiteSlug = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    const slug = url.hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_ARTIFACT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

export interface CdpEvaluationResult {
  readonly result?: {
    readonly value?: unknown;
    readonly description?: string;
  };
  readonly exceptionDetails?: {
    readonly text?: string;
    readonly exception?: { readonly description?: string };
  };
}

export interface PreviewOperationContext {
  readonly operation: string;
  readonly tabId?: string;
  readonly webContentsId?: number;
  readonly artifactPath?: string;
}

export const normalizeCaptureRect = (value: unknown): PreviewAnnotationRect | null => {
  if (typeof value !== "object" || value === null) return null;
  const rect = value as Record<string, unknown>;
  const x = rect["x"];
  const y = rect["y"];
  const width = rect["width"];
  const height = rect["height"];
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(height)),
  };
};

/** `capturePage` never settles when the guest's compositor is wedged. */
export const ANNOTATION_SCREENSHOT_TIMEOUT = "5 seconds";

/**
 * Crops the guest for a picked annotation. A stalled `capturePage` resolves to
 * `null` after the timeout: the annotation is still sendable without its
 * screenshot, and the pick session must settle either way.
 */
export const captureAnnotationScreenshot = (
  tabId: string,
  wc: Electron.WebContents,
  cropRect: PreviewAnnotationRect | null,
): Effect.Effect<PreviewAnnotationPayload["screenshot"], PreviewManagerError> =>
  Effect.tryPromise({
    // The unused abort signal is what makes this interruptible, and therefore
    // what lets the timeout below fire. Drop the parameter and a stalled
    // capture strands the pick session again.
    try: (_signal) =>
      wc.capturePage(
        cropRect
          ? {
              x: cropRect.x,
              y: cropRect.y,
              width: cropRect.width,
              height: cropRect.height,
            }
          : undefined,
      ),
    catch: (cause) =>
      new PreviewOperationError({
        operation: "captureAnnotationScreenshot",
        tabId,
        webContentsId: wc.id,
        cause,
      }),
  }).pipe(
    Effect.map((image): PreviewAnnotationPayload["screenshot"] => {
      const size = image.getSize();
      return {
        dataUrl: image.toDataURL(),
        width: size.width,
        height: size.height,
        cropRect: cropRect ?? { x: 0, y: 0, width: size.width, height: size.height },
      };
    }),
    Effect.timeoutOption(ANNOTATION_SCREENSHOT_TIMEOUT),
    Effect.flatMap((screenshot) =>
      Option.isSome(screenshot)
        ? Effect.succeed(screenshot.value)
        : Effect.logWarning("preview annotation screenshot timed out").pipe(
            Effect.annotateLogs({ tabId, webContentsId: wc.id }),
            Effect.as(null),
          ),
    ),
  );

export const findZoomStep = (current: number): number => {
  const index = ZOOM_LEVELS.findIndex(
    (level) => Math.abs(level - current) < ZOOM_EPSILON || level > current,
  );
  if (index < 0) return ZOOM_LEVELS.length - 1;
  return Math.abs(ZOOM_LEVELS[index]! - current) < ZOOM_EPSILON ? index : index - 1;
};

/**
 * Clamp a client-supplied zoom factor onto the discrete ladder. The setting is
 * chosen from the same ladder, but it arrives over IPC from a schema that only
 * guarantees a positive number, so an out-of-band value snaps to the nearest
 * step rather than leaving the guest at a zoom the zoom controls can't reach.
 */
export const normalizeZoomFactor = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ZOOM_FACTOR;
  let closest = ZOOM_LEVELS[0]!;
  for (const level of ZOOM_LEVELS) {
    if (Math.abs(level - value) < Math.abs(closest - value)) closest = level;
  }
  return closest;
};

export const nextZoomLevel = (current: number, direction: "in" | "out"): number => {
  const step = findZoomStep(current);
  if (direction === "in") {
    return ZOOM_LEVELS[Math.min(step + 1, ZOOM_LEVELS.length - 1)] ?? current;
  }
  return ZOOM_LEVELS[Math.max(step - 1, 0)] ?? current;
};

export type Listener = (tabId: string, state: PreviewTabState) => Effect.Effect<void>;

export type RecordingFrameListener = (frame: DesktopPreviewRecordingFrame) => Effect.Effect<void>;

export type PreviewInputSignal =
  | { readonly kind: "pointer"; readonly x: number; readonly y: number; readonly button: number }
  | { readonly kind: "key"; readonly key: string; readonly code: string };

export interface ManagedListeners {
  readonly attachmentId: symbol;
  readonly cancelFaviconCapture: () => void;
  readonly scope: Scope.Closeable;
  readonly webContents: Electron.WebContents;
}

export type FrameCaptureConsumer = "picture-in-picture" | "recording";

export interface FrameCaptureSession {
  readonly recordingInputOptions?: RecordingInputOptions;
  readonly scope: Scope.Closeable | null;
  readonly consumers: ReadonlySet<FrameCaptureConsumer>;
  readonly unthrottledWebContentsIds: ReadonlySet<number>;
  readonly lastPictureInPictureFrame: Buffer | null;
}

export interface PictureInPictureSession {
  readonly window: BrowserWindow;
  readonly webContentsId: number;
  readonly ready: Deferred.Deferred<void, PreviewManagerError>;
  readonly initializationScope: Scope.Closeable;
}

/** The tab whose frame the next `getDisplayMedia()` request is allowed to capture. */
export interface PendingRecording {
  readonly tabId: string;
  readonly webContents: Electron.WebContents;
  readonly requestingFrameTreeNodeId: number;
  readonly armedAtMillis: number;
}

export interface PickSession {
  readonly cancel: Effect.Effect<void>;
}

export interface BrowserControlSession {
  readonly webContentsId: number;
  // Pins the WebContents' Debugger wrapper for the session's lifetime.
  // Electron's Debugger is GC-managed but registered with Chromium as a raw
  // DevToolsAgentHostClient pointer; collecting it while attached crashes the
  // browser process (electron/electron#53376). Detach must also go through
  // this reference: `wc.debugger` throws once the WebContents is destroyed.
  readonly debugger: Electron.Debugger;
  readonly semaphore: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => void;
}

export interface BrowserDiagnostics {
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  readonly requests: ReadonlyMap<string, { url: string; method: string }>;
}

export const isRecordingInput = Schema.is(DesktopPreviewRecordingInputSchema);

export type RecordingInputListener = (
  event: DesktopPreviewRecordingInputEvent,
) => Effect.Effect<void>;

export type PointerEventListener = (event: DesktopPreviewPointerEvent) => Effect.Effect<void>;

export interface ExpectedAgentInput {
  readonly signal: PreviewInputSignal;
  readonly expiresAt: number;
}

/**
 * Protocols a preview page may open in a real popup window.
 *
 * `about:blank` stays out: Chromium skips browser-side navigation for it, so the
 * child copies the guest's `contextIsolation: false` preferences and Electron
 * gives no way to override them. Those popups keep loading in the preview tab.
 *
 * Deliberately not `ElectronShell.parseSafeExternalUrl`: that also admits
 * `vscode://vscode-remote/...` deep links, which belong in `shell.openExternal`
 * and not in a window spawned by a third-party page in the preview.
 */
export const POPUP_PROTOCOLS = new Set(["http:", "https:"]);

export const isPopupUrl = (rawUrl: string): boolean => {
  try {
    return POPUP_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
};

/**
 * Preferences for a popup a preview page opens.
 *
 * A popup is not a webview attach, so the `will-attach-webview` hardening in
 * `DesktopWindow` never sees it, and an unoverridden child would inherit the
 * guest's relaxed posture: the picker preload needs `contextIsolation: false`
 * to share `globalThis` with the previewed page, and no OAuth provider should
 * get that. The window keeps the opener and the guest session either way.
 */
export const POPUP_WINDOW_OPTIONS = {
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
} satisfies Electron.BrowserWindowConstructorOptions;

/**
 * Decides what a preview page's `window.open` should do.
 *
 * `"popup"` opens a real window, which scripted popups need: denying them makes
 * `window.open()` return `null` (OAuth SDKs report that as a blocked popup), and
 * navigating the preview tab instead destroys the opener the popup has to
 * `postMessage` its result back to.
 *
 * `target="_blank"` links arrive as a tab disposition and keep loading in the
 * preview tab, which is what people expect from a link inside a preview.
 */
export const previewWindowOpenAction = (details: {
  readonly url: string;
  readonly disposition: Electron.HandlerDetails["disposition"];
}): "popup" | "navigate" =>
  details.disposition === "new-window" && isPopupUrl(details.url) ? "popup" : "navigate";

export const isPreviewRefreshShortcut = (input: Electron.Input): boolean =>
  input.type === "keyDown" &&
  input.key.toLowerCase() === "r" &&
  (input.meta || input.control) &&
  !input.shift &&
  !input.alt;

export const isPreviewEditingShortcut = (
  input: Electron.Input,
  platform: NodeJS.Platform,
): boolean => {
  const isMac = platform === "darwin";
  if (isMac ? !input.meta || input.control : !input.control || input.meta) return false;

  const key = input.key.toLowerCase();
  // Option changes the DOM key for macOS Paste and Match Style (for example, to ◊).
  if (isMac && input.alt && input.shift && input.code === "KeyV") return true;
  if (key === "v" && input.shift) return input.alt === isMac;
  if (input.alt) return false;
  if (key === "z") return !input.shift || platform !== "win32";
  if (input.shift) return false;
  return (
    key === "a" ||
    key === "c" ||
    key === "v" ||
    key === "x" ||
    (key === "y" && platform === "win32")
  );
};

export const isPreviewInputSignal = (value: unknown): value is PreviewInputSignal => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "pointer") {
    return (
      "x" in value &&
      typeof value.x === "number" &&
      "y" in value &&
      typeof value.y === "number" &&
      "button" in value &&
      typeof value.button === "number"
    );
  }
  return (
    value.kind === "key" &&
    "key" in value &&
    typeof value.key === "string" &&
    "code" in value &&
    typeof value.code === "string"
  );
};

export const inputSignalsMatch = (left: PreviewInputSignal, right: PreviewInputSignal): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === "pointer" && right.kind === "pointer") {
    return (
      Math.abs(left.x - right.x) <= 1 &&
      Math.abs(left.y - right.y) <= 1 &&
      left.button === right.button
    );
  }
  return (
    left.kind === "key" &&
    right.kind === "key" &&
    left.key === right.key &&
    left.code === right.code
  );
};

export const attempt = <A>(errorContext: PreviewOperationContext, evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
  });

export const attemptPromise = <A>(
  errorContext: PreviewOperationContext,
  evaluate: () => PromiseLike<A>,
) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
  });

export const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export const currentMillis = Clock.currentTimeMillis;

export const encodeJson = (errorContext: PreviewOperationContext, value: unknown) =>
  encodeUnknownJson(value).pipe(
    Effect.mapError((cause) => new PreviewOperationError({ ...errorContext, cause })),
  );

export const nextCounter = (ref: Ref.Ref<number>) =>
  Ref.modify(ref, (value) => [value, value + 1] as const);

export const replaceMap = <K, V>(
  source: ReadonlyMap<K, V>,
  update: (copy: Map<K, V>) => void,
): ReadonlyMap<K, V> => {
  const copy = new Map(source);
  update(copy);
  return copy;
};

export const pushBounded = <A>(buffer: ReadonlyArray<A>, entry: A): ReadonlyArray<A> =>
  [...buffer, entry].slice(-DIAGNOSTIC_BUFFER_LIMIT);
