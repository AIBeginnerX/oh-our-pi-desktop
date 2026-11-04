import * as Schema from "effect/Schema";

export const PreviewAutomationSelectorKind = Schema.Literals([
  "focused-element",
  "selector",
  "locator",
]);

export type PreviewAutomationSelectorKind = typeof PreviewAutomationSelectorKind.Type;

export const PreviewAutomationEvaluationDetailKind = Schema.Literals([
  "exception-description",
  "exception-text",
  "unknown",
]);

export type PreviewAutomationEvaluationDetailKind =
  typeof PreviewAutomationEvaluationDetailKind.Type;

export const previewAutomationEvaluationDetail = (exceptionDetails: unknown) => {
  if (typeof exceptionDetails !== "object" || exceptionDetails === null) {
    return { detailKind: "unknown" as const };
  }
  const details = exceptionDetails as Record<string, unknown>;
  const exception = details["exception"];
  const description =
    typeof exception === "object" &&
    exception !== null &&
    typeof (exception as Record<string, unknown>)["description"] === "string"
      ? (exception as Record<string, unknown>)["description"]
      : undefined;
  if (typeof description === "string" && description.length > 0) {
    return { detailKind: "exception-description" as const, detail: description };
  }
  const text = details["text"];
  if (typeof text === "string" && text.length > 0) {
    return { detailKind: "exception-text" as const, detail: text };
  }
  return { detailKind: "unknown" as const };
};

export const previewAutomationTargetLabel = (
  selectorKind: PreviewAutomationSelectorKind,
  selectorLength?: number,
) =>
  selectorKind === "focused-element"
    ? "the focused element"
    : `${selectorKind} (${selectorLength ?? 0} characters)`;

export class PreviewTabNotFoundError extends Schema.TaggedError<PreviewTabNotFoundError>()(
  "PreviewTabNotFoundError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `Preview tab not found: ${this.tabId}`;
  }
}

export class PreviewWebContentsNotFoundError extends Schema.TaggedError<PreviewWebContentsNotFoundError>()(
  "PreviewWebContentsNotFoundError",
  { tabId: Schema.String, webContentsId: Schema.Number },
) {
  override get message(): string {
    return `WebContents ${this.webContentsId} not found for preview tab ${this.tabId}`;
  }
}

export class PreviewWebviewNotInitializedError extends Schema.TaggedError<PreviewWebviewNotInitializedError>()(
  "PreviewWebviewNotInitializedError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `Preview tab "${this.tabId}" has no webview registered`;
  }
}

export class PreviewMainWindowClosedError extends Schema.TaggedError<PreviewMainWindowClosedError>()(
  "PreviewMainWindowClosedError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `Cannot start preview frame capture while the main window is closed: ${this.tabId}`;
  }
}

export class PreviewRecordingArmConflictError extends Schema.TaggedError<PreviewRecordingArmConflictError>()(
  "PreviewRecordingArmConflictError",
  {
    tabId: Schema.String,
    webContentsId: Schema.Number,
    armedTabId: Schema.String,
  },
) {
  override get message(): string {
    return `Preview tab ${this.armedTabId} is still claiming the capture stream, so recording could not start for tab ${this.tabId}`;
  }
}

export class PreviewRecordingCaptureUnavailableError extends Schema.TaggedError<PreviewRecordingCaptureUnavailableError>()(
  "PreviewRecordingCaptureUnavailableError",
  {
    tabId: Schema.String,
    webContentsId: Schema.Number,
  },
) {
  override get message(): string {
    return `Preview recording capture is unavailable for tab ${this.tabId} in WebContents ${this.webContentsId}`;
  }
}

export class PreviewOperationError extends Schema.TaggedError<PreviewOperationError>()(
  "PreviewOperationError",
  {
    operation: Schema.String,
    tabId: Schema.optional(Schema.String),
    webContentsId: Schema.optional(Schema.Number),
    artifactPath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static toTimelineMessage(error: PreviewOperationError): string {
    return error.cause instanceof Error ? error.cause.message : String(error.cause);
  }

  override get message(): string {
    const context = [
      this.tabId === undefined ? undefined : `tab ${this.tabId}`,
      this.webContentsId === undefined ? undefined : `WebContents ${this.webContentsId}`,
      this.artifactPath === undefined ? undefined : `artifact ${this.artifactPath}`,
    ].filter((value): value is string => value !== undefined);
    return `Desktop preview operation failed: ${this.operation}${context.length === 0 ? "" : ` (${context.join(", ")})`}`;
  }
}

export const isPreviewOperationError = Schema.is(PreviewOperationError);

export class PreviewArtifactPathOutsideDirectoryError extends Schema.TaggedError<PreviewArtifactPathOutsideDirectoryError>()(
  "PreviewArtifactPathOutsideDirectoryError",
  {
    artifactPath: Schema.String,
    artifactDirectory: Schema.String,
  },
) {
  override get message(): string {
    return `Preview artifact path ${this.artifactPath} is outside ${this.artifactDirectory}`;
  }
}

export class PreviewArtifactImageLoadError extends Schema.TaggedError<PreviewArtifactImageLoadError>()(
  "PreviewArtifactImageLoadError",
  { artifactPath: Schema.String },
) {
  override get message(): string {
    return `Preview artifact could not be loaded as an image: ${this.artifactPath}`;
  }
}

export class PreviewAutomationDevToolsOpenError extends Schema.TaggedError<PreviewAutomationDevToolsOpenError>()(
  "PreviewAutomationDevToolsOpenError",
  { webContentsId: Schema.Number },
) {
  override get message(): string {
    return `Close preview DevTools before using agent browser control for WebContents ${this.webContentsId}`;
  }
}

export class PreviewAutomationDebuggerAttachedError extends Schema.TaggedError<PreviewAutomationDebuggerAttachedError>()(
  "PreviewAutomationDebuggerAttachedError",
  { webContentsId: Schema.Number },
) {
  override get message(): string {
    return `Preview control cannot attach to WebContents ${this.webContentsId} because another debugger owns it`;
  }
}

export class PreviewAutomationEvaluationError extends Schema.TaggedError<PreviewAutomationEvaluationError>()(
  "PreviewAutomationEvaluationError",
  {
    tabId: Schema.String,
    detailKind: PreviewAutomationEvaluationDetailKind,
    detailLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  static toTimelineMessage(error: PreviewAutomationEvaluationError): string {
    return previewAutomationEvaluationDetail(error.cause).detail ?? error.message;
  }

  override get message(): string {
    return `Preview JavaScript evaluation failed in tab ${this.tabId}`;
  }
}

export class PreviewAutomationTargetNotFoundError extends Schema.TaggedError<PreviewAutomationTargetNotFoundError>()(
  "PreviewAutomationTargetNotFoundError",
  {
    operation: Schema.String,
    tabId: Schema.String,
    selectorKind: PreviewAutomationSelectorKind,
    selectorLength: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    const target = previewAutomationTargetLabel(this.selectorKind, this.selectorLength);
    return `Preview automation ${this.operation} could not find ${target} in tab ${this.tabId}`;
  }
}

export class PreviewAutomationTargetNotEditableError extends Schema.TaggedError<PreviewAutomationTargetNotEditableError>()(
  "PreviewAutomationTargetNotEditableError",
  {
    tabId: Schema.String,
    selectorKind: PreviewAutomationSelectorKind,
    selectorLength: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    const target = previewAutomationTargetLabel(this.selectorKind, this.selectorLength);
    return `Preview automation type found ${target}, but it is not editable in tab ${this.tabId}`;
  }
}

export class PreviewAutomationCoordinatesOutsideViewportError extends Schema.TaggedError<PreviewAutomationCoordinatesOutsideViewportError>()(
  "PreviewAutomationCoordinatesOutsideViewportError",
  {
    tabId: Schema.String,
    x: Schema.Number,
    y: Schema.Number,
    viewportWidth: Schema.Number,
    viewportHeight: Schema.Number,
  },
) {
  override get message(): string {
    return `Click coordinates (${this.x}, ${this.y}) are outside the ${this.viewportWidth}x${this.viewportHeight} preview viewport for tab ${this.tabId}`;
  }
}

export class PreviewAutomationInvalidSelectorError extends Schema.TaggedError<PreviewAutomationInvalidSelectorError>()(
  "PreviewAutomationInvalidSelectorError",
  {
    operation: Schema.String,
    tabId: Schema.String,
    selectorKind: PreviewAutomationSelectorKind,
    selectorLength: Schema.optionalKey(Schema.Number),
    reasonLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  static toTimelineMessage(error: PreviewAutomationInvalidSelectorError): string {
    if (typeof error.cause !== "object" || error.cause === null) return error.message;
    const reason = (error.cause as Record<string, unknown>)["message"];
    return typeof reason === "string" && reason.length > 0 ? reason : error.message;
  }

  get detail(): {
    readonly selectorKind: PreviewAutomationSelectorKind;
    readonly selectorLength?: number;
  } {
    return {
      selectorKind: this.selectorKind,
      ...(this.selectorLength === undefined ? {} : { selectorLength: this.selectorLength }),
    };
  }

  override get message(): string {
    const target = previewAutomationTargetLabel(this.selectorKind, this.selectorLength);
    return `Preview automation ${this.operation} rejected ${target} in tab ${this.tabId}`;
  }
}

export class PreviewAutomationResultTooLargeError extends Schema.TaggedError<PreviewAutomationResultTooLargeError>()(
  "PreviewAutomationResultTooLargeError",
  {
    tabId: Schema.String,
    actualBytes: Schema.Number,
    maximumBytes: Schema.Number,
  },
) {
  get detail(): { readonly maximumBytes: number } {
    return { maximumBytes: this.maximumBytes };
  }

  override get message(): string {
    return `Preview evaluation result in tab ${this.tabId} was ${this.actualBytes} bytes; maximum is ${this.maximumBytes} bytes`;
  }
}

export class PreviewAutomationTimeoutError extends Schema.TaggedError<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  {
    tabId: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Preview condition did not match within ${this.timeoutMs}ms in tab ${this.tabId}`;
  }
}

export class PreviewAutomationControlInterruptedError extends Schema.TaggedError<PreviewAutomationControlInterruptedError>()(
  "PreviewAutomationControlInterruptedError",
  {
    operation: Schema.String,
    tabId: Schema.String,
    webContentsId: Schema.Number,
  },
) {
  override get message(): string {
    return `Preview automation ${this.operation} was interrupted by human input in tab ${this.tabId}`;
  }
}

export const PreviewManagerError = Schema.Union([
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  PreviewWebviewNotInitializedError,
  PreviewMainWindowClosedError,
  PreviewRecordingArmConflictError,
  PreviewRecordingCaptureUnavailableError,
  PreviewOperationError,
  PreviewArtifactPathOutsideDirectoryError,
  PreviewArtifactImageLoadError,
  PreviewAutomationDevToolsOpenError,
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationEvaluationError,
  PreviewAutomationTargetNotFoundError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationCoordinatesOutsideViewportError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTimeoutError,
  PreviewAutomationControlInterruptedError,
]);

export type PreviewManagerError = typeof PreviewManagerError.Type;

export const isPreviewAutomationControlInterruptedError = Schema.is(
  PreviewAutomationControlInterruptedError,
);

export const isPreviewAutomationEvaluationError = Schema.is(PreviewAutomationEvaluationError);

export const isPreviewAutomationInvalidSelectorError = Schema.is(
  PreviewAutomationInvalidSelectorError,
);
