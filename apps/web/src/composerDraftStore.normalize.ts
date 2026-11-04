import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  CrewThreadOverride,
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderOptionSelection,
  type PreviewAnnotationPayload,
  RuntimeMode,
  type ServerProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { DeepMutable } from "effect/Types";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import { resolveAppModelSelection, resolveAppModelSelectionForInstance } from "./modelSelection";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, videoMimeType } from "./types";
import { type TerminalContextDraft, normalizeTerminalContextText } from "./lib/terminalContext";
import { toComposerContextId } from "./lib/composerContextReferences";
import { getDefaultServerModel } from "./providerModels";
import { UnifiedSettings } from "@t3tools/contracts/settings";
import { type ReviewCommentContext } from "./reviewCommentContext";
import {
  isProviderDriverKind,
  isSnapShotSource,
  DraftThreadEnvMode,
  DraftId,
  PersistedComposerImageAttachment,
  ComposerImageAttachment,
  ComposerFileAttachment,
  PersistedTerminalContextDraft,
  ComposerProjectMemoryReference,
  ProviderOptionSelectionsByProvider,
  LegacyCodexFields,
  PersistedComposerDraftStoreState,
  ComposerThreadDraftState,
  DraftSessionState,
  DraftThreadState,
  ProjectDraftSession,
  ComposerThreadTarget,
  ComposerDraftStoreState,
  EffectiveComposerModelState,
  ComposerDraftModelState,
} from "./composerDraftStore.types";

export function providerSelectionsFromModelSelection(
  modelSelection: ModelSelection | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!modelSelection) {
    return null;
  }
  const options = modelSelection.options;
  if (!options || options.length === 0) {
    return null;
  }
  return { [modelSelection.instanceId]: options };
}

export function modelSelectionByProviderToOptions(
  map: Partial<Record<string, ModelSelection>> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!map) return null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options && selection.options.length > 0) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function cloneModelSelection(selection: ModelSelection): DeepMutable<ModelSelection> {
  return {
    ...selection,
    ...(selection.options ? { options: selection.options.map((option) => ({ ...option })) } : {}),
  } as DeepMutable<ModelSelection>;
}

export function compactModelSelectionByProvider(
  selections: Partial<Record<ProviderInstanceId, ModelSelection>>,
): DeepMutable<Record<ProviderInstanceId, ModelSelection>> {
  const entries: Array<[string, DeepMutable<ModelSelection>]> = [];
  for (const [provider, selection] of Object.entries(selections)) {
    if (selection !== undefined) {
      entries.push([provider, cloneModelSelection(selection)]);
    }
  }
  return Object.fromEntries(entries) as DeepMutable<Record<ProviderInstanceId, ModelSelection>>;
}

export const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByThreadKey: {},
  draftThreadsByThreadKey: {},
  logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  stickyModelSelectionByProvider: {},
  stickyActiveProvider: null,
});

export const EMPTY_IMAGES: ComposerImageAttachment[] = [];
export const EMPTY_FILES: ComposerFileAttachment[] = [];
export const EMPTY_IDS: string[] = [];
export const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
export const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
export const EMPTY_PREVIEW_ANNOTATIONS: PreviewAnnotationPayload[] = [];
export const EMPTY_REVIEW_COMMENTS: ReviewCommentContext[] = [];
export const EMPTY_PROJECT_MEMORY_REFERENCES: ComposerProjectMemoryReference[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_FILES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
Object.freeze(EMPTY_PREVIEW_ANNOTATIONS);
Object.freeze(EMPTY_REVIEW_COMMENTS);
Object.freeze(EMPTY_PROJECT_MEMORY_REFERENCES);
export const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<
  Record<ProviderDriverKind, ModelSelection>
> = Object.freeze({});
export const EMPTY_COMPOSER_DRAFT_MODEL_STATE = Object.freeze<ComposerDraftModelState>({
  activeProvider: null,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
});

export const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  images: EMPTY_IMAGES,
  files: EMPTY_FILES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  previewAnnotations: EMPTY_PREVIEW_ANNOTATIONS,
  reviewComments: EMPTY_REVIEW_COMMENTS,
  projectMemoryReferences: EMPTY_PROJECT_MEMORY_REFERENCES,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

/**
 * Canonical factory for a blank `ComposerThreadDraftState`. Exported so tests
 * (and any other call sites) can build a draft without re-declaring every
 * slice — adding a new field to the interface (e.g. `reviewComments`) only
 * has to be reflected here, not in every stub.
 */
export function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    projectMemoryReferences: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

export function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

export function composerFileDedupKey(
  file: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
): string {
  return `${file.mimeType}\u0000${file.sizeBytes}\u0000${file.name}`;
}

export function composerFileMatchesReattachMarker(
  marker: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
  file: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
): boolean {
  if (marker.name !== file.name || marker.sizeBytes !== file.sizeBytes) return false;
  if (marker.mimeType === file.mimeType) return true;
  const markerMimeType = marker.mimeType.toLowerCase();
  return (
    (markerMimeType === "" || markerMimeType === "application/octet-stream") &&
    videoMimeType(marker) !== null &&
    videoMimeType(file) !== null
  );
}

export function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

export function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    id: toComposerContextId(context.id),
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

export function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

export function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.previewAnnotations.length === 0 &&
    draft.reviewComments.length === 0 &&
    draft.projectMemoryReferences.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}

export function normalizeProviderDriverKind(value: unknown): ProviderDriverKind | null {
  return isProviderDriverKind(value) ? value : null;
}

/**
 * Match the `ProviderInstanceId` slug pattern (letter followed by
 * letters/digits/`-`/`_`, 1..64 chars). Permissive validator — the schema
 * layer owns authoritative validation; this is used inline to gate typed
 * writes to the draft's instance-keyed maps without pulling the full
 * Effect Schema runtime into the hot path.
 */
export const PROVIDER_INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * Coerce an arbitrary persisted value into a valid `ProviderInstanceId`. Used
 * wherever we need to accept both legacy driver-kind keys and custom instance
 * slugs (e.g. `codex_personal`) as routing keys.
 */
export function normalizeProviderInstanceId(value: unknown): ProviderInstanceId | null {
  if (typeof value !== "string") return null;
  if (!PROVIDER_INSTANCE_ID_PATTERN.test(value)) return null;
  return value as ProviderInstanceId;
}

/**
 * Coerce an unknown value into a `ReadonlyArray<ProviderOptionSelection>`.
 * Accepts either:
 *   - the v3 representation: an array of `{ id, value }` entries
 *   - the legacy v2 representation: a record of `{ id: string | boolean }`
 *
 * Validation is intentionally permissive: descriptors are the source of truth
 * for which option ids are meaningful for a given provider/model. Anything
 * outside the descriptor list is harmless trailing data and will simply be
 * ignored downstream.
 */
export function coerceProviderOptionSelections(
  value: unknown,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (Array.isArray(value)) {
    const out: ProviderOptionSelection[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = record.id;
      const optionValue = record.value;
      if (typeof id !== "string" || id.length === 0) continue;
      if (typeof optionValue === "string" || typeof optionValue === "boolean") {
        out.push({ id, value: optionValue });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: ProviderOptionSelection[] = [];
    for (const [id, raw] of Object.entries(record)) {
      if (typeof raw === "string" || typeof raw === "boolean") {
        out.push({ id, value: raw });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/**
 * Normalize a per-provider options bag from either the v3 or legacy v2 shape.
 *
 * `provider` and `legacy` parameters are migration-only inputs used to
 * recover legacy codex fields (effort/codexFastMode/serviceTier) that lived
 * directly on the draft instead of inside `modelOptions.codex`.
 */
export function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderDriverKind | null,
  legacy?: LegacyCodexFields,
): ProviderOptionSelectionsByProvider | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const providerKey of ["codex", "claudeAgent", "cursor", "opencode"] as const) {
    const selections = coerceProviderOptionSelections(candidate?.[providerKey]);
    if (selections) {
      result[providerKey] = selections;
    }
  }

  // Recover legacy codex fields that lived outside modelOptions.
  if (provider === "codex" && legacy) {
    const codexExtras: ProviderOptionSelection[] = [];
    if (typeof legacy.effort === "string" && legacy.effort.length > 0) {
      codexExtras.push({ id: "reasoningEffort", value: legacy.effort });
    }
    const fastMode =
      legacy.codexFastMode === true ||
      (typeof legacy.serviceTier === "string" && legacy.serviceTier === "fast");
    if (fastMode) {
      codexExtras.push({ id: "fastMode", value: true });
    }
    if (codexExtras.length > 0) {
      const existing = result.codex ?? [];
      const existingIds = new Set(existing.map((entry) => entry.id));
      const merged = [...existing];
      for (const extra of codexExtras) {
        if (!existingIds.has(extra.id)) merged.push(extra);
      }
      result.codex = merged;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// Returns a model selection whose `instanceId` is a valid
// `ProviderInstanceId` slug. Legacy `provider` fields are promoted verbatim
// because default instance ids used the same slug as the driver kind.
//
// Selections whose instance id doesn't match the slug pattern collapse to
// `null` — caller is responsible for deciding whether that's a dropped
// write or a routed error.
export function normalizeModelSelection(
  value: unknown,
  legacy?: {
    provider?: unknown;
    model?: unknown;
    modelOptions?: unknown;
    legacyCodex?: LegacyCodexFields;
  },
): NormalizedModelSelection | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  // Post-migration ModelSelection carries `instanceId`; pre-migration (v2
  // storage, legacy wire shapes) carries `provider`. Accept either so both
  // normalized stores and legacy drafts round-trip through this helper.
  const instanceId = normalizeProviderInstanceId(
    candidate?.instanceId ?? candidate?.provider ?? legacy?.provider,
  );
  if (instanceId === null) {
    return null;
  }
  const rawModel = candidate?.model ?? legacy?.model;
  if (typeof rawModel !== "string") {
    return null;
  }
  // Slug normalization can use provider-kind-specific rules when a legacy
  // driver key is present. Instance-only selections are not reverse-inferred
  // into a driver kind here; they get generic default normalization.
  const driverKindHint =
    normalizeProviderDriverKind(candidate?.provider ?? legacy?.provider) ??
    ProviderDriverKind.make("codex");
  const model = normalizeModelSlug(rawModel, driverKindHint);
  if (!model) {
    return null;
  }
  if (Array.isArray(candidate?.options)) {
    const selections = coerceProviderOptionSelections(candidate.options);
    return createModelSelection(instanceId, model, selections) as NormalizedModelSelection;
  }
  // Per-kind options were a pre-migration concern; only recover them for a
  // built-in-kind instance. Custom instances don't have a legacy options
  // store to thread through here.
  const kindForLegacyOptions = normalizeProviderDriverKind(instanceId);
  const modelOptions = kindForLegacyOptions
    ? normalizeProviderModelOptions(
        candidate?.options ? { [kindForLegacyOptions]: candidate.options } : legacy?.modelOptions,
        kindForLegacyOptions,
        kindForLegacyOptions === "codex" ? legacy?.legacyCodex : undefined,
      )
    : null;
  const options = kindForLegacyOptions ? modelOptions?.[kindForLegacyOptions] : undefined;
  return createModelSelection(instanceId, model, options) as NormalizedModelSelection;
}

export type NormalizedModelSelection = Omit<ModelSelection, "instanceId"> & {
  readonly instanceId: ProviderInstanceId;
};

// ── Legacy sync helpers (used only during migration from v2 storage) ──
//
// These operate against the legacy kind-keyed `modelOptions` map. The
// normalized selection now carries an open `ProviderInstanceId`; legacy
// migration only recovers options for keys that existed before custom
// provider instances.

export function legacySyncModelSelectionOptions(
  modelSelection: NormalizedModelSelection | null,
  modelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): NormalizedModelSelection | null {
  if (modelSelection === null) {
    return null;
  }
  const kind = normalizeProviderDriverKind(modelSelection.instanceId);
  const options = kind ? modelOptions?.[kind] : undefined;
  return createModelSelection(
    modelSelection.instanceId,
    modelSelection.model,
    options,
  ) as NormalizedModelSelection;
}

export function legacyMergeModelSelectionIntoProviderModelOptions(
  modelSelection: NormalizedModelSelection | null,
  currentModelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!modelSelection?.options || modelSelection.options.length === 0) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  const kind = normalizeProviderDriverKind(modelSelection.instanceId);
  if (!kind) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  return legacyReplaceProviderModelOptions(
    normalizeProviderModelOptions(currentModelOptions),
    kind,
    modelSelection.options,
  );
}

export function legacyReplaceProviderModelOptions(
  currentModelOptions: ProviderOptionSelectionsByProvider | null | undefined,
  provider: ProviderDriverKind,
  nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  const { [provider]: _discardedProviderModelOptions, ...otherProviderModelOptions } =
    currentModelOptions ?? {};
  const merged: ProviderOptionSelectionsByProvider = { ...otherProviderModelOptions };
  if (nextProviderOptions && nextProviderOptions.length > 0) {
    merged[provider] = nextProviderOptions;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

// ── New helpers for the consolidated representation ────────────────────

export function legacyToModelSelectionByProvider(
  modelSelection: NormalizedModelSelection | null,
  modelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): Partial<Record<ProviderInstanceId, ModelSelection>> {
  const result: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
  if (modelOptions) {
    for (const provider of ["codex", "claudeAgent", "cursor", "opencode"] as const) {
      const options = modelOptions[provider];
      if (options && options.length > 0) {
        const driverKind = ProviderDriverKind.make(provider);
        const instanceKey = defaultInstanceIdForDriver(driverKind);
        result[instanceKey] = createModelSelection(
          instanceKey,
          modelSelection?.instanceId === instanceKey
            ? modelSelection.model
            : (DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL),
          options,
        );
      }
    }
  }
  if (modelSelection) {
    result[modelSelection.instanceId] = modelSelection as ModelSelection;
  }
  return result;
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  /**
   * Optional routing key of the instance whose selection should override
   * the driver-level lookup. When present, the draft is queried by
   * `modelSelectionByProvider[selectedInstanceId]` so a custom Codex
   * instance (e.g. `codex_personal`) reads its own saved model instead of
   * collapsing to the default Codex bucket.
   */
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const baseModelCandidate =
    input.threadModelSelection?.model ?? input.projectModelSelection?.model ?? null;
  const preserveThreadModel =
    input.selectedInstanceId !== null &&
    input.selectedInstanceId !== undefined &&
    input.threadModelSelection?.instanceId === input.selectedInstanceId;
  const baseModel =
    (input.selectedInstanceId
      ? resolveAppModelSelectionForInstance(
          input.selectedInstanceId,
          input.settings,
          input.providers,
          baseModelCandidate,
          { preserveUnavailableSelection: preserveThreadModel },
        )
      : null) ??
    // Antigravity has no static model or cross-account catalog fallback.
    (input.selectedProvider === "antigravity" && input.selectedInstanceId ? "" : null) ??
    resolveAppModelSelection(
      input.selectedProvider,
      input.settings,
      input.providers,
      baseModelCandidate,
    ) ??
    normalizeModelSlug(baseModelCandidate, input.selectedProvider) ??
    getDefaultServerModel(input.providers, input.selectedProvider);
  // Look up the instance's saved selection first; fall back to the
  // driver-kind bucket so legacy kind-keyed drafts still resolve. Every
  // `ProviderDriverKind` literal is a valid `ProviderInstanceId` slug, so the
  // cast to the branded type is safe.
  const instanceSelection = input.selectedInstanceId
    ? input.draft?.modelSelectionByProvider?.[input.selectedInstanceId]
    : undefined;
  const legacySelection =
    input.selectedProvider === "antigravity" &&
    input.selectedInstanceId &&
    input.selectedInstanceId !== defaultInstanceIdForDriver(input.selectedProvider)
      ? undefined
      : input.draft?.modelSelectionByProvider?.[ProviderInstanceId.make(input.selectedProvider)];
  const activeSelection = instanceSelection ?? legacySelection;
  const activeSelectionInstanceId = instanceSelection
    ? (input.selectedInstanceId ?? ProviderInstanceId.make(input.selectedProvider))
    : ProviderInstanceId.make(input.selectedProvider);
  const selectedModel = activeSelection?.model
    ? (resolveAppModelSelectionForInstance(
        activeSelectionInstanceId,
        input.settings,
        input.providers,
        activeSelection.model,
        { preserveUnavailableSelection: true },
      ) ??
      (input.selectedProvider === "antigravity" ? "" : null) ??
      resolveAppModelSelection(
        input.selectedProvider,
        input.settings,
        input.providers,
        activeSelection.model,
      ))
    : baseModel;
  const modelOptions =
    modelSelectionByProviderToOptions(input.draft?.modelSelectionByProvider) ??
    providerSelectionsFromModelSelection(input.threadModelSelection) ??
    providerSelectionsFromModelSelection(input.projectModelSelection) ??
    null;

  return {
    selectedModel,
    modelOptions,
  };
}

export function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }
  if (!previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeDraftThreadPreviewUrls(draft: ComposerThreadDraftState | undefined): void {
  if (!draft) {
    return;
  }
  for (const image of draft.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
}

export function normalizePersistedAttachment(
  value: unknown,
): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    typeof dataUrl !== "string" ||
    id.length === 0 ||
    dataUrl.length === 0
  ) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
    ...(isSnapShotSource(candidate.source) ? { source: candidate.source } : {}),
  };
}

export function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof lineStart !== "number" ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== "number" ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }
  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";
  const terminalLabel =
    typeof candidate.terminalLabel === "string" ? candidate.terminalLabel.trim() : "";
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));
  return {
    id: toComposerContextId(id),
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
    ...(typeof candidate.text === "string" ? { text: candidate.text } : {}),
  };
}

export function normalizeDraftThreadEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftThreadEnvMode {
  if (value === "local" || value === "worktree") {
    return value;
  }
  return fallbackWorktreePath ? "worktree" : "local";
}

export function projectDraftKey(projectRef: ScopedProjectRef): string {
  return scopedProjectKey(projectRef);
}

export function logicalProjectDraftKey(logicalProjectKey: string): string {
  return logicalProjectKey.trim();
}

/**
 * Runtime composer storage key for app-facing identities only.
 *
 * Draft sessions are keyed by `DraftId`. Real threads are keyed by
 * `ScopedThreadRef` so environment identity is always preserved.
 */
export function composerTargetKey(target: ScopedThreadRef | DraftId): string {
  if (typeof target === "string") {
    return target.trim();
  }
  return scopedThreadKey(target);
}

/**
 * Legacy persisted data may still be keyed by a raw `ThreadId`. This helper is
 * intentionally migration-only so live code cannot accidentally accept that
 * incomplete identity.
 */
export function normalizeLegacyComposerStorageKey(
  threadKeyOrId: string,
  options?: {
    environmentId?: EnvironmentId;
  },
): string {
  const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
  if (parsedThreadRef) {
    return composerTargetKey(parsedThreadRef);
  }
  if (options?.environmentId) {
    return composerTargetKey(scopeThreadRef(options.environmentId, threadKeyOrId as ThreadId));
  }
  return threadKeyOrId;
}

export function composerThreadRefFromKey(threadKey: string): ScopedThreadRef | null {
  return parseScopedThreadKey(threadKey);
}

export type ComposerThreadLookupState = Pick<
  ComposerDraftStoreState,
  "draftsByThreadKey" | "draftThreadsByThreadKey"
>;

export function normalizeComposerTarget(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ComposerThreadTarget | null {
  if (typeof target === "string") {
    const draftId = target.trim();
    return draftId.length > 0 ? DraftId.make(draftId) : null;
  }
  return target;
}

export function resolveComposerDraftKey(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): string | null {
  const normalizedTarget = normalizeComposerTarget(state, target);
  if (!normalizedTarget) {
    return null;
  }
  if (typeof normalizedTarget !== "string") {
    const scopedKey = composerTargetKey(normalizedTarget);
    if (state.draftsByThreadKey[scopedKey]) {
      return scopedKey;
    }
    for (const [draftId, draftSession] of Object.entries(state.draftThreadsByThreadKey)) {
      if (
        draftSession.environmentId === normalizedTarget.environmentId &&
        draftSession.threadId === normalizedTarget.threadId
      ) {
        return draftId;
      }
    }
    return scopedKey;
  }
  const threadKey = composerTargetKey(normalizedTarget);
  return threadKey.length > 0 ? threadKey : null;
}

export function resolveComposerThreadId(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ThreadId | null {
  const normalizedTarget = normalizeComposerTarget(state, target);
  if (!normalizedTarget) {
    return null;
  }
  if (typeof normalizedTarget !== "string") {
    return normalizedTarget.threadId;
  }
  return state.draftThreadsByThreadKey[normalizedTarget]?.threadId ?? null;
}

export function getComposerDraftState(
  state: Pick<ComposerDraftStoreState, "draftsByThreadKey" | "draftThreadsByThreadKey">,
  target: ComposerThreadTarget,
): ComposerThreadDraftState | null {
  const threadKey = resolveComposerDraftKey(state, target);
  if (!threadKey) {
    return null;
  }
  return state.draftsByThreadKey[threadKey] ?? null;
}

export function isComposerThreadKeyInUse(
  mappings: Record<string, string>,
  threadKey: string,
): boolean {
  return Object.values(mappings).includes(threadKey);
}

export function toProjectDraftSession(
  draftId: DraftId,
  draftSession: DraftSessionState,
): ProjectDraftSession {
  return {
    draftId,
    ...draftSession,
  };
}

export function createDraftThreadState(
  projectRef: ScopedProjectRef,
  threadId: ThreadId,
  logicalProjectKey: string,
  existingThread: DraftThreadState | undefined,
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
): DraftThreadState {
  // A project change (including switching environments within a logical
  // project) invalidates machine-specific context: the branch may not exist
  // there and the worktree path certainly doesn't. The user's *intent* —
  // env mode and start-from-origin — is machine-independent and carries.
  const projectChanged =
    existingThread !== undefined &&
    (existingThread.environmentId !== projectRef.environmentId ||
      existingThread.projectId !== projectRef.projectId);
  const nextWorktreePath =
    options?.worktreePath === undefined
      ? projectChanged
        ? null
        : (existingThread?.worktreePath ?? null)
      : (options.worktreePath ?? null);
  const nextBranch =
    options?.branch === undefined
      ? projectChanged
        ? null
        : (existingThread?.branch ?? null)
      : (options.branch ?? null);
  const nextStartFromOrigin =
    options?.startFromOrigin === undefined
      ? (existingThread?.startFromOrigin ?? false)
      : options.startFromOrigin;
  const environmentSelection =
    options?.environmentSelection ?? existingThread?.environmentSelection;
  return {
    threadId,
    environmentId: projectRef.environmentId,
    projectId: projectRef.projectId,
    logicalProjectKey,
    ...(environmentSelection ? { environmentSelection } : {}),
    ...(options?.loadBalancedEnvironmentId !== undefined
      ? { loadBalancedEnvironmentId: options.loadBalancedEnvironmentId }
      : existingThread?.loadBalancedEnvironmentId !== undefined
        ? {
            loadBalancedEnvironmentId: projectChanged
              ? null
              : existingThread.loadBalancedEnvironmentId,
          }
        : {}),
    createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
    runtimeMode: options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode:
      options?.interactionMode ?? existingThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    branch: nextBranch,
    worktreePath: nextWorktreePath,
    envMode:
      options?.envMode ?? (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
    startFromOrigin: nextStartFromOrigin,
    ...(existingThread?.crew !== undefined ? { crew: existingThread.crew } : {}),
    promotedTo: null,
  };
}

export function scopedThreadRefsEqual(
  left: ScopedThreadRef | null | undefined,
  right: ScopedThreadRef | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

export function isDraftThreadPromoting(draftThread: DraftThreadState | null | undefined): boolean {
  return draftThread?.promotedTo !== null && draftThread?.promotedTo !== undefined;
}

export function crewsEqual(
  left: CrewThreadOverride | undefined,
  right: CrewThreadOverride | undefined,
) {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export function draftThreadsEqual(
  left: DraftThreadState | undefined,
  right: DraftThreadState,
): boolean {
  return (
    !!left &&
    left.threadId === right.threadId &&
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.logicalProjectKey === right.logicalProjectKey &&
    left.environmentSelection === right.environmentSelection &&
    left.loadBalancedEnvironmentId === right.loadBalancedEnvironmentId &&
    left.createdAt === right.createdAt &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.envMode === right.envMode &&
    left.startFromOrigin === right.startFromOrigin &&
    crewsEqual(left.crew, right.crew) &&
    scopedThreadRefsEqual(left.promotedTo, right.promotedTo)
  );
}

export function removeDraftThreadReferences(
  state: Pick<
    ComposerDraftStoreState,
    | "draftThreadsByThreadKey"
    | "draftsByThreadKey"
    | "logicalProjectDraftThreadKeyByLogicalProjectKey"
  >,
  threadKey: string,
  composerDestination?: ScopedThreadRef,
): Pick<
  ComposerDraftStoreState,
  | "draftThreadsByThreadKey"
  | "draftsByThreadKey"
  | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const nextLogicalMappings = Object.fromEntries(
    Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
      ([, draftThreadKey]) => draftThreadKey !== threadKey,
    ),
  ) as Record<string, string>;
  const { [threadKey]: _removedDraftThread, ...restDraftThreadsByThreadKey } =
    state.draftThreadsByThreadKey;
  const { [threadKey]: removedComposerDraft, ...restDraftsByThreadKey } = state.draftsByThreadKey;
  if (composerDestination && removedComposerDraft) {
    restDraftsByThreadKey[composerTargetKey(composerDestination)] = removedComposerDraft;
  } else {
    revokeDraftThreadPreviewUrls(removedComposerDraft);
  }
  return {
    draftsByThreadKey: restDraftsByThreadKey,
    draftThreadsByThreadKey: restDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
  };
}
