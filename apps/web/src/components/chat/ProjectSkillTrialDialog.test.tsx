// Behavior tests for the skill-trial send dialog, rendered for real with the
// RPC/query/state boundaries mocked (same harness shape as the project-skill
// conflict tests). Assertions observe the real threadEnvironment.startTurn
// payload, held-confirmation races, the submit lock, stale completions, and
// the per-version history read — not callbacks in isolation.
import { StrictMode, act, type ReactElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  AuthOrchestrationOperateScope,
  ProviderInstanceId,
  renderProjectSkillBlock,
  type EnvironmentId,
  type ProjectId,
  type ProjectSkillContent,
  type ProjectSkillDetail,
  type ProjectSkillSummary,
  type ProjectSkillVersionRef,
  type ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  LIST_ATOM: Symbol("list-atom"),
  GET_ATOM: Symbol("get-atom"),
  listQuery: null as any,
  detailQuery: null as any,
  capability: null as any,
  access: "granted" as "granted" | "denied" | "pending",
  shell: null as any,
  registry: null as any,
  registryTrial: true,
  registryUse: true,
  projectScripts: [] as Array<{ id: string; name: string; command: string }>,
  settings: null as any,
  project: null as any,
  registryDetail: null as any,
  catalog: null as any,
  catalogEntry: null as any,
  conn: null as any,
  prepared: null as any,
  CAPABILITY_ATOM: Symbol("capability"),
  SETTINGS_ATOM: Symbol("settings"),
  PROJECT_ATOM: Symbol("project"),
  CATALOG_ATOM: Symbol("catalog"),
  CONN_ATOM: Symbol("conn"),
  PREPARED_ATOM: Symbol("prepared"),
  confirmSession: vi.fn(),
  startTurn: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@effect/atom-react", async () => {
  const react = await import("react");
  return {
    RegistryContext: react.createContext(null),
    useAtomValue: (atom: unknown) => {
      if (atom === harness.CAPABILITY_ATOM) return harness.capability;
      if (atom === harness.SETTINGS_ATOM) return harness.settings;
      if (atom === harness.PROJECT_ATOM) return harness.project;
      return null;
    },
  };
});
vi.mock("../../state/projectSkills", () => ({
  projectSkills: {
    get: () => harness.GET_ATOM,
    list: () => harness.LIST_ATOM,
  },
}));
vi.mock("../../state/selectedChecks", () => ({
  selectedChecksSessionConfirmation: "confirmSession",
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { startTurn: "startTurn" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    (harness as Record<string, unknown>)[String(command)] ?? vi.fn(),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === harness.LIST_ATOM ? harness.listQuery : harness.detailQuery,
}));
vi.mock("../../state/projects", () => ({
  environmentProjects: { projectAtom: () => harness.PROJECT_ATOM },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => harness.CAPABILITY_ATOM,
    settingsValueAtom: () => harness.SETTINGS_ATOM,
  },
}));
vi.mock("../../state/session", () => ({
  environmentSession: { preparedConnectionValueAtom: () => harness.PREPARED_ATOM },
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
vi.mock("../../state/entities", () => ({ readThreadShell: () => harness.shell }));
vi.mock("../settings/ProjectMemorySection", () => ({
  useProjectMemoryOperateAccess: () => harness.access,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/dialog", () => ({
  Dialog: "div",
  DialogPopup: "div",
  DialogHeader: "header",
  DialogTitle: "h1",
  DialogDescription: "p",
  DialogFooter: "footer",
}));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/checkbox", async () => {
  const react = await import("react");
  return {
    Checkbox: (props: { onCheckedChange?: () => void }) =>
      react.createElement("input", {
        type: "checkbox",
        onChange: () => props.onCheckedChange?.(),
      }),
  };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: harness.toast } }));

import { RegistryContext } from "@effect/atom-react";
import { ProjectSkillTrialDialog } from "./ProjectSkillTrialDialog";
import {
  PROJECT_SKILL_TRIAL_RECORD_LABEL,
  PROJECT_SKILL_USE_RECORD_LABEL,
  TRIAL_AUTHORIZATION_COPY,
  USE_SCRIPTS_CHANGED_COPY,
  USE_SCRIPTS_INVALID_COPY,
  USE_UNSUPPORTED_COPY,
  USE_VERSION_GONE_COPY,
  TRIAL_CONFIRM_FAILED_COPY,
  TRIAL_SEND_UNCONFIRMED_COPY,
  TRIAL_TASK_INVALID_COPY,
  TRIAL_UNSUPPORTED_COPY,
  TRIAL_DETAIL_FAILED_COPY,
  TRIAL_THREAD_UNAVAILABLE_COPY,
  TRIAL_VERSION_GONE_COPY,
} from "./ProjectSkillTrialDialog.logic";

const ENV = "env-a" as EnvironmentId;
const PROJECT = "project-a" as ProjectId;
const THREAD = "thread-a" as ThreadId;

const sha = (prefix: string) => (prefix + "0".repeat(64)).slice(0, 64);
const refV1: ProjectSkillVersionRef = {
  projectId: PROJECT,
  skillId: "psk_aaaa1111" as ProjectSkillVersionRef["skillId"],
  version: 1,
  contentSha256: sha("a"),
};
const contentV1: ProjectSkillContent = {
  title: "Deploy site",
  purpose: "Ship the staging build",
  appliesWhen: "Staging is behind",
  doesNotApplyWhen: "Production",
  procedure: "1. Build\n2. Deploy",
  successCheck: "Selected checks pass: lint",
};

const versionViewV1 = {
  version: {
    ref: refV1,
    content: contentV1,
    source: {
      type: "work" as const,
      check: {} as never,
      createdAfterEventSequence: 5,
      draft: { type: "typed" as const },
    },
    state: "candidate" as const,
    retiredReason: null,
    createdAt: "2026-10-11T00:00:00.000Z",
  },
  judgments: [],
  rightsRecorded: false,
  reviewRecorded: false,
  trials: [],
};
const detailV1: ProjectSkillDetail = {
  projectId: PROJECT,
  skillId: refV1.skillId,
  latestVersion: 1,
  versions: [versionViewV1],
};
const detailV1Rehashed: ProjectSkillDetail = {
  ...detailV1,
  versions: [
    {
      ...versionViewV1,
      version: { ...versionViewV1.version, ref: { ...refV1, contentSha256: sha("b") } },
    },
  ],
};

const summaryV1: ProjectSkillSummary = {
  ref: refV1,
  title: "Deploy site",
  state: "candidate",
  createdAt: "2026-10-11T00:00:00.000Z",
  rightsRecorded: false,
  reviewRecorded: false,
};

const settledQuery = (data: unknown) => ({
  data,
  dataUpdatedAt: 1,
  error: null,
  isPending: false,
  isSuccess: true,
  refresh: vi.fn(),
});

const shell = {
  projectId: PROJECT,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-06-01T00:00:00.000Z",
};

const confirmedSession = {
  kind: "confirmed",
  session: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
};

const scope = { environmentId: ENV, projectId: PROJECT, threadId: THREAD };
const onClose = vi.fn();

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
const hasText = (text: string) =>
  renderer!.root.findAll((node) => node.children.some((c) => c === text)).length > 0;
const editTask = (value: string) =>
  act(() =>
    renderer!.root
      .findByProps({ "aria-label": "시험 과제" })
      .props.onChange({ currentTarget: { value } }),
  );

const beginHeldConfirmation = (): ((value: unknown) => void) => {
  let resolveConfirm: (value: unknown) => void = () => {};
  const pending = new Promise<unknown>((resolve) => {
    resolveConfirm = resolve;
  });
  harness.confirmSession.mockReturnValueOnce(pending);
  return resolveConfirm;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.capability = {
    environment: { capabilities: { projectSkills: { manage: true, trial: true, use: true } } },
  };
  harness.access = "granted";
  harness.shell = shell;
  harness.registryTrial = true;
  harness.registryUse = true;
  harness.projectScripts = [
    { id: "lint", name: "Lint", command: "pnpm lint" },
    { id: "test", name: "Test", command: "pnpm test" },
  ];
  syncResolvedScripts();
  harness.registryDetail = AsyncResult.success(detailV1);
  harness.listQuery = settledQuery({ items: [summaryV1], truncated: false });
  harness.detailQuery = settledQuery(detailV1);
  harness.catalogEntry = { id: ENV };
  harness.catalog = { entries: new Map([[ENV, harness.catalogEntry]]) };
  harness.conn = AsyncResult.success({ phase: "connected", generation: 7 });
  harness.prepared = Option.some({ id: "prepared-1" });
  harness.registry = {
    get: (atom: unknown) => {
      if (atom === harness.CAPABILITY_ATOM) {
        return {
          environment: {
            capabilities: {
              projectSkills: {
                manage: true,
                trial: harness.registryTrial,
                use: harness.registryUse,
              },
            },
          },
        };
      }
      if (atom === harness.CATALOG_ATOM) return harness.catalog;
      if (atom === harness.CONN_ATOM) return harness.conn;
      if (atom === harness.PREPARED_ATOM) return harness.prepared;
      if (atom === harness.GET_ATOM) return harness.registryDetail;
      if (atom === harness.SETTINGS_ATOM) return harness.settings;
      if (atom === harness.PROJECT_ATOM) return harness.project;
      return null;
    },
  };
  for (const key of ["confirmSession", "startTurn", "toast"] as const) {
    harness[key].mockReset();
  }
  harness.confirmSession.mockResolvedValue(AsyncResult.success(confirmedSession));
  harness.startTurn.mockResolvedValue(AsyncResult.success({ turnId: "turn-1" }));
  onClose.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

const projectScript = (id: string, name: string, command = "pnpm run") => ({
  id,
  name,
  command,
  icon: "lint" as const,
  runOnWorktreeCreate: false,
});

const syncResolvedScripts = () => {
  harness.settings = {
    defaultProjectScripts: harness.projectScripts.map((entry) =>
      projectScript(entry.id, entry.name, entry.command),
    ),
    projectScriptOverrides: {},
    projectSettingsOverrides: {},
    projectSettingsFolded: true,
  };
  harness.project = {
    id: PROJECT,
    title: "project-a",
    workspaceRoot: "/project-a",
    scripts: [],
  };
};

const nodeContainsText = (node: ReactTestInstance, text: string): boolean => {
  if (node.children?.some((child) => child === text)) return true;
  for (const child of node.children ?? []) {
    if (
      typeof child === "object" &&
      child !== null &&
      nodeContainsText(child as ReactTestInstance, text)
    ) {
      return true;
    }
  }
  return false;
};

const openDialog = () => render(<ProjectSkillTrialDialog scope={scope} onClose={onClose} />);

const openUseDialog = () =>
  render(<ProjectSkillTrialDialog scope={scope} mode="use" onClose={onClose} />);

const toggleScript = (name: string) => {
  const input = renderer!.root.findAllByType("input").find((checkbox) => {
    let parent: ReactTestInstance | undefined = checkbox.parent ?? undefined;
    while (parent) {
      if (nodeContainsText(parent, name)) return true;
      parent = parent.parent ?? undefined;
    }
    return false;
  });
  act(() => input!.props.onChange());
};

const submitUseAndDrain = async () => {
  await act(async () => button("보내기").props.onClick());
  await act(async () => {});
};

const submitAndDrain = async () => {
  await act(async () => button("시험 보내기").props.onClick());
  await act(async () => {});
};

it("sends the exact block, task, and one stampless managed record through startTurn", async () => {
  openDialog();
  await act(async () => {});
  expect(renderer!.root.findByProps({ "aria-label": "버전" }).props.value).toBe("1");
  expect(renderer!.root.findByProps({ "aria-label": "스킬" }).props.value).toBe(refV1.skillId);
  expect(hasText(TRIAL_TASK_INVALID_COPY)).toBe(true);
  editTask("스테이징 배포를 시험해 주세요");
  expect(hasText(TRIAL_TASK_INVALID_COPY)).toBe(false);

  await submitAndDrain();

  expect(harness.confirmSession).toHaveBeenCalledTimes(1);
  expect(harness.startTurn).toHaveBeenCalledTimes(1);
  const call = harness.startTurn.mock.calls[0]![0];
  expect(call.environmentId).toBe(ENV);
  expect(call.input.threadId).toBe(THREAD);
  expect(call.input.modelSelection).toEqual(shell.modelSelection);
  expect(call.input.runtimeMode).toBe(shell.runtimeMode);
  expect(call.input.interactionMode).toBe(shell.interactionMode);
  const message = call.input.message;
  expect(message.role).toBe("user");
  expect(message.attachments).toEqual([]);
  expect(message.text).toBe(
    `${renderProjectSkillBlock({ ref: refV1, content: contentV1, mode: "trial" })}\n\n스테이징 배포를 시험해 주세요`,
  );
  expect(message.context).toEqual({
    version: 1,
    records: [
      {
        version: 1,
        kind: "project-skill",
        label: PROJECT_SKILL_TRIAL_RECORD_LABEL,
        contextId: expect.stringMatching(/^project-skill_/),
        payload: { ref: refV1, mode: "trial" },
      },
    ],
  });
  expect(Object.keys(message.context.records[0]!.payload)).toEqual(["ref", "mode"]);
  expect(harness.toast).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("sends nothing when the capability drops during the held confirmation", async () => {
  openDialog();
  editTask("과제");
  const resolveConfirm = beginHeldConfirmation();
  act(() => button("시험 보내기").props.onClick());
  await act(async () => {});
  expect(harness.confirmSession).toHaveBeenCalledTimes(1);

  harness.registryTrial = false;
  await act(async () => resolveConfirm(AsyncResult.success(confirmedSession)));
  await act(async () => {});

  expect(harness.startTurn).not.toHaveBeenCalled();
  expect(hasText(TRIAL_UNSUPPORTED_COPY)).toBe(true);
});

it("sends nothing when detail is waiting during held confirmation", async () => {
  openDialog();
  editTask("과제");
  const resolveConfirm = beginHeldConfirmation();
  act(() => button("시험 보내기").props.onClick());
  await act(async () => {});

  harness.registryDetail = AsyncResult.success(detailV1, { waiting: true });
  await act(async () => resolveConfirm(AsyncResult.success(confirmedSession)));
  await act(async () => {});

  expect(harness.startTurn).not.toHaveBeenCalled();
  expect(hasText(TRIAL_DETAIL_FAILED_COPY)).toBe(true);
});

it("sends nothing when the thread is recreated under the same id during held confirmation", async () => {
  openDialog();
  editTask("과제");
  const resolveConfirm = beginHeldConfirmation();
  act(() => button("시험 보내기").props.onClick());
  await act(async () => {});
  expect(harness.confirmSession).toHaveBeenCalledTimes(1);
  expect(harness.startTurn).not.toHaveBeenCalled();

  harness.shell = { ...shell, createdAt: "2026-06-02T00:00:00.000Z" };
  await act(async () => resolveConfirm(AsyncResult.success(confirmedSession)));
  await act(async () => {});

  expect(harness.startTurn).not.toHaveBeenCalled();
  expect(hasText(TRIAL_THREAD_UNAVAILABLE_COPY)).toBe(true);
  expect(renderer!.root.findByProps({ "aria-label": "시험 과제" }).props.value).toBe("과제");
});

it("sends nothing when the frozen version is gone during the held confirmation", async () => {
  openDialog();
  editTask("과제");
  const resolveConfirm = beginHeldConfirmation();
  act(() => button("시험 보내기").props.onClick());
  await act(async () => {});

  harness.registryDetail = AsyncResult.success(detailV1Rehashed);
  await act(async () => resolveConfirm(AsyncResult.success(confirmedSession)));
  await act(async () => {});

  expect(harness.startTurn).not.toHaveBeenCalled();
  expect(hasText(TRIAL_VERSION_GONE_COPY)).toBe(true);
});

it("keeps the draft on known authorization rejection and allows a new attempt", async () => {
  openDialog();
  editTask("과제");

  harness.startTurn.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail({ _tag: "EnvironmentAuthorizationError" })),
  );
  await submitAndDrain();

  expect(harness.startTurn).toHaveBeenCalledTimes(1);
  expect(hasText(TRIAL_AUTHORIZATION_COPY)).toBe(true);
  expect(button("시험 보내기").props.disabled).toBe(false);

  harness.startTurn.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error("SENTINEL-SERVER-DETAIL-LEAK boom"))),
  );
  await submitAndDrain();
  expect(harness.startTurn).toHaveBeenCalledTimes(2);
  expect(hasText("SENTINEL-SERVER-DETAIL-LEAK")).toBe(false);
  expect(hasText(TRIAL_SEND_UNCONFIRMED_COPY)).toBe(true);
  expect(button("시험 보내기").props.disabled).toBe(true);
  act(() => button("시험 보내기").props.onClick());
  expect(harness.startTurn).toHaveBeenCalledTimes(2);
});

it("coalesces a double click into exactly one send", async () => {
  openDialog();
  editTask("과제");

  let resolveSend: (value: unknown) => void = () => {};
  harness.startTurn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
  );

  act(() => button("시험 보내기").props.onClick());
  act(() => button("시험 보내기").props.onClick());
  await act(async () => {});
  expect(harness.confirmSession).toHaveBeenCalledTimes(1);
  expect(harness.startTurn).toHaveBeenCalledTimes(1);

  await act(async () => resolveSend(AsyncResult.success({ turnId: "turn-1" })));
  await act(async () => {});
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("ignores a late success after the dialog switched scope", async () => {
  openDialog();
  editTask("과제 A");

  let resolveSend: (value: unknown) => void = () => {};
  harness.startTurn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
  );
  act(() => button("시험 보내기").props.onClick());
  await act(async () => {});
  expect(harness.startTurn).toHaveBeenCalledTimes(1);

  render(
    <ProjectSkillTrialDialog
      scope={{ environmentId: ENV, projectId: PROJECT, threadId: "thread-b" as ThreadId }}
      onClose={onClose}
    />,
  );

  await act(async () => resolveSend(AsyncResult.success({ turnId: "turn-1" })));
  await act(async () => {});
  expect(harness.toast).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it("does not toast success when the connection generation changes during send", async () => {
  openDialog();
  editTask("과제");

  let resolveSend: (value: unknown) => void = () => {};
  harness.startTurn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
  );
  act(() => button("시험 보내기").props.onClick());
  await act(async () => {});
  expect(harness.confirmSession).toHaveBeenCalledTimes(1);
  expect(harness.startTurn).toHaveBeenCalledTimes(1);

  harness.conn = AsyncResult.success({ phase: "connected", generation: 8 });
  await act(async () => resolveSend(AsyncResult.success({ turnId: "turn-1" })));
  await act(async () => {});

  expect(harness.toast).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ "aria-label": "시험 과제" }).props.value).toBe("과제");
  expect(hasText(TRIAL_SEND_UNCONFIRMED_COPY)).toBe(true);
  expect(button("시험 보내기").props.disabled).toBe(true);
});

it("treats an interrupted send as unconfirmed, not never-sent", async () => {
  openDialog();
  editTask("과제");

  harness.startTurn.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
  await submitAndDrain();

  expect(harness.startTurn).toHaveBeenCalledTimes(1);
  expect(hasText(TRIAL_SEND_UNCONFIRMED_COPY)).toBe(true);
  expect(button("시험 보내기").props.disabled).toBe(true);
});

it("gates everything while the trial capability is absent", () => {
  harness.capability = {
    environment: { capabilities: { projectSkills: { manage: true } } },
  };
  harness.registryTrial = false;
  openDialog();

  expect(hasText(TRIAL_UNSUPPORTED_COPY)).toBe(true);
  expect(button("시험 보내기").props.disabled).toBe(true);
});

it("in use mode sends the active older ref, mode use, and frozen script ids", async () => {
  const refV2 = { ...refV1, version: 2, contentSha256: sha("b") };
  const summaryV2: ProjectSkillSummary = {
    ...summaryV1,
    ref: refV2,
    state: "candidate",
  };
  const versionViewActive = {
    ...versionViewV1,
    version: { ...versionViewV1.version, state: "active" as const },
  };
  const versionViewCandidate = {
    ...versionViewV1,
    version: {
      ...versionViewV1.version,
      ref: refV2,
      state: "candidate" as const,
    },
  };
  const detailDual: ProjectSkillDetail = {
    projectId: PROJECT,
    skillId: refV1.skillId,
    latestVersion: 2,
    versions: [versionViewActive, versionViewCandidate],
  };
  harness.listQuery = settledQuery({ items: [summaryV2], truncated: false });
  harness.detailQuery = settledQuery(detailDual);
  harness.registryDetail = AsyncResult.success(detailDual);

  openUseDialog();
  await act(async () => {});
  expect(renderer!.root.findByProps({ "aria-label": "버전" }).props.value).toBe("1");
  toggleScript("Lint");
  editTask("이번 요청 과제");
  await submitUseAndDrain();

  expect(harness.startTurn).toHaveBeenCalledTimes(1);
  const message = harness.startTurn.mock.calls[0]![0].input.message;
  expect(message.text).toBe(
    `${renderProjectSkillBlock({ ref: refV1, content: contentV1, mode: "use" })}\n\n이번 요청 과제`,
  );
  expect(message.context.records[0]).toMatchObject({
    label: PROJECT_SKILL_USE_RECORD_LABEL,
    payload: { ref: refV1, mode: "use", selectedScriptIds: ["lint"] },
  });
  expect(Object.keys(message.context.records[0]!.payload)).toEqual([
    "ref",
    "mode",
    "selectedScriptIds",
  ]);
});

it("keeps trial unchanged when use capability is absent and blocks use sends", async () => {
  harness.capability = {
    environment: { capabilities: { projectSkills: { manage: true, trial: true } } },
  };
  harness.registryUse = false;
  openUseDialog();
  await act(async () => {});
  expect(hasText(USE_UNSUPPORTED_COPY)).toBe(true);
  expect(button("보내기").props.disabled).toBe(true);

  harness.registryUse = false;
  harness.registryTrial = true;
  openDialog();
  editTask("과제");
  await submitAndDrain();
  expect(harness.startTurn).toHaveBeenCalledTimes(1);
});

it("refuses submit without confirm when the selected script is gone from the registry before submit", async () => {
  const versionViewActive = {
    ...versionViewV1,
    version: { ...versionViewV1.version, state: "active" as const },
  };
  const detailActive: ProjectSkillDetail = {
    ...detailV1,
    versions: [versionViewActive],
  };
  harness.detailQuery = settledQuery(detailActive);
  harness.registryDetail = AsyncResult.success(detailActive);

  openUseDialog();
  toggleScript("Lint");
  editTask("과제");
  harness.projectScripts = [];
  syncResolvedScripts();

  await submitUseAndDrain();

  expect(harness.confirmSession).not.toHaveBeenCalled();
  expect(harness.startTurn).not.toHaveBeenCalled();
  expect(hasText(USE_SCRIPTS_INVALID_COPY)).toBe(true);
  expect(button("보내기").props.disabled).toBe(false);

  harness.projectScripts = [{ id: "lint", name: "Lint", command: "pnpm lint" }];
  syncResolvedScripts();
  await submitUseAndDrain();

  expect(harness.confirmSession).toHaveBeenCalledTimes(1);
  expect(harness.startTurn).toHaveBeenCalledTimes(1);
});

it("sends nothing when project scripts change during held confirmation in use mode", async () => {
  const versionViewActive = {
    ...versionViewV1,
    version: { ...versionViewV1.version, state: "active" as const },
  };
  const detailActive: ProjectSkillDetail = {
    ...detailV1,
    versions: [versionViewActive],
  };
  harness.detailQuery = settledQuery(detailActive);
  harness.registryDetail = AsyncResult.success(detailActive);

  openUseDialog();
  toggleScript("Lint");
  editTask("과제");
  const resolveConfirm = beginHeldConfirmation();
  act(() => button("보내기").props.onClick());
  await act(async () => {});

  harness.projectScripts = [{ id: "test", name: "Test", command: "pnpm test" }];
  syncResolvedScripts();
  await act(async () => resolveConfirm(AsyncResult.success(confirmedSession)));
  await act(async () => {});

  expect(harness.startTurn).not.toHaveBeenCalled();
  expect(hasText(USE_SCRIPTS_CHANGED_COPY)).toBe(true);
  expect(renderer!.root.findByProps({ "aria-label": "시험 과제" }).props.value).toBe("과제");
});

it("sends nothing when a selected script command changes in settings during held confirmation", async () => {
  const versionViewActive = {
    ...versionViewV1,
    version: { ...versionViewV1.version, state: "active" as const },
  };
  const detailActive: ProjectSkillDetail = {
    ...detailV1,
    versions: [versionViewActive],
  };
  harness.detailQuery = settledQuery(detailActive);
  harness.registryDetail = AsyncResult.success(detailActive);

  openUseDialog();
  toggleScript("Lint");
  editTask("과제");
  const resolveConfirm = beginHeldConfirmation();
  act(() => button("보내기").props.onClick());
  await act(async () => {});

  harness.projectScripts = [{ id: "lint", name: "Lint", command: "pnpm lint --fix" }];
  syncResolvedScripts();
  await act(async () => resolveConfirm(AsyncResult.success(confirmedSession)));
  await act(async () => {});

  expect(harness.startTurn).not.toHaveBeenCalled();
  expect(hasText(USE_SCRIPTS_CHANGED_COPY)).toBe(true);
});

it("sends nothing when the active ref retires during held confirmation in use mode", async () => {
  const versionViewActive = {
    ...versionViewV1,
    version: { ...versionViewV1.version, state: "active" as const },
  };
  const detailActive: ProjectSkillDetail = {
    ...detailV1,
    versions: [versionViewActive],
  };
  harness.detailQuery = settledQuery(detailActive);
  harness.registryDetail = AsyncResult.success(detailActive);

  openUseDialog();
  toggleScript("Lint");
  editTask("과제");
  const resolveConfirm = beginHeldConfirmation();
  act(() => button("보내기").props.onClick());
  await act(async () => {});

  harness.registryDetail = AsyncResult.success({
    ...detailActive,
    versions: [
      {
        ...versionViewActive,
        version: { ...versionViewActive.version, state: "retired" as const },
      },
    ],
  });
  await act(async () => resolveConfirm(AsyncResult.success(confirmedSession)));
  await act(async () => {});

  expect(harness.startTurn).not.toHaveBeenCalled();
  expect(hasText(USE_VERSION_GONE_COPY)).toBe(true);
});

it("freezes script selection at submit so mid-await toggles cannot swap the operation", async () => {
  const versionViewActive = {
    ...versionViewV1,
    version: { ...versionViewV1.version, state: "active" as const },
  };
  const detailActive: ProjectSkillDetail = {
    ...detailV1,
    versions: [versionViewActive],
  };
  harness.detailQuery = settledQuery(detailActive);
  harness.registryDetail = AsyncResult.success(detailActive);

  openUseDialog();
  toggleScript("Lint");
  editTask("과제");

  let resolveSend: (value: unknown) => void = () => {};
  harness.startTurn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
  );
  const resolveConfirm = beginHeldConfirmation();
  act(() => button("보내기").props.onClick());
  await act(async () => {});
  await act(async () => resolveConfirm(AsyncResult.success(confirmedSession)));
  await act(async () => {});

  toggleScript("Test");
  await act(async () => resolveSend(AsyncResult.success({ turnId: "turn-use" })));
  await act(async () => {});

  const payload = harness.startTurn.mock.calls[0]![0].input.message.context.records[0]!.payload;
  expect(payload).toMatchObject({ selectedScriptIds: ["lint"] });
});

it("shows connection copy when confirmation fails and authorization when scope is missing", async () => {
  openDialog();
  editTask("과제");

  harness.confirmSession.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("x"))));
  await submitAndDrain();
  expect(harness.startTurn).not.toHaveBeenCalled();
  expect(hasText(TRIAL_CONFIRM_FAILED_COPY)).toBe(true);

  harness.confirmSession.mockResolvedValueOnce(
    AsyncResult.success({ kind: "confirmed", session: { authenticated: true, scopes: [] } }),
  );
  await submitAndDrain();
  expect(hasText(TRIAL_AUTHORIZATION_COPY)).toBe(true);
});
