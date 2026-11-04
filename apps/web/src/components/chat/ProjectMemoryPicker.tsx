import { useAtomValue } from "@effect/atom-react";
import { t as tr, useT } from "../../i18n";
import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_MEMORY_MAX_LIMIT,
  PROJECT_MEMORY_QUERY_MAX_LENGTH,
  type EnvironmentId,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EMPTY_AUTO_SELECT_STATE,
  planAutoSelection,
} from "@t3tools/client-runtime/project-memory-auto-select";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { BookMarkedIcon, CheckIcon, HistoryIcon, LightbulbIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";

import type { ComposerProjectMemoryReference, ComposerThreadTarget } from "~/composerDraftStore";
import { composerTargetKey, useComposerDraftStore } from "~/composerDraftStore";
import {
  projectMemoryContextId,
  reconcileProjectMemoryDraftReferences,
} from "~/lib/composerContextRecords";
import { projectMemory } from "~/state/projectMemory";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useEnvironmentQuery } from "~/state/query";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom, serverEnvironment } from "~/state/server";
import { readProject, readThread, readThreadShell } from "~/state/entities";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { deriveLockedProvider, resolveComposerProviderSelection } from "../ChatView.logic";
import { cn } from "~/lib/utils";
import {
  ComposerMemoryTitleContext,
  unknownComposerMemoryTitle,
} from "../composerContextPresentation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProjectMemorySentToThread } from "./ProjectMemorySentToThread";
import { suggestProjectMemories } from "./projectMemorySuggestions";

/**
 * The composer-side project-memory selection flow: a footer button next to
 * "Attach files", a popover listing the project's memories, and the draft
 * bindings that turn a row click into an identifier-only chip. Visibility is
 * dormant by default — it needs the server's `projectMemory.send` capability
 * AND a resolved selected instance whose driver kind the server advertises;
 * anything unresolved only ever disables or hides, never implies support.
 */

const MEMORY_KIND_LABELS: Record<string, string> = {
  fact: "Fact",
  procedure: "Procedure",
  "work-log": "Work log",
};

export const PROJECT_MEMORY_PICKER_LABEL = "Project memory";
export const PROJECT_MEMORY_UNSUPPORTED_PROVIDER_MESSAGE =
  "This provider does not support sending memories";
export const PROJECT_MEMORY_REFERENCE_HOLD_WARNING =
  "This provider does not support memory references. They are held on send.";

/** What the footer button may do, derived from capability plus resolved driver. */
export interface ProjectMemoryComposerGate {
  /** False hides the button entirely (capability absent or send disabled). */
  pickerVisible: boolean;
  pickerEnabled: boolean;
  /** Concise reason shown while the button is visible but disabled. Null when enabled. */
  disabledReason: string | null;
  /** Existing references ride along to a provider that cannot send them. */
  warnExistingReferences: boolean;
}

export function deriveProjectMemoryComposerGate(input: {
  send: boolean;
  sendDriverKinds: ReadonlyArray<ProviderDriverKind> | undefined;
  selectedDriverKind: ProviderDriverKind | undefined;
  providerCatalogPending: boolean;
  hasReferences: boolean;
}): ProjectMemoryComposerGate {
  // Membership of the resolved instance's driver kind — never the instance id.
  // An unresolved or pending catalog cannot imply support.
  const driverSupported =
    input.selectedDriverKind !== undefined &&
    (input.sendDriverKinds?.includes(input.selectedDriverKind) ?? false);
  const pickerVisible = input.send;
  const pickerEnabled = pickerVisible && !input.providerCatalogPending && driverSupported;
  return {
    pickerVisible,
    pickerEnabled,
    disabledReason:
      pickerVisible && !pickerEnabled
        ? input.providerCatalogPending
          ? tr("Checking the provider…")
          : tr(PROJECT_MEMORY_UNSUPPORTED_PROVIDER_MESSAGE)
        : null,
    warnExistingReferences: input.hasReferences && !(input.send && driverSupported),
  };
}

/** Live chip-title state from one loaded list/search page. */
export type ProjectMemoryListSummary = {
  readonly memoryId: string;
  readonly title: string;
  readonly version: number;
};

export function createMemoryTitleResolverFromList(
  data: {
    readonly items: ReadonlyArray<ProjectMemoryListSummary>;
    readonly truncated: boolean;
  } | null,
) {
  if (!data) {
    return unknownComposerMemoryTitle;
  }
  const byMemoryId = new Map(data.items.map((item) => [item.memoryId, item]));
  return (memoryId: string, selectedVersion: number) => {
    const row = byMemoryId.get(memoryId);
    if (!row) {
      // Absence from a truncated page proves nothing; absence from a complete
      // list is the only deletion signal the client may render.
      return data.truncated ? ({ status: "unknown" } as const) : ({ status: "missing" } as const);
    }
    return row.version === selectedVersion
      ? ({ status: "resolved", title: row.title } as const)
      : ({ status: "stale", title: row.title, currentVersion: row.version } as const);
  };
}

/** Resolves memory chip titles from the project's list; unknown until a project exists. */
export function ProjectMemoryTitleProvider(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  children: ReactNode;
}) {
  const result = useEnvironmentQuery(
    props.projectId === null
      ? null
      : projectMemory.list({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, limit: PROJECT_MEMORY_MAX_LIMIT },
        }),
  );
  const resolver = useMemo(() => createMemoryTitleResolverFromList(result.data), [result.data]);
  return <ComposerMemoryTitleContext value={resolver}>{props.children}</ComposerMemoryTitleContext>;
}

/**
 * The live insertion-support decision, read at mutation time from the real
 * descriptor registry and provider catalog — not from render-flushed props. A
 * popover row can stay interactive after the descriptor or the selected
 * instance changed underneath it, so the callback itself re-resolves: the
 * server must advertise memory sends, the instance the picker showed must
 * still exist, be runnable, and its driver kind must be in the current
 * advertised list.
 */
export function readCurrentProjectMemoryInsertionSupport(input: {
  environmentId: EnvironmentId;
  intendedInstanceId: ProviderInstanceId | null | undefined;
}): boolean {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(input.environmentId);
  const capability = config?.environment.capabilities.projectMemory;
  if (config === undefined || capability?.send !== true) {
    return false;
  }
  const advertised = capability.sendDriverKinds;
  if (!advertised || advertised.length === 0) {
    return false;
  }
  if (input.intendedInstanceId === null || input.intendedInstanceId === undefined) {
    return false;
  }
  const snapshot = config.providers.find(
    (provider) => provider.instanceId === input.intendedInstanceId,
  );
  if (
    !snapshot ||
    !snapshot.enabled ||
    !snapshot.installed ||
    snapshot.status !== "ready" ||
    snapshot.availability === "unavailable"
  ) {
    return false;
  }
  return advertised.includes(snapshot.driver);
}

/**
 * The current insertion scope for an existing server thread, read at mutation
 * time with the same production resolution ChatComposer renders with:
 * settings-projected instance entries (`applyProviderInstanceSettings` over the
 * settings `useEnvironmentSettings` reads, same default policy) and candidates
 * in `resolveComposerProviderSelection` precedence — the composer draft's
 * activeProvider for this thread, then the live session, then the shell's
 * persisted model, then the project's resolved default — under the
 * started-thread locked-provider rules. The shell is the authority for both
 * returned fields: a live shell is required (readThread deliberately keeps
 * returning retained detail after the shell is gone) and carries the thread's
 * current project, so a moved or deleted shell fails the scope comparison
 * instead of riding the last render. ChatComposer's footer callbacks and the
 * picker tests share this one reader.
 */
export function readCurrentServerThreadInsertionScope(input: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
}): { instanceId: ProviderInstanceId | null; projectId: ProjectId | null } {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(input.environmentId);
  if (config === undefined) {
    return { instanceId: null, projectId: null };
  }
  const shell = readThreadShell(input.threadRef);
  if (shell === null) {
    return { instanceId: null, projectId: null };
  }
  const thread = readThread(input.threadRef) ?? undefined;
  const settings =
    appAtomRegistry.get(serverEnvironment.settingsValueAtom(input.environmentId)) ??
    DEFAULT_SERVER_SETTINGS;
  const draftActiveProvider =
    useComposerDraftStore.getState().getComposerDraft(input.threadRef)?.activeProvider ?? null;
  const sessionInstanceId = thread?.session?.providerInstanceId ?? null;
  const shellInstanceId = shell.modelSelection.instanceId;
  const project = readProject(scopeProjectRef(input.environmentId, shell.projectId));
  const projectSettings = resolveProjectSettings(settings, shell.projectId, project).settings;
  const projectDefaultInstanceId = projectSettings.defaultModelSelection?.instanceId ?? null;
  const lockedProvider = deriveLockedProvider({
    thread,
    selectedProvider: draftActiveProvider,
    threadProvider: shellInstanceId,
    providers: config.providers,
  });
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(config.providers), settings),
  );
  const { selectedProviderEntry } = resolveComposerProviderSelection({
    entries,
    candidateInstanceIds: [
      draftActiveProvider,
      sessionInstanceId,
      shellInstanceId,
      projectDefaultInstanceId,
    ],
    lockedProvider,
    lockedInstanceId: sessionInstanceId ?? shellInstanceId,
  });
  return {
    instanceId: selectedProviderEntry?.instanceId ?? null,
    projectId: shell.projectId,
  };
}

/** The environment/project/draft a picker render was scoped to. */
export interface ProjectMemoryPickerScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftKey: string;
}

/** Wait for a pause in typing so a chip is never inserted under a moving caret. */
const AUTO_SELECT_DEBOUNCE_MS = 800;

const EMPTY_PROJECT_MEMORY_REFERENCES: ReadonlyArray<ComposerProjectMemoryReference> = [];

/**
 * Binds the picker to the composer draft. `toggle` and `remove` reconcile the
 * originating scope against the live target at insertion time — render-flushed
 * scope, the draft session's CURRENT project in the store, and for toggles the
 * current descriptor/provider support — so a stale list render or an old
 * handler cannot append into (or delete from) a different environment,
 * project, or draft. Removal stays possible in a draft whose support
 * disappeared; it just cannot cross drafts. Returns false on refusal.
 */
export function useProjectMemoryDraftLink(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  composerDraftTarget: ComposerThreadTarget;
  /**
   * For server-thread targets: the instance that would run a turn right now,
   * using the same resolution ChatComposer uses (draft activeProvider, session,
   * locked-provider fallbacks), not the last persisted shell selection alone.
   */
  readServerThreadInsertionInstanceId?: () => ProviderInstanceId | null;
  /** For server-thread targets: reconcile project scope at mutation time. */
  readServerThreadProjectId?: () => ProjectId | null;
}): {
  selected: ReadonlyArray<ComposerProjectMemoryReference>;
  toggle: (
    memoryId: string,
    selectedVersion: number,
    scope: ProjectMemoryPickerScope,
    options?: { readonly insertAtCaret?: boolean },
  ) => boolean;
  remove: (contextId: string, scope: ProjectMemoryPickerScope) => void;
} {
  const selected = useComposerDraftStore(
    (state) =>
      state.getComposerDraft(input.composerDraftTarget)?.projectMemoryReferences ??
      EMPTY_PROJECT_MEMORY_REFERENCES,
  );
  // Kept current through every render so late (non-render) invocations still
  // reconcile against the target the composer is showing right now.
  const liveTargetRef = useRef(input.composerDraftTarget);
  liveTargetRef.current = input.composerDraftTarget;
  const liveScopeRef = useRef<ProjectMemoryPickerScope>({
    environmentId: input.environmentId,
    projectId: input.projectId,
    draftKey: composerTargetKey(input.composerDraftTarget),
  });
  liveScopeRef.current = {
    environmentId: input.environmentId,
    projectId: input.projectId,
    draftKey: composerTargetKey(input.composerDraftTarget),
  };
  // A store mutation can move a draft session to another project before React
  // flushes the next render; the store's own session record is the authority
  // on where a write would land, not the render-flushed scope.
  const readTargetProjectMatches = (): boolean => {
    const target = liveTargetRef.current;
    if (typeof target !== "string") {
      const currentProjectId = input.readServerThreadProjectId?.() ?? null;
      return currentProjectId !== null && currentProjectId === liveScopeRef.current.projectId;
    }
    const session = useComposerDraftStore.getState().getDraftSession(target);
    if (!session) {
      return false;
    }
    return (
      session.environmentId === liveScopeRef.current.environmentId &&
      session.projectId === liveScopeRef.current.projectId
    );
  };
  // The provider that would actually run a turn from this target right now —
  // read from the store at mutation time, never from the last render. A
  // store-only provider move between renders must not ride the previous
  // (still-ready) selection through the gate.
  const readCurrentSelectedInstanceId = (): ProviderInstanceId | null => {
    const target = liveTargetRef.current;
    if (typeof target !== "string") {
      return input.readServerThreadInsertionInstanceId?.() ?? null;
    }
    return useComposerDraftStore.getState().getComposerDraft(target)?.activeProvider ?? null;
  };
  const scopeMatches = (scope: ProjectMemoryPickerScope): boolean => {
    const current = liveScopeRef.current;
    return (
      scope.environmentId === current.environmentId &&
      scope.projectId === current.projectId &&
      scope.draftKey === current.draftKey
    );
  };
  const toggle = (
    memoryId: string,
    selectedVersion: number,
    scope: ProjectMemoryPickerScope,
    options?: { readonly insertAtCaret?: boolean },
  ) => {
    if (!scopeMatches(scope)) {
      return false;
    }
    if (!readTargetProjectMatches()) {
      return false;
    }
    if (
      !readCurrentProjectMemoryInsertionSupport({
        environmentId: liveScopeRef.current.environmentId,
        intendedInstanceId: readCurrentSelectedInstanceId(),
      })
    ) {
      return false;
    }
    return useComposerDraftStore
      .getState()
      .addProjectMemoryReference(
        liveTargetRef.current,
        { memoryId, selectedVersion },
        options?.insertAtCaret === undefined ? undefined : { insertAtCaret: options.insertAtCaret },
      );
  };
  const remove = (contextId: string, scope: ProjectMemoryPickerScope) => {
    if (!scopeMatches(scope)) {
      return;
    }
    if (!readTargetProjectMatches()) {
      return;
    }
    useComposerDraftStore.getState().removeProjectMemoryReference(liveTargetRef.current, contextId);
  };
  return { selected, toggle, remove };
}

/**
 * Editor delete/undo reconciliation for memory selections. ChatComposer's
 * onPromptChange calls this; identifier-only payloads are retained for undo.
 */
export function applyProjectMemoryPromptReconciliation(
  composerDraftTarget: ComposerThreadTarget,
  referencedContextIds: ReadonlySet<string>,
  retained: Map<string, ComposerProjectMemoryReference>,
): void {
  const store = useComposerDraftStore.getState();
  const changes = reconcileProjectMemoryDraftReferences({
    referencedContextIds,
    references:
      store.getComposerDraft(composerDraftTarget)?.projectMemoryReferences ??
      EMPTY_PROJECT_MEMORY_REFERENCES,
    retained,
  });
  for (const reference of changes.removed) {
    store.removeProjectMemoryReference(composerDraftTarget, reference.contextId);
  }
  for (const reference of changes.restored) {
    store.addProjectMemoryReference(
      composerDraftTarget,
      { memoryId: reference.memoryId, selectedVersion: reference.selectedVersion },
      { appendReference: false },
    );
  }
}

export function useProjectMemoryPromptReconciliation(
  composerDraftTarget: ComposerThreadTarget,
): (referencedContextIds: ReadonlySet<string>) => void {
  const targetRef = useRef(composerDraftTarget);
  targetRef.current = composerDraftTarget;
  const retainedRef = useRef(new Map<string, ComposerProjectMemoryReference>());
  const draftKey = composerTargetKey(composerDraftTarget);
  useEffect(() => {
    retainedRef.current = new Map();
  }, [draftKey]);
  return useCallback((referencedContextIds: ReadonlySet<string>) => {
    applyProjectMemoryPromptReconciliation(
      targetRef.current,
      referencedContextIds,
      retainedRef.current,
    );
  }, []);
}

/**
 * The memory list itself: browse by default, bounded search while typing.
 * Both reads are the shared environment-scoped atoms, so a pending or failed
 * read never shows a stale page, and every query is keyed by environment and
 * project.
 */
export function ProjectMemoryPicker(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  scope: ProjectMemoryPickerScope;
  selected: ReadonlyArray<ComposerProjectMemoryReference>;
  onToggle: (memoryId: string, selectedVersion: number, scope: ProjectMemoryPickerScope) => void;
  onRemove: (contextId: string, scope: ProjectMemoryPickerScope) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim().slice(0, PROJECT_MEMORY_QUERY_MAX_LENGTH);
  const result = useEnvironmentQuery(
    trimmedQuery.length > 0
      ? projectMemory.search({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            query: trimmedQuery,
            limit: PROJECT_MEMORY_MAX_LIMIT,
          },
        })
      : projectMemory.list({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, limit: PROJECT_MEMORY_MAX_LIMIT },
        }),
  );
  const selectedMemoryIds = useMemo(
    () => new Set(props.selected.map((reference) => reference.memoryId)),
    [props.selected],
  );
  const items = result.data?.items ?? [];
  return (
    <div className="flex max-h-80 min-w-64 flex-col gap-1" data-memory-picker="true">
      <Input
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={t("Search memories")}
        aria-label={t("Search memories")}
      />
      {result.isPending && result.data === null ? (
        <div className="px-2 py-3 text-secondary-label text-xs">{t("Reading memories…")}</div>
      ) : result.error !== null && result.data === null ? (
        <div className="flex flex-col gap-1 px-2 py-3">
          <div className="text-secondary-label text-xs">{t("Couldn't read the memories.")}</div>
          <Button variant="outline" size="xs" className="w-fit" onClick={result.refresh}>
            {t("Try again")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="px-2 py-3 text-secondary-label text-xs">
          {trimmedQuery.length > 0 ? t("No results.") : t("No memories saved yet.")}
        </div>
      ) : (
        <div className="flex flex-col overflow-y-auto">
          {items.map((item) => {
            const isSelected = selectedMemoryIds.has(item.memoryId);
            return (
              <Button
                key={item.memoryId}
                variant="ghost"
                size="sm"
                className="justify-start"
                aria-pressed={isSelected}
                data-memory-picker-row={item.memoryId}
                onClick={() => {
                  if (isSelected) {
                    props.onRemove(projectMemoryContextId(item.memoryId), props.scope);
                    return;
                  }
                  props.onToggle(item.memoryId, item.version, props.scope);
                }}
              >
                <span className="min-w-0 flex-1 truncate text-start">{item.title}</span>
                <span className="shrink-0 text-secondary-label text-2xs">
                  {t(MEMORY_KIND_LABELS[item.kind] ?? item.kind)} · v{item.version}
                </span>
                {isSelected ? <CheckIcon className="size-3.5 shrink-0" /> : null}
              </Button>
            );
          })}
        </div>
      )}
      {result.data?.truncated ? (
        <div className="px-2 py-1 text-secondary-label text-2xs">
          {t("Results were cut off. Narrow it down with a search.")}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Footer button + popover. `gate` comes from `deriveProjectMemoryComposerGate`
 * so ChatComposer can share one derivation between this button and the inline
 * warning for existing references.
 */
export function ProjectMemoryComposerControl(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  composerDraftTarget: ComposerThreadTarget;
  gate: ProjectMemoryComposerGate;
  readServerThreadInsertionInstanceId: () => ProviderInstanceId | null;
  readServerThreadProjectId: () => ProjectId | null;
}) {
  // Dormant by default: a server that does not advertise memory sends gets no
  // button at all, not a disabled one.
  if (!props.gate.pickerVisible) {
    return null;
  }
  return <ProjectMemoryComposerControlBody {...props} />;
}

function ProjectMemoryComposerControlBody(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  composerDraftTarget: ComposerThreadTarget;
  gate: ProjectMemoryComposerGate;
  readServerThreadInsertionInstanceId: () => ProviderInstanceId | null;
  readServerThreadProjectId: () => ProjectId | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [showSent, setShowSent] = useState(false);
  // The "sent to this thread" view needs a server thread (a draft has sent
  // nothing) and a server that serves it; older servers just don't get the entry.
  const sentThreadId =
    typeof props.composerDraftTarget === "string" ? null : props.composerDraftTarget.threadId;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const sentSupported =
    sentThreadId !== null &&
    serverConfig?.environment.capabilities.projectMemory?.sentToThread === true;
  const link = useProjectMemoryDraftLink({
    environmentId: props.environmentId,
    projectId: props.projectId,
    composerDraftTarget: props.composerDraftTarget,
    readServerThreadInsertionInstanceId: props.readServerThreadInsertionInstanceId,
    readServerThreadProjectId: props.readServerThreadProjectId,
  });
  const scope: ProjectMemoryPickerScope = {
    environmentId: props.environmentId,
    projectId: props.projectId,
    draftKey: composerTargetKey(props.composerDraftTarget),
  };
  // Suggests related memories for what is being typed. The list is read once per project
  // (with bodies, so title and body are both scored) and cached, so typing never adds a
  // server query.
  const draft = useComposerDraftStore(
    (state) => state.getComposerDraft(props.composerDraftTarget)?.prompt ?? "",
  );
  // Visible auto-selection: related memories become ordinary removable chips, added through
  // the same toggle (provider re-check included) and sent through the same reference path.
  // Off unless the environment setting is on; a chip the user removes is not added back.
  const autoSelectEnabled = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.autoSelectProjectMemories,
  );
  // Bodies are only requested when auto-select will score them. Without them the input is
  // the same as the picker list's, so both read one cached title list.
  const memories = useEnvironmentQuery(
    projectMemory.list({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        limit: PROJECT_MEMORY_MAX_LIMIT,
        ...(autoSelectEnabled && props.gate.pickerEnabled ? { includeBody: true } : {}),
      },
    }),
  ).data?.items;
  const suggestion = useMemo(
    () =>
      props.gate.pickerEnabled
        ? suggestProjectMemories(
            draft,
            memories ?? [],
            new Set(link.selected.map((reference) => reference.memoryId)),
            1,
          )[0]
        : undefined,
    [draft, memories, link.selected, props.gate.pickerEnabled],
  );
  // Dismissed chips live on the draft, so they survive switching threads and remounting.
  const draftKey = scope.draftKey;
  const autoSelectStateRef = useRef(EMPTY_AUTO_SELECT_STATE);
  const draftTargetRef = useRef(props.composerDraftTarget);
  draftTargetRef.current = props.composerDraftTarget;
  useEffect(() => {
    const stored = useComposerDraftStore.getState().getComposerDraft(draftTargetRef.current);
    // `added` is restored too: chips attached before a remount still count against the budget.
    autoSelectStateRef.current = {
      ...EMPTY_AUTO_SELECT_STATE,
      added: new Set(stored?.autoSelectAdded),
      dismissed: new Set(stored?.autoSelectDismissed),
    };
  }, [draftKey]);
  useEffect(() => {
    if (draft.trim().length === 0 && link.selected.length === 0) {
      autoSelectStateRef.current = EMPTY_AUTO_SELECT_STATE;
      useComposerDraftStore
        .getState()
        .setAutoSelectState(draftTargetRef.current, { dismissed: [], added: [] });
      return;
    }
    const timer = setTimeout(() => {
      const plan = planAutoSelection({
        enabled: autoSelectEnabled,
        providerAllowed: props.gate.pickerEnabled,
        draft,
        memories: memories ?? [],
        selectedMemoryIds: new Set(link.selected.map((reference) => reference.memoryId)),
        state: autoSelectStateRef.current,
        nowMs: Date.now(),
      });
      autoSelectStateRef.current = plan.state;
      // Persist only ids that still exist, so the draft's list cannot grow past the memory list.
      const known = memories ? new Set<string>(memories.map((item) => item.memoryId)) : null;
      const persistable = (ids: ReadonlySet<string>) =>
        [...ids].filter((id) => known === null || known.has(id));
      useComposerDraftStore.getState().setAutoSelectState(draftTargetRef.current, {
        dismissed: persistable(plan.state.dismissed),
        added: [...plan.state.added],
      });
      for (const item of plan.add) {
        link.toggle(item.memoryId, item.version, scope, { insertAtCaret: false });
      }
    }, AUTO_SELECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `link.toggle` re-reads live state at call time; its identity changes every render.
  }, [draft, memories, link.selected, autoSelectEnabled, props.gate.pickerEnabled, draftKey]);
  return (
    <>
      {suggestion ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="max-w-48"
          data-memory-suggestion={suggestion.memoryId}
          title={t("Add related memory: {title}", { title: suggestion.title })}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => link.toggle(suggestion.memoryId, suggestion.version, scope)}
        >
          <LightbulbIcon />
          <span className="truncate">{suggestion.title}</span>
        </Button>
      ) : null}
      {/* An already-open picker closes when support disappears (render-driven);
          the toggle/remove callbacks still re-verify at mutation time. */}
      <Popover
        open={open && props.gate.pickerEnabled}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setShowSent(false);
        }}
      >
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!props.gate.pickerEnabled}
              aria-label={t(PROJECT_MEMORY_PICKER_LABEL)}
              data-chat-memory-picker-trigger="true"
              title={props.gate.disabledReason ?? t(PROJECT_MEMORY_PICKER_LABEL)}
              onPointerDown={(event) => event.preventDefault()}
            />
          }
        >
          <BookMarkedIcon />
        </PopoverTrigger>
        <PopoverPopup side="top" align="end" width="sm" padding="compact">
          {sentThreadId !== null && sentSupported && showSent ? (
            <ProjectMemorySentToThread
              environmentId={props.environmentId}
              projectId={props.projectId}
              threadId={sentThreadId}
              onBack={() => setShowSent(false)}
              onNavigate={() => {
                setOpen(false);
                setShowSent(false);
              }}
            />
          ) : (
            <div className="flex flex-col gap-1">
              <ProjectMemoryPicker
                environmentId={props.environmentId}
                projectId={props.projectId}
                scope={scope}
                selected={link.selected}
                onToggle={link.toggle}
                onRemove={link.remove}
              />
              {sentSupported ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="w-fit"
                  data-memory-sent-trigger="true"
                  onClick={() => setShowSent(true)}
                >
                  <HistoryIcon />
                  {t("Sent to this thread")}
                </Button>
              ) : null}
            </div>
          )}
        </PopoverPopup>
      </Popover>
    </>
  );
}

/** Inline warning shown when existing references ride to an unsupported target. */
export function ProjectMemoryUnsupportedWarning() {
  const t = useT();
  return (
    <div
      data-memory-unsupported-warning="true"
      className={cn("px-3 text-secondary-label text-xs sm:px-4")}
    >
      {t(PROJECT_MEMORY_REFERENCE_HOLD_WARNING)}
    </div>
  );
}
