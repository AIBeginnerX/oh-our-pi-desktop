import {
  CrewThreadOverride,
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderOptionSelection,
  type PreviewAnnotationPayload,
  RuntimeMode,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
  ComposerContextId,
  ProjectId,
  PreviewAnnotationPayloadSchema,
  PastedTextAttachmentSource,
  SnapShotSource,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { type TerminalContextDraft } from "./lib/terminalContext";
import {
  removeInlineContextReference,
  toComposerContextId,
  type ComposerContextReference,
} from "./lib/composerContextReferences";
import { type ReviewCommentContext, ReviewCommentContextSchema } from "./reviewCommentContext";
import { type ChatFileAttachment, type ChatImageAttachment } from "./types";

export const isRuntimeMode = Schema.is(RuntimeMode);
export const isCrewThreadOverride = Schema.is(CrewThreadOverride);
export const isProviderDriverKind = Schema.is(ProviderDriverKind);
export const isReviewCommentContext = Schema.is(ReviewCommentContextSchema);
export const isSnapShotSource = Schema.is(SnapShotSource);
export const isPreviewAnnotationPayload = Schema.is(PreviewAnnotationPayloadSchema);

export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";
export const COMPOSER_DRAFT_STORAGE_VERSION = 9;
export const DraftThreadEnvModeSchema = Schema.Literals(["local", "worktree"]);
export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type;

export const DraftId = Schema.String.pipe(Schema.brand("DraftId"));
export type DraftId = typeof DraftId.Type;

export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  source: Schema.optional(SnapShotSource),
  dataUrl: Schema.String,
});
export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

export interface ComposerFileAttachment extends Omit<ChatFileAttachment, "previewUrl"> {
  file: File | null;
  uploadedAttachmentId?: string;
  uploadEnvironmentId?: EnvironmentId;
}

/**
 * A hydrated draft file whose upload never finished before the reload has
 * neither bytes (`file` is only ever null after hydration) nor a server-side
 * upload. The composer renders it as a needs-reattach row: the user must
 * attach the file again or remove it before sending.
 */
export function composerFileNeedsReattach(file: ComposerFileAttachment): boolean {
  return file.file === null && file.uploadedAttachmentId === undefined;
}

export function clearStaleFileUploadMetadata(
  draft: ComposerThreadDraftState,
  environmentId: EnvironmentId,
): ComposerThreadDraftState {
  let changed = false;
  const files = draft.files.map((file) => {
    if (
      (file.uploadedAttachmentId === undefined && file.uploadEnvironmentId === undefined) ||
      file.uploadEnvironmentId === environmentId
    ) {
      return file;
    }

    changed = true;
    const nextFile = { ...file };
    delete nextFile.uploadedAttachmentId;
    delete nextFile.uploadEnvironmentId;
    return nextFile;
  });

  return changed ? { ...draft, files } : draft;
}

export const PersistedComposerFileAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  attachmentId: Schema.String,
  environmentId: EnvironmentId,
  source: Schema.optional(PastedTextAttachmentSource),
});
export type PersistedComposerFileAttachment = typeof PersistedComposerFileAttachment.Type;

/**
 * Draft-persisted file. Unlike a stash entry (which requires a finished
 * upload), a draft may hold a file whose upload never completed. Its `File`
 * handle cannot serialize, so it persists as a metadata-only marker (no
 * `attachmentId`) and hydrates as a needs-reattach row instead of vanishing.
 */
export const PersistedComposerDraftFileAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  attachmentId: Schema.optionalKey(Schema.String),
  environmentId: Schema.optionalKey(EnvironmentId),
  source: Schema.optional(PastedTextAttachmentSource),
});
export type PersistedComposerDraftFileAttachment = typeof PersistedComposerDraftFileAttachment.Type;
export const isPersistedComposerDraftFileAttachment = Schema.is(
  PersistedComposerDraftFileAttachment,
);

export const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
  text: Schema.optionalKey(Schema.String),
});
export type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraft.Type;

/**
 * Persisted project-memory selection: identifiers only. Titles and bodies stay
 * in the server's memory store, so localStorage never holds memory content.
 */
export interface ComposerProjectMemoryReference {
  contextId: ComposerContextId;
  memoryId: string;
  selectedVersion: number;
}

export const PersistedComposerProjectMemoryReference = Schema.Struct({
  contextId: Schema.String,
  memoryId: Schema.String,
  selectedVersion: Schema.Number,
});
export type PersistedComposerProjectMemoryReference =
  typeof PersistedComposerProjectMemoryReference.Type;

export const PROJECT_MEMORY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Decode-side validator: malformed selections drop, they never fail the draft. */
export function normalizeProjectMemoryReference(
  value: PersistedComposerProjectMemoryReference,
): ComposerProjectMemoryReference | null {
  if (
    typeof value.contextId !== "string" ||
    value.contextId.length === 0 ||
    typeof value.memoryId !== "string" ||
    !PROJECT_MEMORY_ID_PATTERN.test(value.memoryId) ||
    typeof value.selectedVersion !== "number" ||
    !Number.isSafeInteger(value.selectedVersion) ||
    value.selectedVersion <= 0
  ) {
    return null;
  }
  return {
    contextId: toComposerContextId(value.contextId),
    memoryId: value.memoryId,
    selectedVersion: value.selectedVersion,
  };
}

export function normalizeProjectMemoryReferences(value: unknown): ComposerProjectMemoryReference[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const normalized = normalizeProjectMemoryReference(
      entry as PersistedComposerProjectMemoryReference,
    );
    return normalized ? [normalized] : [];
  });
}

export const PersistedComposerThreadDraftState = Schema.Struct({
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  files: Schema.optionalKey(Schema.Array(PersistedComposerDraftFileAttachment)),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  previewAnnotations: Schema.optionalKey(Schema.Array(PreviewAnnotationPayloadSchema)),
  reviewComments: Schema.optionalKey(Schema.Array(ReviewCommentContextSchema)),
  projectMemoryReferences: Schema.optionalKey(
    Schema.Array(PersistedComposerProjectMemoryReference),
  ),
  autoSelectDismissed: Schema.optionalKey(Schema.Array(Schema.String)),
  autoSelectAdded: Schema.optionalKey(Schema.Array(Schema.String)),
  // Keyed by `ProviderInstanceId` (open branded slug) so custom provider
  // instances (e.g. `codex_personal`) round-trip alongside the built-in
  // `codex` / `claudeAgent` / ... entries. Every prior `ProviderDriverKind`
  // literal satisfies the `ProviderInstanceId` slug pattern, so existing
  // persisted drafts decode unchanged.
  //
  // The record's value schema is NOT wrapped in `Schema.optionalKey`:
  // that helper is only meaningful on property signatures with a known
  // key set, and `Schema.Record(<branded string>, …)` produces an index
  // signature at runtime (Schema rejects the combination). Absence of
  // an entry already encodes "no selection for this instance".
  modelSelectionByProvider: Schema.optionalKey(Schema.Record(ProviderInstanceId, ModelSelection)),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  // True only when a human picked this selection in the composer. Seeded
  // selections (project default / sticky) leave it unset so later seeds can
  // replace them; legacy entries predate the flag and read as seeded too.
  modelSelectionExplicit: Schema.optionalKey(Schema.Boolean),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
export type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftState.Type;

/**
 * Per-provider record of generic option selections. Used as a transient
 * representation when migrating legacy v2 storage payloads and when
 * deriving per-provider option bundles for downstream consumers.
 */
export type ProviderOptionSelectionsByProvider = Partial<
  Record<string, ReadonlyArray<ProviderOptionSelection>>
>;

export type LegacyCodexFields = {
  effort?: unknown;
  codexFastMode?: unknown;
  serviceTier?: unknown;
};

export type LegacyThreadModelFields = {
  provider?: unknown;
  model?: unknown;
  modelOptions?: unknown;
};

export type LegacyV2ThreadDraftFields = {
  modelSelection?: ModelSelection | null;
  modelOptions?: unknown;
};

export type LegacyPersistedComposerThreadDraftState = PersistedComposerThreadDraftState &
  LegacyCodexFields &
  LegacyThreadModelFields &
  LegacyV2ThreadDraftFields;

export type LegacyStickyModelFields = {
  stickyProvider?: unknown;
  stickyModel?: unknown;
  stickyModelOptions?: unknown;
};

export type LegacyV2StoreFields = {
  stickyModelSelection?: ModelSelection | null;
  stickyModelOptions?: unknown;
  projectDraftThreadIdByProjectId?: Record<string, string> | null;
  draftsByThreadId?: Record<string, PersistedComposerThreadDraftState> | null;
  draftThreadsByThreadId?: Record<string, PersistedDraftThreadState> | null;
  projectDraftThreadIdByProjectKey?: Record<string, string> | null;
  draftsByThreadKey?: Record<string, PersistedComposerThreadDraftState> | null;
  draftThreadsByThreadKey?: Record<string, PersistedDraftThreadState> | null;
  projectDraftThreadKeyByProjectKey?: Record<string, string> | null;
  logicalProjectDraftThreadKeyByLogicalProjectKey?: Record<string, string> | null;
};

export type LegacyPersistedComposerDraftStoreState = PersistedComposerDraftStoreState &
  LegacyStickyModelFields &
  LegacyV2StoreFields;

export const PersistedDraftThreadState = Schema.Struct({
  threadId: ThreadId,
  environmentId: Schema.String,
  projectId: ProjectId,
  logicalProjectKey: Schema.optionalKey(Schema.String),
  environmentSelection: Schema.optionalKey(Schema.Literals(["auto", "manual"])),
  loadBalancedEnvironmentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  envMode: DraftThreadEnvModeSchema,
  startFromOrigin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  crew: Schema.optionalKey(CrewThreadOverride),
  promotedTo: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        environmentId: Schema.String,
        threadId: Schema.String,
      }),
    ),
  ),
});
export type PersistedDraftThreadState = typeof PersistedDraftThreadState.Type;

export const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByThreadKey: Schema.Record(Schema.String, PersistedComposerThreadDraftState),
  draftThreadsByThreadKey: Schema.Record(Schema.String, PersistedDraftThreadState),
  logicalProjectDraftThreadKeyByLogicalProjectKey: Schema.Record(Schema.String, Schema.String),
  stickyModelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ModelSelection),
  ),
  stickyActiveProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
});
export type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

export const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreState,
});

/**
 * Composer content keyed by either a draft session (`DraftId`) or a real server
 * thread (`ScopedThreadRef`). This is the editable payload shown in the composer.
 */
/** Options for adding a context record and, independently, a reference to it. */
export interface ComposerContextAddOptions {
  /** `false` when the caller already placed the chip (paste, caret insertion). */
  appendReference?: boolean;
  /** `true` when this action intentionally adds another reference to an existing record. */
  allowDuplicateReference?: boolean;
  /** `false` to append synchronously instead of asking a mounted editor for its current caret. */
  insertAtCaret?: boolean;
}

/**
 * A mounted composer registers itself here so context produced by other panels (diff
 * comments, preview picks) lands at its caret. Without a handler the store appends the
 * reference to the prompt, which is where a draft with no composer open would show it.
 * Runtime-only: never persisted.
 */
export type ComposerContextInsertionHandler = (
  references: ReadonlyArray<ComposerContextReference>,
) => boolean;

export interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  /**
   * Project-memory selections behind the draft's memory chips. Identifier-only
   * by contract: the title/body live server-side and are re-resolved at send.
   */
  projectMemoryReferences: ComposerProjectMemoryReference[];
  /**
   * Memory ids whose auto-selected chip the user removed from this draft, so the
   * composer does not pick them again. Not content: it never keeps a draft alive,
   * and it goes when the draft is sent or cleared.
   */
  autoSelectDismissed?: string[];
  /**
   * Memory ids auto-selection added to this draft and that are still attached, so
   * a remount keeps counting them against the auto-select budget. Same lifetime
   * as `autoSelectDismissed`.
   */
  autoSelectAdded?: string[];
  /**
   * Per-instance model selection. Keyed by `ProviderInstanceId` (open
   * branded slug) so a default `codex` instance and a user-authored
   * `codex_personal` instance each persist their own selected model. Every
   * historical `ProviderDriverKind` literal (`codex` / `claudeAgent` / `cursor` /
   * `opencode`) also satisfies the `ProviderInstanceId` slug pattern, so
   * legacy kind-keyed drafts round-trip unchanged.
   */
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  /** Routing key of the last picked instance (see `modelSelectionByProvider`). */
  activeProvider: ProviderInstanceId | null;
  /**
   * True only when a human picked the active selection in the composer.
   * Absent/false means seeded (project default / sticky), so later seeds
   * may replace it. Legacy entries predate the flag and read as seeded.
   */
  modelSelectionExplicit?: boolean;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

/**
 * Clears every memory selection from a draft, links included. Used when a
 * draft's target project changes: memory ids are project-scoped identifiers,
 * so carrying them into another project would send references the server
 * cannot resolve.
 */
export function stripCrossProjectMemoryReferences(
  draft: ComposerThreadDraftState,
): ComposerThreadDraftState {
  if (draft.projectMemoryReferences.length === 0) {
    return draft;
  }
  return (
    draftWithoutProjectMemoryReferences(
      draft,
      new Set(draft.projectMemoryReferences.map((reference) => reference.contextId)),
    ) ?? draft
  );
}

/**
 * True when the user has invested real content in the draft: typed text or
 * any attachment/context. Model selection and mode choices alone do not
 * count — those are ambient defaults, not work in progress. Used by the
 * sidebar draft rows (which draft sessions deserve a row) and by new-thread
 * resurrection (a draft with content keeps its settings instead of being
 * reset to defaults).
 */
export function composerDraftHasUserContent(
  draft: ComposerThreadDraftState | null | undefined,
): boolean {
  if (!draft) {
    return false;
  }
  return (
    draft.prompt.trim().length > 0 ||
    draft.images.length > 0 ||
    draft.files.length > 0 ||
    draft.persistedAttachments.length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.previewAnnotations.length > 0 ||
    draft.reviewComments.length > 0 ||
    draft.projectMemoryReferences.length > 0
  );
}

/**
 * Mutable routing and execution context for a pre-thread draft session.
 *
 * Unlike a real server thread, a draft session can still change target
 * environment/worktree configuration before the first send.
 */
export interface DraftSessionState {
  threadId: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  logicalProjectKey: string;
  environmentSelection?: "auto" | "manual";
  loadBalancedEnvironmentId?: EnvironmentId | null;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  /** The crew chosen for this chat before its first message; sent with the thread when it is created. */
  crew?: CrewThreadOverride;
  promotedTo?: ScopedThreadRef | null;
}

export type DraftThreadState = DraftSessionState;

/**
 * Draft session metadata paired with its stable draft-session identity.
 */
export interface ProjectDraftSession extends DraftSessionState {
  draftId: DraftId;
}

/**
 * App-facing composer identity:
 * - `DraftId` for pre-thread draft sessions
 * - `ScopedThreadRef` for server-backed threads
 *
 * Raw `ThreadId` is intentionally excluded so callers cannot drop environment
 * identity for real threads.
 */
export type ComposerThreadTarget = ScopedThreadRef | DraftId;

/**
 * Persisted store for composer content plus draft-session metadata.
 *
 * The store intentionally models two domains:
 * - draft sessions keyed by `DraftId`
 * - server thread composer state keyed by `ScopedThreadRef`
 */
export interface ComposerDraftStoreState {
  draftsByThreadKey: Record<string, ComposerThreadDraftState>;
  draftThreadsByThreadKey: Record<string, DraftThreadState>;
  logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
  backgroundSubmissionThreadKeys: Record<string, true>;
  rewindingThreadKeys: ReadonlySet<string>;
  stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  stickyActiveProvider: ProviderInstanceId | null;
  /** Returns the editable composer content for a draft session or server thread. */
  getComposerDraft: (target: ComposerThreadTarget) => ComposerThreadDraftState | null;
  /** Looks up the active draft session for a logical project identity. */
  getDraftThreadByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftSessionByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftThreadByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  getDraftSessionByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  /** Reads mutable draft-session metadata by `DraftId`. */
  getDraftSession: (draftId: DraftId) => DraftSessionState | null;
  /** Resolves a server-thread ref back to a matching draft session when one exists. */
  getDraftSessionByRef: (threadRef: ScopedThreadRef) => DraftSessionState | null;
  /** The draft id that reserved a server-thread ref, while its draft record still exists. */
  getDraftIdByRef: (threadRef: ScopedThreadRef) => DraftId | null;
  getDraftThreadByRef: (threadRef: ScopedThreadRef) => DraftThreadState | null;
  getDraftThread: (threadRef: ComposerThreadTarget) => DraftThreadState | null;
  listDraftThreadKeys: () => string[];
  hasDraftThreadsInEnvironment: (environmentId: EnvironmentId) => boolean;
  /**
   * Creates or updates the draft session tracked for a logical project.
   * Reassigning an existing draft removes its previous logical-project
   * mapping so one session cannot resolve from two projects.
   */
  setLogicalProjectDraftThreadId: (
    logicalProjectKey: string,
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      environmentSelection?: "auto" | "manual";
      loadBalancedEnvironmentId?: EnvironmentId | null;
    },
  ) => void;
  /** Creates or updates the draft session tracked for a concrete project ref. */
  setProjectDraftThreadId: (
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      environmentSelection?: "auto" | "manual";
      loadBalancedEnvironmentId?: EnvironmentId | null;
    },
  ) => void;
  /** Updates mutable draft-session metadata without touching composer content. */
  setDraftThreadContext: (
    threadRef: ComposerThreadTarget,
    options: {
      /** The chat's own crew; null puts the draft back on the default crew. */
      crew?: CrewThreadOverride | null;
      branch?: string | null;
      worktreePath?: string | null;
      projectRef?: ScopedProjectRef;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      environmentSelection?: "auto" | "manual";
      loadBalancedEnvironmentId?: EnvironmentId | null;
    },
  ) => void;
  clearProjectDraftThreadId: (projectRef: ScopedProjectRef) => void;
  clearProjectDraftThreadById: (
    projectRef: ScopedProjectRef,
    threadRef: ComposerThreadTarget,
  ) => void;
  /** Marks a draft session as being promoted to a real server thread. */
  markDraftThreadPromoting: (threadRef: ComposerThreadTarget, promotedTo?: ScopedThreadRef) => void;
  /** Removes draft-session metadata after promotion is complete. */
  finalizePromotedDraftThread: (threadRef: ComposerThreadTarget) => void;
  clearDraftThread: (threadRef: ComposerThreadTarget) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadRef: ComposerThreadTarget, prompt: string) => void;
  setTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void;
  setModelSelection: (
    threadRef: ComposerThreadTarget,
    modelSelection: ModelSelection | null | undefined,
    opts?: {
      explicit?: boolean;
      /**
       * Replace the stored entry outright instead of preserving its
       * existing options when the incoming selection has none. Used when
       * the selection is a complete snapshot (e.g. carried from another
       * thread) rather than a model-only change.
       */
      replaceOptions?: boolean;
    },
  ) => void;
  /** Replace the model options for one or more providers in the draft. */
  setModelOptions: (
    threadRef: ComposerThreadTarget,
    modelOptions:
      | Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>
      | null
      | undefined,
  ) => void;
  applyStickyState: (threadRef: ComposerThreadTarget) => void;
  setProviderModelOptions: (
    threadRef: ComposerThreadTarget,
    provider: ProviderDriverKind,
    nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
    options?: {
      instanceId?: ProviderInstanceId | null | undefined;
      model?: string | null | undefined;
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (
    threadRef: ComposerThreadTarget,
    runtimeMode: RuntimeMode | null | undefined,
  ) => void;
  setInteractionMode: (
    threadRef: ComposerThreadTarget,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  addImage: (threadRef: ComposerThreadTarget, image: ComposerImageAttachment) => boolean;
  /** Returns the ids the draft accepted; duplicates and over-cap attachments are left out. */
  addImages: (
    threadRef: ComposerThreadTarget,
    images: ComposerImageAttachment[],
    options?: { allowDuplicates?: boolean },
  ) => string[];
  removeImage: (threadRef: ComposerThreadTarget, imageId: string) => void;
  /** Returns the ids of files appended; a re-pick that replaces a marker is not listed. */
  addFiles: (
    threadRef: ComposerThreadTarget,
    files: ComposerFileAttachment[],
    options?: { allowDuplicates?: boolean; appendReference?: boolean },
  ) => string[];
  removeFile: (threadRef: ComposerThreadTarget, fileId: string) => void;
  setFileUpload: (
    threadRef: ComposerThreadTarget,
    fileId: string,
    environmentId: EnvironmentId,
    attachmentId: string,
  ) => void;
  markFileUploadMissing: (
    threadRef: ComposerThreadTarget,
    fileId: string,
    environmentId: EnvironmentId,
    attachmentId: string,
  ) => boolean;
  insertTerminalContext: (
    threadRef: ComposerThreadTarget,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (threadRef: ComposerThreadTarget, context: TerminalContextDraft) => void;
  addTerminalContexts: (
    threadRef: ComposerThreadTarget,
    contexts: TerminalContextDraft[],
    options?: ComposerContextAddOptions,
  ) => void;
  removeTerminalContext: (threadRef: ComposerThreadTarget, contextId: string) => void;
  clearTerminalContexts: (threadRef: ComposerThreadTarget) => void;
  addPreviewAnnotation: (
    threadRef: ComposerThreadTarget,
    annotation: PreviewAnnotationPayload,
    options?: ComposerContextAddOptions,
  ) => void;
  setPreviewAnnotations: (
    threadRef: ComposerThreadTarget,
    annotations: ReadonlyArray<PreviewAnnotationPayload>,
  ) => void;
  removePreviewAnnotation: (threadRef: ComposerThreadTarget, annotationId: string) => void;
  addReviewComment: (
    threadRef: ComposerThreadTarget,
    comment: ReviewCommentContext,
    options?: ComposerContextAddOptions,
  ) => void;
  /**
   * Adds one project-memory selection and its prompt link. Deduped by the
   * memory's context id; false when the draft already holds it. The caller
   * owns capability/scope reconciliation — this only writes the draft.
   */
  addProjectMemoryReference: (
    threadRef: ComposerThreadTarget,
    selection: { memoryId: string; selectedVersion: number },
    options?: ComposerContextAddOptions,
  ) => boolean;
  /** Removes one memory selection and its prompt links. */
  removeProjectMemoryReference: (threadRef: ComposerThreadTarget, contextId: string) => void;
  /**
   * Restores an exact selection list (failed-send restore, queue restore).
   * Links are re-ensured for every entry; selections that no longer appear
   * lose their links.
   */
  setProjectMemoryReferences: (
    threadRef: ComposerThreadTarget,
    references: ReadonlyArray<ComposerProjectMemoryReference>,
  ) => void;
  /** Records which memory chips auto-selection added to this draft and which the user dismissed. */
  setAutoSelectState: (
    threadRef: ComposerThreadTarget,
    state: { dismissed: ReadonlyArray<string>; added: ReadonlyArray<string> },
  ) => void;
  /** Registers (or clears, with null) the caret-insertion handler for a draft. */
  setContextInsertionHandler: (
    threadRef: ComposerThreadTarget,
    handler: ComposerContextInsertionHandler | null,
  ) => (() => void) | undefined;
  setReviewComments: (
    threadRef: ComposerThreadTarget,
    comments: ReadonlyArray<ReviewCommentContext>,
  ) => void;
  removeReviewComment: (threadRef: ComposerThreadTarget, commentId: string) => void;
  clearPersistedAttachments: (threadRef: ComposerThreadTarget) => void;
  syncPersistedAttachments: (
    threadRef: ComposerThreadTarget,
    attachments: PersistedComposerImageAttachment[],
  ) => Promise<void>;
  clearComposerContent: (threadRef: ComposerThreadTarget) => void;
  /**
   * Clears the prompt text and attachments, preserving terminal /
   * element contexts, preview annotations, and review comments. Used by the
   * prompt stash. Session-bound context stays in the source draft.
   */
  clearComposerPromptAndImages: (threadRef: ComposerThreadTarget) => void;
}

export interface EffectiveComposerModelState {
  selectedModel: string;
  modelOptions: ProviderOptionSelectionsByProvider | null;
}

export interface ComposerDraftModelState {
  activeProvider: ProviderInstanceId | null;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
}

/**
 * Drops the given memory selections and every prompt link that points at them.
 * Null when nothing matched, so callers can keep identity. A dangling link with
 * no record would be rejected by the send-path resolver, so both leave together.
 */
export function draftWithoutProjectMemoryReferences(
  draft: ComposerThreadDraftState,
  contextIds: ReadonlySet<string>,
): ComposerThreadDraftState | null {
  if (contextIds.size === 0) return null;
  const retained = draft.projectMemoryReferences.filter(
    (reference) => !contextIds.has(reference.contextId),
  );
  if (retained.length === draft.projectMemoryReferences.length) return null;
  let prompt = draft.prompt;
  for (const reference of draft.projectMemoryReferences) {
    if (contextIds.has(reference.contextId)) {
      prompt = removeInlineContextReference(prompt, reference.contextId).prompt;
    }
  }
  return { ...draft, prompt, projectMemoryReferences: retained };
}
