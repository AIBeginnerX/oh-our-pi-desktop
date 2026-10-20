import type {
  EnvironmentId,
  ProjectId,
  ProjectMemory,
  ProjectMemoryId,
  ProjectMemoryKind,
  ProjectMemoryOrigin,
  ProjectMemoryWriteResult,
} from "@t3tools/contracts";
import { PROJECT_MEMORY_MAX_LIMIT } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { projectMemory } from "../../state/projectMemory";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const KIND_OPTIONS = [
  { value: "fact", label: "Fact" },
  { value: "procedure", label: "Procedure" },
  { value: "work-log", label: "Work log" },
] as const;

const KIND_LABEL: Record<ProjectMemoryKind, string> = {
  fact: "Fact",
  procedure: "Procedure",
  "work-log": "Work log",
};

const SEARCH_DEBOUNCE_MS = 200;

interface MemoryDraft {
  readonly title: string;
  readonly body: string;
  readonly kind: ProjectMemoryKind;
  /** ISO instant or null for no expiry. */
  readonly validUntilIso: string | null;
}

const EMPTY_DRAFT: MemoryDraft = { title: "", body: "", kind: "fact", validUntilIso: null };

/**
 * The same rough chars-per-token heuristic the server applies to
 * `estimatedTokens`. A display estimate only — not a tokenizer and not
 * calibrated for non-Latin scripts.
 */
function estimateMemoryTokens(draft: Pick<MemoryDraft, "title" | "body">): number {
  return Math.ceil((draft.title.length + draft.body.length) / 4);
}

function localInputFromDate(date: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : localInputFromDate(date);
}

function localInputToIso(value: string): string | null {
  if (value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function draftFromMemory(memory: ProjectMemory): MemoryDraft {
  return {
    title: memory.title,
    body: memory.body,
    kind: memory.kind,
    validUntilIso: memory.validUntil,
  };
}

function isMemoryError(value: unknown, tag: string): boolean {
  return typeof value === "object" && value !== null && "_tag" in value && value._tag === tag;
}

function readFailure(raw: AsyncResult.AsyncResult<unknown, unknown>): unknown {
  return raw._tag === "Failure" ? Cause.squash(raw.cause) : null;
}

const EMPTY_DETAIL_RESULT = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("project-memory-editor:empty-detail"),
);

/**
 * Why memory writes are unavailable, in the order the user can act on it. Null
 * means writable. Browsing (list, search, detail) stays available either way.
 */
function resolveMemoryWriteLock(operateAccess: "granted" | "denied" | "pending"): string | null {
  if (operateAccess === "pending") {
    return "Checking your access to this environment…";
  }
  if (operateAccess === "denied") {
    return "Your session on this environment can browse memories but not change them.";
  }
  return null;
}

// Same split the environment icon picker uses: the desktop app owns its
// primary server outright, a browser session on the primary checks its cookie
// session's scopes, and a remote checks the scopes its own server reports.
// Presentation only: it is optimistic about cached session data, so skill
// mutations re-confirm through the bounded session check before writing.
export function useProjectMemoryOperateAccess(
  environmentId: EnvironmentId,
): "granted" | "denied" | "pending" {
  const isPrimary = usePrimaryEnvironmentId() === environmentId;
  const primarySession = usePrimarySessionState();
  const remoteSession = useEnvironmentSessionState(environmentId);
  if (isPrimary) {
    return isElectron
      ? "granted"
      : resolvePrimaryOperateAccess({
          isPrimary: true,
          hasDesktopBridge: false,
          session: primarySession.data,
          isPending: primarySession.isPending,
          hasError: primarySession.error !== null,
        });
  }
  return resolveRemoteOperateAccess({
    session: remoteSession.data,
    isPending: remoteSession.isPending,
    hasError: remoteSession.hasError,
  });
}

interface ProjectMemoryEditorDialogProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Edit the memory with this id; null creates a new one. */
  readonly memoryId?: ProjectMemoryId | null;
  /** Prefilled draft for creates; the detail query seeds edits. */
  readonly draft?: MemoryDraft | null;
  /** Provenance recorded for creates; the server verifies message origins. */
  readonly origin: ProjectMemoryOrigin;
  readonly onFinished?: () => void;
}

/**
 * The small create/edit dialog shared by the project settings section and the
 * chat "save to project memory" action. Drafts live in component state only —
 * nothing here persists outside the memory store.
 *
 * The dialog chrome is hook-free and mounts one {@link ProjectMemoryEditorInner}
 * per scope, keyed by a JSON tuple of environment, project, memory and origin.
 * Any scope change remounts, so editor state can never outlive the exact key it
 * was loaded for, and closing unmounts it outright.
 */
export function ProjectMemoryEditorDialog({
  environmentId,
  projectId,
  open,
  onOpenChange,
  memoryId = null,
  draft = null,
  origin,
  onFinished,
}: ProjectMemoryEditorDialogProps) {
  if (!open) return null;
  const originKey =
    origin.type === "message" ? [origin.type, origin.threadId, origin.messageId] : [origin.type];
  const scopeKey = JSON.stringify([environmentId, projectId, memoryId, originKey]);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <ProjectMemoryEditorInner
          key={scopeKey}
          environmentId={environmentId}
          projectId={projectId}
          memoryId={memoryId}
          draft={draft}
          origin={origin}
          {...(onFinished === undefined ? {} : { onFinished })}
          onClose={() => onOpenChange(false)}
        />
      </DialogPopup>
    </Dialog>
  );
}

/** The versioned content a write is based on. Installed as one unit. */
interface EditorSeed {
  readonly fields: MemoryDraft;
  readonly version: number;
}

interface ProjectMemoryEditorInnerProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly memoryId: ProjectMemoryId | null;
  readonly draft: MemoryDraft | null;
  readonly origin: ProjectMemoryOrigin;
  readonly onFinished?: () => void;
  readonly onClose: () => void;
}

/**
 * One editor instance per scope key (see the dialog above): the key remount
 * guarantees everything rendered or written here belongs to exactly this
 * environment, project, memory and origin, and the unmount guard drops
 * in-flight write results when the instance goes away.
 */
function ProjectMemoryEditorInner({
  environmentId,
  projectId,
  memoryId,
  draft,
  origin,
  onFinished,
  onClose,
}: ProjectMemoryEditorInnerProps) {
  const createMemory = useAtomCommand(projectMemory.create, { reportFailure: false });
  const updateMemory = useAtomCommand(projectMemory.update, { reportFailure: false });
  const deleteMemory = useAtomCommand(projectMemory.delete, { reportFailure: false });
  const revalidateScope = useAtomCommand(projectMemory.revalidate, { reportFailure: false });
  const operateAccess = useProjectMemoryOperateAccess(environmentId);
  const writeLock = resolveMemoryWriteLock(operateAccess);

  const detailAtom =
    memoryId !== null ? projectMemory.get({ environmentId, input: { projectId, memoryId } }) : null;
  const detail = useEnvironmentQuery(detailAtom);
  const detailRaw = useAtomValue(detailAtom ?? EMPTY_DETAIL_RESULT);

  // The seed is the versioned content writes are based on; fields and version
  // always install together, so a write can never pair a new draft with an old
  // version. Creates start from the caller's draft with no version.
  const [seed, setSeed] = useState<EditorSeed | null>(
    memoryId !== null ? null : { fields: draft ?? EMPTY_DRAFT, version: 0 },
  );
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  // Set by "Load current version": invalidates the old version for writes and
  // stays set until the fetched fields and version install together. Pending,
  // failure and NotFound never release it.
  const [loadingCurrent, setLoadingCurrent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const dirtyRef = useRef(false);
  // In-flight write results must not touch anything after this instance
  // unmounts (close or scope change).
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const memory = detail.data?.memory;
    if (detail.error !== null) {
      // A failed read can still carry a previous success; never seed from it.
      // A load intent that ends in failure releases the intent flag so "Load
      // current version" becomes the retry again — the write gate itself
      // stays closed through loadFailure.
      if (loadingCurrent) setLoadingCurrent(false);
      return;
    }
    if (!memory || detail.isPending) return;
    if (loadingCurrent) {
      // Load intent is fulfilled only by a fresh eligible response: the exact
      // memory of this editor at the recorded conflict version or newer. A
      // cached pre-write read (the revalidate has not replaced it yet, or the
      // command failed without touching the query) and any late stale response
      // must not consume the intent — the gate and the draft stay untouched.
      const matchesScope = memory.memoryId === memoryId && memory.projectId === projectId;
      const freshEnough = conflictVersion !== null && memory.version >= conflictVersion;
      if (!matchesScope || !freshEnough) return;
      dirtyRef.current = false;
      setSeed({ fields: draftFromMemory(memory), version: memory.version });
      setConflictVersion(null);
      setLoadingCurrent(false);
      return;
    }
    if (dirtyRef.current) return;
    setSeed({ fields: draftFromMemory(memory), version: memory.version });
  }, [
    conflictVersion,
    detail.data,
    detail.error,
    detail.isPending,
    loadingCurrent,
    memoryId,
    projectId,
  ]);

  const update = (patch: Partial<MemoryDraft>) => {
    dirtyRef.current = true;
    setSeed((current) =>
      current === null ? current : { ...current, fields: { ...current.fields, ...patch } },
    );
  };

  const finish = (notice: string) => {
    toastManager.add({ type: "success", title: notice });
    onFinished?.();
    onClose();
  };

  const fail = (cause: unknown) => {
    // Memory RPC failures carry fixed server messages; raw content is never
    // echoed back, including for the sensitive-reason rejection.
    setError(cause instanceof Error ? cause.message : "The memory request failed.");
  };

  // Load failures are reported as themselves; only the typed NotFound may
  // claim the memory is gone, and it renders without any retrieved content.
  const loadFailure = memoryId !== null && detail.error !== null ? detail.error : null;
  const notFound =
    loadFailure !== null && isMemoryError(readFailure(detailRaw), "ProjectMemoryNotFoundError");

  // Writes are admitted only on a settled, unconflicted, loaded seed for this
  // exact memory — or for creates, on the draft — and never while an access
  // check is pending or denied. The handlers below enforce the same gate, so
  // the disabled buttons are not the only guard.
  const writesAdmitted =
    !saving &&
    seed !== null &&
    writeLock === null &&
    (memoryId === null ||
      (!loadingCurrent && conflictVersion === null && loadFailure === null && !detail.isPending));

  const settleWrite = (result: AtomCommandResult<ProjectMemoryWriteResult, unknown>) => {
    if (!liveRef.current) return;
    if (result._tag === "Success") {
      finish(memoryId !== null ? "Memory updated" : "Saved to project memory");
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    if (isMemoryError(cause, "ProjectMemoryConflictError")) {
      // Another version exists. Keep the draft, pull the current memory for
      // review, and keep writes gated until the fetched version installs.
      setConflictVersion(readVersion(cause));
      void revalidateScope({ environmentId, input: { projectId } });
      return;
    }
    fail(cause);
  };

  // "Load current version": install an already-fresh detail directly, or start
  // a revalidate and wait for the fresh eligible response. A failed command
  // keeps the draft and the conflict gate, surfaces a fixed error, and leaves
  // the button available as the retry.
  const loadCurrent = async () => {
    if (loadingCurrent || conflictVersion === null) return;
    const memory = detail.data?.memory;
    if (
      !detail.isPending &&
      detail.error === null &&
      memory !== undefined &&
      memory.memoryId === memoryId &&
      memory.projectId === projectId &&
      memory.version >= conflictVersion
    ) {
      dirtyRef.current = false;
      setSeed({ fields: draftFromMemory(memory), version: memory.version });
      setConflictVersion(null);
      return;
    }
    setLoadingCurrent(true);
    setError(null);
    const retry = () => {
      if (liveRef.current) {
        setLoadingCurrent(false);
        setError("Could not load the current version. Try again.");
      }
    };
    try {
      const result = await revalidateScope({ environmentId, input: { projectId } });
      if (liveRef.current && result._tag !== "Success") retry();
    } catch {
      retry();
    }
  };

  const save = async () => {
    if (seed === null || saving || !writesAdmitted) return;
    const title = seed.fields.title.trim();
    const body = seed.fields.body.trim();
    if (title === "" || body === "") {
      setError("Title and body must not be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (memoryId !== null) {
        settleWrite(
          await updateMemory({
            environmentId,
            input: {
              projectId,
              memoryId,
              expectedVersion: seed.version,
              title,
              body,
              kind: seed.fields.kind,
              validUntil: seed.fields.validUntilIso,
            },
          }),
        );
      } else {
        settleWrite(
          await createMemory({
            environmentId,
            input: {
              projectId,
              kind: seed.fields.kind,
              title,
              body,
              origin,
              ...(seed.fields.validUntilIso === null
                ? {}
                : { validUntil: seed.fields.validUntilIso }),
            },
          }),
        );
      }
    } finally {
      if (liveRef.current) setSaving(false);
    }
  };

  const remove = async () => {
    if (memoryId === null || seed === null || saving || !writesAdmitted) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await deleteMemory({
        environmentId,
        input: { projectId, memoryId, expectedVersion: seed.version },
      });
      if (!liveRef.current) return;
      if (result._tag === "Success") {
        finish("Memory deleted");
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      if (isMemoryError(cause, "ProjectMemoryConflictError")) {
        setConflictVersion(readVersion(cause));
        void revalidateScope({ environmentId, input: { projectId } });
        return;
      }
      fail(cause);
      setDeleteArmed(false);
    } finally {
      if (liveRef.current) setSaving(false);
    }
  };

  if (notFound || (seed === null && loadFailure !== null)) {
    // Nothing retrieved can be shown: either the memory is gone, or its
    // content never loaded. Report which, and nothing else.
    return (
      <>
        <DialogHeader>
          <DialogTitle>Project memory</DialogTitle>
          <DialogDescription>
            {notFound
              ? "This memory no longer exists."
              : "The memory could not be loaded. Check the connection and try again."}
          </DialogDescription>
        </DialogHeader>
        {notFound ? null : <p className="text-sm text-destructive">{loadFailure}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }
  if (seed === null) {
    return (
      <DialogHeader>
        <DialogTitle>Project memory</DialogTitle>
        <DialogDescription>Loading…</DialogDescription>
      </DialogHeader>
    );
  }
  const { fields } = seed;
  const tokens = estimateMemoryTokens(fields);
  const expired =
    fields.validUntilIso !== null && new Date(fields.validUntilIso).getTime() < Date.now();

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {memoryId !== null ? "Edit project memory" : "New project memory"}
        </DialogTitle>
        <DialogDescription>
          Stored for this project only. Memories are not sent to the AI automatically.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        {loadFailure !== null ? (
          <Alert variant="warning">
            <AlertDescription>{loadFailure}</AlertDescription>
          </Alert>
        ) : null}
        {conflictVersion !== null ? (
          <div className="grid gap-2">
            <Alert variant="warning">
              <AlertDescription>
                {loadingCurrent
                  ? "Loading the current version…"
                  : `This memory changed since you loaded it (current version v${conflictVersion}). Your draft is kept — load the current version to continue, or discard your changes.`}
              </AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={loadingCurrent || detail.isPending}
                onClick={() => void loadCurrent()}
              >
                Load current version
              </Button>
              <Button size="sm" variant="ghost" onClick={onClose}>
                Discard changes
              </Button>
            </div>
          </div>
        ) : null}
        <Input
          aria-label="Memory title"
          placeholder="Title"
          value={fields.title}
          maxLength={200}
          onChange={(event) => update({ title: event.currentTarget.value })}
        />
        <Textarea
          aria-label="Memory body"
          placeholder="What should this project remember?"
          value={fields.body}
          maxLength={8000}
          rows={6}
          onChange={(event) => update({ body: event.currentTarget.value })}
        />
        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup
            aria-label="Memory kind"
            variant="segmented"
            value={[fields.kind]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "fact" || value === "procedure" || value === "work-log") {
                update({ kind: value });
              }
            }}
          >
            {KIND_OPTIONS.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <span className="text-xs text-muted-foreground">≈{tokens} tokens (rough estimate)</span>
        </div>
        <label className="grid gap-1 text-sm text-muted-foreground">
          Expires (optional)
          <Input
            type="datetime-local"
            aria-label="Memory expiry"
            value={fields.validUntilIso === null ? "" : isoToLocalInput(fields.validUntilIso)}
            onChange={(event) =>
              update({ validUntilIso: localInputToIso(event.currentTarget.value) })
            }
          />
          {expired ? <span className="text-xs text-destructive">Already expired.</span> : null}
        </label>
        {origin.type === "message" ? (
          <p className="text-xs text-muted-foreground">
            Saved from a chat message. Deleting this memory does not delete the message.
          </p>
        ) : null}
        {writeLock !== null ? <p className="text-xs text-muted-foreground">{writeLock}</p> : null}
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
      <DialogFooter>
        {memoryId !== null ? (
          <Button
            variant="destructive-outline"
            size="sm"
            disabled={!writesAdmitted}
            onClick={() => void remove()}
          >
            <Trash2Icon />
            {deleteArmed ? "Confirm delete" : "Delete"}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={!writesAdmitted} onClick={() => void save()}>
          {memoryId !== null ? "Save changes" : "Save memory"}
        </Button>
      </DialogFooter>
    </>
  );
}

function readVersion(cause: unknown): number | null {
  if (typeof cause === "object" && cause !== null && "currentVersion" in cause) {
    const version = (cause as { currentVersion?: unknown }).currentVersion;
    return typeof version === "number" ? version : null;
  }
  return null;
}

/** Environment+project scoped memory management. Hidden without `manage`. */
export function ProjectMemorySection({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  if (config?.environment.capabilities.projectMemory?.manage !== true) return null;
  return <ProjectMemorySectionInner environmentId={environmentId} projectId={projectId} />;
}

function ProjectMemorySectionInner({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const operateAccess = useProjectMemoryOperateAccess(environmentId);
  const writeLock = resolveMemoryWriteLock(operateAccess);
  const [searchInput, setSearchInput] = useState("");
  const [editingId, setEditingId] = useState<ProjectMemoryId | null>(null);
  const [creating, setCreating] = useState(false);
  const search = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);
  const trimmed = search.trim();

  // Memories are isolated per environment+project; a scope switch starts clean
  // so no pending fetch or selected detail from the old project can show.
  useEffect(() => {
    setSearchInput("");
    setEditingId(null);
    setCreating(false);
  }, [environmentId, projectId]);

  const results = useEnvironmentQuery(
    trimmed === ""
      ? projectMemory.list({
          environmentId,
          input: { projectId, limit: PROJECT_MEMORY_MAX_LIMIT },
        })
      : projectMemory.search({
          environmentId,
          input: { projectId, query: search, limit: PROJECT_MEMORY_MAX_LIMIT },
        }),
  );
  // Every pending read reports no value, so a memory another client deleted
  // (or this client just removed) cannot linger in the list while its
  // replacement loads.
  const items = results.data?.items ?? [];

  return (
    <SettingsSection title="Project memory">
      <SettingsRow
        title="Project memory"
        description="Stored for this project on the connected environment. Memories are not sent to the AI automatically, and deleting one never deletes the chat message it was saved from."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={writeLock !== null}
            title={writeLock ?? undefined}
            onClick={() => setCreating(true)}
          >
            <PlusIcon />
            New memory
          </Button>
        }
      />
      <div className="flex flex-col gap-2 px-6">
        {writeLock !== null ? <p className="text-xs text-muted-foreground">{writeLock}</p> : null}
        <Input
          size="sm"
          aria-label="Search project memories"
          placeholder="Search memories"
          value={searchInput}
          onChange={(event) => setSearchInput(event.currentTarget.value)}
        />
        {results.error !== null ? (
          <p className="text-sm text-destructive">{results.error}</p>
        ) : null}
        {!results.isPending && items.length === 0 && results.error === null ? (
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <SearchIcon className="size-4" aria-hidden />
            {trimmed === "" ? "No memories yet." : "No memories match this search."}
          </p>
        ) : null}
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.memoryId}>
              <button
                type="button"
                onClick={() => setEditingId(item.memoryId)}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {item.title}
                </span>
                <Badge variant="outline" size="sm">
                  {KIND_LABEL[item.kind]}
                </Badge>
                <span className="shrink-0 text-xs text-muted-foreground">v{item.version}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  ≈{item.estimatedTokens} tok
                </span>
              </button>
            </li>
          ))}
        </ul>
        {results.data?.truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing the first {PROJECT_MEMORY_MAX_LIMIT} — refine the search to see more.
          </p>
        ) : null}
      </div>
      {creating || editingId !== null ? (
        <ProjectMemoryEditorDialog
          open
          environmentId={environmentId}
          projectId={projectId}
          memoryId={editingId}
          origin={{ type: "manual" }}
          onOpenChange={(next) => {
            if (!next) {
              setCreating(false);
              setEditingId(null);
            }
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
