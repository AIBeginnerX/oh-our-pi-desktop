// Behavior regressions for the skill-candidate dialogs, rendered for real
// with the RPC/query/state boundaries mocked (same harness shape as the
// project-memory conflict tests). Assertions observe rendered state, real
// command payloads, toasts, and race outcomes — not callbacks in isolation.
//
// Harness fidelity notes: the registry channel stores the same AsyncResult
// wrapper the real atom registry holds (rights/review reads unwrap
// `AsyncResult.value`; lifecycle and evidence boundaries accept only a
// non-waiting Success). The rendered capability is `harness.capability`;
// registry-fresh reads derive from it and may be overridden separately. The
// catalog entry, prepared connection and supervisor generation are stable
// objects across reads so the post-await identity comparison accepts the
// unchanged positive control. They are only replaced deliberately inside the
// race cases.
import { StrictMode, act, type ReactElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  AuthOrchestrationOperateScope,
  MessageId,
  type EnvironmentId,
  type ProjectSkillTrialSummary,
  type ProjectId,
  type ProjectSkillCheckObservation,
  type ProjectSkillCandidateSourceIdentity,
  type ProjectSkillContent,
  type ProjectSkillDetail,
  ProjectSkillEvidenceId,
  type ProjectSkillId,
  type ProjectSkillJudgment,
  type ProjectSkillJudgmentId,
  type ProjectSkillSource,
  type ProjectSkillVersionView,
  type SelectedCheckPlannedCheck,
  type SelectedCheckReceipt,
  type SelectedCheckResult,
  TurnId,
  type ThreadId,
} from "@t3tools/contracts";
import type { SelectedChecksView } from "@t3tools/client-runtime/state/selected-checks-control";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { harness, harnessServerSettings, harnessConfigValue } = vi.hoisted(() => {
  const harnessServerSettings = () => ({
    defaultProjectScripts: [] as const,
    projectScriptOverrides: {},
    projectSettingsOverrides: {},
  });
  const harness = {
    // Render channels
    query: null as any,
    raw: null as any,
    capability: { manage: true } as any,
    access: "granted" as "granted" | "denied" | "pending",
    // Handler channel (registry reads at action boundaries). `registryCapability`
    // overrides only the registry-fresh manage read; the rendered config is
    // `capability` itself.
    registryValue: null as any,
    registryCapability: true,
    generatedDraftCap: false,
    // Stable connection identity the post-await stamp comparison needs
    registry: null as any,
    catalog: null as any,
    catalogEntry: null as any,
    conn: null as any,
    prepared: null as any,
    preparedConnection: null as any,
    // Sentinels the mocked atom families return
    CAPABILITY_ATOM: Symbol("capability"),
    SETTINGS_ATOM: Symbol("settings"),
    CATALOG_ATOM: Symbol("catalog"),
    CONN_ATOM: Symbol("conn"),
    PREPARED_ATOM: Symbol("prepared"),
    // Spies
    confirmSession: vi.fn(),
    create: vi.fn(),
    derive: vi.fn(),
    revise: vi.fn(),
    record: vi.fn(),
    withdraw: vi.fn(),
    delete: vi.fn(),
    activate: vi.fn(),
    retire: vi.fn(),
    revalidate: vi.fn(),
    toast: vi.fn(),
    project: null as any,
    threadShells: [] as any,
    panelSpy: vi.fn((_props: { open?: boolean; onSaveAsSkillCandidate?: () => void }) => null),
    checks: null as any,
  };
  const harnessConfigValue = () => {
    const base = harness.capability ?? { environment: { capabilities: {} } };
    const projectSkills = {
      ...(base.environment?.capabilities?.projectSkills ?? {}),
      manage: harness.registryCapability,
      ...(harness.generatedDraftCap ? { generatedDraft: true } : {}),
    };
    return {
      ...base,
      environment: {
        ...base.environment,
        capabilities: {
          ...base.environment?.capabilities,
          projectSkills,
        },
      },
      settings: base.settings ?? harnessServerSettings(),
    };
  };
  return { harness, harnessServerSettings, harnessConfigValue };
});

vi.mock("@effect/atom-react", async () => {
  const react = await import("react");
  return {
    RegistryContext: react.createContext(null),
    useAtomValue: (atom: unknown) =>
      atom === harness.CAPABILITY_ATOM ? harness.capability : harness.raw,
  };
});
vi.mock("../../state/projectSkills", () => ({
  projectSkills: {
    get: (target: any) => target,
    list: () => null,
    createCandidate: "create",
    deriveDraft: "derive",
    revise: "revise",
    recordJudgment: "record",
    withdrawJudgment: "withdraw",
    delete: "delete",
    activate: "activate",
    retire: "retire",
    revalidate: "revalidate",
  },
}));
vi.mock("../../state/entities", () => ({
  useProject: () => harness.project,
  useThreadShellsForProjectRefs: () => harness.threadShells,
  readProject: (ref: { projectId: string }) =>
    harness.project?.id === ref.projectId ? harness.project : null,
  readThreadShell: (ref: { threadId: string }) => {
    const shell = harness.threadShells.find((thread: { id: string }) => thread.id === ref.threadId);
    if (shell === undefined) return null;
    return {
      id: shell.id,
      projectId: shell.projectId,
      createdAt: shell.createdAt ?? "2026-10-11T00:00:00.000Z",
      archivedAt: shell.archivedAt ?? null,
    };
  },
}));
vi.mock("../../state/selectedChecks", () => ({
  selectedChecksSessionConfirmation: "confirmSession",
  useSelectedChecks: () => harness.checks,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    (harness as Record<string, unknown>)[String(command)] ?? vi.fn(),
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => harness.query }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => harness.CAPABILITY_ATOM,
    settingsValueAtom: () => harness.SETTINGS_ATOM,
  },
}));
vi.mock("../../state/session", () => ({
  environmentSession: { preparedConnectionValueAtom: () => harness.PREPARED_ATOM },
  useEnvironmentSessionState: () => ({ data: null, isPending: false, hasError: false }),
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    catalogValueAtom: harness.CATALOG_ATOM,
    stateAtom: () => harness.CONN_ATOM,
  },
}));
vi.mock("@t3tools/client-runtime/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/connection")>();
  return {
    ...actual,
    AVAILABLE_CONNECTION_STATE: { phase: "connected", generation: 7 },
  };
});
vi.mock("./ProjectMemorySection", () => ({
  useProjectMemoryOperateAccess: () => harness.access,
}));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/select", () => {
  const React = require("react");
  return {
    Select: ({ value, onValueChange, disabled, children }: Record<string, unknown>) =>
      React.createElement(
        "div",
        { onValueChange, "data-select-value": value ?? "", "data-select-disabled": disabled },
        children,
      ),
    SelectTrigger: ({ "aria-label": ariaLabel, children }: Record<string, unknown>) =>
      React.createElement("div", { "aria-label": ariaLabel }, children),
    SelectItem: "option",
    SelectPopup: "div",
    SelectValue: "span",
  };
});
vi.mock("../ui/textarea", () => ({ Textarea: "input" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "span", ToggleGroup: "div" }));
vi.mock("../ui/dialog", () => ({
  Dialog: "div",
  DialogPopup: "div",
  DialogHeader: "header",
  DialogTitle: "h1",
  DialogDescription: "p",
  DialogFooter: "footer",
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: harness.toast } }));
vi.mock("./settingsLayout", () => ({ SettingsRow: "div", SettingsSection: "section" }));

import { RegistryContext } from "@effect/atom-react";
import {
  deleteOutcomeCopy,
  LIFECYCLE_SCOPE_DRIFT_COPY,
  LIFECYCLE_STATE_UNKNOWN_COPY,
  LIFECYCLE_UNSUPPORTED_COPY,
  LIFECYCLE_USE_UNAVAILABLE_COPY,
  DERIVE_UNAVAILABLE_COPY,
  SKILL_AUTHORIZATION_COPY,
  withdrawOutcomeCopy,
} from "./ProjectSkillsSection.logic";
import {
  ProjectSkillCandidateDialog,
  ProjectSkillDialog,
  ProjectSkillsSection,
  VersionTrialHistory,
} from "./ProjectSkillsSection";
import { VERSION_TRIAL_HISTORY_TITLE } from "./ProjectSkillsSection.logic";
import { SelectedChecksControl } from "../chat/ChatHeader";
import type { CurrentChecksSource } from "./ProjectSkillsSection";

const ENV = "env-a" as EnvironmentId;
const PROJECT = "project-a" as ProjectId;
const PROJECT_B = "project-b" as ProjectId;
const SKILL_A = "psk_aaaa1111" as ProjectSkillId;
const SKILL_B = "psk_bbbb2222" as ProjectSkillId;

const SENTINEL = "SENTINEL-USER-CONTENT-LEAK";
const CONFIRM_FAILED_COPY = "Your access could not be confirmed right now. Try again.";
const SKILL_UNSUPPORTED_COPY = "This server does not support skill candidates.";
const SOURCE_INVALID_COPY =
  "This source is no longer current. Run the checks again and save from the new record.";
const VERSION_GONE_COPY =
  "That version changed on the server. The view has been refreshed — review and try again.";

const confirmedSession = {
  kind: "confirmed",
  session: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
};

// ── Typed fixtures: a real receipt and check observation, as the contracts'
// own tests build them, so the frozen sources carry the full schema. ─────────

const shaEnv = "a".repeat(64);
const shaCommand = "b".repeat(64);
const shaStderr = "e".repeat(64);
const treeOid = "c".repeat(40);

const plannedCheck = (scriptId: string, scriptName: string): SelectedCheckPlannedCheck => ({
  scriptId,
  scriptName,
  commandSha256: shaCommand,
  timeoutMs: 60_000,
});

const passedResult = (
  scriptId: string,
  startedAt: string,
  endedAt: string,
): SelectedCheckResult => ({
  scriptId,
  status: "passed",
  startedAt,
  endedAt,
  exitCode: 0,
  exitedBy: "exit",
  exitSignal: null,
  pgid: 41234,
  group: "empty",
  stdout: { bytes: 120, sha256: shaEnv },
  stderr: { bytes: 0, sha256: shaStderr },
  failure: null,
});

const passingReceipt = (
  attemptId: string,
  revision: number,
  planned: ReadonlyArray<SelectedCheckPlannedCheck>,
): SelectedCheckReceipt => ({
  schemaVersion: 1,
  threadId: "thread-1" as ThreadId,
  attemptId,
  revision,
  threadAnchorSequence: 20,
  context: {
    projectId: PROJECT,
    workspaceRoot: "/tmp/workspace",
    worktreePath: null,
    cwd: "/tmp/workspace",
    shell: "/bin/zsh",
    envSha256: shaEnv,
  },
  planned: [...planned],
  environment: {
    environmentId: ENV,
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.6.0",
    serverVersion: "1.0.0",
    nodeVersion: "24.0.0",
  },
  tree: {
    atStart: { kind: "complete", treeOid },
    atEnd: { kind: "complete", treeOid },
    repoAtStart: { topLevel: "/tmp/workspace", commonDir: "/tmp/workspace" },
    repoAtEnd: { topLevel: "/tmp/workspace", commonDir: "/tmp/workspace" },
  },
  phase: "completed",
  checks: [
    passedResult(planned[0]!.scriptId, "2026-10-11T00:00:00Z", "2026-10-11T00:00:30Z"),
    ...(planned[1]
      ? [passedResult(planned[1].scriptId, "2026-10-11T00:00:30Z", "2026-10-11T00:01:00Z")]
      : []),
  ],
  startedAt: "2026-10-11T00:00:00Z",
  endedAt: "2026-10-11T00:01:00Z",
  error: null,
});

const receiptV1 = passingReceipt("attempt-1", 3, [
  plannedCheck("s1", "Lint"),
  plannedCheck("s2", "Test"),
]);
const receiptV2 = passingReceipt("attempt-2", 1, [plannedCheck("s2", "Typecheck")]);

const checkObservation: ProjectSkillCheckObservation = {
  threadId: "thread-1" as ThreadId,
  threadAnchorSequence: 20,
  receiptSequence: 42,
  attemptId: "attempt-1",
  revision: 3,
  projectId: PROJECT,
  workspaceRoot: "/tmp/workspace",
  worktreePath: null,
  cwd: "/tmp/workspace",
  envSha256: shaEnv,
  planned: [plannedCheck("s1", "Lint")],
  tree: { treeOid, repoTopLevel: "/tmp/workspace", repoCommonDir: "/tmp/workspace" },
  environment: {
    environmentId: ENV,
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.6.0",
    serverVersion: "1.0.0",
    nodeVersion: "24.0.0",
  },
  startedAt: "2026-10-11T00:00:00Z",
  endedAt: "2026-10-11T01:00:00Z",
  outcome: "all-selected-passed",
};

// A full passing checks view, as the selected-checks control would derive it.
const passingView = (overrides: Partial<SelectedChecksView> = {}): SelectedChecksView => ({
  open: true,
  headline: "passed",
  hasCurrentAuthority: true,
  getInFlight: false,
  getError: null,
  record: { receipt: receiptV1, sequence: 42 },
  recordAuthority: "current",
  derived: null,
  live: null,
  liveIsNewer: false,
  admission: null,
  capability: null,
  changedScriptIds: [],
  comparisonStale: false,
  newerTurnAfterRecord: false,
  selection: [],
  pendingRunAttemptId: null,
  commandInFlight: null,
  notice: null,
  stopAttemptId: null,
  canRun: true,
  canStop: false,
  canRecover: false,
  dialog: null,
  dialogSubmit: null,
  ...overrides,
});

const contentV1: ProjectSkillContent = {
  title: "Deploy site",
  purpose: "Ship the staging build",
  appliesWhen: "Staging is behind",
  doesNotApplyWhen: "Production",
  procedure: "1. Build\n2. Deploy",
  successCheck: "Selected checks pass: lint",
};
const refV1 = { projectId: PROJECT, skillId: SKILL_A, version: 1, contentSha256: shaEnv };
const workSourceV1: Extract<ProjectSkillSource, { type: "work" }> = {
  type: "work",
  check: checkObservation,
  createdAfterEventSequence: 5,
  draft: { type: "typed" },
};
const versionViewV1: ProjectSkillVersionView = {
  version: {
    ref: refV1,
    content: contentV1,
    source: workSourceV1,
    state: "candidate",
    retiredReason: null,
    createdAt: "2026-10-11T00:00:00.000Z",
  },
  judgments: [],
  rightsRecorded: false,
  reviewRecorded: false,
};
const detailV1: ProjectSkillDetail = {
  projectId: PROJECT,
  skillId: SKILL_A,
  latestVersion: 1,
  versions: [versionViewV1],
};
const versionViewV2: ProjectSkillVersionView = {
  ...versionViewV1,
  version: {
    ...versionViewV1.version,
    ref: { ...refV1, version: 2, contentSha256: "b".repeat(64) },
    content: { ...contentV1, title: "Deploy site v2" },
    source: {
      type: "revision",
      fromVersion: 1,
      createdAfterEventSequence: 9,
      root: workSourceV1,
    },
  },
};
const detailV2: ProjectSkillDetail = {
  projectId: PROJECT,
  skillId: SKILL_A,
  latestVersion: 2,
  versions: [versionViewV2, versionViewV1],
};
const versionViewV3: ProjectSkillVersionView = {
  ...versionViewV1,
  version: {
    ...versionViewV1.version,
    ref: { ...refV1, version: 3, contentSha256: "c".repeat(64) },
    content: { ...contentV1, title: "Deploy site v3" },
    source: {
      type: "revision",
      fromVersion: 2,
      createdAfterEventSequence: 12,
      root: workSourceV1,
    },
  },
};
const detailV3: ProjectSkillDetail = {
  projectId: PROJECT,
  skillId: SKILL_A,
  latestVersion: 3,
  versions: [versionViewV3, versionViewV2, versionViewV1],
};
// A later detail in which the captured v1 no longer exists at all.
const detailV1Gone: ProjectSkillDetail = {
  projectId: PROJECT,
  skillId: SKILL_A,
  latestVersion: 2,
  versions: [versionViewV2],
};
const judgmentId = "pjg_1" as ProjectSkillJudgmentId;
const rightsJudgment: ProjectSkillJudgment = {
  kind: "rights",
  judgmentId,
  ref: refV1,
  recordedAt: "2026-10-11T02:00:00.000Z",
  recordedBy: "authenticated-client",
  basis: "own-work",
  originalSource: null,
  license: null,
  note: "mine",
};
const detailWithJudgment: ProjectSkillDetail = {
  ...detailV1,
  versions: [
    {
      ...versionViewV1,
      judgments: [{ judgment: rightsJudgment, recordedAfterEventSequence: 9, withdrawnAt: null }],
      rightsRecorded: true,
    },
  ],
};

const settled = (data: ProjectSkillDetail) => ({
  data,
  dataUpdatedAt: 1,
  error: null,
  isPending: false,
  isSuccess: true,
  refresh: vi.fn(),
});

let renderer: ReactTestRenderer | null = null;
const render = (element: ReactElement) => {
  const tree = (
    <StrictMode>
      <RegistryContext.Provider value={harness.registry}>{element}</RegistryContext.Provider>
    </StrictMode>
  );
  act(() => {
    if (renderer) renderer.update(tree);
    else renderer = create(tree);
  });
};
const button = (text: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.some((c) => c === text))!;
const hasButton = (text: string) =>
  renderer!.root.findAllByType("button").some((node) => node.children.some((c) => c === text));
const hasText = (text: string) =>
  renderer!.root.findAll((node) => node.children.some((c) => c === text)).length > 0;
const editField = (label: string, value: string) =>
  act(() =>
    renderer!.root
      .findByProps({ "aria-label": label })
      .props.onChange({ currentTarget: { value } }),
  );
const primeRightsJudgment = () => {
  const basisGroup = renderer!.root.findAllByProps({ "aria-label": "Rights basis" })[0]!;
  act(() => basisGroup.props.onValueChange(["own-work"]));
  editField("Judgment note", "wrote it myself");
};

/** The dialog renders the registry channel through the real AsyncResult wrapper. */
const useDetail = (detail: ProjectSkillDetail) => {
  harness.query = settled(detail);
  harness.raw = AsyncResult.success(detail);
  harness.registryValue = AsyncResult.success(detail);
};
const detailPending = () => {
  harness.query = {
    data: null,
    dataUpdatedAt: 0,
    error: null,
    isPending: true,
    isSuccess: false,
    refresh: vi.fn(),
  };
  harness.raw = AsyncResult.initial();
  harness.registryValue = AsyncResult.initial();
};
const detailFailure = (cause: unknown, error = "The request failed.") => {
  harness.query = {
    data: null,
    dataUpdatedAt: 0,
    error,
    isPending: false,
    isSuccess: false,
    refresh: vi.fn(),
  };
  harness.raw = AsyncResult.failure(Cause.fail(cause));
  harness.registryValue = AsyncResult.failure(Cause.fail(cause));
};

const dialogArgs = {
  environmentId: ENV,
  projectId: PROJECT,
  skillId: SKILL_A,
  onClose: vi.fn(),
};

/** The Select owning a trigger label: the nearest ancestor carrying `onValueChange`. */
const selectFor = (label: string): ReactTestInstance => {
  let node: ReactTestInstance | null = renderer!.root.findByProps({ "aria-label": label });
  while (node !== null && typeof node.props.onValueChange !== "function") node = node.parent;
  if (node === null) throw new Error(`Select trigger "${label}" not found`);
  return node;
};
const selectByTriggerLabel = (label: string, value: string) => {
  act(() => {
    selectFor(label).props.onValueChange(value);
  });
};
const selectedValueOf = (label: string): unknown => selectFor(label).props["data-select-value"];

/** The checkbox inside the label with this visible text, never "any unchecked box". */
const checkboxByLabel = (text: string) =>
  renderer!.root
    .findAllByType("label")
    .find((label) => label.findAllByType("span").some((span) => span.children.includes(text)))!
    .findByType("input");

/**
 * Lets awaited continuations run while an enclosing async `act` is still open:
 * React commits and effects flush only when that `act` exits, so a continuation
 * drained here observes nothing but synchronous state.
 */
const drainMicrotasks = async () => {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
};

/**
 * Holds the bounded session confirmation so the test stands exactly at the
 * awaited barrier: the returned resolver releases it after the registry has
 * been mutated. Reaching the barrier is asserted by the caller.
 */
const beginHeldConfirmation = (): ((value: unknown) => void) => {
  let resolveConfirm: (value: unknown) => void = () => {};
  const pending = new Promise<unknown>((resolve) => {
    resolveConfirm = resolve;
  });
  harness.confirmSession.mockReturnValueOnce(pending);
  return resolveConfirm;
};

const reviseIntoConflict = async () => {
  useDetail(detailV1);
  render(<ProjectSkillDialog {...dialogArgs} />);
  act(() => button("Revise").props.onClick());
  editField("Skill Title", "edited title");
  harness.revise.mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail({ _tag: "ProjectSkillStoreConflictError", currentLatestVersion: 2 }),
    ),
  );
  await act(async () => button("Save new version").props.onClick());
  expect(harness.revise).toHaveBeenCalledTimes(1);
  expect(harness.revise.mock.calls[0]![0].input.expectedLatestVersion).toBe(1);
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.capability = {
    environment: { capabilities: { projectSkills: { manage: true } } },
    settings: harnessServerSettings(),
  };
  harness.access = "granted";
  harness.registryCapability = true;
  harness.generatedDraftCap = false;
  harness.raw = AsyncResult.initial(false);
  harness.query = { data: null, error: null, isPending: false };
  harness.registryValue = null;
  // Stable connection identity: the same entry/prepared objects (and the same
  // connection AsyncResult) come back from every registry read, so an
  // unchanged stamp compares equal by reference.
  harness.catalogEntry = { id: ENV };
  harness.catalog = { entries: new Map([[ENV, harness.catalogEntry]]) };
  harness.conn = AsyncResult.success({ phase: "connected", generation: 7 });
  harness.preparedConnection = { id: "prepared-1" };
  harness.prepared = Option.some(harness.preparedConnection);
  harness.registry = {
    get: (atom: unknown) => {
      if (atom === harness.CAPABILITY_ATOM) {
        return harnessConfigValue();
      }
      if (atom === harness.SETTINGS_ATOM) {
        return harness.capability?.settings ?? harnessServerSettings();
      }
      if (atom === harness.CATALOG_ATOM) return harness.catalog;
      if (atom === harness.CONN_ATOM) return harness.conn;
      if (atom === harness.PREPARED_ATOM) return harness.prepared;
      return harness.registryValue;
    },
  };
  for (const key of [
    "confirmSession",
    "create",
    "derive",
    "revise",
    "record",
    "withdraw",
    "delete",
    "activate",
    "retire",
    "revalidate",
    "toast",
  ] as const) {
    harness[key].mockReset();
  }
  harness.confirmSession.mockResolvedValue(AsyncResult.success(confirmedSession));
  harness.revise.mockResolvedValue(AsyncResult.success(versionViewV2));
  harness.record.mockResolvedValue(
    AsyncResult.success({
      judgment: rightsJudgment,
      recordedAfterEventSequence: 10,
      withdrawnAt: null,
    }),
  );
  harness.withdraw.mockResolvedValue(AsyncResult.success({ status: "applied" }));
  harness.delete.mockResolvedValue(AsyncResult.success({ status: "applied" }));
  harness.activate.mockResolvedValue(AsyncResult.success({ stateSeq: 5 }));
  harness.retire.mockResolvedValue(AsyncResult.success({ stateSeq: 7 }));
  harness.revalidate.mockResolvedValue(AsyncResult.success(undefined));
  dialogArgs.skillId = SKILL_A;
  dialogArgs.onClose.mockReset();
  candidateArgs.source = frozenSource;
  candidateArgs.view = passingView();
  candidateArgs.permission = "allowed";
  candidateArgs.manage = true;
  candidateArgs.onAuthorizationRejected = null;
  readCurrent.current = currentSource();
  candidateArgs.onClose.mockReset();
  harness.panelSpy.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

// ── Revise conflict flow ──────────────────────────────────────────────────

it("keeps the draft gated through a revise conflict until a fresh version is loaded", async () => {
  await reviseIntoConflict();

  // The draft survives, writes are gated, and the scope was revalidated.
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "edited title",
  );
  expect(button("Save new version").props.disabled).toBe(true);
  expect(harness.revalidate).toHaveBeenCalledTimes(1);
  expect(harness.revalidate.mock.calls[0]![0].input.projectId).toBe(PROJECT);

  // The confirmation captured the exact connection stamp it will compare after
  // its own await boundary.
  expect(harness.confirmSession).toHaveBeenCalledTimes(1);
  expect(harness.confirmSession.mock.calls[0]![0].environmentId).toBe(ENV);
  expect(harness.confirmSession.mock.calls[0]![0].input.generation).toBe(7);
  expect(harness.confirmSession.mock.calls[0]![0].input.entry).toBe(harness.catalogEntry);
  expect(harness.confirmSession.mock.calls[0]![0].input.prepared).toBe(harness.preparedConnection);

  // The still-cached v1 response must not release the gate or move the draft.
  act(() => button("Load current version").props.onClick());
  await act(async () => {});
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "edited title",
  );
  expect(button("Save new version").props.disabled).toBe(true);
  expect(harness.revise).toHaveBeenCalledTimes(1);

  // A settled v2 response for this skill releases the gate via Load current.
  useDetail(detailV2);
  render(<ProjectSkillDialog {...dialogArgs} />);
  await act(async () => {});
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "Deploy site v2",
  );
  expect(button("Save new version").props.disabled).toBe(false);

  await act(async () => button("Save new version").props.onClick());
  expect(harness.confirmSession).toHaveBeenCalledTimes(2);
  expect(harness.revise).toHaveBeenCalledTimes(2);
  expect(harness.revise.mock.calls[1]![0].input.fromVersion).toBe(2);
  expect(harness.revise.mock.calls[1]![0].input.expectedLatestVersion).toBe(2);
  expect(harness.revise.mock.calls[1]![0].input.content.title).toBe("Deploy site v2");
});

it("aborts when the version paired with the draft changes during the awaited confirmation", async () => {
  useDetail(detailV1);
  render(<ProjectSkillDialog {...dialogArgs} />);
  act(() => button("Revise").props.onClick());
  editField("Skill Title", "edited title");

  // The save stands at the confirmation barrier: exactly one bounded session
  // confirmation is outstanding and nothing has been written yet.
  const resolveConfirm = beginHeldConfirmation();
  act(() => button("Save new version").props.onClick());
  await act(async () => {});
  expect(harness.confirmSession).toHaveBeenCalledTimes(1);
  expect(harness.revise).not.toHaveBeenCalled();

  // A v2 lands while the confirmation is in flight, before its release.
  harness.registryValue = AsyncResult.success(detailV2);
  await act(async () => resolveConfirm(AsyncResult.success(confirmedSession)));
  await act(async () => {});

  expect(harness.revise).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "edited title",
  );
  expect(button("Save new version").props.disabled).toBe(true);
  expect(
    hasText(
      "A newer version (v2) exists. Your draft is kept — load the current version to continue, or discard your changes.",
    ),
  ).toBe(true);
  expect(harness.revalidate).toHaveBeenCalledTimes(1);
  expect(harness.revalidate.mock.calls[0]![0].input.projectId).toBe(PROJECT);
});

it("keeps the draft and allows retry when the confirmation lacks the operate scope", async () => {
  useDetail(detailV1);
  render(<ProjectSkillDialog {...dialogArgs} />);
  act(() => button("Revise").props.onClick());
  harness.confirmSession.mockResolvedValueOnce(
    AsyncResult.success({ kind: "confirmed", session: { authenticated: true, scopes: [] } }),
  );
  await act(async () => button("Save new version").props.onClick());

  expect(harness.revise).not.toHaveBeenCalled();
  expect(hasText(SKILL_AUTHORIZATION_COPY)).toBe(true);
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "Deploy site",
  );

  // The retry reconfirms from scratch: one fresh confirmation, one write.
  await act(async () => button("Save new version").props.onClick());
  expect(harness.confirmSession).toHaveBeenCalledTimes(2);
  expect(harness.revise).toHaveBeenCalledTimes(1);
  expect(harness.revise.mock.calls[0]![0].input.content.title).toBe("Deploy site");
  expect(harness.toast).toHaveBeenCalledWith({ type: "success", title: "New version saved" });
});

// ── Post-confirmation authority: the shared final guard ───────────────────

it.each([
  {
    label: "catalog entry",
    mutate: () => {
      harness.catalogEntry = { id: ENV };
      harness.catalog = { entries: new Map([[ENV, harness.catalogEntry]]) };
    },
  },
  {
    label: "prepared connection",
    mutate: () => {
      harness.preparedConnection = { id: "prepared-2" };
      harness.prepared = Option.some(harness.preparedConnection);
    },
  },
  {
    label: "supervisor generation",
    mutate: () => {
      harness.conn = AsyncResult.success({ phase: "connected", generation: 8 });
    },
  },
])(
  "refuses the revise write when the confirmed $label changed before release",
  async ({ mutate }) => {
    useDetail(detailV1);
    render(<ProjectSkillDialog {...dialogArgs} />);
    act(() => button("Revise").props.onClick());
    editField("Skill Title", "edited title");

    const resolveConfirm = beginHeldConfirmation();
    act(() => button("Save new version").props.onClick());
    await act(async () => {});
    expect(harness.confirmSession).toHaveBeenCalledTimes(1);
    expect(harness.revise).not.toHaveBeenCalled();

    mutate();
    await act(async () => resolveConfirm(AsyncResult.success(confirmedSession)));
    await act(async () => {});

    expect(harness.revise).not.toHaveBeenCalled();
    expect(harness.revalidate).not.toHaveBeenCalled();
    expect(hasText(CONFIRM_FAILED_COPY)).toBe(true);
  },
);

const armHandler = (handler: "revise" | "record" | "withdraw" | "delete"): (() => void) => {
  switch (handler) {
    case "revise": {
      useDetail(detailV1);
      render(<ProjectSkillDialog {...dialogArgs} />);
      act(() => button("Revise").props.onClick());
      return () => button("Save new version").props.onClick();
    }
    case "record": {
      useDetail(detailV1);
      render(<ProjectSkillDialog {...dialogArgs} />);
      primeRightsJudgment();
      return () => button("Record judgment").props.onClick();
    }
    case "withdraw": {
      useDetail(detailWithJudgment);
      render(<ProjectSkillDialog {...dialogArgs} />);
      return () => button("Withdraw").props.onClick();
    }
    case "delete": {
      useDetail(detailV1);
      render(<ProjectSkillDialog {...dialogArgs} />);
      act(() => button("Delete").props.onClick());
      return () => button("Confirm delete").props.onClick();
    }
  }
};

it.each(["revise", "record", "withdraw", "delete"] as const)(
  "blocks the %s write when the manage capability is lost after confirmation",
  async (handler) => {
    const trigger = armHandler(handler);
    const resolveConfirm = beginHeldConfirmation();
    act(() => trigger());
    await act(async () => {});
    expect(harness.confirmSession).toHaveBeenCalledTimes(1);

    // The rendered access still looks granted; the registry-fresh capability
    // read after the await is what refuses the command.
    harness.registryCapability = false;
    await act(async () => resolveConfirm(AsyncResult.success(confirmedSession)));
    await act(async () => {});

    expect(harness.revise).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
    expect(harness.withdraw).not.toHaveBeenCalled();
    expect(harness.delete).not.toHaveBeenCalled();
    expect(hasText(SKILL_UNSUPPORTED_COPY)).toBe(true);
  },
);

it.each(["record", "withdraw"] as const)(
  "refuses the %s write when the exact judgment ref is missing after confirmation",
  async (handler) => {
    const trigger = armHandler(handler);
    const resolveConfirm = beginHeldConfirmation();
    act(() => trigger());
    await act(async () => {});
    expect(harness.confirmSession).toHaveBeenCalledTimes(1);

    // A reread landed a detail without the captured version; the judgment must
    // never move onto the newer version.
    harness.registryValue = AsyncResult.success(detailV1Gone);
    await act(async () => resolveConfirm(AsyncResult.success(confirmedSession)));
    await act(async () => {});

    expect(harness.record).not.toHaveBeenCalled();
    expect(harness.withdraw).not.toHaveBeenCalled();
    expect(hasText(VERSION_GONE_COPY)).toBe(true);
    expect(harness.revalidate).toHaveBeenCalledTimes(1);
    expect(harness.revalidate.mock.calls[0]![0].input.projectId).toBe(PROJECT);
  },
);

// ── Delete ────────────────────────────────────────────────────────────────

it("captures the delete confirmation version; conflict disarms and a reread never auto-deletes", async () => {
  useDetail(detailV1);
  render(<ProjectSkillDialog {...dialogArgs} />);

  act(() => button("Delete").props.onClick());
  expect(button("Confirm delete")).toBeDefined();
  harness.delete.mockResolvedValueOnce(
    AsyncResult.success({ status: "conflict", currentLatestVersion: 3 }),
  );
  await act(async () => button("Confirm delete").props.onClick());

  // The captured expected version was used; the dialog stays, no toast fired,
  // and the confirmation was disarmed pending a fresh review.
  expect(harness.delete).toHaveBeenCalledTimes(1);
  expect(harness.delete.mock.calls[0]![0].input.expectedLatestVersion).toBe(1);
  expect(harness.toast).not.toHaveBeenCalled();
  expect(dialogArgs.onClose).not.toHaveBeenCalled();
  expect(hasButton("Confirm delete")).toBe(false);
  expect(hasText("A newer version (v3) exists. Review it before deleting.")).toBe(true);
  expect(harness.revalidate).toHaveBeenCalled();

  // The reread lands v3 — by itself it must not substitute the expected
  // version and delete, and the banner holds until the review is loaded.
  useDetail(detailV3);
  render(<ProjectSkillDialog {...dialogArgs} />);
  await act(async () => {});
  expect(hasText("A newer version (v3) exists. Review it before deleting.")).toBe(true);
  expect(hasButton("Confirm delete")).toBe(false);
  expect(harness.delete).toHaveBeenCalledTimes(1);

  // Loading the reviewed v3 releases the gate without any delete having run.
  act(() => button("Load current version").props.onClick());
  await act(async () => {});
  expect(hasText("A newer version (v3) exists. Review it before deleting.")).toBe(false);
  expect(hasButton("Confirm delete")).toBe(false);
  expect(harness.delete).toHaveBeenCalledTimes(1);

  // A fresh review arms a fresh capture, and only its confirmation deletes.
  act(() => button("Delete").props.onClick());
  await act(async () => button("Confirm delete").props.onClick());
  expect(harness.delete).toHaveBeenCalledTimes(2);
  expect(harness.delete.mock.calls[1]![0].input.expectedLatestVersion).toBe(3);
  expect(harness.toast).toHaveBeenCalledWith({
    type: "success",
    title: deleteOutcomeCopy.applied,
  });
  expect(dialogArgs.onClose).toHaveBeenCalled();
});

it("gives delete's not-found its own copy and closes", async () => {
  useDetail(detailV1);
  render(<ProjectSkillDialog {...dialogArgs} />);
  act(() => button("Delete").props.onClick());
  harness.delete.mockResolvedValueOnce(AsyncResult.success({ status: "not-found" }));
  await act(async () => button("Confirm delete").props.onClick());

  expect(harness.delete).toHaveBeenCalledTimes(1);
  expect(harness.toast).toHaveBeenCalledTimes(1);
  expect(harness.toast).toHaveBeenCalledWith({
    type: "success",
    title: deleteOutcomeCopy["not-found"],
  });
  expect(dialogArgs.onClose).toHaveBeenCalled();
});

// ── Withdraw ──────────────────────────────────────────────────────────────

it("reports an already-withdrawn judgment without a success toast and refreshes", async () => {
  useDetail(detailWithJudgment);
  render(<ProjectSkillDialog {...dialogArgs} />);

  harness.withdraw.mockResolvedValueOnce(AsyncResult.success({ status: "already-withdrawn" }));
  await act(async () => button("Withdraw").props.onClick());

  expect(harness.withdraw).toHaveBeenCalledTimes(1);
  expect(harness.withdraw.mock.calls[0]![0].input.ref).toEqual(refV1);
  expect(harness.toast).not.toHaveBeenCalled();
  expect(harness.revalidate).toHaveBeenCalled();
  expect(hasText("That judgment was already withdrawn.")).toBe(true);
});

it("toasts only the applied withdraw; not-found is a notice plus refresh", async () => {
  useDetail(detailWithJudgment);
  render(<ProjectSkillDialog {...dialogArgs} />);

  await act(async () => button("Withdraw").props.onClick());
  expect(harness.withdraw).toHaveBeenCalledTimes(1);
  expect(harness.withdraw.mock.calls[0]![0]).toEqual({
    environmentId: ENV,
    input: { ref: refV1, judgmentId },
  });
  expect(harness.toast).toHaveBeenCalledTimes(1);
  expect(harness.toast).toHaveBeenCalledWith({
    type: "success",
    title: withdrawOutcomeCopy.applied,
  });
  expect(harness.revalidate).not.toHaveBeenCalled();

  harness.withdraw.mockResolvedValueOnce(AsyncResult.success({ status: "not-found" }));
  await act(async () => button("Withdraw").props.onClick());
  expect(harness.withdraw).toHaveBeenCalledTimes(2);
  // Still exactly one toast: the refresh outcomes never count as applied.
  expect(harness.toast).toHaveBeenCalledTimes(1);
  expect(hasText(withdrawOutcomeCopy["not-found"])).toBe(true);
  expect(harness.revalidate).toHaveBeenCalledTimes(1);
});

// ── Record judgment ───────────────────────────────────────────────────────

it("records a judgment with the exact captured ref and the user-owned body", async () => {
  useDetail(detailV1);
  render(<ProjectSkillDialog {...dialogArgs} />);

  primeRightsJudgment();
  await act(async () => button("Record judgment").props.onClick());

  expect(harness.record).toHaveBeenCalledTimes(1);
  expect(harness.record.mock.calls[0]![0]).toEqual({
    environmentId: ENV,
    input: {
      ref: refV1,
      judgment: {
        kind: "rights",
        basis: "own-work",
        originalSource: null,
        license: null,
        note: "wrote it myself",
      },
    },
  });
  expect(harness.toast).toHaveBeenCalledWith({ type: "success", title: "Judgment recorded" });
});

it("refuses to record without a deliberate basis — none is defaulted", async () => {
  useDetail(detailV1);
  render(<ProjectSkillDialog {...dialogArgs} />);

  await act(async () => button("Record judgment").props.onClick());

  expect(harness.record).not.toHaveBeenCalled();
  expect(harness.confirmSession).not.toHaveBeenCalled();
  expect(
    hasText("Select a basis (or check all three review boxes) and add a note within the limits."),
  ).toBe(true);
});

// ── Fixed copy for server rejections ──────────────────────────────────────

it("keeps the draft and shows fixed copy for store and unknown rejections", async () => {
  useDetail(detailV1);
  render(<ProjectSkillDialog {...dialogArgs} />);
  act(() => button("Revise").props.onClick());
  editField("Skill Title", "edited title");

  harness.revise.mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail({ _tag: "ProjectSkillStoreError", message: `${SENTINEL} boom` }),
    ),
  );
  await act(async () => button("Save new version").props.onClick());
  expect(harness.revise).toHaveBeenCalledTimes(1);
  expect(hasText(SENTINEL)).toBe(false);
  expect(hasText("The server could not save this change. Try again.")).toBe(true);
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "edited title",
  );

  harness.revise.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error(`${SENTINEL} boom`))),
  );
  await act(async () => button("Save new version").props.onClick());
  expect(harness.revise).toHaveBeenCalledTimes(2);
  expect(hasText(SENTINEL)).toBe(false);
  expect(hasText("The request failed. Try again.")).toBe(true);
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "edited title",
  );
});

// ── Read-only access ──────────────────────────────────────────────────────

it("shows the detail read-only and blocks every handler when access is denied", async () => {
  useDetail(detailWithJudgment);
  render(<ProjectSkillDialog {...dialogArgs} />);

  // Prime a valid judgment form first, so the refusals below are attributable
  // to the access gate rather than an invalid form.
  primeRightsJudgment();

  harness.access = "denied";
  render(<ProjectSkillDialog {...dialogArgs} />);

  expect(hasText("Deploy site")).toBe(true);
  expect(button("Revise").props.disabled).toBe(true);
  expect(button("Delete").props.disabled).toBe(true);
  expect(button("Withdraw").props.disabled).toBe(true);
  expect(button("Record judgment").props.disabled).toBe(true);
  expect(
    hasText("Your session on this environment can view skill candidates but not change them."),
  ).toBe(true);

  // Handlers invoked directly still refuse: no arming, no confirmation, no
  // commands.
  act(() => button("Revise").props.onClick());
  expect(hasButton("Save new version")).toBe(false);
  act(() => button("Delete").props.onClick());
  expect(hasButton("Confirm delete")).toBe(false);
  await act(async () => button("Delete").props.onClick());
  await act(async () => button("Withdraw").props.onClick());
  await act(async () => button("Record judgment").props.onClick());
  expect(harness.confirmSession).not.toHaveBeenCalled();
  expect(harness.revise).not.toHaveBeenCalled();
  expect(harness.delete).not.toHaveBeenCalled();
  expect(harness.withdraw).not.toHaveBeenCalled();
  expect(harness.record).not.toHaveBeenCalled();
});

it("gates every write while operate access is still pending", () => {
  harness.access = "pending";
  useDetail(detailV1);
  render(<ProjectSkillDialog {...dialogArgs} />);

  expect(hasText("Checking your access to this environment…")).toBe(true);
  expect(button("Revise").props.disabled).toBe(true);
  expect(button("Delete").props.disabled).toBe(true);
});

// ── Settings section ──────────────────────────────────────────────────────

it("renders nothing without the projectSkills manage capability", () => {
  harness.capability = null;
  render(<ProjectSkillsSection environmentId={ENV} projectId={PROJECT} />);
  expect(renderer!.root.findAllByType("section")).toHaveLength(0);
});

it("lists candidates with recording-status badges when the capability is present", () => {
  harness.query = {
    data: {
      items: [
        {
          ref: refV1,
          title: "Deploy site",
          state: "candidate",
          createdAt: "2026-10-11T00:00:00.000Z",
          rightsRecorded: true,
          reviewRecorded: false,
        },
      ],
      truncated: false,
    },
    dataUpdatedAt: 1,
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: vi.fn(),
  } as any;
  render(<ProjectSkillsSection environmentId={ENV} projectId={PROJECT} />);
  expect(hasText("Deploy site")).toBe(true);
  expect(hasText("Candidate · inactive")).toBe(true);
  expect(hasText("Rights recorded")).toBe(true);
});

it("renders fixed copy for a failed list query — never the raw error", () => {
  harness.query = {
    data: null,
    dataUpdatedAt: 0,
    error: `${SENTINEL}: connection reset by peer`,
    isPending: false,
    isSuccess: false,
    refresh: vi.fn(),
  } as any;
  render(<ProjectSkillsSection environmentId={ENV} projectId={PROJECT} />);

  expect(renderer!.root.findAllByType("section")).toHaveLength(1);
  expect(hasText(SENTINEL)).toBe(false);
  expect(hasText("No skill candidates yet.")).toBe(false);
});

// ── Skill A → B switch, including a superseded late outcome ───────────────

it("drops skill A's revise draft when the dialog switches to skill B", async () => {
  useDetail(detailV1);
  render(<ProjectSkillDialog {...dialogArgs} />);
  act(() => button("Revise").props.onClick());
  editField("Skill Title", "edited on A");
  expect(hasButton("Save new version")).toBe(true);

  // A's revise command is still outstanding when the dialog switches to B.
  let resolveRevise: (value: unknown) => void = () => {};
  harness.revise.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRevise = resolve;
      }),
  );
  await act(async () => button("Save new version").props.onClick());
  expect(harness.revise).toHaveBeenCalledTimes(1);

  const detailB: ProjectSkillDetail = {
    ...detailV1,
    skillId: SKILL_B,
    versions: [
      {
        ...versionViewV1,
        version: {
          ...versionViewV1.version,
          ref: { ...refV1, skillId: SKILL_B },
          content: { ...contentV1, title: "Deploy B" },
        },
      },
    ],
  };
  useDetail(detailB);
  dialogArgs.skillId = SKILL_B;
  render(<ProjectSkillDialog {...dialogArgs} />);

  // Remount: A's editing state is gone and B renders only B's detail.
  expect(hasButton("Save new version")).toBe(false);
  expect(renderer!.root.findAllByProps({ "aria-label": "Skill Title" })).toHaveLength(0);
  expect(hasText("Deploy B")).toBe(true);

  // Settling A's command after the switch must not touch the new scope.
  await act(async () => resolveRevise(AsyncResult.success(versionViewV2)));
  await act(async () => {});
  expect(harness.toast).not.toHaveBeenCalled();
  expect(dialogArgs.onClose).not.toHaveBeenCalled();
  expect(hasText("Deploy B")).toBe(true);
});

// ── Failed refresh: the draft and its retry route stay reachable ──────────

it("keeps the draft reachable through pending, failed, and missing detail, then recovers", async () => {
  await reviseIntoConflict();

  // Pending refresh: nothing is released while the query has no value.
  detailPending();
  render(<ProjectSkillDialog {...dialogArgs} />);
  await act(async () => {});
  expect(hasButton("Save new version")).toBe(false);

  // Failed refresh: the edited draft and a retry control remain reachable.
  detailFailure({ _tag: "ProjectSkillStoreError", message: `${SENTINEL} refresh` });
  render(<ProjectSkillDialog {...dialogArgs} />);
  await act(async () => {});
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "edited title",
  );
  expect(hasButton("Save new version")).toBe(false);
  expect(hasButton("Load current version")).toBe(true);

  // The missing candidate: the dialog says so and still offers no write.
  detailFailure({ _tag: "ProjectSkillStoreNotFoundError" }, "not found");
  render(<ProjectSkillDialog {...dialogArgs} />);
  await act(async () => {});
  expect(hasText("This skill candidate no longer exists.")).toBe(true);
  expect(hasButton("Save new version")).toBe(false);

  // The retry route completes once a settled v2 arrives: load it explicitly,
  // then write from the installed current version.
  useDetail(detailV2);
  render(<ProjectSkillDialog {...dialogArgs} />);
  await act(async () => {});
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "edited title",
  );
  expect(button("Save new version").props.disabled).toBe(true);
  act(() => button("Load current version").props.onClick());
  await act(async () => {});
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "Deploy site v2",
  );
  expect(button("Save new version").props.disabled).toBe(false);
  await act(async () => button("Save new version").props.onClick());
  expect(harness.revise).toHaveBeenCalledTimes(2);
  expect(harness.revise.mock.calls[1]![0].input.fromVersion).toBe(2);
  expect(harness.toast).toHaveBeenCalledWith({ type: "success", title: "New version saved" });
});

// ── Candidate dialog (chat path) ──────────────────────────────────────────

const frozenSource = {
  environmentId: ENV,
  projectId: PROJECT,
  threadId: "thread-1" as ThreadId,
  expected: { attemptId: "attempt-1", revision: 3, receiptSequence: 42 },
  checkNames: ["Lint", "Test"],
};
const currentSource = (view: SelectedChecksView = passingView()): CurrentChecksSource => ({
  view,
  permission: "allowed" as const,
  projectId: PROJECT,
});
// One reader function closing over mutable current data: its identity never
// changes across renders, exactly like the panel hook's fresh read.
const readCurrent = { current: currentSource() };
const readCurrentSource = () => readCurrent.current;
const candidateArgs = {
  source: frozenSource,
  readCurrentSource,
  onClose: vi.fn(),
  view: passingView() as SelectedChecksView | null,
  permission: "allowed" as "allowed" | "read-only" | "unknown" | null,
  manage: true as boolean | null,
  onAuthorizationRejected: null as (() => void) | null,
};

const DERIVE_SHA = "c".repeat(64);
const DERIVE_PIN = "d".repeat(64);
const derivedSourceIdentity = (): ProjectSkillCandidateSourceIdentity => ({
  derivationFormat: "oop-project-skill-review-draft-source/v1",
  projectId: PROJECT,
  projectIncarnationSequence: 1,
  threadId: frozenSource.threadId,
  threadIncarnationSequence: 1,
  turnId: TurnId.make("turn-1"),
  assistantMessageId: MessageId.make("assistant-msg-1"),
  requestMessageId: MessageId.make("request-msg-1"),
  assistantBodySha256: DERIVE_SHA,
  requestBodySha256: DERIVE_SHA,
  extractedProcedureSha256: DERIVE_SHA,
  requirementsVersion: 1,
  requirementsContentSha256: DERIVE_SHA,
  taskResultRecordSequence: 1,
  taskResultRecordRevision: 0,
  taskResultRecordSha256: DERIVE_SHA,
  acceptedCheck: frozenSource.expected,
  currentCheck: frozenSource.expected,
  threadTitleSha256: DERIVE_SHA,
  boundRequirementTextSha256: DERIVE_SHA,
  boundSuccessCheckTextSha256: DERIVE_SHA,
  wholeSourceSha256: DERIVE_PIN,
});

const derivedPartial = {
  title: "Derived title",
  purpose: "Derived purpose",
  appliesWhen: "When derived",
  procedure: "1. Step one\n2. Step two",
  successCheck: "Derived success",
};

const fillCandidate = () => {
  editField("Skill Title", "My procedure");
  editField("Skill Purpose", "Do the thing");
  editField("Skill Applies when", "Whenever");
  editField("Skill Does not apply when", "Never mind");
  editField("Skill Procedure", "steps go here");
  // successCheck stays prefilled from the frozen record.
};

const renderCandidate = () => {
  render(<ProjectSkillCandidateDialog {...candidateArgs} />);
};

it("saves the candidate with the frozen tuple, typed draft, and trimmed content", async () => {
  renderCandidate();
  expect(renderer!.root.findByProps({ "aria-label": "Skill Success check" }).props.value).toBe(
    "Selected checks pass: Lint, Test",
  );
  fillCandidate();

  harness.create.mockResolvedValueOnce(AsyncResult.success(versionViewV1));
  await act(async () => button("Save candidate").props.onClick());

  expect(harness.create).toHaveBeenCalledTimes(1);
  const input = harness.create.mock.calls[0]![0].input;
  expect(input.projectId).toBe(PROJECT);
  expect(input.threadId).toBe("thread-1");
  expect(input.expected).toEqual({ attemptId: "attempt-1", revision: 3, receiptSequence: 42 });
  expect(input.draft).toEqual({ type: "typed" });
  expect(input.content).toEqual({
    title: "My procedure",
    purpose: "Do the thing",
    appliesWhen: "Whenever",
    doesNotApplyWhen: "Never mind",
    procedure: "steps go here",
    successCheck: "Selected checks pass: Lint, Test",
  });
  expect(harness.toast).toHaveBeenCalledWith({
    type: "success",
    title: "Skill candidate saved",
  });
  expect(candidateArgs.onClose).toHaveBeenCalled();
});

it("disables saving and keeps the draft when the source changed before submit", async () => {
  renderCandidate();
  fillCandidate();

  // The panel's current record moved on; both the reactive view and the fresh
  // reader now report the newer receipt, as the real hook would.
  const movedView = passingView({ record: { receipt: receiptV2, sequence: 43 } });
  candidateArgs.view = movedView;
  readCurrent.current = { view: movedView, permission: "allowed" as const, projectId: PROJECT };
  renderCandidate();
  await act(async () => {});

  expect(button("Save candidate").props.disabled).toBe(true);
  expect(hasText(SOURCE_INVALID_COPY)).toBe(true);
  await act(async () => button("Save candidate").props.onClick());
  expect(harness.create).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "My procedure",
  );
});

it("blocks the write while the manage capability is lost and recovers with it", async () => {
  renderCandidate();
  fillCandidate();

  candidateArgs.manage = false;
  renderCandidate();
  expect(button("Save candidate").props.disabled).toBe(true);
  expect(hasText(SKILL_UNSUPPORTED_COPY)).toBe(true);
  await act(async () => button("Save candidate").props.onClick());
  expect(harness.create).not.toHaveBeenCalled();
  expect(harness.confirmSession).not.toHaveBeenCalled();

  candidateArgs.manage = true;
  renderCandidate();
  expect(button("Save candidate").props.disabled).toBe(false);
  expect(hasText(SKILL_UNSUPPORTED_COPY)).toBe(false);
});

it("updates the display gate reactively while open and recovers without losing the draft", async () => {
  renderCandidate();
  fillCandidate();
  const reader = candidateArgs.readCurrentSource;

  // The headline is no longer passed; saving disables with an explanation and
  // the direct handler is refused even before the button state matters.
  candidateArgs.view = passingView({ headline: "running" });
  renderCandidate();
  expect(button("Save candidate").props.disabled).toBe(true);
  expect(hasText(SOURCE_INVALID_COPY)).toBe(true);
  await act(async () => button("Save candidate").props.onClick());
  expect(harness.create).not.toHaveBeenCalled();

  // Permission downgrades gate the same way, through the stable reader.
  candidateArgs.view = passingView();
  candidateArgs.permission = "read-only";
  renderCandidate();
  expect(button("Save candidate").props.disabled).toBe(true);
  expect(hasText(SKILL_AUTHORIZATION_COPY)).toBe(true);

  // A pending permission observation gates through the fresh reader; it
  // recovers into an allowed one without replacing the frozen tuple or
  // touching the draft.
  candidateArgs.permission = "unknown";
  readCurrent.current = { view: passingView(), permission: "unknown" as const, projectId: PROJECT };
  renderCandidate();
  expect(button("Save candidate").props.disabled).toBe(true);
  candidateArgs.permission = "allowed";
  readCurrent.current = currentSource();
  renderCandidate();
  expect(button("Save candidate").props.disabled).toBe(false);
  expect(hasText(SOURCE_INVALID_COPY)).toBe(false);
  expect(hasText(SKILL_AUTHORIZATION_COPY)).toBe(false);
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "My procedure",
  );
  expect(candidateArgs.readCurrentSource).toBe(reader);

  // The unchanged positive path still writes exactly once.
  harness.create.mockResolvedValueOnce(AsyncResult.success(versionViewV1));
  await act(async () => button("Save candidate").props.onClick());
  expect(harness.create).toHaveBeenCalledTimes(1);
  expect(harness.toast).toHaveBeenCalledWith({
    type: "success",
    title: "Skill candidate saved",
  });
  expect(candidateArgs.onClose).toHaveBeenCalled();
});

it("coalesces rapid duplicate submissions into one command and one success", async () => {
  renderCandidate();
  fillCandidate();
  let resolveCreate: (value: unknown) => void = () => {};
  harness.create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
  );

  act(() => button("Save candidate").props.onClick());
  act(() => button("Save candidate").props.onClick());
  await act(async () => {});
  expect(harness.create).toHaveBeenCalledTimes(1);
  expect(candidateArgs.onClose).not.toHaveBeenCalled();

  await act(async () => resolveCreate(AsyncResult.success(versionViewV1)));
  await act(async () => {});
  expect(harness.toast).toHaveBeenCalledTimes(1);
  expect(harness.toast).toHaveBeenCalledWith({
    type: "success",
    title: "Skill candidate saved",
  });
  expect(candidateArgs.onClose).toHaveBeenCalledTimes(1);
});

it("keeps the draft and shows fixed copy on a source rejection", async () => {
  renderCandidate();
  fillCandidate();
  harness.create.mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail({ _tag: "ProjectSkillStoreRejectedError", reason: "source-changed" }),
    ),
  );
  await act(async () => button("Save candidate").props.onClick());

  expect(harness.toast).not.toHaveBeenCalled();
  expect(candidateArgs.onClose).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "My procedure",
  );
  expect(hasText("New input was recorded after these checks. Run checks again.")).toBe(true);
});

it("forces renewed authorization after a rejection without discarding the draft", async () => {
  const retryPermission = vi.fn();
  candidateArgs.onAuthorizationRejected = retryPermission;
  renderCandidate();
  fillCandidate();

  harness.create.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail({ _tag: "EnvironmentAuthorizationError" })),
  );
  await act(async () => button("Save candidate").props.onClick());

  expect(harness.create).toHaveBeenCalledTimes(1);
  expect(retryPermission).toHaveBeenCalledTimes(1);
  expect(hasText(SKILL_AUTHORIZATION_COPY)).toBe(true);
  expect(candidateArgs.onClose).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "My procedure",
  );

  // The synchronous invalidation lands as an unconfirmed permission on both
  // channels, as the panel hook reports it: no second create may ride on the
  // stale confirmation.
  candidateArgs.permission = "unknown";
  readCurrent.current = { view: passingView(), permission: "unknown" as const, projectId: PROJECT };
  renderCandidate();
  expect(button("Save candidate").props.disabled).toBe(true);
  await act(async () => button("Save candidate").props.onClick());
  expect(harness.create).toHaveBeenCalledTimes(1);

  // A fresh allowed confirmation re-enables the unchanged draft and it saves.
  candidateArgs.permission = "allowed";
  readCurrent.current = currentSource();
  renderCandidate();
  expect(button("Save candidate").props.disabled).toBe(false);
  harness.create.mockResolvedValueOnce(AsyncResult.success(versionViewV1));
  await act(async () => button("Save candidate").props.onClick());
  expect(harness.create).toHaveBeenCalledTimes(2);
  expect(harness.toast).toHaveBeenCalledWith({
    type: "success",
    title: "Skill candidate saved",
  });
  expect(candidateArgs.onClose).toHaveBeenCalled();
});

it("ignores a late create outcome after the frozen scope changed project", async () => {
  renderCandidate();
  fillCandidate();

  let resolveCreate: (value: unknown) => void = () => {};
  harness.create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
  );
  act(() => button("Save candidate").props.onClick());
  await act(async () => {});
  expect(harness.create).toHaveBeenCalledTimes(1);

  // Same thread, different project: the scope key changes and the dialog
  // remounts with a clean draft for the new scope.
  candidateArgs.source = { ...frozenSource, projectId: PROJECT_B };
  readCurrent.current = {
    view: passingView(),
    permission: "allowed" as const,
    projectId: PROJECT_B,
  };
  renderCandidate();
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe("");
  expect(hasButton("Save candidate")).toBe(true);

  await act(async () => resolveCreate(AsyncResult.success(versionViewV1)));
  await act(async () => {});
  expect(harness.toast).not.toHaveBeenCalled();
  expect(candidateArgs.onClose).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe("");
});

it("treats an interrupted create as neither success nor failure", async () => {
  renderCandidate();
  fillCandidate();
  harness.create.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
  await act(async () => button("Save candidate").props.onClick());

  expect(harness.toast).not.toHaveBeenCalled();
  expect(candidateArgs.onClose).not.toHaveBeenCalled();
  expect(hasText("The request failed. Try again.")).toBe(false);
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "My procedure",
  );
});

it("does not offer derive when generatedDraft capability is absent", () => {
  harness.generatedDraftCap = false;
  renderCandidate();
  expect(hasButton("Draft from accepted work")).toBe(false);
});

it("fills untouched fields from an available derive and saves with the derived draft pin", async () => {
  harness.generatedDraftCap = true;
  renderCandidate();
  harness.derive.mockResolvedValueOnce(
    AsyncResult.success({
      status: "available",
      partial: derivedPartial,
      truncation: {},
      source: derivedSourceIdentity(),
    }),
  );
  await act(async () => button("Draft from accepted work").props.onClick());
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "Derived title",
  );
  expect(
    renderer!.root.findByProps({ "aria-label": "Skill Does not apply when" }).props.value,
  ).toBe("");
  editField("Skill Does not apply when", "Never for docs");
  harness.create.mockResolvedValueOnce(AsyncResult.success(versionViewV1));
  await act(async () => button("Save candidate").props.onClick());
  expect(harness.create).toHaveBeenCalledTimes(1);
  expect(harness.create.mock.calls[0]![0].input.draft).toEqual({
    type: "derived",
    messageId: MessageId.make("assistant-msg-1"),
    expectedSourceIdentitySha256: DERIVE_PIN,
  });
  expect(harness.create.mock.calls[0]![0].input.content.doesNotApplyWhen).toBe("Never for docs");
});

it("shows fixed copy for unavailable derive without filling procedure fields", async () => {
  harness.generatedDraftCap = true;
  renderCandidate();
  harness.derive.mockResolvedValueOnce(
    AsyncResult.success({ status: "unavailable", reason: "no-procedure-section" }),
  );
  await act(async () => button("Draft from accepted work").props.onClick());
  expect(hasText(DERIVE_UNAVAILABLE_COPY["no-procedure-section"])).toBe(true);
  expect(renderer!.root.findByProps({ "aria-label": "Skill Procedure" }).props.value).toBe("");
  expect(harness.create).not.toHaveBeenCalled();
});

it("preserves a field edited while derive is pending", async () => {
  harness.generatedDraftCap = true;
  renderCandidate();
  let resolveDerive: (value: unknown) => void = () => {};
  harness.derive.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveDerive = resolve;
      }),
  );
  act(() => button("Draft from accepted work").props.onClick());
  editField("Skill Title", "Kept title");
  await act(async () =>
    resolveDerive(
      AsyncResult.success({
        status: "available",
        partial: derivedPartial,
        truncation: {},
        source: derivedSourceIdentity(),
      }),
    ),
  );
  await act(async () => {});
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "Kept title",
  );
  expect(renderer!.root.findByProps({ "aria-label": "Skill Purpose" }).props.value).toBe(
    "Derived purpose",
  );
});

const beginPendingDerive = () => {
  let resolveDerive: (value: unknown) => void = () => {};
  harness.derive.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveDerive = resolve;
      }),
  );
  act(() => button("Draft from accepted work").props.onClick());
  return async (value: unknown) => {
    await act(async () => resolveDerive(value));
    await act(async () => {});
  };
};

it("refuses derive result when the frozen source tuple drifts on the same dialog", async () => {
  harness.generatedDraftCap = true;
  render(<ProjectSkillCandidateDialog {...candidateArgs} />);
  const finishDerive = beginPendingDerive();
  editField("Skill Title", "Kept during drift");
  const movedView = passingView({ record: { receipt: receiptV2, sequence: 43 } });
  readCurrent.current = { view: movedView, permission: "allowed" as const, projectId: PROJECT };
  candidateArgs.view = movedView;
  render(<ProjectSkillCandidateDialog {...candidateArgs} />);
  await finishDerive(
    AsyncResult.success({
      status: "available",
      partial: derivedPartial,
      truncation: {},
      source: derivedSourceIdentity(),
    }),
  );
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "Kept during drift",
  );
  expect(renderer!.root.findByProps({ "aria-label": "Skill Purpose" }).props.value).toBe("");
  expect(hasText(SOURCE_INVALID_COPY)).toBe(true);
  expect(renderer!.root.findByProps({ "aria-label": "Skill Procedure" }).props.value).toBe("");
});

it("refuses derive result when permission is lost on the same dialog", async () => {
  harness.generatedDraftCap = true;
  render(<ProjectSkillCandidateDialog {...candidateArgs} />);
  const finishDerive = beginPendingDerive();
  editField("Skill Title", "Kept during permission loss");
  candidateArgs.permission = "read-only";
  readCurrent.current = {
    view: passingView(),
    permission: "read-only" as const,
    projectId: PROJECT,
  };
  render(<ProjectSkillCandidateDialog {...candidateArgs} />);
  await finishDerive(
    AsyncResult.success({
      status: "available",
      partial: derivedPartial,
      truncation: {},
      source: derivedSourceIdentity(),
    }),
  );
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "Kept during permission loss",
  );
  expect(hasText(SKILL_AUTHORIZATION_COPY)).toBe(true);
});

it("refuses derive result when generatedDraft capability is lost on the same dialog", async () => {
  harness.generatedDraftCap = true;
  render(<ProjectSkillCandidateDialog {...candidateArgs} />);
  const finishDerive = beginPendingDerive();
  editField("Skill Title", "Kept during capability loss");
  harness.generatedDraftCap = false;
  render(<ProjectSkillCandidateDialog {...candidateArgs} />);
  await finishDerive(
    AsyncResult.success({
      status: "available",
      partial: derivedPartial,
      truncation: {},
      source: derivedSourceIdentity(),
    }),
  );
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "Kept during capability loss",
  );
  expect(hasText(SKILL_UNSUPPORTED_COPY)).toBe(true);
});

it("refuses derive result when the connection generation changes on the same dialog", async () => {
  harness.generatedDraftCap = true;
  render(<ProjectSkillCandidateDialog {...candidateArgs} />);
  const finishDerive = beginPendingDerive();
  editField("Skill Title", "Kept during reconnect");
  harness.conn = AsyncResult.success({ phase: "connected", generation: 8 });
  render(<ProjectSkillCandidateDialog {...candidateArgs} />);
  await finishDerive(
    AsyncResult.success({
      status: "available",
      partial: derivedPartial,
      truncation: {},
      source: derivedSourceIdentity(),
    }),
  );
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "Kept during reconnect",
  );
  expect(hasText(CONFIRM_FAILED_COPY)).toBe(true);
});

it("ignores a late derive outcome after the frozen scope changed", async () => {
  harness.generatedDraftCap = true;
  renderCandidate();
  let resolveDerive: (value: unknown) => void = () => {};
  harness.derive.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveDerive = resolve;
      }),
  );
  act(() => button("Draft from accepted work").props.onClick());
  candidateArgs.source = { ...frozenSource, projectId: PROJECT_B };
  readCurrent.current = {
    view: passingView(),
    permission: "allowed" as const,
    projectId: PROJECT_B,
  };
  renderCandidate();
  await act(async () =>
    resolveDerive(
      AsyncResult.success({
        status: "available",
        partial: derivedPartial,
        truncation: {},
        source: derivedSourceIdentity(),
      }),
    ),
  );
  await act(async () => {});
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe("");
  expect(hasButton("Draft from accepted work")).toBe(true);
});

it("keeps the draft on source-changed create after a derived pin was applied", async () => {
  harness.generatedDraftCap = true;
  renderCandidate();
  harness.derive.mockResolvedValueOnce(
    AsyncResult.success({
      status: "available",
      partial: derivedPartial,
      truncation: {},
      source: derivedSourceIdentity(),
    }),
  );
  await act(async () => button("Draft from accepted work").props.onClick());
  editField("Skill Does not apply when", "When not");
  harness.create.mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail({ _tag: "ProjectSkillStoreRejectedError", reason: "source-changed" }),
    ),
  );
  await act(async () => button("Save candidate").props.onClick());
  expect(renderer!.root.findByProps({ "aria-label": "Skill Title" }).props.value).toBe(
    "Derived title",
  );
  expect(candidateArgs.onClose).not.toHaveBeenCalled();
});

const lifecycleCapability = {
  environment: {
    capabilities: {
      projectSkills: { manage: true, lifecycle: true, trial: true, use: true },
    },
  },
  settings: harnessServerSettings(),
};

const lifecycleWithoutUse = {
  environment: {
    capabilities: {
      projectSkills: { manage: true, lifecycle: true, trial: true, use: false },
    },
  },
  settings: harnessServerSettings(),
};

const primeLifecycleProject = () => {
  harness.project = {
    id: PROJECT,
    environmentId: ENV,
    scripts: [
      { id: "lint", name: "Lint", command: "pnpm lint", group: null, runOnWorktreeCreate: false },
    ],
  };
  harness.threadShells = [
    {
      environmentId: ENV,
      projectId: PROJECT,
      id: "thread-1" as ThreadId,
      title: "Main thread",
      archivedAt: null,
      createdAt: "2026-10-11T00:00:00.000Z",
    },
  ];
};

const reproductionEvidenceId = ProjectSkillEvidenceId.make("evidence-repro-conflict");
const harmfulEvidenceId = ProjectSkillEvidenceId.make("evidence-harm-conflict");
const sourceThreadId = "thread-source" as ThreadId;

const versionWithLifecycleTrials = (
  base: ProjectSkillVersionView = versionViewV1,
): ProjectSkillVersionView => ({
  ...base,
  trials: [
    {
      threadId: "thread-trial" as ThreadId,
      messageId: MessageId.make("message-ev"),
      inputEventSequence: 12,
      admittedSkillStateSeq: 1,
      delivery: "provider-accepted",
      providerDriverKind: null,
      sameThreadAsSource: false,
      window: "closed",
      observations: [
        {
          evidenceId: reproductionEvidenceId,
          attemptId: "attempt-repro",
          receiptSequence: 1,
          outcome: "all-selected-passed",
          endedAt: null,
        },
      ],
      uncountedAttempts: 0,
    },
    {
      threadId: "thread-trial-fail" as ThreadId,
      messageId: MessageId.make("message-ev-fail"),
      inputEventSequence: 13,
      admittedSkillStateSeq: 1,
      delivery: "provider-accepted",
      providerDriverKind: null,
      sameThreadAsSource: false,
      window: "closed",
      observations: [
        {
          evidenceId: harmfulEvidenceId,
          attemptId: "attempt-harm",
          receiptSequence: 2,
          outcome: "failed",
          endedAt: null,
        },
      ],
      uncountedAttempts: 0,
    },
  ],
  version: {
    ...base.version,
    source: {
      type: "work",
      check: { ...checkObservation, threadId: sourceThreadId },
      createdAfterEventSequence: 5,
      draft: { type: "typed" },
    },
  },
});

/** The target a user leaves on the form: the one thread and the "Lint" project script. */
const chooseLifecycleTarget = () => {
  selectByTriggerLabel("Activation thread", "thread-1");
  act(() => checkboxByLabel("Lint").props.onCheckedChange());
  expect(selectedValueOf("Activation thread")).toBe("thread-1");
  expect(checkboxByLabel("Lint").props.checked).toBe(true);
};

it("sends activate with thread and script target after confirmation", async () => {
  harness.capability = lifecycleCapability;
  primeLifecycleProject();
  useDetail({ ...detailV1, stateSeq: 4 });
  render(<ProjectSkillDialog {...dialogArgs} />);
  chooseLifecycleTarget();
  harness.confirmSession.mockResolvedValueOnce(AsyncResult.success(confirmedSession));
  harness.activate.mockResolvedValueOnce(AsyncResult.success({ stateSeq: 5 }));
  await act(async () => button("활성화").props.onClick());
  expect(harness.activate).toHaveBeenCalledTimes(1);
  expect(harness.activate.mock.calls[0]![0].input).toEqual({
    ref: refV1,
    expectedStateSeq: 4,
    target: { threadId: "thread-1", scriptIds: ["lint"] },
  });
  expect(harness.retire).not.toHaveBeenCalled();
});

it("retire sends no target and only the pinned state sequence", async () => {
  harness.capability = lifecycleCapability;
  primeLifecycleProject();
  const activeDetail: ProjectSkillDetail = {
    ...detailV1,
    stateSeq: 6,
    versions: [{ ...versionViewV1, version: { ...versionViewV1.version, state: "active" } }],
  };
  useDetail(activeDetail);
  render(<ProjectSkillDialog {...dialogArgs} />);
  harness.confirmSession.mockResolvedValueOnce(AsyncResult.success(confirmedSession));
  harness.retire.mockResolvedValueOnce(AsyncResult.success({ stateSeq: 7 }));
  await act(async () => button("사용 중지").props.onClick());
  expect(harness.retire).toHaveBeenCalledTimes(1);
  expect(harness.retire.mock.calls[0]![0].input).toEqual({
    ref: refV1,
    expectedStateSeq: 6,
  });
  expect(harness.activate).not.toHaveBeenCalled();
});

it("refuses lifecycle RPC when only the lifecycle capability is lost during held confirmation", async () => {
  harness.capability = lifecycleCapability;
  primeLifecycleProject();
  useDetail({ ...detailV1, stateSeq: 2 });
  render(<ProjectSkillDialog {...dialogArgs} />);
  chooseLifecycleTarget();
  const release = beginHeldConfirmation();
  act(() => button("활성화").props.onClick());
  await act(async () => {});
  expect(harness.confirmSession).toHaveBeenCalledTimes(1);
  // Manage still holds, so only the lifecycle read can be what refuses.
  harness.capability = {
    environment: { capabilities: { projectSkills: { manage: true, lifecycle: false } } },
    settings: lifecycleCapability.settings,
  };
  await act(async () => release(AsyncResult.success(confirmedSession)));
  expect(harness.activate).not.toHaveBeenCalled();
  expect(hasText(LIFECYCLE_UNSUPPORTED_COPY)).toBe(true);
});

it("revalidates after a typed state-changed rejection without retrying activate", async () => {
  harness.capability = lifecycleCapability;
  primeLifecycleProject();
  useDetail({ ...detailV1, stateSeq: 3 });
  render(<ProjectSkillDialog {...dialogArgs} />);
  chooseLifecycleTarget();
  harness.confirmSession.mockResolvedValueOnce(AsyncResult.success(confirmedSession));
  harness.activate.mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail({ _tag: "ProjectSkillStoreRejectedError", reason: "state-changed" }),
    ),
  );
  await act(async () => button("활성화").props.onClick());
  expect(harness.activate).toHaveBeenCalledTimes(1);
  expect(harness.revalidate).toHaveBeenCalled();
});

it("restores a retired version with an explicit thread target", async () => {
  harness.capability = lifecycleCapability;
  primeLifecycleProject();
  const retiredView: ProjectSkillVersionView = {
    ...versionViewV1,
    version: { ...versionViewV1.version, state: "retired" },
  };
  useDetail({ ...detailV1, stateSeq: 8, versions: [retiredView] });
  render(<ProjectSkillDialog {...dialogArgs} />);
  chooseLifecycleTarget();
  harness.confirmSession.mockResolvedValueOnce(AsyncResult.success(confirmedSession));
  harness.activate.mockResolvedValueOnce(AsyncResult.success({ stateSeq: 9 }));
  await act(async () => button("이전 버전 복원").props.onClick());
  expect(harness.activate).toHaveBeenCalledTimes(1);
  expect(harness.activate.mock.calls[0]![0].input.target).toEqual({
    threadId: "thread-1",
    scriptIds: ["lint"],
  });
});

/**
 * The two evidence-judgment forms. `prepare` completes everything except the
 * evidence choice and note, so a fully valid form reaches the confirmation.
 */
const evidenceCases = [
  {
    label: "reproduction",
    evidenceLabel: "Reproduction evidence",
    noteLabel: "Reproduction note",
    evidenceId: reproductionEvidenceId,
    recordButton: "Record reproduction judgment",
    expectedJudgment: {
      kind: "reproduction",
      observedEvidenceId: reproductionEvidenceId,
      procedureApplied: true,
      successConditionConfirmed: true,
      taskNotUsedForAuthoring: true,
      note: "repro note",
    },
    prepare: () => {
      act(() => {
        for (const text of [
          "Procedure applied on a separate task",
          "Success condition confirmed",
          "Task was not used to author this procedure",
        ]) {
          checkboxByLabel(text).props.onCheckedChange(true);
        }
      });
    },
  },
  {
    label: "harmful non-application",
    evidenceLabel: "Non-application evidence",
    noteLabel: "Non-application note",
    evidenceId: harmfulEvidenceId,
    recordButton: "Record non-application judgment",
    expectedJudgment: {
      kind: "non-application",
      observedEvidenceId: harmfulEvidenceId,
      taskDescription: "separate task",
      verdict: "harmful",
      note: "harm note",
    },
    prepare: () => {
      editField("Task description", "separate task");
      act(() => {
        renderer!.root
          .findByProps({ "aria-label": "Non-application verdict" })
          .props.onValueChange(["harmful"]);
      });
    },
  },
] as const;

const evidenceDetail = (): ProjectSkillDetail => ({
  ...detailV1,
  stateSeq: 5,
  versions: [versionWithLifecycleTrials()],
});

/** Renders a fully valid evidence form; the caller clicks its record button. */
const armEvidenceJudgment = (evidenceCase: (typeof evidenceCases)[number]) => {
  const detail = evidenceDetail();
  harness.capability = lifecycleCapability;
  primeLifecycleProject();
  useDetail(detail);
  render(<ProjectSkillDialog {...dialogArgs} />);
  selectByTriggerLabel(evidenceCase.evidenceLabel, evidenceCase.evidenceId);
  evidenceCase.prepare();
  editField(evidenceCase.noteLabel, evidenceCase.expectedJudgment.note);
  return detail;
};

it.each(evidenceCases)(
  "records $label with evidence-linked payload after confirmation",
  async (evidenceCase) => {
    armEvidenceJudgment(evidenceCase);
    harness.confirmSession.mockResolvedValueOnce(AsyncResult.success(confirmedSession));
    harness.record.mockResolvedValueOnce(
      AsyncResult.success({
        judgment: rightsJudgment,
        recordedAfterEventSequence: 11,
        withdrawnAt: null,
      }),
    );
    await act(async () => button(evidenceCase.recordButton).props.onClick());
    expect(harness.record).toHaveBeenCalledTimes(1);
    expect(harness.record.mock.calls[0]![0].input.judgment).toEqual(evidenceCase.expectedJudgment);
  },
);

it.each(evidenceCases)(
  "refuses $label RPC when evidence disappears during held confirmation but keeps the note",
  async (evidenceCase) => {
    const detail = armEvidenceJudgment(evidenceCase);
    const release = beginHeldConfirmation();
    act(() => button(evidenceCase.recordButton).props.onClick());
    await act(async () => {});
    // The complete form reached the confirmation barrier before the drift.
    expect(harness.confirmSession).toHaveBeenCalledTimes(1);
    useDetail({ ...detail, versions: [{ ...detail.versions[0]!, trials: [] }] });
    await act(async () => release(AsyncResult.success(confirmedSession)));
    expect(harness.record).not.toHaveBeenCalled();
    expect(hasText(LIFECYCLE_SCOPE_DRIFT_COPY)).toBe(true);
    expect(renderer!.root.findByProps({ "aria-label": evidenceCase.noteLabel }).props.value).toBe(
      evidenceCase.expectedJudgment.note,
    );
  },
);

it("refuses activate when script definitions change during held confirmation", async () => {
  harness.capability = lifecycleCapability;
  primeLifecycleProject();
  useDetail({ ...detailV1, stateSeq: 4 });
  render(<ProjectSkillDialog {...dialogArgs} />);
  chooseLifecycleTarget();
  const release = beginHeldConfirmation();
  act(() => button("활성화").props.onClick());
  await act(async () => {});
  expect(harness.confirmSession).toHaveBeenCalledTimes(1);
  harness.project = {
    ...harness.project,
    scripts: [
      {
        id: "lint",
        name: "Lint",
        command: "pnpm lint-changed",
        group: null,
        runOnWorktreeCreate: false,
      },
    ],
  };
  await act(async () => release(AsyncResult.success(confirmedSession)));
  expect(harness.activate).not.toHaveBeenCalled();
  expect(hasText(LIFECYCLE_SCOPE_DRIFT_COPY)).toBe(true);
});

it("refuses activate when stateSeq drifts during held confirmation", async () => {
  harness.capability = lifecycleCapability;
  primeLifecycleProject();
  useDetail({ ...detailV1, stateSeq: 4 });
  render(<ProjectSkillDialog {...dialogArgs} />);
  chooseLifecycleTarget();
  const release = beginHeldConfirmation();
  act(() => button("활성화").props.onClick());
  await act(async () => {});
  expect(harness.confirmSession).toHaveBeenCalledTimes(1);
  useDetail({ ...detailV1, stateSeq: 5 });
  await act(async () => release(AsyncResult.success(confirmedSession)));
  expect(harness.activate).not.toHaveBeenCalled();
  expect(hasText(LIFECYCLE_SCOPE_DRIFT_COPY)).toBe(true);
});

it("revalidates after not-ready without auto-retrying activate", async () => {
  harness.capability = lifecycleCapability;
  primeLifecycleProject();
  useDetail({ ...detailV1, stateSeq: 3 });
  render(<ProjectSkillDialog {...dialogArgs} />);
  chooseLifecycleTarget();
  harness.confirmSession.mockResolvedValueOnce(AsyncResult.success(confirmedSession));
  harness.activate.mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail({
        _tag: "ProjectSkillStoreRejectedError",
        reason: "not-ready",
        gaps: ["review-missing"],
      }),
    ),
  );
  await act(async () => button("활성화").props.onClick());
  expect(harness.activate).toHaveBeenCalledTimes(1);
  expect(harness.revalidate).toHaveBeenCalled();
});

// ── Held-confirmation boundary reads: settled detail and live selection ───
//
// Each operation renders its own form and returns what a case needs: the
// detail it rendered, the click, the RPC spy, and a draft check. The cases
// below change only one thing between the held confirmation and its release.

const activateOperation = {
  label: "activate",
  rpc: () => harness.activate,
  arm: () => {
    const detail: ProjectSkillDetail = { ...detailV1, stateSeq: 4 };
    harness.capability = lifecycleCapability;
    primeLifecycleProject();
    useDetail(detail);
    render(<ProjectSkillDialog {...dialogArgs} />);
    chooseLifecycleTarget();
    return { detail, click: () => button("활성화").props.onClick() };
  },
  expectDraftKept: () => {
    expect(selectedValueOf("Activation thread")).toBe("thread-1");
    expect(checkboxByLabel("Lint").props.checked).toBe(true);
  },
};

const retireOperation = {
  label: "retire",
  rpc: () => harness.retire,
  arm: () => {
    const detail: ProjectSkillDetail = {
      ...detailV1,
      stateSeq: 6,
      versions: [{ ...versionViewV1, version: { ...versionViewV1.version, state: "active" } }],
    };
    harness.capability = lifecycleCapability;
    primeLifecycleProject();
    useDetail(detail);
    render(<ProjectSkillDialog {...dialogArgs} />);
    return { detail, click: () => button("사용 중지").props.onClick() };
  },
  expectDraftKept: () => {},
};

const evidenceOperation = (evidenceCase: (typeof evidenceCases)[number]) => ({
  label: evidenceCase.label,
  rpc: () => harness.record,
  arm: () => ({
    detail: armEvidenceJudgment(evidenceCase),
    click: () => button(evidenceCase.recordButton).props.onClick(),
  }),
  expectDraftKept: () => {
    expect(renderer!.root.findByProps({ "aria-label": evidenceCase.noteLabel }).props.value).toBe(
      evidenceCase.expectedJudgment.note,
    );
  },
});

/** Reads of the same detail the registry could hand a boundary mid-refresh. */
const registryReads = [
  {
    label: "a waiting refresh of the same detail",
    read: (detail: ProjectSkillDetail) => AsyncResult.success(detail, { waiting: true }),
    sends: false,
  },
  {
    label: "a failed refresh holding the previous success",
    read: (detail: ProjectSkillDetail) =>
      AsyncResult.failure<ProjectSkillDetail, string>(Cause.fail("refresh failed"), {
        previousSuccess: Option.some(AsyncResult.success<ProjectSkillDetail, string>(detail)),
      }),
    sends: false,
  },
  {
    label: "a settled success of the same detail (control)",
    read: (detail: ProjectSkillDetail) => AsyncResult.success(detail),
    sends: true,
  },
] as const;

it.each(
  [activateOperation, retireOperation, evidenceOperation(evidenceCases[0])].flatMap((operation) =>
    registryReads.map((registryRead) => ({
      name: `${operation.label} with ${registryRead.label}`,
      operation,
      registryRead,
    })),
  ),
)("holds the $name", async ({ operation, registryRead }) => {
  const { detail, click } = operation.arm();
  const release = beginHeldConfirmation();
  act(() => click());
  await act(async () => {});
  expect(harness.confirmSession).toHaveBeenCalledTimes(1);

  // Only the registry channel moves; the rendered dialog still shows the
  // settled detail, as it does until React renders the refresh.
  harness.registryValue = registryRead.read(detail);
  await act(async () => release(AsyncResult.success(confirmedSession)));

  expect(operation.rpc()).toHaveBeenCalledTimes(registryRead.sends ? 1 : 0);
  if (!registryRead.sends) {
    expect(hasText(LIFECYCLE_SCOPE_DRIFT_COPY)).toBe(true);
    operation.expectDraftKept();
  }
});

it("does not request confirmation while the detail is still refreshing", async () => {
  const { detail, click } = activateOperation.arm();
  harness.registryValue = AsyncResult.success(detail, { waiting: true });
  await act(async () => click());
  expect(harness.confirmSession).not.toHaveBeenCalled();
  expect(harness.activate).not.toHaveBeenCalled();
  expect(hasText(LIFECYCLE_STATE_UNKNOWN_COPY)).toBe(true);
});

const clearThread = () => selectFor("Activation thread").props.onValueChange("");
const reselectThread = () => selectFor("Activation thread").props.onValueChange("thread-1");
const deselectLint = () => checkboxByLabel("Lint").props.onCheckedChange();
const clearEvidence = (evidenceCase: (typeof evidenceCases)[number]) => () =>
  selectFor(evidenceCase.evidenceLabel).props.onValueChange("");

it.each([
  {
    name: "a thread cleared after the form rendered",
    operation: activateOperation,
    change: clearThread,
    sameEvent: false,
    sends: false,
  },
  {
    name: "a thread cleared in the event that releases the confirmation",
    operation: activateOperation,
    change: clearThread,
    sameEvent: true,
    sends: false,
  },
  {
    name: "a script deselected in the event that releases the confirmation",
    operation: activateOperation,
    change: deselectLint,
    sameEvent: true,
    sends: false,
  },
  {
    name: "a reproduction evidence choice cleared in the releasing event",
    operation: evidenceOperation(evidenceCases[0]),
    change: clearEvidence(evidenceCases[0]),
    sameEvent: true,
    sends: false,
  },
  {
    name: "a non-application evidence choice cleared in the releasing event",
    operation: evidenceOperation(evidenceCases[1]),
    change: clearEvidence(evidenceCases[1]),
    sameEvent: true,
    sends: false,
  },
  {
    name: "the same thread chosen again in the releasing event (control)",
    operation: activateOperation,
    change: reselectThread,
    sameEvent: true,
    sends: true,
  },
])("holds the live choice against $name", async ({ operation, change, sameEvent, sends }) => {
  const { click } = operation.arm();
  const release = beginHeldConfirmation();
  act(() => click());
  await act(async () => {});
  expect(harness.confirmSession).toHaveBeenCalledTimes(1);

  if (sameEvent) {
    // One open `act`: the handler's synchronous setter has run, but React has
    // not committed or flushed effects when the released continuation reads.
    await act(async () => {
      change();
      release(AsyncResult.success(confirmedSession));
      await drainMicrotasks();
    });
  } else {
    act(() => {
      change();
    });
    await act(async () => release(AsyncResult.success(confirmedSession)));
  }

  expect(operation.rpc()).toHaveBeenCalledTimes(sends ? 1 : 0);
  if (!sends) expect(hasText(LIFECYCLE_SCOPE_DRIFT_COPY)).toBe(true);
});

it("disables activate and restore when use is false but keeps retire and judgments", async () => {
  harness.capability = lifecycleWithoutUse;
  primeLifecycleProject();
  useDetail({ ...detailV1, stateSeq: 4 });
  render(<ProjectSkillDialog {...dialogArgs} />);
  chooseLifecycleTarget();
  expect(button("활성화").props.disabled).toBe(true);
  expect(hasText(LIFECYCLE_USE_UNAVAILABLE_COPY)).toBe(true);
  await act(async () => renderer?.unmount());
  renderer = null;

  useDetail({
    ...detailV1,
    stateSeq: 6,
    versions: [{ ...versionViewV1, version: { ...versionViewV1.version, state: "active" } }],
  });
  render(<ProjectSkillDialog {...dialogArgs} />);
  expect(button("사용 중지").props.disabled).not.toBe(true);
  await act(async () => renderer?.unmount());
  renderer = null;

  useDetail(evidenceDetail());
  render(<ProjectSkillDialog {...dialogArgs} />);
  selectByTriggerLabel("Reproduction evidence", reproductionEvidenceId);
  for (const text of [
    "Procedure applied on a separate task",
    "Success condition confirmed",
    "Task was not used to author this procedure",
  ]) {
    act(() => checkboxByLabel(text).props.onCheckedChange(true));
  }
  editField("Reproduction note", "repro note");
  harness.confirmSession.mockResolvedValueOnce(AsyncResult.success(confirmedSession));
  harness.record.mockResolvedValueOnce(
    AsyncResult.success({
      judgment: rightsJudgment,
      recordedAfterEventSequence: 11,
      withdrawnAt: null,
    }),
  );
  await act(async () => button("Record reproduction judgment").props.onClick());
  expect(harness.record).toHaveBeenCalledTimes(1);
  expect(harness.activate).not.toHaveBeenCalled();
});

it("refuses activate RPC when use is lost during held confirmation", async () => {
  harness.capability = lifecycleCapability;
  primeLifecycleProject();
  useDetail({ ...detailV1, stateSeq: 2 });
  render(<ProjectSkillDialog {...dialogArgs} />);
  chooseLifecycleTarget();
  const release = beginHeldConfirmation();
  act(() => button("활성화").props.onClick());
  await act(async () => {});
  expect(harness.confirmSession).toHaveBeenCalledTimes(1);
  harness.capability = lifecycleWithoutUse;
  await act(async () => release(AsyncResult.success(confirmedSession)));
  expect(harness.activate).not.toHaveBeenCalled();
  expect(hasText(LIFECYCLE_USE_UNAVAILABLE_COPY)).toBe(true);
});

it("hides lifecycle controls when stateSeq is unknown", () => {
  harness.capability = lifecycleCapability;
  primeLifecycleProject();
  useDetail({
    projectId: detailV1.projectId,
    skillId: detailV1.skillId,
    latestVersion: detailV1.latestVersion,
    versions: detailV1.versions,
  });
  render(<ProjectSkillDialog {...dialogArgs} />);
  expect(hasText("활성화")).toBe(false);
  expect(hasText("사용 중지")).toBe(false);
});

// ── ChatHeader transition ─────────────────────────────────────────────────

vi.mock("../chat/SelectedChecksPanel", () => ({ SelectedChecksPanel: harness.panelSpy }));
vi.mock("../GitActionsControl", () => ({ default: () => null }));
vi.mock("../chat/OpenInPicker", () => ({ OpenInPicker: () => null }));
vi.mock("../../remoteOpen", () => ({ useRemoteOpenState: () => ({ mode: null }) }));
vi.mock("~/hooks/useT3ProjectFileScripts", () => ({ useT3ProjectFileScripts: () => [] }));
vi.mock("~/hooks/useThreadActionMenu", () => ({ useThreadActionMenu: () => ({}) }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { update: "threadUpdate", delete: "threadDelete" },
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => ENV }));
vi.mock("../../panelAnimations", () => ({
  observeResponsiveBreakpointFade: () => () => {},
  usePanelAnimationSettings: () => ({}),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "div",
  WorkspaceBreadcrumbText: "span",
}));
vi.mock("~/hooks/useMediaQuery", () => ({ useIsMobile: () => false }));
vi.mock("../ui/tooltip", () => ({ Tooltip: "div", TooltipTrigger: "div", TooltipPopup: "div" }));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuPopup: "div",
  MenuSeparator: "hr",
  MenuTrigger: "div",
  MenuItem: "div",
}));
vi.mock("../ProjectScriptsControl", () => ({ default: () => null }));
vi.mock("../chat/ReleaseVerificationPanel", () => ({ ReleaseVerificationPanel: () => null }));
vi.mock("../../state/releaseVerification", () => ({
  releaseVerificationEnvironment: { run: "rvRun", cancel: "rvCancel" },
  useReleaseVerification: () => ({
    unsupported: true,
    result: null,
    error: null,
    live: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

const controlProps = {
  environmentId: ENV,
  threadId: "thread-1" as ThreadId,
  threadTitle: "Thread",
  project: null,
  scripts: [] as ReadonlyArray<never> | undefined,
  collapsed: false,
  onRequestMenuClose: vi.fn(),
};

const stubChecksHandle = () => {
  harness.checks = {
    view: passingView(),
    candidates: [],
    permission: "allowed",
    permissionStatus: "confirmed",
    retryPermission: vi.fn(),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    toggle: vi.fn(),
    refresh: vi.fn(),
    run: vi.fn(),
    stop: vi.fn(),
    recheck: vi.fn(),
    openRecoveryDialog: vi.fn(),
    closeRecoveryDialog: vi.fn(),
    submitRecoveryDialog: vi.fn(),
    readCurrentSource: vi.fn(() => currentSource()),
    recordIdentity: null,
    readRecordIdentity: () => null,
  };
};

it("keeps the checks controller open while the candidate dialog owns the screen", async () => {
  stubChecksHandle();
  render(<SelectedChecksControl {...controlProps} />);

  expect(harness.panelSpy).toHaveBeenCalled();
  expect(harness.panelSpy.mock.lastCall![0].open).toBe(true);
  expect(harness.panelSpy.mock.lastCall![0].onSaveAsSkillCandidate).toBeTypeOf("function");

  act(() => harness.panelSpy.mock.lastCall![0].onSaveAsSkillCandidate!());

  // The controller was not closed: the hook keeps observing, the panel is
  // only hidden, and the real candidate dialog mounted from the frozen read.
  expect(harness.checks.closePanel).not.toHaveBeenCalled();
  expect(harness.checks.readCurrentSource).toHaveBeenCalled();
  expect(hasText("New skill candidate")).toBe(true);
  expect(renderer!.root.findByProps({ "aria-label": "Skill Success check" }).props.value).toBe(
    "Selected checks pass: Lint, Test",
  );
  expect(harness.panelSpy.mock.lastCall![0].open).toBe(false);

  // The unchanged positive path still works from the header: filling the real
  // candidate and saving issues exactly one frozen-tuple create.
  fillCandidate();
  editField("Skill Title", "Header saved");
  harness.create.mockResolvedValueOnce(AsyncResult.success(versionViewV1));
  await act(async () => button("Save candidate").props.onClick());
  expect(harness.create).toHaveBeenCalledTimes(1);
  const input = harness.create.mock.calls[0]![0].input;
  expect(input.projectId).toBe(PROJECT);
  expect(input.threadId).toBe("thread-1");
  expect(input.expected).toEqual({ attemptId: "attempt-1", revision: 3, receiptSequence: 42 });
  expect(input.draft).toEqual({ type: "typed" });
  expect(input.content.title).toBe("Header saved");
  expect(input.content.successCheck).toBe("Selected checks pass: Lint, Test");
  expect(harness.toast).toHaveBeenCalledWith({
    type: "success",
    title: "Skill candidate saved",
  });

  // Exiting through the close restored the panel through the same controller.
  expect(harness.panelSpy.mock.lastCall![0].open).toBe(true);
  expect(harness.panelSpy.mock.lastCall![0].onSaveAsSkillCandidate).toBeTypeOf("function");
});

it("freezes a new tuple when a newer record is saved instead", () => {
  stubChecksHandle();
  render(<SelectedChecksControl {...controlProps} />);
  harness.checks.readCurrentSource.mockImplementation(() =>
    currentSource(passingView({ record: { receipt: receiptV2, sequence: 43 } })),
  );
  harness.checks.view = passingView({ record: { receipt: receiptV2, sequence: 43 } });
  act(() => harness.panelSpy.mock.lastCall![0].onSaveAsSkillCandidate!());
  expect(renderer!.root.findByProps({ "aria-label": "Skill Success check" }).props.value).toBe(
    "Selected checks pass: Typecheck",
  );
});

it("hides the save action when the source is not eligible", () => {
  stubChecksHandle();
  harness.checks.view = passingView({ headline: "failed" });
  render(<SelectedChecksControl {...controlProps} />);
  expect(harness.panelSpy.mock.lastCall![0].onSaveAsSkillCandidate).toBeUndefined();
});

it("renders per-version trial history from ProjectSkillVersionView.trials", () => {
  const trialMessageId = MessageId.make("message-trial-1");
  const openTrial: ProjectSkillTrialSummary = {
    threadId: "thread-1" as ThreadId,
    messageId: trialMessageId,
    inputEventSequence: 120,
    admittedSkillStateSeq: 4,
    delivery: "unknown",
    providerDriverKind: null,
    sameThreadAsSource: false,
    window: "open",
    provisionalObservations: [],
  };
  const withTrials: ProjectSkillVersionView = { ...versionViewV1, trials: [openTrial] };
  act(() => {
    renderer = create(<VersionTrialHistory view={withTrials} trialCapability={true} />);
  });
  expect(
    renderer!.root.findAll((node) => node.children.some((c) => c === VERSION_TRIAL_HISTORY_TITLE))
      .length,
  ).toBeGreaterThan(0);
  expect(hasText(`Trial ${trialMessageId}`)).toBe(true);
  expect(hasText("Delivery unconfirmed — the provider send may or may not have completed.")).toBe(
    true,
  );
});
