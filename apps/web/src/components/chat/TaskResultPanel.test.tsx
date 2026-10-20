import {
  ProjectId,
  TaskResultRejectedError,
  WS_METHODS,
  type TaskResultGetResult,
  type TaskResultRecord,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SelectedChecksCurrentSource } from "../../state/selectedChecks";
import { taskResultGet, taskResultSetRequirements } from "../../state/taskResult";
import {
  callsOf,
  completion,
  drainTaskResultBag,
  entriesOf,
  getTaskResultBag,
  type TaskResultTestBag,
} from "../../state/taskResult.test-fixture";
import { TaskResultPanel } from "./TaskResultPanel";

const GET_METHOD = WS_METHODS.taskResultGet;
const SET_METHOD = WS_METHODS.taskResultSetRequirements;

const GET_LABEL = taskResultGet.label;
const SET_LABEL = taskResultSetRequirements.label;

vi.mock("../../connection/runtime", async () => ({
  connectionAtomRuntime: (await import("../../state/taskResult.test-fixture")).getTaskResultBag()
    .testRuntime,
}));

vi.mock("../../state/use-atom-command", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/use-atom-command")>();
  const { getTaskResultBag: bag, wrapUseAtomCommand: wrap } =
    await import("../../state/taskResult.test-fixture");
  return wrap(original, bag());
});

vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({ latestTurn: { state: "completed" } }),
}));

vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("../ui/input", () => ({
  Input: (props: {
    value: string;
    disabled?: boolean;
    onChange: (event: { target: { value: string } }) => void;
  }) =>
    createElement("input", {
      value: props.value,
      disabled: props.disabled,
      onChange: (event: { target: { value: string } }) => props.onChange(event),
    }),
}));

const bag: TaskResultTestBag = getTaskResultBag();
const environmentId = bag.environmentId;
const threadId = bag.threadId;
let renderer: ReactTestRenderer | undefined;

function minimalRecord(): TaskResultRecord {
  return {
    schemaVersion: 1,
    threadId,
    revision: 0,
    threadIncarnation: 2,
    requirements: {
      version: 1,
      items: [{ id: "r1", text: "Lint", scriptIds: ["lint"] }],
      checks: [{ scriptId: "lint", commandSha256: "a".repeat(64) }],
      setAt: "2026-01-01T00:00:00.000Z",
    },
    acceptance: null,
  };
}

function minimalGetResult(): TaskResultGetResult {
  return {
    record: { kind: "present", record: minimalRecord(), sequence: 1 },
    threadIncarnation: 2,
    checks: {
      capability: { available: true, reason: null },
      record: { kind: "none" },
      changedScriptIds: [],
      admission: { state: "open" },
      treeUnchanged: true,
      environmentMatches: true,
      contextMatches: true,
    },
  };
}

function readSource(): SelectedChecksCurrentSource {
  return {
    environmentId,
    threadId,
    lifecycleKey: "k",
    permission: "allowed",
    permissionStatus: "confirmed",
    confirmationAttempt: 1,
    recordKey: "a:1:2:completed",
    projectId: ProjectId.make("project-panel"),
    view: {
      open: true,
      headline: "passed",
      hasCurrentAuthority: true,
      getInFlight: false,
      getError: null,
      record: null,
      recordAuthority: "current",
      derived: null,
      live: null,
      liveIsNewer: false,
      admission: { state: "open" },
      capability: { available: true, reason: null },
      changedScriptIds: [],
      comparisonStale: false,
      newerTurnAfterRecord: false,
      selection: [],
      pendingRunAttemptId: null,
      commandInFlight: null,
      notice: null,
      stopAttemptId: null,
      canRun: false,
      canStop: false,
      canRecover: false,
      dialog: null,
      dialogSubmit: null,
    },
  };
}

async function settleGet(methodOrdinal: number) {
  const entry = entriesOf(bag, GET_METHOD)[methodOrdinal - 1];
  if (entry === undefined) throw new Error("no pending get");
  await act(async () => {
    entry.deferred.resolve(minimalGetResult());
    await completion(bag, GET_LABEL, methodOrdinal);
  });
}

/** Requirement text inputs carry a string `value`; checkbox inputs never do. */
function requirementTextInput(root: ReactTestInstance): ReactTestInstance {
  const textInput = root
    .findAllByType("input")
    .find((node) => typeof node.props.value === "string");
  if (textInput === undefined) throw new Error("requirement text input not found");
  return textInput;
}

describe("TaskResultPanel", () => {
  beforeEach(() => {
    bag.rpcEntries.length = 0;
    bag.rpcCalls.length = 0;
    bag.recorded.completions.length = 0;
    bag.teardown.current = false;
    bag.setFailure.current = new TaskResultRejectedError({
      reason: "conflict",
      detail: "write-unconfirmed",
    });
    renderer = undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    if (renderer !== undefined) {
      await act(() => renderer?.unmount());
      renderer = undefined;
    }
    await act(async () => {
      await drainTaskResultBag(bag);
    });
    vi.unstubAllGlobals();
  });

  it("keeps edited requirement text through a refused save and held reconciliation read", async () => {
    let tree!: ReactTestRenderer;
    await act(() => {
      tree = create(
        createElement(
          RegistryContext.Provider,
          { value: bag.registry },
          createElement(TaskResultPanel, {
            environmentId,
            threadId,
            readCurrentSource: readSource,
            candidates: [
              {
                id: "lint",
                name: "Lint",
                command: "lint",
                icon: "lint",
                runOnWorktreeCreate: false,
              },
            ],
            recordKey: "a:1:2:completed",
          }),
        ),
      );
      renderer = tree;
    });
    await act(async () => {
      await bag.waitForCall(GET_METHOD, 1);
    });

    await settleGet(1);

    const input = requirementTextInput(tree.root);
    await act(async () => {
      input.props.onChange({ target: { value: "Edited in panel" } });
    });

    const save = tree.root.findByProps({ children: "Save requirements" });
    await act(async () => {
      save.props.onClick();
      await bag.waitForCall(SET_METHOD, 1);
      await completion(bag, SET_LABEL, 1);
      await bag.waitForCall(GET_METHOD, 2);
    });
    expect(callsOf(bag, SET_METHOD)).toEqual([
      {
        threadId,
        threadIncarnation: 2,
        expectedRevision: 0,
        items: [{ id: "r1", text: "Edited in panel", scriptIds: ["lint"] }],
      },
    ]);
    expect(tree.root.findAllByProps({ children: "Unsaved requirement edits." }).length).toBe(1);
    expect(requirementTextInput(tree.root).props.value).toBe("Edited in panel");
    // Held reconciliation keeps the dirty draft visible but read-only, with no
    // stale acceptance/verification claim.
    expect(requirementTextInput(tree.root).props.disabled).toBe(true);
    expect(tree.root.findAllByProps({ children: "Verified by you" }).length).toBe(0);
    expect(entriesOf(bag, GET_METHOD)).toHaveLength(2);

    await settleGet(2);
    expect(requirementTextInput(tree.root).props.value).toBe("Edited in panel");
    expect(tree.root.findAllByProps({ children: "Verified by you" }).length).toBe(0);
  });
});
