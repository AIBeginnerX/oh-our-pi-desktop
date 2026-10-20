import type {
  AuthSessionState,
  EnvironmentId,
  ProjectId,
  ProjectSkillCandidateSourceIdentity,
  ProjectSkillContent,
  ProjectSkillDetail,
  ProjectSkillEvidenceId,
  ProjectSkillId,
  ProjectSkillJudgmentId,
  ProjectSkillSource,
  ProjectSkillSummary,
  ProjectSkillVersionRef,
  ProjectSkillVersionState,
  ProjectSkillVersionView,
  ProjectSkillStoreRejectReason,
  ThreadId,
} from "@t3tools/contracts";
import {
  AuthOrchestrationOperateScope,
  PROJECT_SKILL_LIST_LIMIT,
  PROJECT_SKILL_LIMITS,
  SELECTED_CHECK_MAX,
  type ProjectScript,
  type RecordableProjectSkillJudgment,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionCatalogEntry,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { SelectedChecksView } from "@t3tools/client-runtime/state/selected-checks-control";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { environmentCatalog } from "../../connection/catalog";
import {
  readProject,
  readThreadShell,
  useProject,
  useThreadShellsForProjectRefs,
} from "../../state/entities";
import { projectSkills } from "../../state/projectSkills";
import { useEnvironmentQuery } from "../../state/query";
import {
  selectedChecksSessionConfirmation,
  type SelectedChecksConfirmationOutcome,
} from "../../state/selectedChecks";
import { environmentSession } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjectMemoryOperateAccess } from "./ProjectMemorySection";
import {
  CANDIDATE_DERIVE_OPTION_COPY,
  CANDIDATE_NOTICE,
  CANDIDATE_PROCEDURE_UNTRUSTED_COPY,
  deleteOutcomeCopy,
  derivedSourceProvenanceLines,
  DERIVE_UNAVAILABLE_COPY,
  derivationTruncationNotice,
  EMPTY_SKILL_CONTENT,
  isTaggedError,
  mergeDerivePartialIntoForm,
  projectSkillGeneratedDraftCapabilityOf,
  judgmentSummary,
  JUDGMENT_KIND_LABEL,
  sameProjectSkillVersionRef,
  SKILL_AUTHORIZATION_COPY,
  type SkillContentForm,
  type SkillJudgmentForm,
  type SkillSourceTuple,
  skillRejectionCopy,
  resolveSkillWriteLock,
  RIGHTS_BASES,
  RIGHTS_BASIS_LABEL,
  sameSkillSource,
  skillSourceFromChecks,
  type SkillRightsBasis,
  successCheckPrefill,
  toRecordableJudgment,
  toSkillContent,
  versionTrialHistoryPanel,
  VERSION_TRIAL_HISTORY_EMPTY_COPY,
  VERSION_TRIAL_HISTORY_TITLE,
  VERSION_TRIAL_HISTORY_UNAVAILABLE_COPY,
  projectSkillTrialCapabilityOf,
  withdrawOutcomeCopy,
  evidenceOfferForSelectValue,
  findTrialEvidenceOffer,
  freezeProjectScriptBindings,
  freezeSelectedScriptIds,
  freezeTrialEvidenceChoice,
  type FrozenTrialEvidenceChoice,
  LIFECYCLE_ACTIVATE_SUCCESS,
  LIFECYCLE_JUDGMENT_INVALID_COPY,
  LIFECYCLE_NON_APPLICATION_RECORDED,
  LIFECYCLE_REPRODUCTION_RECORDED,
  LIFECYCLE_RESTORE_SUCCESS,
  LIFECYCLE_RETIRE_SUCCESS,
  LIFECYCLE_SCOPE_DRIFT_COPY,
  LIFECYCLE_SCRIPTS_INVALID_COPY,
  LIFECYCLE_STATE_UNKNOWN_COPY,
  LIFECYCLE_THREAD_REQUIRED_COPY,
  LIFECYCLE_UNSUPPORTED_COPY,
  LIFECYCLE_USE_UNAVAILABLE_COPY,
  lifecycleActivateOperationStillValid,
  lifecycleRetireOperationStillValid,
  type LifecycleTargetSelection,
  nonApplicationEvidenceOffers,
  projectSkillLifecycleCapabilityOf,
  projectSkillUseCapabilityOf,
  projectSkillStateSeqOf,
  reproductionEvidenceOffers,
  skillLifecycleRejectionNeedsRefetch,
  trialEvidenceChoiceStillValid,
  type SkillNonApplicationForm,
  type SkillReproductionForm,
  toRecordableNonApplication,
  toRecordableReproduction,
  type SkillTrialEvidenceOffer,
  versionViewForRef,
} from "./ProjectSkillsSection.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const VERSION_STATE_LABEL: Record<ProjectSkillVersionState, string> = {
  candidate: "Candidate · inactive",
  active: "Active",
  retired: "Retired",
};

const SOURCE_INVALID_COPY =
  "This source is no longer current. Run the checks again and save from the new record.";
const SKILL_UNSUPPORTED_COPY = "This server does not support skill candidates.";
const CONFIRM_FAILED_COPY = "Your access could not be confirmed right now. Try again.";
const CONTENT_INVALID_COPY = "All six fields are required and must fit their length limits.";
const JUDGMENT_INVALID_COPY =
  "Select a basis (or check all three review boxes) and add a note within the limits.";
const VERSION_GONE_COPY =
  "That version changed on the server. The view has been refreshed — review and try again.";
const LOAD_FAILED_COPY = "Could not load the current version. Try again.";
const JUDGMENT_NOTICE =
  "Recorded by an authenticated connection — not a human or legal verification.";

function formatSkillInstant(value: string | null): string {
  if (value === null) return "time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unavailable" : date.toLocaleString();
}

/** Fresh capability read for action boundaries — a rendered boolean is not. */
export function readManageCapability(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): boolean {
  const config = registry.get(serverEnvironment.configValueAtom(environmentId));
  return config?.environment.capabilities.projectSkills?.manage === true;
}

export function readGeneratedDraftCapability(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): boolean {
  const config = registry.get(serverEnvironment.configValueAtom(environmentId));
  return projectSkillGeneratedDraftCapabilityOf(config);
}

export function readLifecycleCapability(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): boolean {
  const config = registry.get(serverEnvironment.configValueAtom(environmentId));
  return projectSkillLifecycleCapabilityOf(config);
}

export function readUseCapability(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): boolean {
  const config = registry.get(serverEnvironment.configValueAtom(environmentId));
  return projectSkillUseCapabilityOf(config);
}

/** Registry-fresh resolved scripts for lifecycle target validation. */
function readResolvedProjectScriptsForProject(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): ReadonlyArray<ProjectScript> {
  const project = readProject({ environmentId, projectId });
  if (project === null) return [];
  const settings = registry.get(serverEnvironment.settingsValueAtom(environmentId));
  if (settings === null) return [];
  return [...resolveProjectScripts(settings, project)];
}

interface ConnectionStamp {
  readonly entry: ConnectionCatalogEntry;
  readonly generation: number;
  readonly prepared: PreparedConnection;
}

/** The exact connection identity a settings write confirms against. */
function readConnectionStamp(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): ConnectionStamp | null {
  const entry =
    registry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId) ?? null;
  const connection = Option.getOrElse(
    AsyncResult.value(registry.get(environmentCatalog.stateAtom(environmentId))),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const prepared = Option.getOrNull(
    registry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  if (entry === null || connection.phase !== "connected" || prepared === null) return null;
  return { entry, generation: connection.generation, prepared };
}

function connectionStampMatches(before: ConnectionStamp, after: ConnectionStamp | null): boolean {
  return (
    after !== null &&
    after.entry === before.entry &&
    after.prepared === before.prepared &&
    after.generation === before.generation
  );
}

/**
 * Registry-fresh authority before applying a derive result or treating a
 * derived save as still valid — same connection stamp, source tuple, manage,
 * permission, and generatedDraft capability.
 */
function candidateDeriveAuthorityProblem(
  readCurrentSource: () => CurrentChecksSource | null,
  registry: AtomRegistry.AtomRegistry,
  source: FrozenSkillSource,
  stampBefore: ConnectionStamp,
): string | null {
  const current = readCurrentSource();
  if (current === null || current.projectId !== source.projectId) return SOURCE_INVALID_COPY;
  const problem = candidateSourceProblem(readCurrentSource, registry, source, {
    view: current.view,
    permission: current.permission,
    manage: readManageCapability(registry, source.environmentId),
  });
  if (problem !== null) return problem;
  if (!readGeneratedDraftCapability(registry, source.environmentId)) {
    return SKILL_UNSUPPORTED_COPY;
  }
  if (!connectionStampMatches(stampBefore, readConnectionStamp(registry, source.environmentId))) {
    return CONFIRM_FAILED_COPY;
  }
  return null;
}

function sessionHasOperateScope(session: AuthSessionState): boolean {
  return (
    session.authenticated === true &&
    session.scopes !== undefined &&
    session.scopes.includes(AuthOrchestrationOperateScope)
  );
}

/**
 * Per-dialog synchronous write lock. `saving` state alone lets two handlers
 * run before React commits; `begin` returns one invocation id or null, and
 * late results must confirm both mounted status and invocation identity via
 * `isCurrent` before touching state.
 */
function useDialogWriteLock() {
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);
  const busyRef = useRef(false);
  const seqRef = useRef(0);
  const begin = () => {
    if (busyRef.current) return null;
    busyRef.current = true;
    return ++seqRef.current;
  };
  const end = (invocation: number) => {
    if (seqRef.current === invocation) busyRef.current = false;
  };
  const isCurrent = (invocation: number) => liveRef.current && seqRef.current === invocation;
  return { liveRef, begin, end, isCurrent };
}

/** State with a synchronous mirror for handler-time gates. */
function useMirrored<T>(initial: T) {
  const [value, setValue] = useState<T>(initial);
  const ref = useRef(value);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, set, ref] as const;
}

function contentToForm(content: ProjectSkillContent): SkillContentForm {
  return {
    title: content.title,
    purpose: content.purpose,
    appliesWhen: content.appliesWhen,
    doesNotApplyWhen: content.doesNotApplyWhen,
    procedure: content.procedure,
    successCheck: content.successCheck,
  };
}

const CONTENT_FIELDS: ReadonlyArray<{
  key: keyof SkillContentForm;
  label: string;
  rows: number;
}> = [
  { key: "title", label: "Title", rows: 1 },
  { key: "purpose", label: "Purpose", rows: 2 },
  { key: "appliesWhen", label: "Applies when", rows: 2 },
  { key: "doesNotApplyWhen", label: "Does not apply when", rows: 2 },
  { key: "procedure", label: "Procedure", rows: 8 },
  { key: "successCheck", label: "Success check", rows: 2 },
];

function SkillContentFields({
  value,
  onChange,
  disabled,
}: {
  readonly value: SkillContentForm;
  readonly onChange: (key: keyof SkillContentForm, next: string) => void;
  readonly disabled: boolean;
}) {
  return (
    <>
      {CONTENT_FIELDS.map((field) => (
        <label key={field.key} className="grid gap-1 text-sm">
          {field.label}
          <Textarea
            aria-label={`Skill ${field.label}`}
            rows={field.rows}
            value={value[field.key]}
            maxLength={PROJECT_SKILL_LIMITS[field.key]}
            disabled={disabled}
            onChange={(event) => onChange(field.key, event.currentTarget.value)}
          />
        </label>
      ))}
    </>
  );
}

// ── Create dialog (chat → Checks panel) ───────────────────────────────────

/** The source frozen when the candidate dialog opens; never retargeted. */
export interface FrozenSkillSource {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly expected: SkillSourceTuple;
  readonly checkNames: ReadonlyArray<string>;
}

/** The agreed narrow read over the selected-checks hook's current authority. */
export interface CurrentChecksSource {
  readonly view: SelectedChecksView;
  readonly permission: "allowed" | "read-only" | "unknown";
  readonly projectId: ProjectId;
}

export const skillCandidateScopeKey = (source: FrozenSkillSource): string =>
  JSON.stringify([source.environmentId, source.projectId, source.threadId, source.expected]);

/**
 * The frozen source is compared against a fresh read at open and again at
 * submit; the panel's controller stays open underneath (the header only hides
 * it), so its focus and connection observation keep the authority current.
 * `reactive` carries the panel's current view/permission/capability so the
 * display gate reflects loss and recovery while the dialog stays open — the
 * fresh reader remains the only save authority either way.
 */
function candidateSourceProblem(
  readCurrentSource: () => CurrentChecksSource | null,
  registry: AtomRegistry.AtomRegistry,
  source: FrozenSkillSource,
  reactive: {
    readonly view: SelectedChecksView | null;
    readonly permission: CurrentChecksSource["permission"] | null;
    readonly manage: boolean | null;
  } = { view: null, permission: null, manage: null },
): string | null {
  if (reactive.manage === false) return SKILL_UNSUPPORTED_COPY;
  if (reactive.permission === "read-only") return SKILL_AUTHORIZATION_COPY;
  if (reactive.view !== null && reactive.view.headline !== "passed") {
    return SOURCE_INVALID_COPY;
  }
  const manage = readManageCapability(registry, source.environmentId);
  if (!manage) return SKILL_UNSUPPORTED_COPY;
  const current = readCurrentSource();
  if (current === null || current.projectId !== source.projectId) return SOURCE_INVALID_COPY;
  const fresh = skillSourceFromChecks({
    view: current.view,
    permission: current.permission,
    manage,
  });
  if (fresh === null || !sameSkillSource(fresh, source.expected)) return SOURCE_INVALID_COPY;
  return null;
}

export function ProjectSkillCandidateDialog({
  source,
  readCurrentSource,
  onClose,
  view = null,
  permission = null,
  manage = null,
  onAuthorizationRejected = null,
}: {
  readonly source: FrozenSkillSource;
  readonly readCurrentSource: () => CurrentChecksSource | null;
  readonly onClose: () => void;
  readonly view?: SelectedChecksView | null;
  readonly permission?: CurrentChecksSource["permission"] | null;
  readonly manage?: boolean | null;
  readonly onAuthorizationRejected?: (() => void) | null;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <ProjectSkillCandidateInner
          key={skillCandidateScopeKey(source)}
          source={source}
          readCurrentSource={readCurrentSource}
          onClose={onClose}
          view={view}
          permission={permission}
          manage={manage}
          onAuthorizationRejected={onAuthorizationRejected}
        />
      </DialogPopup>
    </Dialog>
  );
}

function ProjectSkillCandidateInner({
  source,
  readCurrentSource,
  onClose,
  view,
  permission,
  manage,
  onAuthorizationRejected,
}: {
  readonly source: FrozenSkillSource;
  readonly readCurrentSource: () => CurrentChecksSource | null;
  readonly onClose: () => void;
  readonly view: SelectedChecksView | null;
  readonly permission: CurrentChecksSource["permission"] | null;
  readonly manage: boolean | null;
  readonly onAuthorizationRejected: (() => void) | null;
}) {
  const registry = useContext(RegistryContext);
  const createCandidate = useAtomCommand(projectSkills.createCandidate, { reportFailure: false });
  const deriveDraft = useAtomCommand(projectSkills.deriveDraft, { reportFailure: false });
  const lock = useDialogWriteLock();
  const successPrefill = successCheckPrefill(source.checkNames);
  const [fields, setFields] = useState<SkillContentForm>({
    ...EMPTY_SKILL_CONTENT,
    successCheck: successPrefill,
  });
  const touchedRef = useRef<Set<keyof SkillContentForm>>(new Set());
  const [derivedPin, setDerivedPin] = useState<ProjectSkillCandidateSourceIdentity | null>(null);
  const [deriveNotice, setDeriveNotice] = useState<string | null>(null);
  const [truncationNotice, setTruncationNotice] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceProblem, setSourceProblem] = useState<string | null>(null);
  const [generatedDraftCap, setGeneratedDraftCap] = useState(() =>
    readGeneratedDraftCapability(registry, source.environmentId),
  );

  useEffect(() => {
    setSourceProblem(
      candidateSourceProblem(readCurrentSource, registry, source, { view, permission, manage }),
    );
    setGeneratedDraftCap(readGeneratedDraftCapability(registry, source.environmentId));
    // The fresh hook keeps readCurrentSource stable across ordinary panel
    // updates, so the reactive observations below are what re-run this gate —
    // invalidation disables saving and later recovery clears the problem
    // without touching the frozen tuple or the draft.
  }, [readCurrentSource, registry, source, view, permission, manage]);

  const update = (key: keyof SkillContentForm, next: string) => {
    touchedRef.current.add(key);
    setFields((current) => ({ ...current, [key]: next }));
  };

  const deriveDisabled =
    deriving || saving || sourceProblem !== null || derivedPin !== null || !generatedDraftCap;

  const runDerive = async () => {
    if (deriveDisabled) return;
    const invocation = lock.begin();
    if (invocation === null) return;
    setDeriving(true);
    setError(null);
    setDeriveNotice(null);
    setTruncationNotice(null);
    try {
      const problem = candidateSourceProblem(readCurrentSource, registry, source, {
        view,
        permission,
        manage,
      });
      if (problem !== null) {
        setSourceProblem(problem);
        return;
      }
      if (!readGeneratedDraftCapability(registry, source.environmentId)) return;
      const stampBefore = readConnectionStamp(registry, source.environmentId);
      if (stampBefore === null) {
        setDeriveNotice(CONFIRM_FAILED_COPY);
        return;
      }
      const result = await deriveDraft({
        environmentId: source.environmentId,
        input: {
          projectId: source.projectId,
          threadId: source.threadId,
          expected: source.expected,
        },
      });
      if (!lock.isCurrent(invocation)) return;
      if (result._tag !== "Success") {
        if (isAtomCommandInterrupted(result)) return;
        const cause = squashAtomCommandFailure(result);
        setError(skillRejectionCopy(cause));
        if (isTaggedError(cause, "EnvironmentAuthorizationError")) {
          onAuthorizationRejected?.();
        }
        return;
      }
      const authorityProblem = candidateDeriveAuthorityProblem(
        readCurrentSource,
        registry,
        source,
        stampBefore,
      );
      if (authorityProblem !== null) {
        setDeriveNotice(authorityProblem);
        return;
      }
      const payload = result.value;
      if (payload.status === "unavailable") {
        setDeriveNotice(DERIVE_UNAVAILABLE_COPY[payload.reason]);
        return;
      }
      setDerivedPin(payload.source);
      setFields((current) =>
        mergeDerivePartialIntoForm(current, payload.partial, touchedRef.current),
      );
      setTruncationNotice(derivationTruncationNotice(payload.truncation));
    } finally {
      lock.end(invocation);
      if (lock.isCurrent(invocation)) setDeriving(false);
    }
  };

  const save = async () => {
    if (saving || sourceProblem !== null) return;
    const invocation = lock.begin();
    if (invocation === null) return;
    setSaving(true);
    setError(null);
    try {
      // The button gate again, registry-fresh: capability, permission, and the
      // frozen tuple against the panel's current authority.
      const problem = candidateSourceProblem(readCurrentSource, registry, source, {
        view,
        permission,
        manage,
      });
      if (problem !== null) {
        setSourceProblem(problem);
        return;
      }
      const derivedStamp =
        derivedPin === null ? null : readConnectionStamp(registry, source.environmentId);
      if (derivedPin !== null) {
        if (!readGeneratedDraftCapability(registry, source.environmentId)) {
          setError(SKILL_UNSUPPORTED_COPY);
          return;
        }
        if (derivedStamp === null) {
          setError(CONFIRM_FAILED_COPY);
          return;
        }
        const derivedAuthority = candidateDeriveAuthorityProblem(
          readCurrentSource,
          registry,
          source,
          derivedStamp,
        );
        if (derivedAuthority !== null) {
          setError(derivedAuthority);
          return;
        }
      }
      const content = toSkillContent(fields);
      if (content === null) {
        setError(CONTENT_INVALID_COPY);
        return;
      }
      const draft =
        derivedPin === null
          ? { type: "typed" as const }
          : {
              type: "derived" as const,
              messageId: derivedPin.assistantMessageId,
              expectedSourceIdentitySha256: derivedPin.wholeSourceSha256,
            };
      const result = await createCandidate({
        environmentId: source.environmentId,
        input: {
          projectId: source.projectId,
          threadId: source.threadId,
          expected: source.expected,
          content,
          draft,
        },
      });
      if (!lock.isCurrent(invocation)) return;
      if (derivedPin !== null && derivedStamp !== null) {
        const derivedAuthority = candidateDeriveAuthorityProblem(
          readCurrentSource,
          registry,
          source,
          derivedStamp,
        );
        if (derivedAuthority !== null) {
          setError(derivedAuthority);
          return;
        }
      }
      if (result._tag === "Success") {
        toastManager.add({ type: "success", title: "Skill candidate saved" });
        onClose();
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      // Rejections keep the draft; every sentence is fixed local copy.
      const cause = squashAtomCommandFailure(result);
      setError(skillRejectionCopy(cause));
      if (isTaggedError(cause, "EnvironmentAuthorizationError")) {
        // The panel may still hold an allowed confirmation for this identity;
        // synchronously invalidate it so the next attempt reconfirms.
        onAuthorizationRejected?.();
      }
    } finally {
      lock.end(invocation);
      if (lock.isCurrent(invocation)) setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>New skill candidate</DialogTitle>
        <DialogDescription>
          {CANDIDATE_NOTICE}
          {generatedDraftCap ? ` ${CANDIDATE_DERIVE_OPTION_COPY}` : null}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="grid gap-1 rounded-md border border-border p-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Pending review</p>
          <p>
            Frozen check receipt · attempt {source.expected.attemptId} · revision{" "}
            {source.expected.revision} · seq {source.expected.receiptSequence}
          </p>
          <p>Selected checks on this receipt · {source.checkNames.join(", ")}</p>
          <p>
            For Draft from accepted work only: passing checks alone does not prove an accepted task
            result — the server binds acceptance for that draft.
          </p>
          {derivedPin !== null ? (
            <div className="grid gap-0.5 border-t border-border pt-2">
              {derivedSourceProvenanceLines(derivedPin).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          ) : null}
        </div>
        {generatedDraftCap ? (
          <Button
            size="sm"
            variant="outline"
            disabled={deriveDisabled}
            onClick={() => void runDerive()}
          >
            {deriving ? "Preparing draft…" : "Draft from accepted work"}
          </Button>
        ) : null}
        {deriveNotice !== null ? (
          <p className="text-sm text-muted-foreground" role="status">
            {deriveNotice}
          </p>
        ) : null}
        {derivedPin !== null ? (
          <p className="text-sm text-muted-foreground">{CANDIDATE_PROCEDURE_UNTRUSTED_COPY}</p>
        ) : null}
        {truncationNotice !== null ? (
          <p className="text-sm text-muted-foreground" role="status">
            {truncationNotice}
          </p>
        ) : null}
        <SkillContentFields value={fields} onChange={update} disabled={saving} />
        {sourceProblem !== null ? (
          <p className="text-sm text-muted-foreground" role="status">
            {sourceProblem}
          </p>
        ) : null}
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={saving || deriving || sourceProblem !== null}
          onClick={() => void save()}
        >
          Save candidate
        </Button>
      </DialogFooter>
    </>
  );
}

// ── Detail dialog (settings) ──────────────────────────────────────────────

/** Versions arrive latest-first; pin the entry the detail's version names. */
function latestVersionView(value: ProjectSkillDetail): ProjectSkillVersionView | null {
  return value.versions.find((entry) => entry.version.ref.version === value.latestVersion) ?? null;
}

function sourceLine(source: ProjectSkillSource): string {
  if (source.type === "revision") return `Revision of v${source.fromVersion}`;
  const names = source.check.planned.map((check) => check.scriptName).join(", ");
  return `From passed checks · recorded ${formatSkillInstant(source.check.endedAt)} · ${names}`;
}

type LifecycleApplyIntent = "activate" | "restore";

function VersionEvidenceJudgmentFields({
  disabled,
  offers,
  evidenceAriaLabel,
  noteAriaLabel,
  observedEvidenceId,
  onObservedEvidenceIdChange,
  note,
  onNoteChange,
  submitLabel,
  onSubmit,
  submitDisabled,
  children,
}: {
  readonly disabled: boolean;
  readonly offers: ReadonlyArray<SkillTrialEvidenceOffer>;
  readonly evidenceAriaLabel: string;
  readonly noteAriaLabel: string;
  readonly observedEvidenceId: ProjectSkillEvidenceId | "";
  readonly onObservedEvidenceIdChange: (id: ProjectSkillEvidenceId | "") => void;
  readonly note: string;
  readonly onNoteChange: (note: string) => void;
  readonly submitLabel: string;
  readonly onSubmit: () => void;
  readonly submitDisabled?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <label className="grid gap-1 text-sm">
        Evidence
        <Select
          value={observedEvidenceId === "" ? null : observedEvidenceId}
          disabled={disabled || offers.length === 0}
          onValueChange={(value) => {
            const offer = evidenceOfferForSelectValue(offers, value ?? "");
            onObservedEvidenceIdChange(offer?.evidenceId ?? "");
          }}
        >
          <SelectTrigger aria-label={evidenceAriaLabel} size="sm" className="w-full">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectPopup>
            {offers.map((offer) => (
              <SelectItem key={offer.evidenceId} value={offer.evidenceId}>
                {offer.evidenceId} · seq {offer.trial.inputEventSequence}
                {offer.observation.outcome === "all-selected-passed"
                  ? " · passed"
                  : ` · ${offer.observation.outcome}`}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
      {children}
      <Textarea
        aria-label={noteAriaLabel}
        placeholder="Note"
        rows={2}
        value={note}
        maxLength={PROJECT_SKILL_LIMITS.note}
        disabled={disabled}
        onChange={(event) => onNoteChange(event.currentTarget.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || submitDisabled === true || offers.length === 0}
        onClick={onSubmit}
      >
        {submitLabel}
      </Button>
    </div>
  );
}

function VersionReproductionJudgmentForm({
  disabled,
  offers,
  onRecord,
}: {
  readonly disabled: boolean;
  readonly offers: ReturnType<typeof reproductionEvidenceOffers>;
  readonly onRecord: (
    form: SkillReproductionForm,
    readObservedEvidenceId: () => SkillReproductionForm["observedEvidenceId"],
  ) => void;
}) {
  const [observedEvidenceId, setObservedEvidenceId, observedEvidenceIdRef] =
    useMirrored<SkillReproductionForm["observedEvidenceId"]>("");
  const [procedureApplied, setProcedureApplied] = useState(false);
  const [successConditionConfirmed, setSuccessConditionConfirmed] = useState(false);
  const [taskNotUsedForAuthoring, setTaskNotUsedForAuthoring] = useState(false);
  const [note, setNote] = useState("");
  const form: SkillReproductionForm = {
    observedEvidenceId,
    procedureApplied,
    successConditionConfirmed,
    taskNotUsedForAuthoring,
    note,
  };
  return (
    <VersionEvidenceJudgmentFields
      disabled={disabled}
      offers={offers}
      evidenceAriaLabel="Reproduction evidence"
      noteAriaLabel="Reproduction note"
      observedEvidenceId={observedEvidenceId}
      onObservedEvidenceIdChange={setObservedEvidenceId}
      note={note}
      onNoteChange={setNote}
      submitLabel="Record reproduction judgment"
      onSubmit={() => onRecord(form, () => observedEvidenceIdRef.current)}
    >
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={procedureApplied}
          disabled={disabled}
          onCheckedChange={(checked) => setProcedureApplied(checked === true)}
        />
        <span>Procedure applied on a separate task</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={successConditionConfirmed}
          disabled={disabled}
          onCheckedChange={(checked) => setSuccessConditionConfirmed(checked === true)}
        />
        <span>Success condition confirmed</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={taskNotUsedForAuthoring}
          disabled={disabled}
          onCheckedChange={(checked) => setTaskNotUsedForAuthoring(checked === true)}
        />
        <span>Task was not used to author this procedure</span>
      </label>
    </VersionEvidenceJudgmentFields>
  );
}

function VersionNonApplicationJudgmentForm({
  disabled,
  offers,
  onRecord,
}: {
  readonly disabled: boolean;
  readonly offers: ReturnType<typeof nonApplicationEvidenceOffers>;
  readonly onRecord: (
    form: SkillNonApplicationForm,
    readObservedEvidenceId: () => SkillNonApplicationForm["observedEvidenceId"],
  ) => void;
}) {
  const [observedEvidenceId, setObservedEvidenceId, observedEvidenceIdRef] =
    useMirrored<SkillNonApplicationForm["observedEvidenceId"]>("");
  const [taskDescription, setTaskDescription] = useState("");
  const [verdict, setVerdict] = useState<SkillNonApplicationForm["verdict"]>("");
  const [note, setNote] = useState("");
  const form: SkillNonApplicationForm = {
    observedEvidenceId,
    taskDescription,
    verdict,
    note,
  };
  return (
    <VersionEvidenceJudgmentFields
      disabled={disabled}
      offers={offers}
      evidenceAriaLabel="Non-application evidence"
      noteAriaLabel="Non-application note"
      observedEvidenceId={observedEvidenceId}
      onObservedEvidenceIdChange={setObservedEvidenceId}
      note={note}
      onNoteChange={setNote}
      submitLabel="Record non-application judgment"
      onSubmit={() => onRecord(form, () => observedEvidenceIdRef.current)}
    >
      <Textarea
        aria-label="Task description"
        placeholder="Task where the procedure did not apply"
        rows={2}
        value={taskDescription}
        disabled={disabled}
        onChange={(event) => setTaskDescription(event.currentTarget.value)}
      />
      <ToggleGroup
        aria-label="Non-application verdict"
        variant="segmented"
        value={verdict === "" ? [] : [verdict]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "correctly-not-applied" || value === "harmful") setVerdict(value);
        }}
      >
        <Toggle value="correctly-not-applied">Correctly not applied</Toggle>
        <Toggle value="harmful">Harmful</Toggle>
      </ToggleGroup>
    </VersionEvidenceJudgmentFields>
  );
}

function VersionLifecycleControls({
  view,
  disabled,
  useCapability,
  projectThreads,
  scripts,
  onApplyLifecycle,
  onRetire,
}: {
  readonly view: ProjectSkillVersionView;
  readonly disabled: boolean;
  readonly useCapability: boolean;
  readonly projectThreads: ReadonlyArray<{ readonly threadId: ThreadId; readonly title: string }>;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly onApplyLifecycle: (
    ref: ProjectSkillVersionRef,
    target: LifecycleTargetSelection,
    readLiveTarget: () => LifecycleTargetSelection | null,
    intent: LifecycleApplyIntent,
  ) => void;
  readonly onRetire: (ref: ProjectSkillVersionRef) => void;
}) {
  const { version } = view;
  const needsTarget = version.state === "candidate" || version.state === "retired";
  const [threadId, setThreadId, threadIdRef] = useMirrored<ThreadId | "">("");
  const [selectedScriptIds, setSelectedScriptIds, selectedScriptIdsRef] = useMirrored<
    ReadonlyArray<string>
  >([]);
  const toggleScript = (scriptId: string) => {
    const current = selectedScriptIdsRef.current;
    if (current.includes(scriptId)) {
      setSelectedScriptIds(current.filter((id) => id !== scriptId));
    } else if (current.length < SELECTED_CHECK_MAX) {
      setSelectedScriptIds([...current, scriptId]);
    }
  };
  // The mirrors move inside the event handler, so the activation boundary sees
  // a choice made before React commits; a cleared thread reads as null.
  const readLiveTarget = (): LifecycleTargetSelection | null =>
    threadIdRef.current === ""
      ? null
      : { threadId: threadIdRef.current, scriptIds: selectedScriptIdsRef.current };
  const frozenScriptIds = freezeSelectedScriptIds(selectedScriptIds);
  const targetReady = threadId !== "" && frozenScriptIds !== null && frozenScriptIds.length > 0;
  const runApply = (intent: LifecycleApplyIntent) => {
    if (!targetReady || frozenScriptIds === null) return;
    onApplyLifecycle(version.ref, { threadId, scriptIds: frozenScriptIds }, readLiveTarget, intent);
  };
  const activateRestoreBlocked = !useCapability;
  return (
    <div className="grid gap-2 border-t border-border pt-2">
      <p className="text-sm font-medium">Lifecycle</p>
      {activateRestoreBlocked ? (
        <p className="text-xs text-muted-foreground">{LIFECYCLE_USE_UNAVAILABLE_COPY}</p>
      ) : null}
      {needsTarget ? (
        <>
          <label className="grid gap-1 text-sm">
            Thread
            <Select
              value={threadId === "" ? null : threadId}
              disabled={disabled}
              onValueChange={(value) => setThreadId((value ?? "") as ThreadId | "")}
            >
              <SelectTrigger aria-label="Activation thread" size="sm" className="w-full">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectPopup>
                {projectThreads.map((thread) => (
                  <SelectItem key={thread.threadId} value={thread.threadId}>
                    {thread.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <div className="grid gap-2 text-sm">
            <p>Project scripts</p>
            {scripts.length === 0 ? (
              <p className="text-xs text-muted-foreground">No scripts on this project.</p>
            ) : (
              scripts.map((script) => {
                const checked = selectedScriptIds.includes(script.id);
                const atMax = selectedScriptIds.length >= SELECTED_CHECK_MAX;
                return (
                  <label key={script.id} className="flex items-center gap-2">
                    <Checkbox
                      checked={checked}
                      disabled={disabled || (!checked && atMax)}
                      onCheckedChange={() => toggleScript(script.id)}
                    />
                    <span>{script.name}</span>
                  </label>
                );
              })
            )}
          </div>
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {version.state === "candidate" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || activateRestoreBlocked || !targetReady}
            onClick={() => runApply("activate")}
          >
            활성화
          </Button>
        ) : null}
        {version.state === "retired" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || activateRestoreBlocked || !targetReady}
            onClick={() => runApply("restore")}
          >
            이전 버전 복원
          </Button>
        ) : null}
        {version.state === "active" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onRetire(version.ref)}
          >
            사용 중지
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function VersionJudgmentForm({
  disabled,
  onRecord,
}: {
  readonly disabled: boolean;
  readonly onRecord: (form: SkillJudgmentForm) => void;
}) {
  const [kind, setKind] = useState<"rights" | "review">("rights");
  const [basis, setBasis] = useState<SkillRightsBasis | "">("");
  const [originalSource, setOriginalSource] = useState("");
  const [license, setLicense] = useState("");
  const [provenanceChecked, setProvenanceChecked] = useState(false);
  const [privacyChecked, setPrivacyChecked] = useState(false);
  const [scopeChecked, setScopeChecked] = useState(false);
  const [note, setNote] = useState("");
  const form: SkillJudgmentForm =
    kind === "rights"
      ? { kind, basis, originalSource, license, note }
      : { kind, provenanceChecked, privacyChecked, scopeChecked, note };
  return (
    <div className="grid gap-2">
      <ToggleGroup
        aria-label="Judgment kind"
        variant="segmented"
        value={[kind]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "rights" || value === "review") setKind(value);
        }}
      >
        <Toggle value="rights">Rights</Toggle>
        <Toggle value="review">Review</Toggle>
      </ToggleGroup>
      {kind === "rights" ? (
        <>
          <div className="grid gap-1 text-sm">
            Basis
            <ToggleGroup
              aria-label="Rights basis"
              variant="segmented"
              value={basis === "" ? [] : [basis]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === undefined || (RIGHTS_BASES as readonly string[]).includes(value)) {
                  setBasis((value as SkillRightsBasis | undefined) ?? "");
                }
              }}
            >
              {RIGHTS_BASES.map((value) => (
                <Toggle key={value} value={value}>
                  {RIGHTS_BASIS_LABEL[value]}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
          <Input
            aria-label="Original source (optional)"
            placeholder="Original source (optional)"
            value={originalSource}
            maxLength={PROJECT_SKILL_LIMITS.source}
            onChange={(event) => setOriginalSource(event.currentTarget.value)}
          />
          <Input
            aria-label="License (optional)"
            placeholder="License (optional)"
            value={license}
            maxLength={PROJECT_SKILL_LIMITS.license}
            onChange={(event) => setLicense(event.currentTarget.value)}
          />
        </>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={provenanceChecked}
              onCheckedChange={(checked) => setProvenanceChecked(checked === true)}
            />
            <span>Provenance checked</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={privacyChecked}
              onCheckedChange={(checked) => setPrivacyChecked(checked === true)}
            />
            <span>Privacy checked</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={scopeChecked}
              onCheckedChange={(checked) => setScopeChecked(checked === true)}
            />
            <span>Scope checked</span>
          </label>
        </>
      )}
      <Textarea
        aria-label="Judgment note"
        placeholder="Note"
        rows={2}
        value={note}
        maxLength={PROJECT_SKILL_LIMITS.note}
        onChange={(event) => setNote(event.currentTarget.value)}
      />
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => onRecord(form)}>
        Record judgment
      </Button>
      <p className="text-xs text-muted-foreground">{JUDGMENT_NOTICE}</p>
    </div>
  );
}

export function VersionTrialHistory({
  view,
  trialCapability,
}: {
  readonly view: ProjectSkillVersionView;
  readonly trialCapability: boolean;
}) {
  const panel = versionTrialHistoryPanel({ trialCapability, trials: view.trials });
  if (panel.kind === "hidden") return null;
  return (
    <div className="grid gap-2 border-t border-border pt-2">
      <p className="text-sm font-medium">{VERSION_TRIAL_HISTORY_TITLE}</p>
      {panel.kind === "unavailable" ? (
        <p className="text-xs text-muted-foreground">{VERSION_TRIAL_HISTORY_UNAVAILABLE_COPY}</p>
      ) : null}
      {panel.kind === "empty" ? (
        <p className="text-xs text-muted-foreground">{VERSION_TRIAL_HISTORY_EMPTY_COPY}</p>
      ) : null}
      {panel.kind === "listed"
        ? panel.rows.map((row) => (
            <div key={row.key} className="grid gap-1 rounded-md border border-border p-2">
              <p className="text-sm font-medium">{row.headline}</p>
              {row.lines.map((line, index) => (
                <p key={`${row.key}:${index}`} className="text-xs text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
          ))
        : null}
    </div>
  );
}

function VersionSection({
  view,
  trialCapability,
  lifecycleCapability,
  lifecycleVersionCapability,
  useCapability,
  writeDisabled,
  projectThreads,
  scripts,
  onWithdraw,
  onRecord,
  onRecordReproduction,
  onRecordNonApplication,
  onApplyLifecycle,
  onRetire,
}: {
  readonly view: ProjectSkillVersionView;
  readonly trialCapability: boolean;
  readonly lifecycleCapability: boolean;
  readonly lifecycleVersionCapability: boolean;
  readonly useCapability: boolean;
  readonly writeDisabled: boolean;
  readonly projectThreads: ReadonlyArray<{ readonly threadId: ThreadId; readonly title: string }>;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly onWithdraw: (ref: ProjectSkillVersionRef, judgmentId: ProjectSkillJudgmentId) => void;
  readonly onRecord: (ref: ProjectSkillVersionRef, form: SkillJudgmentForm) => void;
  readonly onRecordReproduction: (
    ref: ProjectSkillVersionRef,
    form: SkillReproductionForm,
    readObservedEvidenceId: () => SkillReproductionForm["observedEvidenceId"],
  ) => void;
  readonly onRecordNonApplication: (
    ref: ProjectSkillVersionRef,
    form: SkillNonApplicationForm,
    readObservedEvidenceId: () => SkillNonApplicationForm["observedEvidenceId"],
  ) => void;
  readonly onApplyLifecycle: (
    ref: ProjectSkillVersionRef,
    target: LifecycleTargetSelection,
    readLiveTarget: () => LifecycleTargetSelection | null,
    intent: LifecycleApplyIntent,
  ) => void;
  readonly onRetire: (ref: ProjectSkillVersionRef) => void;
}) {
  const { version, judgments, rightsRecorded, reviewRecorded } = view;
  return (
    <section className="grid gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">v{version.ref.version}</p>
        <Badge variant="outline" size="sm">
          {VERSION_STATE_LABEL[version.state]}
        </Badge>
        {rightsRecorded ? (
          <Badge variant="outline" size="sm">
            Rights recorded
          </Badge>
        ) : null}
        {reviewRecorded ? (
          <Badge variant="outline" size="sm">
            Review recorded
          </Badge>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{sourceLine(version.source)}</p>
      <div className="grid gap-1 text-sm">
        <p>
          <span className="text-muted-foreground">Title: </span>
          {version.content.title}
        </p>
        <p>
          <span className="text-muted-foreground">Purpose: </span>
          {version.content.purpose}
        </p>
        <p>
          <span className="text-muted-foreground">Applies when: </span>
          {version.content.appliesWhen}
        </p>
        <p>
          <span className="text-muted-foreground">Does not apply when: </span>
          {version.content.doesNotApplyWhen}
        </p>
        <p>
          <span className="text-muted-foreground">Procedure:</span>
        </p>
        <p className="whitespace-pre-wrap">{version.content.procedure}</p>
        <p>
          <span className="text-muted-foreground">Success check: </span>
          {version.content.successCheck}
        </p>
      </div>
      <div className="grid gap-2">
        {judgments.map((row) => (
          <div key={row.judgment.judgmentId} className="grid gap-1 border-t border-border pt-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {JUDGMENT_KIND_LABEL[row.judgment.kind]}
                {row.withdrawnAt !== null ? " (withdrawn)" : ""}
              </span>
              {row.withdrawnAt === null ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={writeDisabled}
                  onClick={() => onWithdraw(row.judgment.ref, row.judgment.judgmentId)}
                >
                  Withdraw
                </Button>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">{judgmentSummary(row.judgment)}</p>
            <p className="text-sm">{row.judgment.note}</p>
            <p className="text-xs text-muted-foreground">
              Recorded {formatSkillInstant(row.judgment.recordedAt)}
              {row.withdrawnAt !== null
                ? ` · Withdrawn ${formatSkillInstant(row.withdrawnAt)}`
                : ""}
            </p>
          </div>
        ))}
      </div>
      <VersionTrialHistory view={view} trialCapability={trialCapability} />
      {lifecycleVersionCapability ? (
        <VersionLifecycleControls
          view={view}
          disabled={writeDisabled}
          useCapability={useCapability}
          projectThreads={projectThreads}
          scripts={scripts}
          onApplyLifecycle={onApplyLifecycle}
          onRetire={onRetire}
        />
      ) : null}
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Record a judgment on v{version.ref.version}
        </summary>
        <div className="mt-2">
          <VersionJudgmentForm
            disabled={writeDisabled}
            onRecord={(form) => onRecord(version.ref, form)}
          />
        </div>
      </details>
      {lifecycleCapability ? (
        <>
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              재현 판단 기록 · v{version.ref.version}
            </summary>
            <div className="mt-2">
              <VersionReproductionJudgmentForm
                disabled={writeDisabled}
                offers={reproductionEvidenceOffers(view)}
                onRecord={(form, readObservedEvidenceId) =>
                  onRecordReproduction(version.ref, form, readObservedEvidenceId)
                }
              />
            </div>
          </details>
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              비적용 판단 기록 · v{version.ref.version}
            </summary>
            <div className="mt-2">
              <VersionNonApplicationJudgmentForm
                disabled={writeDisabled}
                offers={nonApplicationEvidenceOffers(view)}
                onRecord={(form, readObservedEvidenceId) =>
                  onRecordNonApplication(version.ref, form, readObservedEvidenceId)
                }
              />
            </div>
          </details>
        </>
      ) : null}
    </section>
  );
}

export function ProjectSkillDialog({
  environmentId,
  projectId,
  skillId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly skillId: ProjectSkillId;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <ProjectSkillDialogInner
          key={JSON.stringify([environmentId, projectId, skillId])}
          environmentId={environmentId}
          projectId={projectId}
          skillId={skillId}
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}

/** The versioned content a revise write is based on, installed as one unit. */
interface ReviseSeed {
  readonly fields: SkillContentForm;
  readonly fromVersion: number;
  readonly expectedLatestVersion: number;
}

function ProjectSkillDialogInner({
  environmentId,
  projectId,
  skillId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly skillId: ProjectSkillId;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const reviseCommand = useAtomCommand(projectSkills.revise, { reportFailure: false });
  const recordCommand = useAtomCommand(projectSkills.recordJudgment, { reportFailure: false });
  const withdrawCommand = useAtomCommand(projectSkills.withdrawJudgment, { reportFailure: false });
  const deleteCommand = useAtomCommand(projectSkills.delete, { reportFailure: false });
  const activateCommand = useAtomCommand(projectSkills.activate, { reportFailure: false });
  const retireCommand = useAtomCommand(projectSkills.retire, { reportFailure: false });
  const revalidateScope = useAtomCommand(projectSkills.revalidate, { reportFailure: false });
  const confirmSession = useAtomCommand(selectedChecksSessionConfirmation, {
    reportFailure: false,
    reportDefect: false,
  });
  const operateAccess = useProjectMemoryOperateAccess(environmentId);
  const writeLock = resolveSkillWriteLock(operateAccess);
  const lock = useDialogWriteLock();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const trialCapability = projectSkillTrialCapabilityOf(config);
  const lifecycleCapability = projectSkillLifecycleCapabilityOf(config);
  const useCapability = projectSkillUseCapabilityOf(config);
  const projectRecord = useProject({ environmentId, projectId });
  const threadShells = useThreadShellsForProjectRefs([{ environmentId, projectId }]);
  const projectThreads = threadShells
    .filter((thread) => thread.projectId === projectId && thread.archivedAt === null)
    .map((thread) => ({ threadId: thread.id, title: thread.title }));
  const scripts =
    projectRecord !== null && config !== null && config !== undefined
      ? resolveProjectScripts(config.settings, projectRecord)
      : [];
  const detailAtom = projectSkills.get({ environmentId, input: { projectId, skillId } });
  const detail = useEnvironmentQuery(detailAtom);
  const detailRaw = useAtomValue(detailAtom);

  const [seed, setSeed, seedRef] = useMirrored<ReviseSeed | null>(null);
  const [conflictVersion, setConflict, conflictRef] = useMirrored<number | null>(null);
  const [loadingCurrent, setLoading, loadingRef] = useMirrored(false);
  const [saving, setSaving, savingRef] = useMirrored(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const deleteExpectedRef = useRef<number | null>(null);
  const loadSeqRef = useRef(0);
  const rawCause = detailRaw._tag === "Failure" ? Cause.squash(detailRaw.cause) : null;
  const notFound =
    detail.error !== null && isTaggedError(rawCause, "ProjectSkillStoreNotFoundError");

  const exactSkillDetail = (value: ProjectSkillDetail | null): ProjectSkillDetail | null =>
    value !== null && value.projectId === projectId && value.skillId === skillId ? value : null;

  /** Registry-fresh detail for this exact skill; anything else is null. */
  const readFreshDetail = (): ProjectSkillDetail | null =>
    exactSkillDetail(Option.getOrNull(AsyncResult.value(registry.get(detailAtom))));

  /**
   * Lifecycle and evidence mutation boundaries accept only a settled Success:
   * `AsyncResult.value` also yields a waiting Success and a Failure's previous
   * success, neither of which is a current read.
   */
  const readSettledDetail = (): ProjectSkillDetail | null => {
    const result = registry.get(detailAtom);
    return result._tag === "Success" && !result.waiting ? exactSkillDetail(result.value) : null;
  };

  const detailSettled = !detail.isPending && detail.error === null && detail.data !== null;

  const installSeed = (next: ReviseSeed | null) => {
    setSeed(next);
  };

  const installFromFresh = (fresh: ProjectSkillDetail) => {
    if (seedRef.current !== null) {
      const latest = latestVersionView(fresh);
      if (latest !== null) {
        setSeed({
          fields: contentToForm(latest.version.content),
          fromVersion: fresh.latestVersion,
          expectedLatestVersion: fresh.latestVersion,
        });
      }
    }
    setConflict(null);
    setLoading(false);
  };

  // "Load current version" is fulfilled only by a settled fresh response for
  // this exact skill at the recorded conflict version or newer. Pending,
  // failure, and NotFound never release the gate.
  useEffect(() => {
    if (detail.error !== null) {
      if (loadingRef.current) setLoading(false);
      return;
    }
    const fresh = detail.data;
    if (!fresh || detail.isPending || !loadingRef.current) return;
    if (fresh.skillId !== skillId || fresh.projectId !== projectId) return;
    if (conflictRef.current === null || fresh.latestVersion < conflictRef.current) return;
    if (seedRef.current !== null) {
      const latest = latestVersionView(fresh);
      if (latest !== null) {
        setSeed({
          fields: contentToForm(latest.version.content),
          fromVersion: fresh.latestVersion,
          expectedLatestVersion: fresh.latestVersion,
        });
      }
    }
    setConflict(null);
    setLoading(false);
  }, [
    detail.data,
    detail.error,
    detail.isPending,
    setLoading,
    setConflict,
    setSeed,
    skillId,
    projectId,
    conflictRef,
    loadingRef,
    seedRef,
  ]);

  const startRevise = () => {
    if (writeLock !== null || !detailSettled || detail.data === null || seed !== null) return;
    if (conflictVersion !== null || loadingCurrent || saving) return;
    const latest = latestVersionView(detail.data);
    if (latest === null) return;
    setError(null);
    setNotice(null);
    installSeed({
      fields: contentToForm(latest.version.content),
      fromVersion: detail.data.latestVersion,
      expectedLatestVersion: detail.data.latestVersion,
    });
  };

  const updateSeed = (key: keyof SkillContentForm, next: string) => {
    if (seedRef.current === null) return;
    setSeed({
      ...seedRef.current,
      fields: { ...seedRef.current.fields, [key]: next },
    });
  };

  /**
   * The bounded pre-submit confirmation: captures the actual catalog entry,
   * supervisor generation and prepared object, and its command re-verifies
   * them around a direct session fetch. Only authenticated=true with an
   * explicit orchestration:operate scope lets a skill command proceed. The
   * confirmed stamp is returned so the caller can compare it against a fresh
   * read after its own await boundary.
   */
  const confirmWrite = async (): Promise<
    { ok: true; stamp: ConnectionStamp } | { ok: false; copy: string }
  > => {
    const stamp = readConnectionStamp(registry, environmentId);
    if (stamp === null) return { ok: false, copy: CONFIRM_FAILED_COPY };
    let result: AtomCommandResult<SelectedChecksConfirmationOutcome, unknown>;
    try {
      result = await confirmSession({
        environmentId,
        input: { generation: stamp.generation, prepared: stamp.prepared, entry: stamp.entry },
      });
    } catch {
      return { ok: false, copy: CONFIRM_FAILED_COPY };
    }
    if (!lock.liveRef.current) return { ok: false, copy: CONFIRM_FAILED_COPY };
    if (result._tag !== "Success") return { ok: false, copy: CONFIRM_FAILED_COPY };
    const outcome = result.value;
    if (
      outcome.kind !== "confirmed" ||
      outcome.session === undefined ||
      !sessionHasOperateScope(outcome.session)
    ) {
      return { ok: false, copy: SKILL_AUTHORIZATION_COPY };
    }
    return { ok: true, stamp };
  };

  /**
   * The post-confirmation guard, run by the caller in the same synchronous
   * continuation after its await: the exact connection identity that was
   * confirmed must still be current, and the manage capability must still
   * hold, before any skill command is issued.
   */
  const finalGate = (stamp: ConnectionStamp): string | null => {
    const now = readConnectionStamp(registry, environmentId);
    if (
      now === null ||
      now.entry !== stamp.entry ||
      now.prepared !== stamp.prepared ||
      now.generation !== stamp.generation
    ) {
      return CONFIRM_FAILED_COPY;
    }
    if (!readManageCapability(registry, environmentId)) return SKILL_UNSUPPORTED_COPY;
    return null;
  };

  const finalLifecycleGate = (stamp: ConnectionStamp): string | null => {
    const base = finalGate(stamp);
    if (base !== null) return base;
    if (!readLifecycleCapability(registry, environmentId)) return LIFECYCLE_UNSUPPORTED_COPY;
    return null;
  };

  const finalActivateGate = (stamp: ConnectionStamp): string | null => {
    const base = finalLifecycleGate(stamp);
    if (base !== null) return base;
    if (!readUseCapability(registry, environmentId)) return LIFECYCLE_USE_UNAVAILABLE_COPY;
    return null;
  };

  const gateName = (): string | null => {
    if (!readManageCapability(registry, environmentId)) return SKILL_UNSUPPORTED_COPY;
    if (conflictRef.current !== null || loadingRef.current) return LOAD_FAILED_COPY;
    if (readFreshDetail() === null) return LOAD_FAILED_COPY;
    return null;
  };

  const handleLifecycleStoreRejection = (cause: unknown) => {
    setError(skillRejectionCopy(cause));
    if (isTaggedError(cause, "ProjectSkillStoreRejectedError")) {
      const reason = (cause as { readonly reason: ProjectSkillStoreRejectReason }).reason;
      if (skillLifecycleRejectionNeedsRefetch(reason)) {
        void revalidateScope({ environmentId, input: { projectId } });
      }
    }
  };

  /**
   * Records one judgment. Reproduction and non-application judgments cite an
   * observation: the exact offer the user chose is frozen here, before the
   * confirmation await, and the caller's reader must still return that choice
   * afterwards. Rights and review judgments need no reader.
   */
  const submitRecordableJudgment = async (
    ref: ProjectSkillVersionRef,
    judgment: RecordableProjectSkillJudgment,
    successTitle: string,
    readObservedEvidenceId: (() => ProjectSkillEvidenceId | "") | null = null,
  ) => {
    if (savingRef.current || writeLock !== null) return;
    if (conflictRef.current !== null || loadingRef.current) return;

    let evidence: {
      readonly kind: "reproduction" | "non-application";
      readonly choice: FrozenTrialEvidenceChoice;
      readonly readObservedEvidenceId: () => ProjectSkillEvidenceId | "";
    } | null = null;
    if (judgment.kind === "reproduction" || judgment.kind === "non-application") {
      const detailBefore = readSettledDetail();
      const viewBefore = detailBefore !== null ? versionViewForRef(detailBefore, ref) : null;
      const offer =
        viewBefore !== null
          ? findTrialEvidenceOffer(viewBefore, judgment.observedEvidenceId, judgment.kind)
          : null;
      if (offer === null || readObservedEvidenceId === null) {
        setError(LIFECYCLE_SCOPE_DRIFT_COPY);
        return;
      }
      evidence = {
        kind: judgment.kind,
        choice: freezeTrialEvidenceChoice(offer),
        readObservedEvidenceId,
      };
    }

    const invocation = lock.begin();
    if (invocation === null) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const gate = gateName();
      if (gate !== null) {
        setError(gate);
        return;
      }
      const confirmed = await confirmWrite();
      if (!lock.isCurrent(invocation)) return;
      if (!confirmed.ok) {
        setError(confirmed.copy);
        return;
      }
      const postGate =
        evidence !== null ? finalLifecycleGate(confirmed.stamp) : finalGate(confirmed.stamp);
      if (postGate !== null) {
        setError(postGate);
        return;
      }
      if (evidence !== null) {
        const detailNow = readSettledDetail();
        const viewNow = detailNow !== null ? versionViewForRef(detailNow, ref) : null;
        if (
          viewNow === null ||
          conflictRef.current !== null ||
          loadingRef.current ||
          evidence.readObservedEvidenceId() !== evidence.choice.evidenceId ||
          !trialEvidenceChoiceStillValid(viewNow, evidence.choice, evidence.kind)
        ) {
          setError(LIFECYCLE_SCOPE_DRIFT_COPY);
          return;
        }
      } else {
        const fresh = readFreshDetail();
        const refCurrent =
          fresh !== null &&
          ref.projectId === projectId &&
          ref.skillId === skillId &&
          fresh.versions.some((entry) => sameProjectSkillVersionRef(entry.version.ref, ref));
        if (!refCurrent || conflictRef.current !== null || loadingRef.current) {
          setError(VERSION_GONE_COPY);
          void revalidateScope({ environmentId, input: { projectId } });
          return;
        }
      }
      const result = await recordCommand({ environmentId, input: { ref, judgment } });
      if (!lock.isCurrent(invocation)) return;
      if (result._tag === "Success") {
        toastManager.add({ type: "success", title: successTitle });
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      if (evidence !== null) {
        handleLifecycleStoreRejection(cause);
        return;
      }
      setError(skillRejectionCopy(cause));
      if (
        isTaggedError(cause, "ProjectSkillStoreRejectedError") &&
        (cause as { reason?: string }).reason === "ref-mismatch"
      ) {
        void revalidateScope({ environmentId, input: { projectId } });
      }
    } finally {
      lock.end(invocation);
      if (lock.isCurrent(invocation)) setSaving(false);
    }
  };

  const saveRevise = async () => {
    const current = seedRef.current;
    if (current === null || savingRef.current || writeLock !== null) return;
    if (conflictRef.current !== null || loadingRef.current) return;
    const invocation = lock.begin();
    if (invocation === null) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const fresh = readFreshDetail();
      if (fresh === null || fresh.latestVersion !== current.expectedLatestVersion) {
        // The version paired with this draft was superseded: keep the draft,
        // force a reread, and stay gated until Load current installs fresh.
        setConflict(fresh?.latestVersion ?? current.expectedLatestVersion);
        void revalidateScope({ environmentId, input: { projectId } });
        return;
      }
      const content = toSkillContent(current.fields);
      if (content === null) {
        setError(CONTENT_INVALID_COPY);
        return;
      }
      const confirmed = await confirmWrite();
      if (!lock.isCurrent(invocation)) return;
      if (!confirmed.ok) {
        setError(confirmed.copy);
        return;
      }
      const gate = finalGate(confirmed.stamp);
      if (gate !== null) {
        setError(gate);
        return;
      }
      // Re-checked after the awaited confirmation, in this same synchronous
      // continuation; render state is not authority.
      const now = readFreshDetail();
      if (
        now === null ||
        now.latestVersion !== current.expectedLatestVersion ||
        conflictRef.current !== null ||
        loadingRef.current
      ) {
        setConflict(now === null ? current.expectedLatestVersion : now.latestVersion);
        void revalidateScope({ environmentId, input: { projectId } });
        return;
      }
      const result = await reviseCommand({
        environmentId,
        input: {
          projectId,
          skillId,
          fromVersion: current.fromVersion,
          expectedLatestVersion: current.expectedLatestVersion,
          content,
        },
      });
      if (!lock.isCurrent(invocation)) return;
      if (result._tag === "Success") {
        toastManager.add({ type: "success", title: "New version saved" });
        installSeed(null);
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      if (isTaggedError(cause, "ProjectSkillStoreConflictError")) {
        const version = (cause as { currentLatestVersion?: number }).currentLatestVersion;
        if (typeof version === "number") setConflict(version);
        void revalidateScope({ environmentId, input: { projectId } });
        return;
      }
      setError(skillRejectionCopy(cause));
    } finally {
      lock.end(invocation);
      if (lock.isCurrent(invocation)) setSaving(false);
    }
  };

  const loadCurrent = async () => {
    if (loadingRef.current || conflictRef.current === null) return;
    const fresh = readFreshDetail();
    if (fresh !== null && fresh.latestVersion >= conflictRef.current) {
      installFromFresh(fresh);
      return;
    }
    const loadToken = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    // A discarded/cancelled load bumps the token, so this continuation ignores
    // its own late result instead of resetting or erroring afterwards.
    const fail = () => {
      if (lock.liveRef.current && loadSeqRef.current === loadToken) {
        setLoading(false);
        setError(LOAD_FAILED_COPY);
      }
    };
    try {
      const result = await revalidateScope({ environmentId, input: { projectId } });
      if (lock.liveRef.current && loadSeqRef.current === loadToken && result._tag !== "Success") {
        fail();
      }
    } catch {
      fail();
    }
  };

  const recordJudgmentOn = async (ref: ProjectSkillVersionRef, form: SkillJudgmentForm) => {
    const judgment = toRecordableJudgment(form);
    if (judgment === null) {
      setError(JUDGMENT_INVALID_COPY);
      return;
    }
    await submitRecordableJudgment(ref, judgment, "Judgment recorded");
  };

  /** Form conversion only; the shared submit freezes the cited observation. */
  const recordEvidenceOn = async (
    ref: ProjectSkillVersionRef,
    judgment: RecordableProjectSkillJudgment | null,
    successTitle: string,
    readObservedEvidenceId: () => ProjectSkillEvidenceId | "",
  ) => {
    if (judgment === null) {
      setError(LIFECYCLE_JUDGMENT_INVALID_COPY);
      return;
    }
    await submitRecordableJudgment(ref, judgment, successTitle, readObservedEvidenceId);
  };

  const activateVersion = async (
    ref: ProjectSkillVersionRef,
    target: LifecycleTargetSelection,
    readLiveTarget: () => LifecycleTargetSelection | null,
    successTitle: string,
  ) => {
    if (savingRef.current || writeLock !== null) return;
    if (conflictRef.current !== null || loadingRef.current) return;
    const frozenScriptIds = freezeSelectedScriptIds(target.scriptIds);
    if (target.threadId === "" || frozenScriptIds === null) {
      setError(
        frozenScriptIds === null ? LIFECYCLE_SCRIPTS_INVALID_COPY : LIFECYCLE_THREAD_REQUIRED_COPY,
      );
      return;
    }
    const freshBefore = readSettledDetail();
    const viewBefore = freshBefore !== null ? versionViewForRef(freshBefore, ref) : null;
    const expectedStateSeq = freshBefore !== null ? projectSkillStateSeqOf(freshBefore) : null;
    if (viewBefore === null || expectedStateSeq === null) {
      setError(LIFECYCLE_STATE_UNKNOWN_COPY);
      return;
    }
    const scriptsBefore = readResolvedProjectScriptsForProject(registry, environmentId, projectId);
    const shellBefore = readThreadShell(scopeThreadRef(environmentId, target.threadId));
    const scriptBindings = freezeProjectScriptBindings(scriptsBefore, frozenScriptIds);
    if (shellBefore === null || scriptBindings === null) {
      setError(LIFECYCLE_SCOPE_DRIFT_COPY);
      return;
    }
    const frozen = {
      ref,
      expectedStateSeq,
      expectedVersionState: viewBefore.version.state,
      projectId,
      threadId: target.threadId,
      threadCreatedAt: shellBefore.createdAt,
      scriptBindings,
      target: { threadId: target.threadId, scriptIds: frozenScriptIds },
    };
    const invocation = lock.begin();
    if (invocation === null) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (!readLifecycleCapability(registry, environmentId)) {
        setError(LIFECYCLE_UNSUPPORTED_COPY);
        return;
      }
      if (!readUseCapability(registry, environmentId)) {
        setError(LIFECYCLE_USE_UNAVAILABLE_COPY);
        return;
      }
      const gate = gateName();
      if (gate !== null) {
        setError(gate);
        return;
      }
      const confirmed = await confirmWrite();
      if (!lock.isCurrent(invocation)) return;
      if (!confirmed.ok) {
        setError(confirmed.copy);
        return;
      }
      const postGate = finalActivateGate(confirmed.stamp);
      if (postGate !== null) {
        setError(postGate);
        return;
      }
      // Same synchronous run as the RPC below. A cleared live selection is
      // drift, never a reason to fall back to the frozen target.
      const fresh = readSettledDetail();
      const selection = readLiveTarget();
      if (
        fresh === null ||
        selection === null ||
        !lifecycleActivateOperationStillValid({
          detail: fresh,
          skillId,
          project: readProject({ environmentId, projectId }),
          threadShell: readThreadShell(scopeThreadRef(environmentId, frozen.threadId)),
          scripts: readResolvedProjectScriptsForProject(registry, environmentId, projectId),
          frozen,
          selection,
        })
      ) {
        setError(LIFECYCLE_SCOPE_DRIFT_COPY);
        return;
      }
      const result = await activateCommand({
        environmentId,
        input: {
          ref: frozen.ref,
          expectedStateSeq: frozen.expectedStateSeq,
          target: { threadId: frozen.target.threadId, scriptIds: [...frozen.target.scriptIds] },
        },
      });
      if (!lock.isCurrent(invocation)) return;
      if (result._tag === "Success") {
        toastManager.add({ type: "success", title: successTitle });
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      handleLifecycleStoreRejection(squashAtomCommandFailure(result));
    } finally {
      lock.end(invocation);
      if (lock.isCurrent(invocation)) setSaving(false);
    }
  };

  const applyLifecycleVersion = (
    ref: ProjectSkillVersionRef,
    target: LifecycleTargetSelection,
    readLiveTarget: () => LifecycleTargetSelection | null,
    intent: LifecycleApplyIntent,
  ) => {
    const successTitle =
      intent === "restore" ? LIFECYCLE_RESTORE_SUCCESS : LIFECYCLE_ACTIVATE_SUCCESS;
    void activateVersion(ref, target, readLiveTarget, successTitle);
  };

  const retireVersion = async (ref: ProjectSkillVersionRef) => {
    if (savingRef.current || writeLock !== null) return;
    if (conflictRef.current !== null || loadingRef.current) return;
    const freshBefore = readSettledDetail();
    const viewBefore = freshBefore !== null ? versionViewForRef(freshBefore, ref) : null;
    const expectedStateSeq = freshBefore !== null ? projectSkillStateSeqOf(freshBefore) : null;
    if (viewBefore === null || expectedStateSeq === null || viewBefore.version.state !== "active") {
      setError(LIFECYCLE_STATE_UNKNOWN_COPY);
      return;
    }
    const frozen = {
      ref,
      expectedStateSeq,
      expectedVersionState: "active" as const,
      projectId,
    };
    const invocation = lock.begin();
    if (invocation === null) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (!readLifecycleCapability(registry, environmentId)) {
        setError(LIFECYCLE_UNSUPPORTED_COPY);
        return;
      }
      const gate = gateName();
      if (gate !== null) {
        setError(gate);
        return;
      }
      const confirmed = await confirmWrite();
      if (!lock.isCurrent(invocation)) return;
      if (!confirmed.ok) {
        setError(confirmed.copy);
        return;
      }
      const postGate = finalLifecycleGate(confirmed.stamp);
      if (postGate !== null) {
        setError(postGate);
        return;
      }
      const fresh = readSettledDetail();
      if (
        fresh === null ||
        !lifecycleRetireOperationStillValid({ detail: fresh, skillId, frozen })
      ) {
        setError(LIFECYCLE_SCOPE_DRIFT_COPY);
        return;
      }
      const result = await retireCommand({
        environmentId,
        input: { ref: frozen.ref, expectedStateSeq: frozen.expectedStateSeq },
      });
      if (!lock.isCurrent(invocation)) return;
      if (result._tag === "Success") {
        toastManager.add({ type: "success", title: LIFECYCLE_RETIRE_SUCCESS });
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      handleLifecycleStoreRejection(squashAtomCommandFailure(result));
    } finally {
      lock.end(invocation);
      if (lock.isCurrent(invocation)) setSaving(false);
    }
  };

  const withdrawJudgment = async (
    ref: ProjectSkillVersionRef,
    judgmentId: ProjectSkillJudgmentId,
  ) => {
    if (savingRef.current || writeLock !== null) return;
    if (conflictRef.current !== null || loadingRef.current) return;
    const invocation = lock.begin();
    if (invocation === null) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const gate = gateName();
      if (gate !== null) {
        setError(gate);
        return;
      }
      const confirmed = await confirmWrite();
      if (!lock.isCurrent(invocation)) return;
      if (!confirmed.ok) {
        setError(confirmed.copy);
        return;
      }
      const postGate = finalGate(confirmed.stamp);
      if (postGate !== null) {
        setError(postGate);
        return;
      }
      const fresh = readFreshDetail();
      const refCurrent =
        fresh !== null &&
        ref.projectId === projectId &&
        ref.skillId === skillId &&
        fresh.versions.some((entry) => sameProjectSkillVersionRef(entry.version.ref, ref));
      if (!refCurrent || conflictRef.current !== null || loadingRef.current) {
        setError(VERSION_GONE_COPY);
        void revalidateScope({ environmentId, input: { projectId } });
        return;
      }
      const result = await withdrawCommand({ environmentId, input: { ref, judgmentId } });
      if (!lock.isCurrent(invocation)) return;
      if (result._tag === "Success") {
        // Resolved is not applied: only the status union says what counted.
        const status = result.value.status;
        if (status === "applied") {
          toastManager.add({ type: "success", title: withdrawOutcomeCopy.applied });
        } else {
          setNotice(withdrawOutcomeCopy[status]);
          void revalidateScope({ environmentId, input: { projectId } });
        }
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      setError(skillRejectionCopy(squashAtomCommandFailure(result)));
    } finally {
      lock.end(invocation);
      if (lock.isCurrent(invocation)) setSaving(false);
    }
  };

  const armDelete = () => {
    if (deleteArmed) return;
    const fresh = readFreshDetail();
    if (fresh === null || fresh.projectId !== projectId || fresh.skillId !== skillId) return;
    // The confirmation captures the version under review; a later reread never
    // substitutes a new expectedLatestVersion on its own.
    deleteExpectedRef.current = fresh.latestVersion;
    setDeleteArmed(true);
  };

  const remove = async () => {
    if (savingRef.current || writeLock !== null) return;
    if (conflictRef.current !== null || loadingRef.current) return;
    if (!deleteArmed) {
      armDelete();
      return;
    }
    const expected = deleteExpectedRef.current;
    if (expected === null) {
      setDeleteArmed(false);
      return;
    }
    const invocation = lock.begin();
    if (invocation === null) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const gate = gateName();
      if (gate !== null) {
        setError(gate);
        return;
      }
      const confirmed = await confirmWrite();
      if (!lock.isCurrent(invocation)) return;
      if (!confirmed.ok) {
        setError(confirmed.copy);
        return;
      }
      const postGate = finalGate(confirmed.stamp);
      if (postGate !== null) {
        setError(postGate);
        return;
      }
      if (readFreshDetail() === null || conflictRef.current !== null || loadingRef.current) {
        setError(VERSION_GONE_COPY);
        void revalidateScope({ environmentId, input: { projectId } });
        return;
      }
      const result = await deleteCommand({
        environmentId,
        input: { projectId, skillId, expectedLatestVersion: expected },
      });
      if (!lock.isCurrent(invocation)) return;
      if (result._tag === "Success") {
        const status = result.value.status;
        if (status === "conflict") {
          // Conflict disarms the confirmation; the reread below must not
          // perform the delete — a fresh confirmation is required.
          setDeleteArmed(false);
          deleteExpectedRef.current = null;
          setConflict(result.value.currentLatestVersion);
          void revalidateScope({ environmentId, input: { projectId } });
          return;
        }
        toastManager.add({ type: "success", title: deleteOutcomeCopy[status] });
        onClose();
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      setError(skillRejectionCopy(squashAtomCommandFailure(result)));
      setDeleteArmed(false);
    } finally {
      lock.end(invocation);
      if (lock.isCurrent(invocation)) setSaving(false);
    }
  };

  if (notFound) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Skill candidate</DialogTitle>
          <DialogDescription>This skill candidate no longer exists.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }
  if (
    detail.error !== null &&
    detail.data === null &&
    (seed !== null || conflictVersion !== null)
  ) {
    // A failed refresh deliberately has no previous value, but a preserved
    // revise draft (and its conflict gate) must stay reachable here — the
    // close-only screen would unmount and silently drop the draft. Retry the
    // actual query/revalidate signal; only a matching settled detail at or
    // above the conflict bound may install a seed or release the gate.
    return (
      <>
        <DialogHeader>
          <DialogTitle>Skill candidate</DialogTitle>
          <DialogDescription>
            Your draft is kept. The current version could not be loaded.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {seed !== null ? (
            <div className="grid gap-3 rounded-md border border-border p-3">
              <p className="text-sm font-medium">New version revising v{seed.fromVersion}</p>
              <SkillContentFields value={seed.fields} onChange={updateSeed} disabled={saving} />
            </div>
          ) : null}
          {conflictVersion !== null ? (
            <p className="text-sm text-muted-foreground" role="alert">
              A newer version (v{conflictVersion}) exists. Load the current version to continue.
            </p>
          ) : null}
          <p className="text-sm text-destructive">
            The skill candidate could not be loaded. Check the connection and try again.
          </p>
        </div>
        <DialogFooter>
          {conflictVersion !== null ? (
            <Button
              size="sm"
              variant="outline"
              disabled={loadingCurrent}
              onClick={() => void loadCurrent()}
            >
              Load current version
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={loadingCurrent}
              onClick={() => detail.refresh()}
            >
              Try again
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }
  if (detail.error !== null && detail.data === null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Skill candidate</DialogTitle>
          <DialogDescription>
            The skill candidate could not be loaded. Check the connection and try again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }
  const loaded = detail.data;
  const latest = loaded !== null ? latestVersionView(loaded) : null;
  if (loaded === null || latest === null) {
    return (
      <DialogHeader>
        <DialogTitle>Skill candidate</DialogTitle>
        <DialogDescription>Loading…</DialogDescription>
      </DialogHeader>
    );
  }
  const writesAdmitted =
    writeLock === null && !saving && conflictVersion === null && !loadingCurrent && detailSettled;
  const reviseAdmitted = writesAdmitted && seed !== null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{latest.version.content.title}</DialogTitle>
        <DialogDescription>
          Each version below shows its status for this project. Versions are immutable; revising
          adds a new version.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        {conflictVersion !== null ? (
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" size="sm">
                {VERSION_STATE_LABEL[latest.version.state]}
              </Badge>
              <p className="text-sm text-muted-foreground" role="alert">
                {seed !== null
                  ? `A newer version (v${conflictVersion}) exists. Your draft is kept — load the current version to continue, or discard your changes.`
                  : `A newer version (v${conflictVersion}) exists. Review it before deleting.`}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={loadingCurrent || detail.isPending}
                onClick={() => void loadCurrent()}
              >
                Load current version
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  // Cancels any in-flight load — its late result is ignored
                  // via the token — and resets the loading state instead of
                  // leaving the dialog latched.
                  loadSeqRef.current += 1;
                  setLoading(false);
                  installSeed(null);
                  setConflict(null);
                }}
              >
                {seed !== null ? "Discard changes" : "Dismiss"}
              </Button>
            </div>
          </div>
        ) : null}
        {seed !== null ? (
          <div className="grid gap-3 rounded-md border border-border p-3">
            <p className="text-sm font-medium">New version revising v{seed.fromVersion}</p>
            <SkillContentFields value={seed.fields} onChange={updateSeed} disabled={saving} />
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">{JUDGMENT_NOTICE}</p>
        {writeLock !== null ? <p className="text-xs text-muted-foreground">{writeLock}</p> : null}
        {notice !== null ? (
          <p className="text-sm text-muted-foreground" role="status">
            {notice}
          </p>
        ) : null}
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
        {loaded.versions.map((view) => (
          <VersionSection
            key={view.version.ref.version}
            view={view}
            trialCapability={trialCapability}
            lifecycleCapability={lifecycleCapability}
            lifecycleVersionCapability={
              lifecycleCapability && projectSkillStateSeqOf(loaded) !== null
            }
            useCapability={useCapability}
            writeDisabled={!writesAdmitted}
            projectThreads={projectThreads}
            scripts={scripts}
            onWithdraw={(ref, judgmentId) => void withdrawJudgment(ref, judgmentId)}
            onRecord={(ref, form) => void recordJudgmentOn(ref, form)}
            onRecordReproduction={(ref, form, readObservedEvidenceId) =>
              void recordEvidenceOn(
                ref,
                toRecordableReproduction(form),
                LIFECYCLE_REPRODUCTION_RECORDED,
                readObservedEvidenceId,
              )
            }
            onRecordNonApplication={(ref, form, readObservedEvidenceId) =>
              void recordEvidenceOn(
                ref,
                toRecordableNonApplication(form),
                LIFECYCLE_NON_APPLICATION_RECORDED,
                readObservedEvidenceId,
              )
            }
            onApplyLifecycle={(ref, target, readLiveTarget, intent) =>
              applyLifecycleVersion(ref, target, readLiveTarget, intent)
            }
            onRetire={(ref) => void retireVersion(ref)}
          />
        ))}
      </div>
      <DialogFooter>
        {seed === null ? (
          <>
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={!writesAdmitted}
              onClick={() => void remove()}
            >
              {deleteArmed ? "Confirm delete" : "Delete"}
            </Button>
            <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
              Close
            </Button>
            <Button size="sm" disabled={!writesAdmitted} onClick={startRevise}>
              Revise
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => installSeed(null)}>
              Cancel
            </Button>
            <Button size="sm" disabled={!reviseAdmitted} onClick={() => void saveRevise()}>
              Save new version
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

// ── Settings section ──────────────────────────────────────────────────────

/** Environment+project scoped skill-candidate list. Hidden without `manage`. */
export function ProjectSkillsSection({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  if (config?.environment.capabilities.projectSkills?.manage !== true) return null;
  return <ProjectSkillsSectionInner environmentId={environmentId} projectId={projectId} />;
}

function ProjectSkillsSectionInner({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const operateAccess = useProjectMemoryOperateAccess(environmentId);
  const writeLock = resolveSkillWriteLock(operateAccess);
  const [selectedId, setSelectedId] = useState<ProjectSkillId | null>(null);

  // Skills are isolated per environment+project; a scope switch starts clean.
  useEffect(() => {
    setSelectedId(null);
  }, [environmentId, projectId]);

  const results = useEnvironmentQuery(
    projectSkills.list({
      environmentId,
      input: { projectId, limit: PROJECT_SKILL_LIST_LIMIT.default },
    }),
  );
  const items: ReadonlyArray<ProjectSkillSummary> = results.data?.items ?? [];

  return (
    <SettingsSection title="Project skill candidates">
      <SettingsRow
        title="Project skill candidates"
        description="Saved procedure candidates for this project. Candidates are inactive for automatic use. You can explicitly send a selected version for a trial. Create one from a passed check in the chat header."
      />
      <div className="flex flex-col gap-2 px-6">
        {writeLock !== null ? <p className="text-xs text-muted-foreground">{writeLock}</p> : null}
        {results.error !== null ? (
          <div className="flex items-center gap-2">
            <p className="text-sm text-destructive">
              The skill candidate list could not be loaded. Try again.
            </p>
            <Button size="sm" variant="ghost" onClick={() => results.refresh()}>
              Retry
            </Button>
          </div>
        ) : null}
        {!results.isPending && items.length === 0 && results.error === null ? (
          <p className="py-2 text-sm text-muted-foreground">
            No skill candidates yet. Save one from a passed check in the chat header.
          </p>
        ) : null}
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.ref.skillId}>
              <button
                type="button"
                onClick={() => setSelectedId(item.ref.skillId)}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {item.title}
                </span>
                {item.rightsRecorded ? (
                  <Badge variant="outline" size="sm">
                    Rights recorded
                  </Badge>
                ) : null}
                {item.reviewRecorded ? (
                  <Badge variant="outline" size="sm">
                    Review recorded
                  </Badge>
                ) : null}
                <Badge variant="outline" size="sm">
                  {VERSION_STATE_LABEL[item.state]}
                </Badge>
                <span className="shrink-0 text-xs text-muted-foreground">v{item.ref.version}</span>
              </button>
            </li>
          ))}
        </ul>
        {results.data?.truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing the first {PROJECT_SKILL_LIST_LIMIT.default}.
          </p>
        ) : null}
      </div>
      {selectedId !== null ? (
        <ProjectSkillDialog
          environmentId={environmentId}
          projectId={projectId}
          skillId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </SettingsSection>
  );
}
