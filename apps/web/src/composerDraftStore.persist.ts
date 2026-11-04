import {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  type PreviewAnnotationPayload,
  ThreadId,
  ElementContextDetails,
  ProjectId,
} from "@t3tools/contracts";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopeThreadRef,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import {
  ensureInlineContextReferences,
  formatInlineContextReference,
  toKindScopedComposerContextId,
  toComposerContextId,
} from "./lib/composerContextReferences";
import {
  fileContextReference,
  previewAnnotationContextReference,
  projectMemoryContextReference,
  reviewCommentContextReference,
  terminalContextReference,
} from "./lib/composerContextRecords";
import { type PersistStorage, type StorageValue } from "zustand/middleware";
import { createDeferredStorage, createMemoryStorage } from "./lib/storage";
import {
  isRuntimeMode,
  isReviewCommentContext,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  ComposerImageAttachment,
  ComposerFileAttachment,
  PersistedComposerDraftStoreState,
  ComposerThreadDraftState,
  composerDraftHasUserContent,
  DraftThreadState,
  ComposerDraftStoreState,
  isCrewThreadOverride,
  isPreviewAnnotationPayload,
  PersistedComposerImageAttachment,
  isPersistedComposerDraftFileAttachment,
  normalizeProjectMemoryReferences,
  PersistedComposerThreadDraftState,
  LegacyPersistedComposerThreadDraftState,
  LegacyPersistedComposerDraftStoreState,
  PersistedDraftThreadState,
  PersistedComposerDraftStoreStorage,
} from "./composerDraftStore.types";
import {
  compactModelSelectionByProvider,
  shouldRemoveDraft,
  normalizeModelSelection,
  projectDraftKey,
  isDraftThreadPromoting,
  EMPTY_PERSISTED_DRAFT_STORE_STATE,
  normalizeProviderInstanceId,
  normalizeProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacyToModelSelectionByProvider,
  normalizePersistedAttachment,
  normalizePersistedTerminalContextDraft,
  normalizeDraftThreadEnvMode,
  normalizeLegacyComposerStorageKey,
  composerThreadRefFromKey,
} from "./composerDraftStore.normalize";
import { elementContextToPreviewAnnotation } from "./lib/elementContext";
import * as Schema from "effect/Schema";
import { DeepMutable } from "effect/Types";
import { getLocalStorageItem } from "./hooks/useLocalStorage";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "./types";
import { migrateLegacyTerminalContextPlaceholders } from "./lib/terminalContext";

export function normalizePersistedDraftThreads(
  rawDraftThreadsByThreadId: unknown,
  rawProjectDraftThreadIdByProjectKey: unknown,
): Pick<
  PersistedComposerDraftStoreState,
  "draftThreadsByThreadKey" | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const draftThreadsByThreadKey: Record<string, PersistedDraftThreadState> = {};
  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();
  if (
    rawProjectDraftThreadIdByProjectKey &&
    typeof rawProjectDraftThreadIdByProjectKey === "object"
  ) {
    for (const [projectKey, threadId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey as Record<string, unknown>,
    )) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        continue;
      }
      const projectRef = parseScopedProjectKey(projectKey);
      if (!projectRef) {
        continue;
      }
      const parsedThreadRef = parseScopedThreadKey(threadId);
      if (parsedThreadRef) {
        environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId);
        continue;
      }
      environmentIdByThreadId.set(threadId as ThreadId, projectRef.environmentId);
    }
  }
  if (rawDraftThreadsByThreadId && typeof rawDraftThreadsByThreadId === "object") {
    for (const [threadKeyOrId, rawDraftThread] of Object.entries(
      rawDraftThreadsByThreadId as Record<string, unknown>,
    )) {
      if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
        continue;
      }
      if (!rawDraftThread || typeof rawDraftThread !== "object") {
        continue;
      }
      const candidateDraftThread = rawDraftThread as Record<string, unknown>;
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId);
      const threadId =
        parsedThreadRef?.threadId ??
        (typeof candidateDraftThread.threadId === "string" &&
        candidateDraftThread.threadId.length > 0
          ? (candidateDraftThread.threadId as ThreadId)
          : (threadKeyOrId as ThreadId));
      const environmentId =
        parsedThreadRef?.environmentId ??
        (typeof candidateDraftThread.environmentId === "string" &&
        candidateDraftThread.environmentId.length > 0
          ? (candidateDraftThread.environmentId as EnvironmentId)
          : environmentIdByThreadId.get(threadKeyOrId as ThreadId));
      const projectId = candidateDraftThread.projectId;
      const createdAt = candidateDraftThread.createdAt;
      const branch = candidateDraftThread.branch;
      const worktreePath = candidateDraftThread.worktreePath;
      const startFromOrigin = candidateDraftThread.startFromOrigin === true;
      const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
      const promotedToCandidate = candidateDraftThread.promotedTo;
      const promotedToRecord =
        promotedToCandidate && typeof promotedToCandidate === "object"
          ? (promotedToCandidate as Record<string, unknown>)
          : null;
      const promotedTo =
        promotedToRecord &&
        typeof promotedToRecord.environmentId === "string" &&
        promotedToRecord.environmentId.length > 0 &&
        typeof promotedToRecord.threadId === "string" &&
        promotedToRecord.threadId.length > 0
          ? scopeThreadRef(
              promotedToRecord.environmentId as EnvironmentId,
              promotedToRecord.threadId as ThreadId,
            )
          : null;
      if (typeof projectId !== "string" || projectId.length === 0 || environmentId === undefined) {
        continue;
      }
      const normalizedEnvironmentId = environmentId as EnvironmentId;
      draftThreadsByThreadKey[threadKey] = {
        threadId,
        environmentId: normalizedEnvironmentId,
        projectId: projectId as ProjectId,
        logicalProjectKey:
          typeof candidateDraftThread.logicalProjectKey === "string" &&
          candidateDraftThread.logicalProjectKey.length > 0
            ? candidateDraftThread.logicalProjectKey
            : parsedThreadRef
              ? projectDraftKey(scopeProjectRef(normalizedEnvironmentId, projectId as ProjectId))
              : threadKeyOrId,
        createdAt:
          typeof createdAt === "string" && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode: isRuntimeMode(candidateDraftThread.runtimeMode)
          ? candidateDraftThread.runtimeMode
          : DEFAULT_RUNTIME_MODE,
        interactionMode:
          candidateDraftThread.interactionMode === "plan" ||
          candidateDraftThread.interactionMode === "default"
            ? candidateDraftThread.interactionMode
            : DEFAULT_INTERACTION_MODE,
        branch: typeof branch === "string" ? branch : null,
        worktreePath: normalizedWorktreePath,
        envMode: normalizeDraftThreadEnvMode(candidateDraftThread.envMode, normalizedWorktreePath),
        startFromOrigin,
        ...(isCrewThreadOverride(candidateDraftThread.crew)
          ? { crew: candidateDraftThread.crew }
          : {}),
        ...(candidateDraftThread.environmentSelection === "manual" ||
        candidateDraftThread.environmentSelection === "auto"
          ? { environmentSelection: candidateDraftThread.environmentSelection }
          : {}),
        ...(typeof candidateDraftThread.loadBalancedEnvironmentId === "string" &&
        candidateDraftThread.loadBalancedEnvironmentId.length > 0
          ? { loadBalancedEnvironmentId: candidateDraftThread.loadBalancedEnvironmentId }
          : candidateDraftThread.loadBalancedEnvironmentId === null
            ? { loadBalancedEnvironmentId: null }
            : {}),
        promotedTo,
      };
    }
  }

  const logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {};
  if (
    rawProjectDraftThreadIdByProjectKey &&
    typeof rawProjectDraftThreadIdByProjectKey === "object"
  ) {
    for (const [logicalProjectKey, threadKeyOrId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey as Record<string, unknown>,
    )) {
      if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
        continue;
      }
      const projectRef = parseScopedProjectKey(logicalProjectKey);
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId);
      logicalProjectDraftThreadKeyByLogicalProjectKey[logicalProjectKey] = threadKey;
      const existingDraftThread = draftThreadsByThreadKey[threadKey];
      if (parsedThreadRef) {
        environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId);
      }
      // Logical project keys may contain a workspace path after the
      // environment prefix. When the persisted draft already names that
      // logical key, its concrete project id remains authoritative.
      if (existingDraftThread?.logicalProjectKey === logicalProjectKey) {
        continue;
      }
      if (!projectRef) {
        if (existingDraftThread) {
          draftThreadsByThreadKey[threadKey] = {
            ...existingDraftThread,
            logicalProjectKey,
          };
        }
        continue;
      }
      if (!existingDraftThread) {
        draftThreadsByThreadKey[threadKey] = {
          threadId: parsedThreadRef?.threadId ?? (threadKey as ThreadId),
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          logicalProjectKey,
          createdAt: new Date().toISOString(),
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          envMode: "local",
          startFromOrigin: false,
          promotedTo: null,
        };
      } else if (
        existingDraftThread.projectId !== projectRef.projectId ||
        existingDraftThread.environmentId !== projectRef.environmentId
      ) {
        draftThreadsByThreadKey[threadKey] = {
          ...existingDraftThread,
          threadId: existingDraftThread.threadId,
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          logicalProjectKey,
        };
      }
    }
  }

  return { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey };
}

export function normalizePersistedDraftsByThreadId(
  rawDraftMap: unknown,
  draftThreadsByThreadKey: PersistedComposerDraftStoreState["draftThreadsByThreadKey"],
): PersistedComposerDraftStoreState["draftsByThreadKey"] {
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return {};
  }

  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();
  for (const [threadKey, draftThread] of Object.entries(draftThreadsByThreadKey)) {
    const parsedThreadRef = composerThreadRefFromKey(threadKey);
    if (!parsedThreadRef) {
      continue;
    }
    environmentIdByThreadId.set(
      parsedThreadRef.threadId,
      draftThread.environmentId as EnvironmentId,
    );
  }

  const nextDraftsByThreadKey: DeepMutable<PersistedComposerDraftStoreState["draftsByThreadKey"]> =
    {};
  for (const [threadKeyOrId, draftValue] of Object.entries(
    rawDraftMap as Record<string, unknown>,
  )) {
    if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draftCandidate = draftValue as PersistedComposerThreadDraftState;
    const promptCandidate = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const files = Array.isArray(draftCandidate.files)
      ? draftCandidate.files.filter(isPersistedComposerDraftFileAttachment)
      : [];
    const terminalContexts = Array.isArray(draftCandidate.terminalContexts)
      ? draftCandidate.terminalContexts.flatMap((entry) => {
          const normalized = normalizePersistedTerminalContextDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const reviewComments = Array.isArray(draftCandidate.reviewComments)
      ? draftCandidate.reviewComments.filter(isReviewCommentContext)
      : [];
    const projectMemoryReferences = normalizeProjectMemoryReferences(
      draftCandidate.projectMemoryReferences,
    );
    const previewAnnotations = Array.isArray(draftCandidate.previewAnnotations)
      ? draftCandidate.previewAnnotations.filter(isPreviewAnnotationPayload)
      : [];
    const legacyElements =
      "elementContexts" in draftValue && Array.isArray(draftValue.elementContexts)
        ? draftValue.elementContexts
        : [];
    for (const element of legacyElements) {
      if (
        !Schema.is(ElementContextDetails)(element) ||
        !("id" in element) ||
        typeof element.id !== "string" ||
        !("pickedAt" in element) ||
        typeof element.pickedAt !== "string"
      )
        continue;
      if (!previewAnnotations.some((annotation) => annotation.id === element.id)) {
        previewAnnotations.push(
          elementContextToPreviewAnnotation(element, element.id, element.pickedAt),
        );
      }
    }
    const runtimeMode = isRuntimeMode(draftCandidate.runtimeMode)
      ? draftCandidate.runtimeMode
      : null;
    const interactionMode =
      draftCandidate.interactionMode === "plan" || draftCandidate.interactionMode === "default"
        ? draftCandidate.interactionMode
        : null;
    const contextIds = new Map<string, string>();
    for (const [kind, entries] of [
      ["image", attachments],
      ["file", files],
      ["terminal", terminalContexts],
      ["review-comment", reviewComments],
      ["preview-annotation", previewAnnotations],
    ] as const) {
      for (const entry of entries) {
        const contextId = toKindScopedComposerContextId(kind, entry.id);
        contextIds.set(`${kind}/${entry.id}`, contextId);
        contextIds.set(`${kind}/${toComposerContextId(entry.id)}`, contextId);
        if (kind === "preview-annotation") {
          contextIds.set(`${kind}/${toComposerContextId(`annotation-${entry.id}`)}`, contextId);
        }
      }
      // A live canonical reference wins over another record's legacy producer-ID alias.
      for (const entry of entries) {
        const contextId = toKindScopedComposerContextId(kind, entry.id);
        contextIds.set(`${kind}/${contextId}`, contextId);
      }
    }
    // Older drafts used producer ids (including dots and colons) directly in links.
    // Rewrite only links backed by this draft, before appending any missing references.
    const migratedPrompt = promptCandidate.replace(
      /!?\[([^\]\r\n]*)\]\(t3-context:\/\/v1\/([a-z-]+)\/([^/()\r\n]+)\)/g,
      (source, label: string, kind: string, id: string) => {
        const contextId = contextIds.get(`${kind}/${id}`);
        return contextId ? formatInlineContextReference({ kind, contextId, label }) : source;
      },
    );
    const prompt = ensureInlineContextReferences(
      migrateLegacyTerminalContextPlaceholders(migratedPrompt, terminalContexts),
      terminalContexts.map((context) => terminalContextReference({ ...context, text: "" })),
    );
    // If the draft already has the v3 shape, use it directly
    const legacyDraftCandidate = draftValue as LegacyPersistedComposerThreadDraftState;
    let modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
    let activeProvider: ProviderInstanceId | null = null;
    let modelSelectionExplicit: true | undefined = undefined;

    if (
      draftCandidate.modelSelectionByProvider &&
      typeof draftCandidate.modelSelectionByProvider === "object"
    ) {
      // v3 format
      modelSelectionByProvider = draftCandidate.modelSelectionByProvider as Partial<
        Record<ProviderInstanceId, ModelSelection>
      >;
      activeProvider = normalizeProviderInstanceId(draftCandidate.activeProvider);
      modelSelectionExplicit = draftCandidate.modelSelectionExplicit === true ? true : undefined;
    } else {
      // v2 or legacy format: migrate
      const normalizedModelOptions =
        normalizeProviderModelOptions(
          legacyDraftCandidate.modelOptions,
          undefined,
          legacyDraftCandidate,
        ) ?? null;
      const normalizedModelSelection = normalizeModelSelection(
        legacyDraftCandidate.modelSelection,
        {
          provider: legacyDraftCandidate.provider,
          model: legacyDraftCandidate.model,
          modelOptions: normalizedModelOptions ?? (legacyDraftCandidate.modelOptions as unknown),
          legacyCodex: legacyDraftCandidate,
        },
      );
      const mergedModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
        normalizedModelSelection,
        normalizedModelOptions,
      );
      const modelSelection = legacySyncModelSelectionOptions(
        normalizedModelSelection,
        mergedModelOptions,
      );
      modelSelectionByProvider = legacyToModelSelectionByProvider(
        modelSelection,
        mergedModelOptions,
      );
      activeProvider = modelSelection?.instanceId ?? null;
    }

    const hasModelData =
      Object.keys(modelSelectionByProvider).length > 0 || activeProvider !== null;
    if (
      promptCandidate.length === 0 &&
      attachments.length === 0 &&
      files.length === 0 &&
      terminalContexts.length === 0 &&
      previewAnnotations.length === 0 &&
      reviewComments.length === 0 &&
      projectMemoryReferences.length === 0 &&
      previewAnnotations.length === 0 &&
      !hasModelData &&
      !runtimeMode &&
      !interactionMode
    ) {
      continue;
    }
    const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
    const normalizedThreadKey =
      parsedThreadRef !== null
        ? normalizeLegacyComposerStorageKey(threadKeyOrId)
        : draftThreadsByThreadKey[threadKeyOrId] !== undefined
          ? threadKeyOrId
          : (() => {
              const environmentId = environmentIdByThreadId.get(threadKeyOrId as ThreadId);
              return environmentId
                ? normalizeLegacyComposerStorageKey(threadKeyOrId, { environmentId })
                : threadKeyOrId;
            })();
    nextDraftsByThreadKey[normalizedThreadKey] = {
      prompt,
      attachments,
      ...(files.length > 0 ? { files } : {}),
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(previewAnnotations.length > 0 ? { previewAnnotations } : {}),
      ...(reviewComments.length > 0 ? { reviewComments } : {}),
      ...(projectMemoryReferences.length > 0 ? { projectMemoryReferences } : {}),
      ...(previewAnnotations.length > 0 ? { previewAnnotations } : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(modelSelectionByProvider),
            activeProvider,
            ...(modelSelectionExplicit ? { modelSelectionExplicit: true } : {}),
          }
        : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(interactionMode ? { interactionMode } : {}),
    };
  }

  return nextDraftsByThreadKey;
}

export function persistedComposerDraftHasUserContent(
  draft: PersistedComposerThreadDraftState,
): boolean {
  return (
    draft.prompt.trim().length > 0 ||
    draft.attachments.length > 0 ||
    (draft.files?.length ?? 0) > 0 ||
    (draft.terminalContexts?.length ?? 0) > 0 ||
    (draft.previewAnnotations?.length ?? 0) > 0 ||
    (draft.reviewComments?.length ?? 0) > 0 ||
    (draft.projectMemoryReferences?.length ?? 0) > 0
  );
}

export function stripLegacyModelSeedsFromEmptyDraftSessions(
  draftsByThreadKey: PersistedComposerDraftStoreState["draftsByThreadKey"],
  draftThreadsByThreadKey: PersistedComposerDraftStoreState["draftThreadsByThreadKey"],
): PersistedComposerDraftStoreState["draftsByThreadKey"] {
  return Object.fromEntries(
    Object.entries(draftsByThreadKey).flatMap(([threadKey, draft]) => {
      if (
        draftThreadsByThreadKey[threadKey] === undefined ||
        draft.modelSelectionExplicit === true ||
        persistedComposerDraftHasUserContent(draft)
      ) {
        return [[threadKey, draft]];
      }

      const {
        activeProvider: _activeProvider,
        modelSelectionByProvider: _modelSelectionByProvider,
        modelSelectionExplicit: _modelSelectionExplicit,
        ...retained
      } = draft;
      return retained.runtimeMode || retained.interactionMode ? [[threadKey, retained]] : [];
    }),
  );
}

export function migratePersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  const normalized = normalizeCurrentPersistedComposerDraftStoreState(persistedState);
  return {
    ...normalized,
    draftsByThreadKey: stripLegacyModelSeedsFromEmptyDraftSessions(
      normalized.draftsByThreadKey,
      normalized.draftThreadsByThreadKey,
    ),
  };
}

/** Select the persisted draft fields when the storage write is ready to flush. */
export function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  // Draft sessions worth persisting: mapped (a new-thread flow targets
  // them), promoting (mid-send), or holding real user content (they back a
  // sidebar row). Everything else is a zombie — and its composer blob must
  // be dropped WITH it, or model/mode-only entries would persist forever
  // keyed to a session that no longer exists.
  const mappedDraftKeys = new Set(
    Object.values(state.logicalProjectDraftThreadKeyByLogicalProjectKey),
  );
  const keptSessionKeys = new Set(
    Object.entries(state.draftThreadsByThreadKey)
      .filter(
        ([threadKey, draftThread]) =>
          mappedDraftKeys.has(threadKey) ||
          isDraftThreadPromoting(draftThread) ||
          composerDraftHasUserContent(state.draftsByThreadKey[threadKey]),
      )
      .map(([threadKey]) => threadKey),
  );
  const persistedDraftsByThreadKey: DeepMutable<
    PersistedComposerDraftStoreState["draftsByThreadKey"]
  > = {};
  for (const [threadKey, draft] of Object.entries(state.draftsByThreadKey)) {
    if (typeof threadKey !== "string" || threadKey.length === 0) {
      continue;
    }
    // Composer content keyed to a dropped draft session goes with it.
    // Server-thread keys have no session entry and are unaffected.
    if (state.draftThreadsByThreadKey[threadKey] !== undefined && !keptSessionKeys.has(threadKey)) {
      continue;
    }
    const hasModelData =
      Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null;
    if (
      draft.prompt.length === 0 &&
      draft.persistedAttachments.length === 0 &&
      draft.files.length === 0 &&
      draft.terminalContexts.length === 0 &&
      draft.previewAnnotations.length === 0 &&
      draft.reviewComments.length === 0 &&
      draft.projectMemoryReferences.length === 0 &&
      !hasModelData &&
      draft.runtimeMode === null &&
      draft.interactionMode === null
    ) {
      continue;
    }
    const persistedDraft: DeepMutable<PersistedComposerThreadDraftState> = {
      prompt: draft.prompt,
      attachments: draft.persistedAttachments,
      ...(draft.files.length > 0
        ? {
            // A file whose upload has not finished has no serializable bytes.
            // It persists as a metadata-only marker so it can surface as a
            // needs-reattach row after reload instead of silently vanishing.
            files: draft.files.map((file) => ({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
              ...(file.source ? { source: file.source } : {}),
              ...(file.uploadedAttachmentId && file.uploadEnvironmentId
                ? {
                    attachmentId: file.uploadedAttachmentId,
                    environmentId: file.uploadEnvironmentId,
                  }
                : {}),
            })),
          }
        : {}),
      ...(draft.terminalContexts.length > 0
        ? {
            terminalContexts: draft.terminalContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              createdAt: context.createdAt,
              terminalId: context.terminalId,
              terminalLabel: context.terminalLabel,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
              text: context.text,
            })),
          }
        : {}),
      ...(draft.previewAnnotations.length > 0
        ? {
            previewAnnotations: draft.previewAnnotations.map(
              (annotation) => ({ ...annotation }) as DeepMutable<PreviewAnnotationPayload>,
            ),
          }
        : {}),
      ...(draft.reviewComments.length > 0
        ? {
            reviewComments: draft.reviewComments.map((comment) => ({ ...comment })),
          }
        : {}),
      ...(draft.autoSelectDismissed !== undefined && draft.autoSelectDismissed.length > 0
        ? { autoSelectDismissed: [...draft.autoSelectDismissed] }
        : {}),
      ...(draft.autoSelectAdded !== undefined && draft.autoSelectAdded.length > 0
        ? { autoSelectAdded: [...draft.autoSelectAdded] }
        : {}),
      // Identifier-only by contract: no title or body ever persists with a draft.
      ...(draft.projectMemoryReferences.length > 0
        ? {
            projectMemoryReferences: draft.projectMemoryReferences.map((reference) => ({
              contextId: reference.contextId,
              memoryId: reference.memoryId,
              selectedVersion: reference.selectedVersion,
            })),
          }
        : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(
              draft.modelSelectionByProvider,
            ),
            activeProvider: draft.activeProvider,
            ...(draft.modelSelectionExplicit ? { modelSelectionExplicit: true } : {}),
          }
        : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
    };
    persistedDraftsByThreadKey[threadKey] = persistedDraft;
  }
  const persistedDraftThreadsByThreadKey: Record<string, PersistedDraftThreadState> = {};
  for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
    if (!keptSessionKeys.has(threadKey)) {
      continue;
    }
    persistedDraftThreadsByThreadKey[threadKey] = draftThread;
  }
  return {
    draftsByThreadKey: persistedDraftsByThreadKey,
    draftThreadsByThreadKey: persistedDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(
      state.stickyModelSelectionByProvider,
    ),
    stickyActiveProvider: state.stickyActiveProvider,
  };
}

export function normalizeCurrentPersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const normalizedPersistedState = persistedState as LegacyPersistedComposerDraftStoreState;
  const { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey } =
    normalizePersistedDraftThreads(
      normalizedPersistedState.draftThreadsByThreadKey ??
        normalizedPersistedState.draftThreadsByThreadId,
      normalizedPersistedState.logicalProjectDraftThreadKeyByLogicalProjectKey ??
        normalizedPersistedState.projectDraftThreadKeyByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectId,
    );

  // Handle both v3 (modelSelectionByProvider) and v2/legacy formats
  let stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
  let stickyActiveProvider: ProviderInstanceId | null = null;
  if (
    normalizedPersistedState.stickyModelSelectionByProvider &&
    typeof normalizedPersistedState.stickyModelSelectionByProvider === "object"
  ) {
    stickyModelSelectionByProvider =
      normalizedPersistedState.stickyModelSelectionByProvider as Partial<
        Record<ProviderInstanceId, ModelSelection>
      >;
    stickyActiveProvider = normalizeProviderInstanceId(
      normalizedPersistedState.stickyActiveProvider,
    );
  } else {
    // Legacy migration path
    const stickyModelOptions =
      normalizeProviderModelOptions(normalizedPersistedState.stickyModelOptions) ?? {};
    const normalizedStickyModelSelection = normalizeModelSelection(
      normalizedPersistedState.stickyModelSelection,
      {
        provider: normalizedPersistedState.stickyProvider ?? "codex",
        model: normalizedPersistedState.stickyModel,
        modelOptions: stickyModelOptions,
      },
    );
    const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
      normalizedStickyModelSelection,
      stickyModelOptions,
    );
    const stickyModelSelection = legacySyncModelSelectionOptions(
      normalizedStickyModelSelection,
      nextStickyModelOptions,
    );
    stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
      stickyModelSelection,
      nextStickyModelOptions,
    );
    stickyActiveProvider = normalizeProviderInstanceId(normalizedPersistedState.stickyProvider);
  }

  return {
    draftsByThreadKey: normalizePersistedDraftsByThreadId(
      normalizedPersistedState.draftsByThreadKey ?? normalizedPersistedState.draftsByThreadId,
      draftThreadsByThreadKey,
    ),
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(stickyModelSelectionByProvider),
    stickyActiveProvider,
  };
}

export function readPersistedAttachmentIdsFromStorage(threadKey: string): string[] {
  if (threadKey.length === 0) {
    return [];
  }
  try {
    const persisted = getLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      PersistedComposerDraftStoreStorage,
    );
    if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION) {
      return [];
    }
    return (persisted.state.draftsByThreadKey[threadKey]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

export function verifyPersistedAttachments(
  threadKey: string,
  attachments: PersistedComposerImageAttachment[],
  set: (
    partial:
      | ComposerDraftStoreState
      | Partial<ComposerDraftStoreState>
      | ((
          state: ComposerDraftStoreState,
        ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
    replace?: false,
  ) => void,
): void {
  let persistedIdSet = new Set<string>();
  try {
    composerDebouncedStorage.flush();
    persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadKey));
  } catch {
    persistedIdSet = new Set();
  }
  set((state) => {
    const current = state.draftsByThreadKey[threadKey];
    if (!current) {
      return state;
    }
    const imageIdSet = new Set(current.images.map((image) => image.id));
    const persistedAttachments = attachments.filter(
      (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
    );
    const nonPersistedImageIds: string[] = [];
    for (const image of current.images) {
      if (!persistedIdSet.has(image.id)) {
        nonPersistedImageIds.push(image.id);
      }
    }
    const nextDraft: ComposerThreadDraftState = {
      ...current,
      persistedAttachments,
      nonPersistedImageIds,
    };
    const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
    if (shouldRemoveDraft(nextDraft)) {
      delete nextDraftsByThreadKey[threadKey];
    } else {
      nextDraftsByThreadKey[threadKey] = nextDraft;
    }
    return { draftsByThreadKey: nextDraftsByThreadKey };
  });
}

export function hydratePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  const commaIndex = attachment.dataUrl.indexOf(",");
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : attachment.dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;
      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}

export function hydrateImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = hydratePersistedComposerImageAttachment(attachment);
    if (!file) return [];

    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.dataUrl,
        file,
        ...(attachment.source ? { source: attachment.source } : {}),
      } satisfies ComposerImageAttachment,
    ];
  });
}

export function toHydratedThreadDraft(
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState {
  // The persisted draft is already in v3 shape (migration handles older formats)
  const modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> =
    persistedDraft.modelSelectionByProvider ?? {};
  const activeProvider = normalizeProviderInstanceId(persistedDraft.activeProvider) ?? null;
  const files: ComposerFileAttachment[] =
    persistedDraft.files?.map((file) => ({
      type: "file" as const,
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      file: null,
      ...(file.source ? { source: file.source } : {}),
      // A marker without an attachment id hydrates as needs-reattach: no
      // bytes, no server-side upload, only the metadata to tell the user
      // what to attach again.
      ...(file.attachmentId !== undefined && file.environmentId !== undefined
        ? { uploadedAttachmentId: file.attachmentId, uploadEnvironmentId: file.environmentId }
        : {}),
    })) ?? [];
  const projectMemoryReferences = normalizeProjectMemoryReferences(
    persistedDraft.projectMemoryReferences,
  );

  return {
    // Files predating inline references get a chip appended; images stay shelf-only.
    // Memory selections re-ensure their links the same way, so a link edited out of
    // the text cannot silently strand a record.
    prompt: ensureInlineContextReferences(persistedDraft.prompt, [
      ...(persistedDraft.reviewComments ?? []).map(reviewCommentContextReference),
      ...(persistedDraft.previewAnnotations ?? []).map(previewAnnotationContextReference),
      ...files.map(fileContextReference),
      ...projectMemoryReferences.map((reference) =>
        projectMemoryContextReference(reference.memoryId),
      ),
    ]),
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    files,
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: context.text ?? "",
      })) ?? [],
    previewAnnotations:
      persistedDraft.previewAnnotations?.map((annotation) => ({ ...annotation })) ?? [],
    reviewComments: persistedDraft.reviewComments?.map((comment) => ({ ...comment })) ?? [],
    projectMemoryReferences,
    ...(persistedDraft.autoSelectDismissed && persistedDraft.autoSelectDismissed.length > 0
      ? { autoSelectDismissed: [...persistedDraft.autoSelectDismissed] }
      : {}),
    ...(persistedDraft.autoSelectAdded && persistedDraft.autoSelectAdded.length > 0
      ? { autoSelectAdded: [...persistedDraft.autoSelectAdded] }
      : {}),
    modelSelectionByProvider,
    activeProvider,
    ...(persistedDraft.modelSelectionExplicit ? { modelSelectionExplicit: true } : {}),
    runtimeMode: persistedDraft.runtimeMode ?? null,
    interactionMode: persistedDraft.interactionMode ?? null,
  };
}

export function toHydratedDraftThreadState(
  persistedDraftThread: PersistedDraftThreadState,
): DraftThreadState {
  return {
    threadId: persistedDraftThread.threadId,
    environmentId: persistedDraftThread.environmentId as EnvironmentId,
    projectId: persistedDraftThread.projectId,
    logicalProjectKey:
      persistedDraftThread.logicalProjectKey ??
      projectDraftKey(
        scopeProjectRef(
          persistedDraftThread.environmentId as EnvironmentId,
          persistedDraftThread.projectId,
        ),
      ),
    createdAt: persistedDraftThread.createdAt,
    runtimeMode: persistedDraftThread.runtimeMode,
    interactionMode: persistedDraftThread.interactionMode,
    branch: persistedDraftThread.branch,
    worktreePath: persistedDraftThread.worktreePath,
    envMode: persistedDraftThread.envMode,
    startFromOrigin: persistedDraftThread.startFromOrigin,
    ...(persistedDraftThread.crew !== undefined ? { crew: persistedDraftThread.crew } : {}),
    ...(persistedDraftThread.environmentSelection
      ? { environmentSelection: persistedDraftThread.environmentSelection }
      : {}),
    ...(persistedDraftThread.loadBalancedEnvironmentId !== undefined
      ? {
          loadBalancedEnvironmentId:
            persistedDraftThread.loadBalancedEnvironmentId as EnvironmentId | null,
        }
      : {}),
    promotedTo: persistedDraftThread.promotedTo
      ? scopeThreadRef(
          persistedDraftThread.promotedTo.environmentId as EnvironmentId,
          persistedDraftThread.promotedTo.threadId as ThreadId,
        )
      : null,
  };
}

export const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

// Keep the immutable state until flush. Migration writebacks already have the persisted shape.
export type ComposerPersistState =
  | { capturedState: ComposerDraftStoreState }
  | PersistedComposerDraftStoreState;

export const composerDebouncedStorage = createDeferredStorage<StorageValue<ComposerPersistState>>(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  (value) =>
    JSON.stringify({
      state:
        "capturedState" in value.state
          ? partializeComposerDraftStoreState(value.state.capturedState)
          : value.state,
      version: value.version,
    }),
  COMPOSER_PERSIST_DEBOUNCE_MS,
);

export const composerPersistStorage: PersistStorage<ComposerPersistState> = {
  getItem: (name) => {
    // The base storage is localStorage (or in-memory), which is synchronous.
    const raw = composerDebouncedStorage.getItem(name);
    if (typeof raw !== "string") {
      return null;
    }
    // Parsed persisted JSON. `migrate` and `merge` normalize it from unknown,
    // so the cast mirrors the one zustand's createJSONStorage performs.
    return JSON.parse(raw) as StorageValue<ComposerPersistState>;
  },
  setItem: (name, value) => composerDebouncedStorage.setItem(name, value),
  removeItem: (name) => composerDebouncedStorage.removeItem(name),
};

// Flush pending composer draft writes before page unload to prevent data loss.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}
