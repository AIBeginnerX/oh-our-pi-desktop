import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ProviderDriverKind,
  PROJECT_MEMORY_MAX_LIMIT,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type PreviewAnnotationPayload,
  type ServerProvider,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import * as Equal from "effect/Equal";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import { useMemo } from "react";
import {
  appendInlineContextReference,
  collectInlineContextIds,
  ensureInlineContextReferences,
  formatInlineContextReference,
  removeInlineContextReference,
  toKindScopedComposerContextId,
} from "./lib/composerContextReferences";
import {
  fileContextReference,
  previewAnnotationContextId,
  previewAnnotationContextReference,
  projectMemoryContextId,
  projectMemoryContextReference,
  reviewCommentContextId,
  reviewCommentContextReference,
  terminalContextReference,
} from "./lib/composerContextRecords";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  isRuntimeMode,
  isReviewCommentContext,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  DraftId,
  ComposerImageAttachment,
  ComposerFileAttachment,
  composerFileNeedsReattach,
  clearStaleFileUploadMetadata,
  PROJECT_MEMORY_ID_PATTERN,
  normalizeProjectMemoryReference,
  ComposerContextInsertionHandler,
  ComposerThreadDraftState,
  stripCrossProjectMemoryReferences,
  composerDraftHasUserContent,
  DraftThreadState,
  ComposerThreadTarget,
  ComposerDraftStoreState,
  EffectiveComposerModelState,
  ComposerDraftModelState,
  draftWithoutProjectMemoryReferences,
} from "./composerDraftStore.types";
import {
  compactModelSelectionByProvider,
  EMPTY_COMPOSER_DRAFT_MODEL_STATE,
  EMPTY_THREAD_DRAFT,
  createEmptyThreadDraft,
  composerImageDedupKey,
  composerFileDedupKey,
  composerFileMatchesReattachMarker,
  terminalContextDedupKey,
  normalizeTerminalContextForThread,
  normalizeTerminalContextsForThread,
  shouldRemoveDraft,
  normalizeProviderDriverKind,
  normalizeModelSelection,
  deriveEffectiveComposerModelState,
  revokeObjectPreviewUrl,
  revokeDraftThreadPreviewUrls,
  projectDraftKey,
  logicalProjectDraftKey,
  resolveComposerDraftKey,
  resolveComposerThreadId,
  getComposerDraftState,
  isComposerThreadKeyInUse,
  toProjectDraftSession,
  createDraftThreadState,
  scopedThreadRefsEqual,
  isDraftThreadPromoting,
  crewsEqual,
  draftThreadsEqual,
  removeDraftThreadReferences,
} from "./composerDraftStore.normalize";
import {
  migratePersistedComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
  verifyPersistedAttachments,
  toHydratedThreadDraft,
  toHydratedDraftThreadState,
  ComposerPersistState,
  composerDebouncedStorage,
  composerPersistStorage,
} from "./composerDraftStore.persist";
export {
  partializeComposerDraftStoreState,
  hydrateImagesFromPersisted,
} from "./composerDraftStore.persist";

export {
  composerFileDedupKey,
  composerFileMatchesReattachMarker,
  deriveEffectiveComposerModelState,
  composerTargetKey,
} from "./composerDraftStore.normalize";

export {
  COMPOSER_DRAFT_STORAGE_KEY,
  DraftId,
  PersistedComposerImageAttachment,
  composerFileNeedsReattach,
  PersistedComposerFileAttachment,
  PersistedComposerDraftFileAttachment,
  composerDraftHasUserContent,
} from "./composerDraftStore.types";
export type {
  DraftThreadEnvMode,
  ComposerImageAttachment,
  ComposerFileAttachment,
  ComposerProjectMemoryReference,
  ComposerContextAddOptions,
  ComposerContextInsertionHandler,
  ComposerThreadDraftState,
  DraftSessionState,
  DraftThreadState,
  ProjectDraftSession,
  ComposerThreadTarget,
  EffectiveComposerModelState,
} from "./composerDraftStore.types";

const contextInsertionHandlers = new Map<string, ComposerContextInsertionHandler>();

const composerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (setBase, get) => {
      const set = setBase;

      return {
        draftsByThreadKey: {},
        draftThreadsByThreadKey: {},
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
        backgroundSubmissionThreadKeys: {},
        rewindingThreadKeys: new Set<string>(),
        stickyModelSelectionByProvider: {},
        stickyActiveProvider: null,
        getComposerDraft: (target) => getComposerDraftState(get(), target),
        getDraftThreadByLogicalProjectKey: (logicalProjectKey) => {
          return get().getDraftSessionByLogicalProjectKey(logicalProjectKey);
        },
        getDraftSessionByLogicalProjectKey: (logicalProjectKey) => {
          const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
          if (normalizedLogicalProjectKey.length === 0) {
            return null;
          }
          const draftId =
            get().logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
          if (!draftId) {
            return null;
          }
          const draftThread = get().draftThreadsByThreadKey[draftId];
          if (!draftThread || isDraftThreadPromoting(draftThread)) {
            return null;
          }
          return toProjectDraftSession(DraftId.make(draftId), draftThread);
        },
        getDraftThreadByProjectRef: (projectRef) => {
          return get().getDraftSessionByProjectRef(projectRef);
        },
        getDraftSessionByProjectRef: (projectRef) => {
          const state = get();
          // Mapped drafts win: a project can also own older unmapped drafts
          // (invested ones left behind by a remap), but "the" draft for a
          // project is the one new-thread flows currently target.
          for (const draftId of Object.values(
            state.logicalProjectDraftThreadKeyByLogicalProjectKey,
          )) {
            const draftThread = state.draftThreadsByThreadKey[draftId];
            if (!draftThread || isDraftThreadPromoting(draftThread)) {
              continue;
            }
            if (
              draftThread.projectId === projectRef.projectId &&
              draftThread.environmentId === projectRef.environmentId
            ) {
              return toProjectDraftSession(DraftId.make(draftId), draftThread);
            }
          }
          for (const [draftId, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
            if (isDraftThreadPromoting(draftThread)) {
              continue;
            }
            if (
              draftThread.projectId === projectRef.projectId &&
              draftThread.environmentId === projectRef.environmentId
            ) {
              return toProjectDraftSession(DraftId.make(draftId), draftThread);
            }
          }
          return null;
        },
        getDraftSession: (draftId) => get().draftThreadsByThreadKey[draftId] ?? null,
        getDraftSessionByRef: (threadRef) => {
          for (const draftSession of Object.values(get().draftThreadsByThreadKey)) {
            if (
              draftSession.environmentId === threadRef.environmentId &&
              draftSession.threadId === threadRef.threadId
            ) {
              return draftSession;
            }
          }
          return null;
        },
        getDraftIdByRef: (threadRef) => {
          for (const [draftId, draftSession] of Object.entries(get().draftThreadsByThreadKey)) {
            if (
              draftSession.environmentId === threadRef.environmentId &&
              draftSession.threadId === threadRef.threadId
            ) {
              return DraftId.make(draftId);
            }
          }
          return null;
        },
        getDraftThread: (threadRef) => {
          if (typeof threadRef === "string") {
            return get().getDraftSession(DraftId.make(threadRef));
          }
          return get().getDraftSessionByRef(threadRef);
        },
        getDraftThreadByRef: (threadRef) => {
          return get().getDraftSessionByRef(threadRef);
        },
        listDraftThreadKeys: () =>
          Object.values(get().draftThreadsByThreadKey).map((draftThread) =>
            scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
          ),
        hasDraftThreadsInEnvironment: (environmentId) =>
          Object.values(get().draftThreadsByThreadKey).some(
            (draftThread) => draftThread.environmentId === environmentId,
          ),
        setLogicalProjectDraftThreadId: (logicalProjectKey, projectRef, draftId, options) => {
          const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
          if (normalizedLogicalProjectKey.length === 0 || draftId.length === 0) {
            return;
          }
          set((state) => {
            const existingThread = state.draftThreadsByThreadKey[draftId];
            const previousThreadKeyForLogicalProject =
              state.logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
            const nextDraftThread = createDraftThreadState(
              projectRef,
              options?.threadId ?? existingThread?.threadId ?? ThreadId.make(draftId),
              normalizedLogicalProjectKey,
              existingThread,
              options,
            );
            const hasSameLogicalMapping = previousThreadKeyForLogicalProject === draftId;
            const hasNoStaleMappingsForDraft = Object.entries(
              state.logicalProjectDraftThreadKeyByLogicalProjectKey,
            ).every(
              ([logicalKey, mappedDraftId]) =>
                mappedDraftId !== draftId || logicalKey === normalizedLogicalProjectKey,
            );
            if (
              hasSameLogicalMapping &&
              hasNoStaleMappingsForDraft &&
              draftThreadsEqual(existingThread, nextDraftThread)
            ) {
              return state;
            }
            // A draft session belongs to one logical project at a time. When
            // an open draft is retargeted in place, remove any old mapping
            // for that same draft so the previous project cannot resolve it.
            const nextLogicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> =
              Object.fromEntries(
                Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
                  ([logicalKey, mappedDraftId]) =>
                    mappedDraftId !== draftId || logicalKey === normalizedLogicalProjectKey,
                ),
              );
            nextLogicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey] =
              draftId;
            const nextDraftThreadsByThreadKey: Record<string, DraftThreadState> = {
              ...state.draftThreadsByThreadKey,
              [draftId]: nextDraftThread,
            };
            const existingDraft = state.draftsByThreadKey[draftId];
            let nextDraftsByThreadKey = state.draftsByThreadKey;
            if (
              existingThread &&
              existingDraft !== undefined &&
              (existingThread.environmentId !== projectRef.environmentId ||
                existingThread.projectId !== projectRef.projectId)
            ) {
              // A draft moving across environments also drops uploads staged for
              // the old one; a draft moving across projects drops its memory
              // selections, whose ids only resolve inside the origin project.
              let nextDraft =
                existingThread.environmentId !== projectRef.environmentId
                  ? clearStaleFileUploadMetadata(existingDraft, projectRef.environmentId)
                  : existingDraft;
              nextDraft = stripCrossProjectMemoryReferences(nextDraft);
              if (nextDraft !== existingDraft) {
                nextDraftsByThreadKey = {
                  ...state.draftsByThreadKey,
                  [draftId]: nextDraft,
                };
              }
            }
            const previousDraftThread =
              previousThreadKeyForLogicalProject === undefined
                ? undefined
                : nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
            // A remap only garbage-collects the previous draft when the user
            // never invested content in it. A draft with typed text or
            // attachments stays alive unmapped — the sidebar draft rows list
            // every such session, so "new thread" can mint a fresh draft
            // without destroying the one the user walked away from.
            if (
              previousThreadKeyForLogicalProject &&
              previousThreadKeyForLogicalProject !== draftId &&
              !isComposerThreadKeyInUse(
                nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
                previousThreadKeyForLogicalProject,
              ) &&
              !isDraftThreadPromoting(previousDraftThread) &&
              !composerDraftHasUserContent(
                state.draftsByThreadKey[previousThreadKeyForLogicalProject],
              )
            ) {
              delete nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
              if (state.draftsByThreadKey[previousThreadKeyForLogicalProject] !== undefined) {
                nextDraftsByThreadKey = { ...nextDraftsByThreadKey };
                delete nextDraftsByThreadKey[previousThreadKeyForLogicalProject];
              }
            }
            return {
              draftsByThreadKey: nextDraftsByThreadKey,
              draftThreadsByThreadKey: nextDraftThreadsByThreadKey,
              logicalProjectDraftThreadKeyByLogicalProjectKey:
                nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
            };
          });
        },
        setProjectDraftThreadId: (projectRef, draftId, options) => {
          get().setLogicalProjectDraftThreadId(
            projectDraftKey(projectRef),
            projectRef,
            draftId,
            options,
          );
        },
        setDraftThreadContext: (threadRef, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const existing = state.draftThreadsByThreadKey[threadKey];
            if (!existing) {
              return state;
            }
            const nextProjectRef = options.projectRef ?? {
              environmentId: existing.environmentId,
              projectId: existing.projectId,
            };
            if (
              nextProjectRef.projectId.length === 0 ||
              nextProjectRef.environmentId.length === 0
            ) {
              return state;
            }
            // Mirrors createDraftThreadState: a project/environment change
            // drops machine-specific context (branch, worktree path) but
            // keeps the user's env mode and start-from-origin intent.
            const projectChanged =
              nextProjectRef.environmentId !== existing.environmentId ||
              nextProjectRef.projectId !== existing.projectId;
            const nextWorktreePath =
              options.worktreePath === undefined
                ? projectChanged
                  ? null
                  : existing.worktreePath
                : (options.worktreePath ?? null);
            const nextBranch =
              options.branch === undefined
                ? projectChanged
                  ? null
                  : existing.branch
                : (options.branch ?? null);
            const nextStartFromOrigin =
              options.startFromOrigin === undefined
                ? existing.startFromOrigin
                : options.startFromOrigin;
            const nextCrew =
              options.crew === undefined ? existing.crew : (options.crew ?? undefined);
            const environmentSelection =
              options.environmentSelection ??
              (options.branch != null || options.worktreePath != null
                ? "manual"
                : existing.environmentSelection);
            const nextDraftThread: DraftThreadState = {
              threadId: existing.threadId,
              environmentId: nextProjectRef.environmentId,
              projectId: nextProjectRef.projectId,
              logicalProjectKey: existing.logicalProjectKey,
              ...(environmentSelection ? { environmentSelection } : {}),
              loadBalancedEnvironmentId:
                options.loadBalancedEnvironmentId === undefined
                  ? projectChanged
                    ? null
                    : (existing.loadBalancedEnvironmentId ?? null)
                  : options.loadBalancedEnvironmentId,
              createdAt:
                options.createdAt === undefined
                  ? existing.createdAt
                  : options.createdAt || existing.createdAt,
              runtimeMode: options.runtimeMode ?? existing.runtimeMode,
              interactionMode: options.interactionMode ?? existing.interactionMode,
              branch: nextBranch,
              worktreePath: nextWorktreePath,
              envMode:
                options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
              startFromOrigin: nextStartFromOrigin,
              ...(nextCrew !== undefined ? { crew: nextCrew } : {}),
              promotedTo: existing.promotedTo ?? null,
            };
            const isUnchanged =
              nextDraftThread.environmentId === existing.environmentId &&
              nextDraftThread.projectId === existing.projectId &&
              nextDraftThread.logicalProjectKey === existing.logicalProjectKey &&
              nextDraftThread.environmentSelection === existing.environmentSelection &&
              nextDraftThread.loadBalancedEnvironmentId === existing.loadBalancedEnvironmentId &&
              nextDraftThread.createdAt === existing.createdAt &&
              nextDraftThread.runtimeMode === existing.runtimeMode &&
              nextDraftThread.interactionMode === existing.interactionMode &&
              nextDraftThread.branch === existing.branch &&
              nextDraftThread.worktreePath === existing.worktreePath &&
              nextDraftThread.envMode === existing.envMode &&
              nextDraftThread.startFromOrigin === existing.startFromOrigin &&
              crewsEqual(nextDraftThread.crew, existing.crew) &&
              scopedThreadRefsEqual(nextDraftThread.promotedTo, existing.promotedTo);
            if (isUnchanged) {
              return state;
            }
            // Same contract as setLogicalProjectDraftThreadId: memory ids do not
            // survive a project move.
            let nextDraftsByThreadKey = state.draftsByThreadKey;
            if (projectChanged) {
              const composerDraft = state.draftsByThreadKey[threadKey];
              const stripped = composerDraft
                ? stripCrossProjectMemoryReferences(composerDraft)
                : null;
              if (stripped && stripped !== composerDraft) {
                nextDraftsByThreadKey = { ...state.draftsByThreadKey, [threadKey]: stripped };
              }
            }
            return {
              draftsByThreadKey: nextDraftsByThreadKey,
              draftThreadsByThreadKey: {
                ...state.draftThreadsByThreadKey,
                [threadKey]: nextDraftThread,
              },
            };
          });
        },
        clearProjectDraftThreadId: (projectRef) => {
          set((state) => {
            // A project can own several sessions (invested drafts survive
            // remaps unmapped), so project removal must sweep them all — a
            // leftover would render a sidebar row for a project that no
            // longer exists.
            const matchingThreadKeys = Object.entries(state.draftThreadsByThreadKey)
              .filter(
                ([, draftThread]) =>
                  draftThread.projectId === projectRef.projectId &&
                  draftThread.environmentId === projectRef.environmentId,
              )
              .map(([threadKey]) => threadKey);
            if (matchingThreadKeys.length === 0) {
              return state;
            }
            let nextState = {
              draftsByThreadKey: state.draftsByThreadKey,
              draftThreadsByThreadKey: state.draftThreadsByThreadKey,
              logicalProjectDraftThreadKeyByLogicalProjectKey:
                state.logicalProjectDraftThreadKeyByLogicalProjectKey,
            };
            for (const threadKey of matchingThreadKeys) {
              nextState = removeDraftThreadReferences(nextState, threadKey);
            }
            return nextState;
          });
        },
        clearProjectDraftThreadById: (projectRef, threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const draftThread = state.draftThreadsByThreadKey[threadKey];
            if (
              !draftThread ||
              draftThread.projectId !== projectRef.projectId ||
              draftThread.environmentId !== projectRef.environmentId
            ) {
              return state;
            }
            return removeDraftThreadReferences(state, threadKey);
          });
        },
        markDraftThreadPromoting: (threadRef, promotedTo) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) {
            return;
          }
          set((state) => {
            const existing = state.draftThreadsByThreadKey[threadKey];
            if (!existing) {
              return state;
            }
            const nextPromotedTo =
              promotedTo ?? scopeThreadRef(existing.environmentId, existing.threadId);
            if (scopedThreadRefsEqual(existing.promotedTo, nextPromotedTo)) {
              return state;
            }
            return {
              draftThreadsByThreadKey: {
                ...state.draftThreadsByThreadKey,
                [threadKey]: {
                  ...existing,
                  promotedTo: nextPromotedTo,
                },
              },
            };
          });
        },
        finalizePromotedDraftThread: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const existing = state.draftThreadsByThreadKey[threadKey];
            if (!existing || !isDraftThreadPromoting(existing)) {
              return state;
            }
            return removeDraftThreadReferences(state, threadKey, existing.promotedTo ?? undefined);
          });
        },
        clearDraftThread: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const hasDraftThread = state.draftThreadsByThreadKey[threadKey] !== undefined;
            const hasLogicalProjectMapping = Object.values(
              state.logicalProjectDraftThreadKeyByLogicalProjectKey,
            ).includes(threadKey);
            const hasComposerDraft = state.draftsByThreadKey[threadKey] !== undefined;
            if (!hasDraftThread && !hasLogicalProjectMapping && !hasComposerDraft) {
              return state;
            }
            return removeDraftThreadReferences(state, threadKey);
          });
        },
        setStickyModelSelection: (modelSelection) => {
          const normalized = normalizeModelSelection(modelSelection);
          set((state) => {
            if (!normalized) {
              return state;
            }
            const current = state.stickyModelSelectionByProvider[normalized.instanceId];
            // Model-only picker updates omit options (same contract as
            // setModelSelection). Keep the last sticky traits so Fast/Normal
            // survives Composer 2 → 2.5 and new chats.
            const nextSelection =
              normalized.options !== undefined
                ? normalized
                : createModelSelection(normalized.instanceId, normalized.model, current?.options);
            const nextMap: Partial<Record<ProviderInstanceId, ModelSelection>> = {
              ...state.stickyModelSelectionByProvider,
              [normalized.instanceId]: nextSelection,
            };
            if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
              return state.stickyActiveProvider === normalized.instanceId
                ? state
                : { stickyActiveProvider: normalized.instanceId };
            }
            return {
              stickyModelSelectionByProvider: nextMap,
              stickyActiveProvider: normalized.instanceId,
            };
          });
        },
        applyStickyState: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const stickyMap = state.stickyModelSelectionByProvider;
            const stickyActiveProvider = state.stickyActiveProvider;
            const existing = state.draftsByThreadKey[threadKey];
            const base = existing ?? createEmptyThreadDraft();
            const nextMap = compactModelSelectionByProvider(stickyMap);
            if (
              Equal.equals(base.modelSelectionByProvider, nextMap) &&
              base.activeProvider === stickyActiveProvider &&
              base.modelSelectionExplicit === undefined
            ) {
              return state;
            }
            const { modelSelectionExplicit: _modelSelectionExplicit, ...retained } = base;
            const nextDraft: ComposerThreadDraftState = {
              ...retained,
              modelSelectionByProvider: nextMap,
              activeProvider: stickyActiveProvider,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setPrompt: (threadRef, prompt) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const nextDraft: ComposerThreadDraftState = {
              ...existing,
              prompt,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setTerminalContexts: (threadRef, contexts) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          const threadId = resolveComposerThreadId(get(), threadRef);
          if (!threadKey || !threadId) {
            return;
          }
          const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const nextDraft: ComposerThreadDraftState = {
              ...existing,
              prompt: ensureInlineContextReferences(
                existing.terminalContexts
                  .filter((context) => !normalizedContexts.some((next) => next.id === context.id))
                  .reduce(
                    (prompt, context) =>
                      removeInlineContextReference(
                        prompt,
                        terminalContextReference(context).contextId,
                      ).prompt,
                    existing.prompt,
                  ),
                normalizedContexts.map(terminalContextReference),
              ),
              terminalContexts: normalizedContexts,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setModelSelection: (threadRef, modelSelection, opts) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const normalized = normalizeModelSelection(modelSelection);
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            if (!existing && normalized === null) {
              return state;
            }
            const base = existing ?? createEmptyThreadDraft();
            const nextMap = { ...base.modelSelectionByProvider };
            if (normalized) {
              const current = nextMap[normalized.instanceId];
              if (normalized.options !== undefined || opts?.replaceOptions) {
                // Explicit options provided (or the caller passed a complete
                // snapshot whose absent options mean "no options") → use the
                // selection as-is.
                nextMap[normalized.instanceId] = normalized as ModelSelection;
              } else {
                // No options in selection → preserve existing options, update provider+model
                nextMap[normalized.instanceId] = createModelSelection(
                  normalized.instanceId,
                  normalized.model,
                  current?.options,
                );
              }
            }
            const nextActiveProvider = normalized?.instanceId ?? base.activeProvider;
            if (
              Equal.equals(base.modelSelectionByProvider, nextMap) &&
              base.activeProvider === nextActiveProvider &&
              (base.modelSelectionExplicit ?? false) === (opts?.explicit === true)
            ) {
              return state;
            }
            // Last writer defines intent: picker writes mark the selection
            // explicit; seeding writes leave it unset so future seeds can
            // replace it.
            const { modelSelectionExplicit: _previousExplicit, ...restBase } = base;
            const nextDraft: ComposerThreadDraftState = {
              ...restBase,
              modelSelectionByProvider: nextMap,
              activeProvider: nextActiveProvider,
              ...(opts?.explicit === true ? { modelSelectionExplicit: true as const } : {}),
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setModelOptions: (threadRef, modelOptions) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            if (!existing && (!modelOptions || Object.keys(modelOptions).length === 0)) {
              return state;
            }
            const base = existing ?? createEmptyThreadDraft();
            const nextMap = { ...base.modelSelectionByProvider };
            for (const provider of ["codex", "claudeAgent", "cursor", "opencode"] as const) {
              if (!modelOptions || !(provider in modelOptions)) continue;
              const opts = modelOptions[provider];
              const driverKind = ProviderDriverKind.make(provider);
              const instanceKey = defaultInstanceIdForDriver(driverKind);
              const current = nextMap[instanceKey];
              if (opts && opts.length > 0) {
                nextMap[instanceKey] = createModelSelection(
                  instanceKey,
                  current?.model ?? DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL,
                  opts,
                );
              } else if (current?.options) {
                const { options: _, ...rest } = current;
                nextMap[instanceKey] = rest as ModelSelection;
              }
            }
            if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              modelSelectionByProvider: nextMap,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setProviderModelOptions: (threadRef, provider, nextProviderOptions, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const normalizedProvider = normalizeProviderDriverKind(provider);
          if (normalizedProvider === null) {
            return;
          }
          const instanceKey = options?.instanceId ?? defaultInstanceIdForDriver(normalizedProvider);
          const fallbackModel =
            normalizeModelSlug(options?.model, normalizedProvider) ??
            DEFAULT_MODEL_BY_PROVIDER[normalizedProvider] ??
            DEFAULT_MODEL;
          const providerOpts =
            nextProviderOptions && nextProviderOptions.length > 0 ? nextProviderOptions : undefined;

          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            const base = existing ?? createEmptyThreadDraft();

            // Update the map entry for this provider
            const nextMap = { ...base.modelSelectionByProvider };
            const currentForProvider = nextMap[instanceKey];
            if (providerOpts) {
              nextMap[instanceKey] = createModelSelection(
                instanceKey,
                currentForProvider?.model ?? fallbackModel,
                providerOpts,
              );
            } else if (currentForProvider && (currentForProvider.options?.length ?? 0) > 0) {
              const { options: _, ...rest } = currentForProvider;
              nextMap[instanceKey] = rest as ModelSelection;
            }

            // Handle sticky persistence
            let nextStickyMap = state.stickyModelSelectionByProvider;
            let nextStickyActiveProvider = state.stickyActiveProvider;
            if (options?.persistSticky === true) {
              nextStickyMap = { ...state.stickyModelSelectionByProvider };
              const stickyBase =
                nextStickyMap[instanceKey] ??
                base.modelSelectionByProvider[instanceKey] ??
                createModelSelection(instanceKey, fallbackModel);
              if (providerOpts) {
                nextStickyMap[instanceKey] = createModelSelection(
                  instanceKey,
                  stickyBase.model,
                  providerOpts,
                );
              } else if ((stickyBase.options?.length ?? 0) > 0) {
                const { options: _, ...rest } = stickyBase;
                nextStickyMap[instanceKey] = rest as ModelSelection;
              }
              nextStickyActiveProvider = options.instanceId
                ? instanceKey
                : (base.activeProvider ?? instanceKey);
            }

            if (
              Equal.equals(base.modelSelectionByProvider, nextMap) &&
              Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
              state.stickyActiveProvider === nextStickyActiveProvider
            ) {
              return state;
            }

            // Trait edits are user-driven intent: mark the selection explicit
            // so later seeds cannot silently replace the chosen options.
            const { modelSelectionExplicit: _previousExplicit, ...restBase } = base;
            const nextDraft: ComposerThreadDraftState = {
              ...restBase,
              ...(options?.instanceId ? { activeProvider: instanceKey } : {}),
              modelSelectionByProvider: nextMap,
              modelSelectionExplicit: true,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }

            return {
              draftsByThreadKey: nextDraftsByThreadKey,
              ...(options?.persistSticky === true
                ? {
                    stickyModelSelectionByProvider: nextStickyMap,
                    stickyActiveProvider: nextStickyActiveProvider,
                  }
                : {}),
            };
          });
        },
        setRuntimeMode: (threadRef, runtimeMode) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const nextRuntimeMode = isRuntimeMode(runtimeMode) ? runtimeMode : null;
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            if (!existing && nextRuntimeMode === null) {
              return state;
            }
            const base = existing ?? createEmptyThreadDraft();
            if (base.runtimeMode === nextRuntimeMode) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              runtimeMode: nextRuntimeMode,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setInteractionMode: (threadRef, interactionMode) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const nextInteractionMode =
            interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            if (!existing && nextInteractionMode === null) {
              return state;
            }
            const base = existing ?? createEmptyThreadDraft();
            if (base.interactionMode === nextInteractionMode) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              interactionMode: nextInteractionMode,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        addImage: (threadRef, image) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          const threadId = resolveComposerThreadId(get(), threadRef);
          if (!threadKey || !threadId) {
            return false;
          }
          const acceptedIds = get().addImages(
            typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef,
            [image],
          );
          return acceptedIds.includes(image.id);
        },
        addImages: (threadRef, images, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0 || images.length === 0) {
            return [];
          }
          let acceptedIds: string[] = [];
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const existingIds = new Set(existing.images.map((image) => image.id));
            const existingDedupKeys = new Set(
              existing.images.map((image) => composerImageDedupKey(image)),
            );
            const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
            const dedupedIncoming: ComposerImageAttachment[] = [];
            for (const image of images) {
              const dedupKey = composerImageDedupKey(image);
              if (
                existingIds.has(image.id) ||
                (!options?.allowDuplicates && existingDedupKeys.has(dedupKey))
              ) {
                // Avoid revoking a blob URL that's still referenced by an accepted image.
                if (!acceptedPreviewUrls.has(image.previewUrl)) {
                  revokeObjectPreviewUrl(image.previewUrl);
                }
                continue;
              }
              if (
                existing.images.length + existing.files.length + dedupedIncoming.length >=
                PROVIDER_SEND_TURN_MAX_ATTACHMENTS
              ) {
                if (!acceptedPreviewUrls.has(image.previewUrl)) {
                  revokeObjectPreviewUrl(image.previewUrl);
                }
                continue;
              }
              dedupedIncoming.push(image);
              existingIds.add(image.id);
              existingDedupKeys.add(dedupKey);
              acceptedPreviewUrls.add(image.previewUrl);
            }
            if (dedupedIncoming.length === 0) {
              return state;
            }
            acceptedIds = dedupedIncoming.map((image) => image.id);
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  images: [...existing.images, ...dedupedIncoming],
                },
              },
            };
          });
          return acceptedIds;
        },
        removeImage: (threadRef, imageId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const existing = get().draftsByThreadKey[threadKey];
          if (!existing) {
            return;
          }
          const removedImage = existing.images.find((image) => image.id === imageId);
          if (removedImage) {
            revokeObjectPreviewUrl(removedImage.previewUrl);
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              prompt: removeInlineContextReference(
                current.prompt,
                toKindScopedComposerContextId("image", imageId),
              ).prompt,
              images: current.images.filter((image) => image.id !== imageId),
              nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
              persistedAttachments: current.persistedAttachments.filter(
                (attachment) => attachment.id !== imageId,
              ),
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        addFiles: (threadRef, files, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0 || files.length === 0) {
            return [];
          }
          let acceptedIds: string[] = [];
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const knownIds = new Set(existing.files.map((file) => file.id));
            const knownFiles = new Map<string, ComposerFileAttachment>(
              existing.files.map((file) => [composerFileDedupKey(file), file]),
            );
            const accepted: ComposerFileAttachment[] = [];
            // Needs-reattach markers replaced in place by a re-pick, keyed by
            // the marker's id.
            const replacements = new Map<string, ComposerFileAttachment>();
            for (const file of files) {
              const key = composerFileDedupKey(file);
              if (knownIds.has(file.id)) {
                continue;
              }
              const duplicate = options?.allowDuplicates
                ? undefined
                : (knownFiles.get(key) ??
                  existing.files.find(
                    (candidate) =>
                      composerFileNeedsReattach(candidate) &&
                      !replacements.has(candidate.id) &&
                      composerFileMatchesReattachMarker(candidate, file),
                  ));
              if (duplicate) {
                // A needs-reattach marker is not a usable duplicate. Replace
                // it so the upload restarts.
                if (composerFileNeedsReattach(duplicate) && !replacements.has(duplicate.id)) {
                  replacements.set(duplicate.id, file);
                  knownIds.add(file.id);
                  knownFiles.set(key, file);
                }
                continue;
              }
              if (
                existing.images.length + existing.files.length + accepted.length >=
                PROVIDER_SEND_TURN_MAX_ATTACHMENTS
              ) {
                break;
              }
              accepted.push(file);
              knownIds.add(file.id);
              knownFiles.set(key, file);
            }
            if (accepted.length === 0 && replacements.size === 0) {
              return state;
            }
            acceptedIds = accepted.map((file) => file.id);
            const retained = existing.files.map((file) => replacements.get(file.id) ?? file);
            // A replaced marker's chip follows the file to its new id.
            const prompt =
              replacements.size === 0
                ? existing.prompt
                : replaceComposerContextReferences(existing.prompt, (occurrence) => {
                    const original = existing.files.find(
                      (file) => fileContextReference(file).contextId === occurrence.contextId,
                    );
                    const replacement = original ? replacements.get(original.id) : undefined;
                    return replacement
                      ? formatInlineContextReference(fileContextReference(replacement))
                      : occurrence.source;
                  });
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  prompt: options?.appendReference
                    ? ensureInlineContextReferences(
                        prompt,
                        [...accepted, ...replacements.values()].map(fileContextReference),
                      )
                    : prompt,
                  files: [...retained, ...accepted],
                },
              },
            };
          });
          return acceptedIds;
        },
        removeFile: (threadRef, fileId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current?.files.some((file) => file.id === fileId)) {
              return state;
            }
            const nextDraft = {
              ...current,
              prompt: removeInlineContextReference(
                current.prompt,
                toKindScopedComposerContextId("file", fileId),
              ).prompt,
              files: current.files.filter((file) => file.id !== fileId),
            } satisfies ComposerThreadDraftState;
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setFileUpload: (threadRef, fileId, environmentId, attachmentId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            const file = current?.files.find((entry) => entry.id === fileId);
            if (
              !current ||
              !file ||
              (file.uploadEnvironmentId === environmentId &&
                file.uploadedAttachmentId === attachmentId)
            ) {
              return state;
            }
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...current,
                  files: current.files.map((entry) =>
                    entry.id === fileId
                      ? {
                          ...entry,
                          uploadedAttachmentId: attachmentId,
                          uploadEnvironmentId: environmentId,
                        }
                      : entry,
                  ),
                },
              },
            };
          });
        },
        markFileUploadMissing: (threadRef, fileId, environmentId, attachmentId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return false;
          }
          let markedMissing = false;
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            const file = current?.files.find((entry) => entry.id === fileId);
            if (
              !current ||
              !file ||
              file.file !== null ||
              file.uploadEnvironmentId !== environmentId ||
              file.uploadedAttachmentId !== attachmentId
            ) {
              return state;
            }
            markedMissing = true;
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...current,
                  files: current.files.map((entry) => {
                    if (entry.id !== fileId) {
                      return entry;
                    }
                    const marker = { ...entry };
                    delete marker.uploadedAttachmentId;
                    delete marker.uploadEnvironmentId;
                    return marker;
                  }),
                },
              },
            };
          });
          return markedMissing;
        },
        insertTerminalContext: (threadRef, prompt, context, index) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          const threadId = resolveComposerThreadId(get(), threadRef);
          if (!threadKey || !threadId) {
            return false;
          }
          let inserted = false;
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const normalizedContext = normalizeTerminalContextForThread(threadId, context);
            if (!normalizedContext) {
              return state;
            }
            const dedupKey = terminalContextDedupKey(normalizedContext);
            if (
              existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
              existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
            ) {
              return state;
            }
            inserted = true;
            const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
            const nextDraft: ComposerThreadDraftState = {
              ...existing,
              prompt,
              terminalContexts: [
                ...existing.terminalContexts.slice(0, boundedIndex),
                normalizedContext,
                ...existing.terminalContexts.slice(boundedIndex),
              ],
            };
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: nextDraft,
              },
            };
          });
          return inserted;
        },
        addTerminalContext: (threadRef, context) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          const threadId = resolveComposerThreadId(get(), threadRef);
          if (!threadKey || !threadId) {
            return;
          }
          get().addTerminalContexts(
            typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef,
            [context],
          );
        },
        addTerminalContexts: (threadRef, contexts, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          const threadId = resolveComposerThreadId(get(), threadRef);
          if (!threadKey || !threadId || contexts.length === 0) {
            return;
          }
          const currentContexts = get().draftsByThreadKey[threadKey]?.terminalContexts ?? [];
          const incoming = normalizeTerminalContextsForThread(threadId, [
            ...currentContexts,
            ...contexts,
          ]).slice(currentContexts.length);
          if (incoming.length === 0) return;
          const placedAtCaret =
            options?.appendReference !== false &&
            options?.insertAtCaret !== false &&
            (contextInsertionHandlers.get(threadKey)?.(incoming.map(terminalContextReference)) ??
              false);
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
              ...existing.terminalContexts,
              ...contexts,
            ]).slice(existing.terminalContexts.length);
            if (acceptedContexts.length === 0) {
              return state;
            }
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  prompt:
                    placedAtCaret || options?.appendReference === false
                      ? existing.prompt
                      : ensureInlineContextReferences(
                          existing.prompt,
                          [...existing.terminalContexts, ...acceptedContexts].map(
                            terminalContextReference,
                          ),
                        ),
                  terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
                },
              },
            };
          });
        },
        removeTerminalContext: (threadRef, contextId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0 || contextId.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              prompt: removeInlineContextReference(
                current.prompt,
                toKindScopedComposerContextId("terminal", contextId),
              ).prompt,
              terminalContexts: current.terminalContexts.filter(
                (context) => context.id !== contextId,
              ),
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        clearTerminalContexts: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current || current.terminalContexts.length === 0) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              prompt: current.terminalContexts.reduce(
                (prompt, context) =>
                  removeInlineContextReference(prompt, terminalContextReference(context).contextId)
                    .prompt,
                current.prompt,
              ),
              terminalContexts: [],
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        addPreviewAnnotation: (threadRef, annotation, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) return;
          const compactAnnotation: PreviewAnnotationPayload = {
            ...annotation,
            screenshot: annotation.screenshot ? { ...annotation.screenshot, dataUrl: "" } : null,
          };
          const reference = previewAnnotationContextReference(compactAnnotation);
          const current = get().draftsByThreadKey[threadKey];
          const alreadyPresent =
            current?.previewAnnotations.some((entry) => entry.id === annotation.id) ?? false;
          // The handler updates the same draft through `setPrompt`. Run it before this store
          // update so the latest prompt is what the record update preserves. Calling it from
          // inside the updater lets the outer update overwrite the inserted reference.
          const placedAtCaret =
            !alreadyPresent &&
            options?.appendReference !== false &&
            options?.insertAtCaret !== false &&
            (contextInsertionHandlers.get(threadKey)?.([reference]) ?? false);
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const nextAnnotations = existing.previewAnnotations.filter(
              (entry) => entry.id !== annotation.id,
            );
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  prompt:
                    alreadyPresent || placedAtCaret || options?.appendReference === false
                      ? existing.prompt
                      : appendInlineContextReference(existing.prompt, reference),
                  previewAnnotations: [...nextAnnotations, compactAnnotation],
                },
              },
            };
          });
        },
        setPreviewAnnotations: (threadRef, annotations) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) return;
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const retainedIds = new Set(annotations.map((annotation) => annotation.id));
            let prompt = existing.prompt;
            for (const previous of existing.previewAnnotations) {
              if (retainedIds.has(previous.id)) continue;
              prompt = removeInlineContextReference(
                prompt,
                previewAnnotationContextId(previous.id),
              ).prompt;
            }
            prompt = ensureInlineContextReferences(
              prompt,
              annotations.map(previewAnnotationContextReference),
            );
            const nextDraft = { ...existing, prompt, previewAnnotations: [...annotations] };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
            else nextDraftsByThreadKey[threadKey] = nextDraft;
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        removePreviewAnnotation: (threadRef, annotationId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey || !annotationId) return;
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) return state;
            const previewAnnotations = current.previewAnnotations.filter(
              (entry) => entry.id !== annotationId,
            );
            if (previewAnnotations.length === current.previewAnnotations.length) return state;
            const nextDraft = {
              ...current,
              prompt: removeInlineContextReference(
                current.prompt,
                previewAnnotationContextId(annotationId),
              ).prompt,
              previewAnnotations,
              images: current.images.filter((image) => image.id !== annotationId),
              persistedAttachments: current.persistedAttachments.filter(
                (image) => image.id !== annotationId,
              ),
              nonPersistedImageIds: current.nonPersistedImageIds.filter(
                (imageId) => imageId !== annotationId,
              ),
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
            else nextDraftsByThreadKey[threadKey] = nextDraft;
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        addReviewComment: (threadRef, comment, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey || !isReviewCommentContext(comment)) return;
          const reference = reviewCommentContextReference(comment);
          const current = get().draftsByThreadKey[threadKey];
          const alreadyPresent =
            current?.reviewComments.some((entry) => entry.id === comment.id) ?? false;
          const shouldPlaceReference =
            options?.appendReference !== false &&
            (!alreadyPresent || options?.allowDuplicateReference === true);
          // See addPreviewAnnotation: editor insertion writes the prompt through this store and
          // must complete before the record update reads the draft it is extending.
          const placedAtCaret =
            shouldPlaceReference &&
            options?.insertAtCaret !== false &&
            (contextInsertionHandlers.get(threadKey)?.([reference]) ?? false);
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const reviewComments = existing.reviewComments.filter(
              (entry) => entry.id !== comment.id,
            );
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  prompt:
                    !shouldPlaceReference || placedAtCaret
                      ? existing.prompt
                      : appendInlineContextReference(existing.prompt, reference),
                  reviewComments: [...reviewComments, { ...comment }],
                },
              },
            };
          });
        },
        setContextInsertionHandler: (threadRef, handler) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) return;
          if (handler) contextInsertionHandlers.set(threadKey, handler);
          else contextInsertionHandlers.delete(threadKey);
          return () => {
            if (contextInsertionHandlers.get(threadKey) === handler) {
              contextInsertionHandlers.delete(threadKey);
            }
          };
        },
        setReviewComments: (threadRef, comments) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) return;
          const reviewComments = comments
            .filter(isReviewCommentContext)
            .map((comment) => ({ ...comment }));
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const retainedIds = new Set(reviewComments.map((comment) => comment.id));
            let prompt = existing.prompt;
            for (const previous of existing.reviewComments) {
              if (retainedIds.has(previous.id)) continue;
              prompt = removeInlineContextReference(
                prompt,
                reviewCommentContextId(previous.id),
              ).prompt;
            }
            prompt = ensureInlineContextReferences(
              prompt,
              reviewComments.map(reviewCommentContextReference),
            );
            const nextDraft = { ...existing, prompt, reviewComments };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
            else nextDraftsByThreadKey[threadKey] = nextDraft;
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        removeReviewComment: (threadRef, commentId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey || !commentId) return;
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) return state;
            const reviewComments = current.reviewComments.filter((entry) => entry.id !== commentId);
            if (reviewComments.length === current.reviewComments.length) return state;
            const nextDraft = {
              ...current,
              prompt: removeInlineContextReference(
                current.prompt,
                reviewCommentContextId(commentId),
              ).prompt,
              reviewComments,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
            else nextDraftsByThreadKey[threadKey] = nextDraft;
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        addProjectMemoryReference: (threadRef, selection, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0 || !PROJECT_MEMORY_ID_PATTERN.test(selection.memoryId)) {
            return false;
          }
          const contextId = projectMemoryContextId(selection.memoryId);
          if (
            get().draftsByThreadKey[threadKey]?.projectMemoryReferences.some(
              (entry) => entry.contextId === contextId,
            ) ??
            false
          ) {
            return false;
          }
          const reference = projectMemoryContextReference(selection.memoryId);
          // See addPreviewAnnotation/addReviewComment: the editor handler writes
          // the prompt through this store and must run BEFORE the record update,
          // whose re-read below then preserves the inserted link instead of
          // overwriting it with a stale prompt.
          const linkAlreadyInPromptBefore = collectInlineContextIds(
            get().draftsByThreadKey[threadKey]?.prompt ?? "",
          ).includes(contextId);
          const placedAtCaret =
            !linkAlreadyInPromptBefore &&
            options?.appendReference !== false &&
            options?.insertAtCaret !== false &&
            (contextInsertionHandlers.get(threadKey)?.([reference]) ?? false);
          set((state) => {
            // Re-read inside the updater: the handler above may have written the
            // prompt through setPrompt.
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            if (existing.projectMemoryReferences.some((entry) => entry.contextId === contextId)) {
              return state;
            }
            const linkAlreadyInPrompt = collectInlineContextIds(existing.prompt).includes(
              contextId,
            );
            const nextDraft: ComposerThreadDraftState = {
              ...existing,
              prompt:
                linkAlreadyInPrompt || placedAtCaret || options?.appendReference === false
                  ? existing.prompt
                  : appendInlineContextReference(existing.prompt, reference),
              projectMemoryReferences: [
                ...existing.projectMemoryReferences,
                {
                  contextId,
                  memoryId: selection.memoryId,
                  selectedVersion: selection.selectedVersion,
                },
              ],
            };
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: nextDraft,
              },
            };
          });
          return true;
        },
        removeProjectMemoryReference: (threadRef, contextId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0 || contextId.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            const nextDraft = draftWithoutProjectMemoryReferences(current, new Set([contextId]));
            if (!nextDraft) {
              return state;
            }
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setAutoSelectState: (threadRef, state) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          const existing = get().draftsByThreadKey[threadKey];
          if (threadKey.length === 0 || !existing) return;
          // Bounded like the memory list itself, so a long-lived draft cannot grow without limit.
          const dismissed = state.dismissed.slice(-PROJECT_MEMORY_MAX_LIMIT);
          const added = state.added.slice(-PROJECT_MEMORY_MAX_LIMIT);
          const sameIds = (
            current: ReadonlyArray<string> | undefined,
            next: ReadonlyArray<string>,
          ) =>
            (current ?? []).length === next.length &&
            (current ?? []).every((id, i) => id === next[i]);
          if (
            sameIds(existing.autoSelectDismissed, dismissed) &&
            sameIds(existing.autoSelectAdded, added)
          ) {
            return;
          }
          const { autoSelectDismissed: _dismissed, autoSelectAdded: _added, ...rest } = existing;
          set((current) => ({
            draftsByThreadKey: {
              ...current.draftsByThreadKey,
              [threadKey]: {
                ...rest,
                ...(dismissed.length > 0 ? { autoSelectDismissed: [...dismissed] } : {}),
                ...(added.length > 0 ? { autoSelectAdded: [...added] } : {}),
              },
            },
          }));
        },
        setProjectMemoryReferences: (threadRef, references) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          // Restores merge sources (draft + queue), so dedupe by context id and
          // keep the first selection verbatim.
          const seenContextIds = new Set<string>();
          const normalized = references.flatMap((reference) => {
            const valid = normalizeProjectMemoryReference(reference);
            if (!valid || seenContextIds.has(valid.contextId)) {
              return [];
            }
            seenContextIds.add(valid.contextId);
            return [valid];
          });
          const retainedIds = new Set(normalized.map((reference) => reference.contextId));
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            let prompt = existing.prompt;
            for (const reference of existing.projectMemoryReferences) {
              if (!retainedIds.has(reference.contextId)) {
                prompt = removeInlineContextReference(prompt, reference.contextId).prompt;
              }
            }
            prompt = ensureInlineContextReferences(
              prompt,
              normalized.map((reference) => projectMemoryContextReference(reference.memoryId)),
            );
            const nextDraft: ComposerThreadDraftState = {
              ...existing,
              prompt,
              projectMemoryReferences: normalized,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        clearPersistedAttachments: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              persistedAttachments: [],
              nonPersistedImageIds: [],
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        syncPersistedAttachments: async (threadRef, attachments) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) {
            return;
          }
          const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              // Stage attempted attachments so persist middleware can try writing them.
              persistedAttachments: attachments,
              nonPersistedImageIds: current.nonPersistedImageIds.filter(
                (id) => !attachmentIdSet.has(id),
              ),
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
          await Promise.resolve();
          verifyPersistedAttachments(threadKey, attachments, set);
        },
        clearComposerContent: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              prompt: "",
              images: [],
              files: [],
              nonPersistedImageIds: [],
              persistedAttachments: [],
              terminalContexts: [],
              previewAnnotations: [],
              reviewComments: [],
              projectMemoryReferences: [],
            };
            delete nextDraft.autoSelectDismissed;
            delete nextDraft.autoSelectAdded;
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        clearComposerPromptAndImages: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            for (const image of current.images) {
              revokeObjectPreviewUrl(image.previewUrl);
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              prompt: ensureInlineContextReferences("", [
                ...current.terminalContexts.map(terminalContextReference),
                ...current.reviewComments.map(reviewCommentContextReference),
                ...current.previewAnnotations.map(previewAnnotationContextReference),
                ...current.projectMemoryReferences.map((reference) =>
                  projectMemoryContextReference(reference.memoryId),
                ),
              ]),
              images: [],
              files: [],
              nonPersistedImageIds: [],
              persistedAttachments: [],
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
      };
    },
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      storage: composerPersistStorage,
      migrate: migratePersistedComposerDraftStoreState,
      // Defer the draft walk and serialization until the storage write flushes.
      partialize: (state): ComposerPersistState => ({ capturedState: state }),
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);
        const draftsByThreadKey = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadKey).map(([threadKey, draft]) => [
            threadKey,
            toHydratedThreadDraft(draft),
          ]),
        );
        const draftThreadsByThreadKey = Object.fromEntries(
          Object.entries(normalizedPersisted.draftThreadsByThreadKey).map(
            ([threadKey, draftThread]) => [threadKey, toHydratedDraftThreadState(draftThread)],
          ),
        ) as Record<string, DraftThreadState>;
        return {
          ...currentState,
          draftsByThreadKey,
          draftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey:
            normalizedPersisted.logicalProjectDraftThreadKeyByLogicalProjectKey,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        };
      },
    },
  ),
);

export const useComposerDraftStore = composerDraftStore;

export function beginBackgroundDraftSubmissionByRef(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  useComposerDraftStore.setState((state) => {
    if (state.backgroundSubmissionThreadKeys[threadKey]) {
      return state;
    }
    return {
      backgroundSubmissionThreadKeys: {
        ...state.backgroundSubmissionThreadKeys,
        [threadKey]: true,
      },
    };
  });
}

export function clearBackgroundDraftSubmissionByRef(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  useComposerDraftStore.setState((state) => {
    if (!state.backgroundSubmissionThreadKeys[threadKey]) {
      return state;
    }
    const backgroundSubmissionThreadKeys = { ...state.backgroundSubmissionThreadKeys };
    delete backgroundSubmissionThreadKeys[threadKey];
    return { backgroundSubmissionThreadKeys };
  });
}

export function useBackgroundDraftSubmissionPending(threadRef: ScopedThreadRef | null): boolean {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  return useComposerDraftStore(
    (state) => threadKey !== null && state.backgroundSubmissionThreadKeys[threadKey] === true,
  );
}

export function clearComposerDraftsEnvironment(environmentId: EnvironmentId): void {
  useComposerDraftStore.setState((state) => {
    const removedThreadKeys = new Set<string>();

    for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
      if (draftThread.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }
    for (const threadKey of Object.keys(state.draftsByThreadKey)) {
      if (parseScopedThreadKey(threadKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }
    for (const [logicalProjectKey, threadKey] of Object.entries(
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    )) {
      if (parseScopedProjectKey(logicalProjectKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }

    const nextLogicalMappings = Object.fromEntries(
      Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
        ([logicalProjectKey, threadKey]) =>
          parseScopedProjectKey(logicalProjectKey)?.environmentId !== environmentId &&
          !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, string>;
    const nextDraftThreads = Object.fromEntries(
      Object.entries(state.draftThreadsByThreadKey).filter(
        ([threadKey, draftThread]) =>
          draftThread.environmentId !== environmentId && !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, DraftThreadState>;
    const nextDrafts = Object.fromEntries(
      Object.entries(state.draftsByThreadKey).filter(([threadKey, draft]) => {
        if (!removedThreadKeys.has(threadKey)) {
          return true;
        }
        revokeDraftThreadPreviewUrls(draft);
        return false;
      }),
    ) as Record<string, ComposerThreadDraftState>;
    const nextBackgroundSubmissionThreadKeys = Object.fromEntries(
      Object.entries(state.backgroundSubmissionThreadKeys).filter(
        ([threadKey]) => parseScopedThreadKey(threadKey)?.environmentId !== environmentId,
      ),
    ) as Record<string, true>;

    return {
      draftsByThreadKey: nextDrafts,
      draftThreadsByThreadKey: nextDraftThreads,
      logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
      backgroundSubmissionThreadKeys: nextBackgroundSubmissionThreadKeys,
      rewindingThreadKeys: new Set(
        [...state.rewindingThreadKeys].filter(
          (threadKey) => parseScopedThreadKey(threadKey)?.environmentId !== environmentId,
        ),
      ),
    };
  });
  composerDebouncedStorage.flush();
}

export function useComposerThreadDraft(threadRef: ComposerThreadTarget): ComposerThreadDraftState {
  return useComposerDraftStore((state) => {
    return getComposerDraftState(state, threadRef) ?? EMPTY_THREAD_DRAFT;
  });
}

/**
 * True when a real thread's composer holds unsent user content. Selects a
 * boolean so the sidebar row that reads it re-renders only when the draft
 * appears or disappears, not on every keystroke.
 */
export function useThreadHasUnsentDraft(threadRef: ScopedThreadRef): boolean {
  return useComposerDraftStore((state) =>
    composerDraftHasUserContent(getComposerDraftState(state, threadRef)),
  );
}

function useComposerDraftModelState(threadRef: ComposerThreadTarget): ComposerDraftModelState {
  return useComposerDraftStore(
    useShallow((state) => {
      const draft = getComposerDraftState(state, threadRef);
      return draft
        ? {
            activeProvider: draft.activeProvider,
            modelSelectionByProvider: draft.modelSelectionByProvider,
          }
        : EMPTY_COMPOSER_DRAFT_MODEL_STATE;
    }),
  );
}

export function useEffectiveComposerModelState(input: {
  threadRef?: ComposerThreadTarget;
  draftId?: DraftId;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  /**
   * When supplied, the draft's saved selection for this instance takes
   * precedence over the driver-kind bucket — so a custom `codex_personal`
   * instance reads its own model, not the default Codex's.
   */
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const draft = useComposerDraftModelState(input.threadRef ?? input.draftId ?? DraftId.make(""));

  return useMemo(
    () =>
      deriveEffectiveComposerModelState({
        draft,
        providers: input.providers,
        selectedProvider: input.selectedProvider,
        selectedInstanceId: input.selectedInstanceId,
        threadModelSelection: input.threadModelSelection,
        projectModelSelection: input.projectModelSelection,
        settings: input.settings,
      }),
    [
      draft,
      input.providers,
      input.settings,
      input.projectModelSelection,
      input.selectedInstanceId,
      input.selectedProvider,
      input.threadModelSelection,
    ],
  );
}

export function markPromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    if (
      draftThread.environmentId === threadRef.environmentId &&
      draftThread.threadId === threadRef.threadId
    ) {
      draftStore.markDraftThreadPromoting(DraftId.make(draftId), threadRef);
    }
  }
}

export function restoreFailedBackgroundDraftThread(
  draftId: DraftId,
  draftThread: DraftThreadState,
  threadId: ThreadId,
): void {
  useComposerDraftStore.setState((state) => ({
    draftThreadsByThreadKey: {
      ...state.draftThreadsByThreadKey,
      [draftId]: {
        ...draftThread,
        threadId,
        promotedTo: null,
      },
    },
  }));
}

export function finalizePromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    const promotedRef = draftThread.promotedTo;
    const matches = promotedRef
      ? promotedRef.environmentId === threadRef.environmentId &&
        promotedRef.threadId === threadRef.threadId
      : draftThread.environmentId === threadRef.environmentId &&
        draftThread.threadId === threadRef.threadId;
    if (matches) {
      const target = DraftId.make(draftId);
      draftStore.markDraftThreadPromoting(target, threadRef);
      draftStore.finalizePromotedDraftThread(target);
    }
  }
  clearBackgroundDraftSubmissionByRef(threadRef);
}
