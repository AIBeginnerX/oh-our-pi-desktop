// React interaction tests for the project-memory recovery hook (M3 R1–R13).
// The atom boundary is controlled by the harness (config + thread-state result),
// commands and the new-thread handler are spies, and the composer draft store is
// the real one: every scenario drives actual clicks and asserts actual store or
// spy outcomes, not rendered markup shape.
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  DraftId,
  composerDraftHasUserContent,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useProjectMemoryRecovery } from "./ProjectMemoryRecovery";

const { harness, QUERY_ATOM, CONFIG_ATOM, ACK_CMD, REVALIDATE_CMD } = vi.hoisted(() => ({
  harness: {
    config: null as unknown,
    raw: null as unknown,
    threadStateTargets: [] as unknown[],
    shellReads: [] as unknown[],
    shell: null as unknown,
    acknowledge: vi.fn(),
    revalidate: vi.fn(),
    handleNewThread: vi.fn(),
  },
  QUERY_ATOM: { sentinel: "thread-state-query" },
  CONFIG_ATOM: { sentinel: "config-value" },
  ACK_CMD: { sentinel: "acknowledge-thread" },
  REVALIDATE_CMD: { sentinel: "revalidate" },
}));

vi.mock("../../state/projectMemory", () => ({
  projectMemory: {
    threadState: (target: unknown) => {
      harness.threadStateTargets.push(target);
      return QUERY_ATOM;
    },
    acknowledgeThread: ACK_CMD,
    revalidate: REVALIDATE_CMD,
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === ACK_CMD
      ? harness.acknowledge
      : command === REVALIDATE_CMD
        ? harness.revalidate
        : vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === CONFIG_ATOM ? harness.config : harness.raw),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => CONFIG_ATOM },
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => harness.handleNewThread,
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: (ref: unknown) => {
    harness.shellReads.push(ref);
    return harness.shell;
  },
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: "div",
  AlertDialogPopup: "div",
  AlertDialogHeader: "header",
  AlertDialogTitle: "h2",
  AlertDialogDescription: "p",
  AlertDialogFooter: "footer",
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipTrigger: (props: { render?: ReactNode }) => props.render ?? null,
  TooltipPopup: "span",
}));

type RecoveryInput = Parameters<typeof useProjectMemoryRecovery>[0];

const envId = EnvironmentId.make("env-a");
const projectId = ProjectId.make("project-a");
const threadId = ThreadId.make("thread-a");
const sourceRef = scopeThreadRef(envId, threadId);
const projectRef = scopeProjectRef(envId, projectId);
const capabilityOn = {
  environment: { capabilities: { projectMemory: { threadRecovery: true } } },
};
const baseInput: RecoveryInput = {
  environmentId: envId,
  projectId,
  threadId,
  isServerThread: true,
  activities: [],
};

const heldRaw = (seq: number, mayHaveMore = false) =>
  AsyncResult.success({
    held: true,
    latestChangeSeq: seq,
    acknowledgedThrough: 0,
    changes: [
      { changeSeq: seq, reason: "updated" },
      { changeSeq: seq - 1, reason: "deleted" },
    ],
    mayHaveMore,
  });
const ackSuccess = AsyncResult.success({ status: "applied", acknowledgedThrough: 7 });

const TestHost = (props: { readonly input: RecoveryInput }) => {
  const { bannerItem, dialog } = useProjectMemoryRecovery(props.input);
  return (
    <div>
      {bannerItem === null ? null : (
        <div data-testid="banner">
          <div>{bannerItem.title}</div>
          {bannerItem.description === undefined ? null : <div>{bannerItem.description}</div>}
          {bannerItem.actions ?? null}
        </div>
      )}
      {dialog}
    </div>
  );
};

let renderer: ReactTestRenderer | null = null;
const render = (input: RecoveryInput) => {
  const element = <TestHost input={input} />;
  act(() => {
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
};
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.props.children === label);
const click = (label: string) => {
  const node = button(label);
  if (!node) throw new Error(`missing button: ${label}`);
  act(() => {
    node.props.onClick?.();
  });
};
const textOfInstance = (node: ReactTestInstance | string): string => {
  if (typeof node === "string") return node;
  return node.children
    .map((child) => (typeof child === "string" ? child : textOfInstance(child)))
    .join("");
};
const rootText = () => textOfInstance(renderer!.root);
const bannerText = () => {
  const banner = renderer!.root.findAllByProps({ "data-testid": "banner" }).at(0);
  return banner === undefined ? "" : textOfInstance(banner);
};

const realSetPrompt = useComposerDraftStore.getState().setPrompt;
let setPrompt: ReturnType<typeof vi.fn>;
const draftStore = () => useComposerDraftStore.getState();
/** Registers a live, unpromoted, empty draft session for `id` in the active project. */
const registerDraft = (id: string, thread: string) => {
  draftStore().setLogicalProjectDraftThreadId("logical-key-a", projectRef, DraftId.make(id), {
    threadId: ThreadId.make(thread),
  });
};
/** Fixture writes bypass the setPrompt spy so oracles only count recovery carry writes. */
const seedComposerPrompt = (...args: Parameters<typeof realSetPrompt>) => {
  realSetPrompt(...args);
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.config = capabilityOn;
  harness.raw = AsyncResult.initial(false);
  harness.threadStateTargets.length = 0;
  harness.shellReads.length = 0;
  harness.shell = null;
  harness.acknowledge.mockReset().mockResolvedValue(ackSuccess);
  harness.revalidate.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  harness.handleNewThread.mockReset();
  setPrompt = vi.fn(realSetPrompt);
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    backgroundSubmissionThreadKeys: {},
    rewindingThreadKeys: new Set(),
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
    setPrompt: setPrompt as unknown as typeof realSetPrompt,
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

it("R1: held banner → Keep this thread's context → confirm acknowledges the displayed seq", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  await act(async () => {});
  expect(bannerText()).toContain("Project memory used by this thread changed");
  expect(bannerText()).toContain("1 updated · 1 deleted in the latest 2 recorded changes");

  await act(async () => {
    click("Keep this thread's context");
  });
  expect(rootText()).toContain(
    "This accepts all project-memory changes recorded for this thread through change #7, including changes not shown here.",
  );
  expect(rootText()).toContain(
    "The provider may still have the earlier memory content. Nothing is removed from the provider or its history.",
  );
  expect(rootText()).toContain("Any later change will hold this thread again.");

  await act(async () => click("Confirm"));
  expect(harness.acknowledge).toHaveBeenCalledTimes(1);
  expect(harness.acknowledge.mock.calls[0]?.[0]).toEqual({
    environmentId: envId,
    input: { projectId, threadId, throughChangeSeq: 7 },
  });
  expect(button("Confirm")).toBeUndefined();
});

it("R2: pending then a new seq in the same scope keeps the dialog open with only the confirm disabled", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  await act(async () => {});
  await act(async () => {
    click("Keep this thread's context");
  });

  harness.raw = AsyncResult.initial(true);
  render(baseInput);
  await act(async () => {});
  expect(button("Confirm")).toBeDefined();
  expect(button("Confirm")!.props.disabled).toBe(true);
  expect(rootText()).toContain("Changes were updated. Close and review again.");
  expect(harness.acknowledge).not.toHaveBeenCalled();

  harness.raw = heldRaw(9);
  render(baseInput);
  await act(async () => {});
  expect(button("Confirm")!.props.disabled).toBe(true);
  await act(async () => click("Confirm"));
  expect(harness.acknowledge).not.toHaveBeenCalled();
  // The captured watermark is never advanced to the newer seq.
  expect(rootText()).toContain("through change #7");
});

it("R3: the same seq in another scope closes the dialog and drops the old scope's async result", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  let resolveAckA: ((result: unknown) => void) | undefined;
  harness.acknowledge.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveAckA = resolve;
      }),
  );
  await act(async () => {
    click("Keep this thread's context");
  });
  await act(async () => {
    click("Confirm");
  });
  expect(harness.acknowledge).toHaveBeenCalledTimes(1);

  const threadB = ThreadId.make("thread-b");
  harness.raw = heldRaw(7);
  render({ ...baseInput, threadId: threadB });
  await act(async () => {});
  expect(button("Confirm")).toBeUndefined();

  let resolveContinueB: ((opened: { draftId: DraftId; threadId: ThreadId }) => void) | undefined;
  harness.handleNewThread.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveContinueB = resolve;
      }),
  );
  registerDraft("draft-r3b", "thread-r3b");
  await act(async () => {
    click("Continue in new thread");
  });
  expect(harness.handleNewThread).toHaveBeenCalledTimes(1);
  expect(button("Continue in new thread")!.props.disabled).toBe(true);

  await act(async () =>
    resolveAckA?.(AsyncResult.success({ status: "applied", acknowledgedThrough: 7 })),
  );
  expect(button("Confirm")).toBeUndefined();
  expect(button("Close")).toBeUndefined();
  expect(button("Continue in new thread")!.props.disabled).toBe(true);
  await act(async () => {
    click("Continue in new thread");
  });
  expect(harness.handleNewThread).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveContinueB?.({
      draftId: DraftId.make("draft-r3b"),
      threadId: ThreadId.make("thread-r3b"),
    });
  });
  expect(button("Continue in new thread")!.props.disabled).toBe(false);
});

it("R3b: a late ack from an earlier visit to the same scope cannot clear a newer pending confirm", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  let resolveAckFirst: ((result: unknown) => void) | undefined;
  harness.acknowledge.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveAckFirst = resolve;
      }),
  );
  await act(async () => {
    click("Keep this thread's context");
  });
  await act(async () => {
    click("Confirm");
  });
  expect(harness.acknowledge).toHaveBeenCalledTimes(1);

  harness.raw = heldRaw(7);
  render({ ...baseInput, threadId: ThreadId.make("thread-b") });
  await act(async () => {});

  harness.raw = heldRaw(7);
  render(baseInput);
  await act(async () => {});

  let resolveAckSecond: ((result: unknown) => void) | undefined;
  harness.acknowledge.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveAckSecond = resolve;
      }),
  );
  await act(async () => {
    click("Keep this thread's context");
  });
  await act(async () => {
    click("Confirm");
  });
  expect(harness.acknowledge).toHaveBeenCalledTimes(2);
  expect(button("Confirm")).toBeDefined();
  expect(rootText()).toContain("through change #7");

  await act(async () =>
    resolveAckFirst?.(AsyncResult.success({ status: "applied", acknowledgedThrough: 7 })),
  );
  expect(button("Confirm")).toBeDefined();
  expect(button("Confirm")!.props.disabled).toBe(true);
  expect(rootText()).toContain("through change #7");
  expect(harness.acknowledge).toHaveBeenCalledTimes(2);

  await act(async () => {
    click("Confirm");
  });
  expect(harness.acknowledge).toHaveBeenCalledTimes(2);

  await act(async () =>
    resolveAckSecond?.(AsyncResult.success({ status: "applied", acknowledgedThrough: 7 })),
  );
  expect(button("Confirm")).toBeUndefined();
});

it("R4: capability off→on keeps hook order, skips the RPC while off, and closes the dialog", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  await act(async () => {});
  expect(harness.threadStateTargets).toHaveLength(1);
  await act(async () => {
    click("Keep this thread's context");
  });
  expect(button("Confirm")).toBeDefined();

  harness.config = null;
  render(baseInput);
  await act(async () => {});
  expect(harness.threadStateTargets).toHaveLength(1);
  expect(button("Confirm")).toBeUndefined();

  harness.config = capabilityOn;
  render(baseInput);
  await act(async () => {});
  expect(harness.threadStateTargets).toHaveLength(2);
});

it("R5: a fast second confirm click is one call, and all actions disable while in flight", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  harness.acknowledge.mockImplementationOnce(() => new Promise(() => {}));
  await act(async () => {
    click("Keep this thread's context");
  });
  await act(async () => {
    click("Confirm");
    click("Confirm");
  });
  expect(harness.acknowledge).toHaveBeenCalledTimes(1);
  expect(button("Confirm")!.props.disabled).toBe(true);
  expect(button("Continue in new thread")!.props.disabled).toBe(true);
  expect(button("Keep this thread's context")!.props.disabled).toBe(true);
});

it("R6: a failed confirm retries the same captured seq; a permission failure never retries", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  await act(async () => {
    click("Keep this thread's context");
  });

  harness.acknowledge.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail({ _tag: "ProjectMemoryStoreError", message: "store down" })),
  );
  await act(async () => click("Confirm"));
  expect(rootText()).toContain("Couldn't confirm. Review the changes and try again.");
  expect(button("Confirm")!.props.disabled).toBe(false);
  await act(async () => click("Confirm"));
  expect(harness.acknowledge).toHaveBeenCalledTimes(2);
  expect(harness.acknowledge.mock.calls[1]?.[0].input.throughChangeSeq).toBe(7);
  expect(button("Confirm")).toBeUndefined();

  await act(async () => {
    click("Keep this thread's context");
  });

  harness.acknowledge.mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail({
        _tag: "EnvironmentAuthorizationError",
        message: "denied",
        requiredScope: "operate",
      }),
    ),
  );
  await act(async () => click("Confirm"));
  expect(rootText()).toContain("You don't have permission to confirm this on this server.");
  expect(button("Confirm")!.props.disabled).toBe(true);
  await act(async () => click("Confirm"));
  expect(harness.acknowledge).toHaveBeenCalledTimes(3);
});

it("R7: after a successful ack the banner persists through waiting and a failed refetch", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  await act(async () => {});
  await act(async () => click("Keep this thread's context"));
  await act(async () => click("Confirm"));
  expect(button("Confirm")).toBeUndefined();

  harness.raw = AsyncResult.initial(true);
  render(baseInput);
  await act(async () => {});
  expect(bannerText()).toContain("Checking project memory changes…");

  harness.raw = AsyncResult.failure(Cause.fail(new Error("refresh failed")));
  render(baseInput);
  await act(async () => {});
  expect(bannerText()).toContain("Couldn't check project memory changes for this thread.");

  harness.raw = heldRaw(9);
  render(baseInput);
  await act(async () => {});
  expect(bannerText()).toContain("Project memory used by this thread changed");
});

it("R8: the new draft receives only the sanitized current prompt; the source prompt is intact", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  const destinationId = DraftId.make("draft-r8");
  const destinationThreadId = ThreadId.make("thread-r8");
  harness.handleNewThread.mockResolvedValueOnce({
    draftId: destinationId,
    threadId: destinationThreadId,
  });
  registerDraft("draft-r8", "thread-r8");
  seedComposerPrompt(sourceRef, "NEW-DRAFT review [Project memory](t3-context://v1/memory/m1)");
  setPrompt.mockClear();

  await act(async () => click("Continue in new thread"));

  expect(harness.handleNewThread).toHaveBeenCalledTimes(1);
  expect(harness.handleNewThread).toHaveBeenCalledWith(projectRef);
  // The only thread state consulted is the destination shell, never the source.
  expect(harness.shellReads).toEqual([scopeThreadRef(envId, destinationThreadId)]);
  const destination = draftStore().getComposerDraft(destinationId);
  expect(destination?.prompt).toBe("NEW-DRAFT review");
  expect(destination?.prompt).not.toContain("OLD-MSG");
  expect(setPrompt).toHaveBeenCalledTimes(1);
  expect(setPrompt.mock.calls[0]?.[0]).toEqual(destinationId);
  // The source thread keeps its exact unsent prompt.
  expect(draftStore().getComposerDraft(sourceRef)?.prompt).toBe(
    "NEW-DRAFT review [Project memory](t3-context://v1/memory/m1)",
  );
  expect(harness.acknowledge).not.toHaveBeenCalled();
});

it("R8b: a prompt that sanitizes to empty leaves the new draft empty", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  const destinationId = DraftId.make("draft-r8b");
  harness.handleNewThread.mockResolvedValueOnce({
    draftId: destinationId,
    threadId: ThreadId.make("thread-r8b"),
  });
  registerDraft("draft-r8b", "thread-r8b");
  seedComposerPrompt(sourceRef, "[Project memory](t3-context://v1/memory/m1)");
  setPrompt.mockClear();

  await act(async () => click("Continue in new thread"));

  expect(setPrompt).not.toHaveBeenCalled();
  const destination = draftStore().getComposerDraft(destinationId);
  expect(destination?.prompt ?? "").toBe("");
  expect(composerDraftHasUserContent(destination)).toBe(false);
});

it("R9: promoted, remapped, missing, invested, shell-backed, or null destinations never get a write", async () => {
  const cases: Array<{
    readonly name: string;
    readonly prepare?: () => void;
    readonly returned: { draftId: DraftId; threadId: ThreadId } | null;
  }> = [
    {
      name: "promoted draft",
      prepare: () => {
        registerDraft("draft-r9", "thread-r9");
        draftStore().markDraftThreadPromoting(DraftId.make("draft-r9"));
      },
      returned: { draftId: DraftId.make("draft-r9"), threadId: ThreadId.make("thread-r9") },
    },
    {
      name: "remapped to another project",
      prepare: () => {
        registerDraft("draft-r9", "thread-r9");
        draftStore().setLogicalProjectDraftThreadId(
          "logical-key-b",
          scopeProjectRef(envId, ProjectId.make("project-b")),
          DraftId.make("draft-r9"),
          { threadId: ThreadId.make("thread-r9") },
        );
      },
      returned: { draftId: DraftId.make("draft-r9"), threadId: ThreadId.make("thread-r9") },
    },
    {
      name: "missing draft",
      returned: { draftId: DraftId.make("draft-r9-ghost"), threadId: ThreadId.make("thread-r9g") },
    },
    {
      name: "draft gained content",
      prepare: () => {
        registerDraft("draft-r9", "thread-r9");
        seedComposerPrompt(DraftId.make("draft-r9"), "already invested");
      },
      returned: { draftId: DraftId.make("draft-r9"), threadId: ThreadId.make("thread-r9") },
    },
    {
      name: "draft thread has a server shell",
      prepare: () => {
        harness.shell = { runtimeMode: "full-access" };
        registerDraft("draft-r9", "thread-r9");
      },
      returned: { draftId: DraftId.make("draft-r9"), threadId: ThreadId.make("thread-r9") },
    },
    { name: "handler returned null", returned: null },
  ];

  for (const testCase of cases) {
    harness.raw = heldRaw(7);
    harness.handleNewThread.mockResolvedValueOnce(testCase.returned);
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    harness.shell = null;
    harness.shellReads.length = 0;
    render(baseInput);
    testCase.prepare?.();
    seedComposerPrompt(sourceRef, "nonempty recovery prompt");
    expect(draftStore().getComposerDraft(sourceRef)?.prompt).toBe("nonempty recovery prompt");
    setPrompt.mockClear();
    await act(async () => click("Continue in new thread"));
    expect(setPrompt, testCase.name).not.toHaveBeenCalled();
    await act(async () => renderer?.unmount());
    renderer = null;
    harness.shell = null;
  }
});

it("R10: the destination write survives the intentional source unmount", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  let resolveOpen: ((opened: { draftId: DraftId; threadId: ThreadId }) => void) | undefined;
  harness.handleNewThread.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
  );
  registerDraft("draft-r10", "thread-r10");
  seedComposerPrompt(sourceRef, "carry me");
  setPrompt.mockClear();

  await act(async () => click("Continue in new thread"));
  expect(harness.handleNewThread).toHaveBeenCalledTimes(1);

  // The navigation unmounts the source surface before the handler settles.
  await act(async () => {
    renderer?.unmount();
    renderer = null;
  });
  await act(async () => {
    resolveOpen?.({ draftId: DraftId.make("draft-r10"), threadId: ThreadId.make("thread-r10") });
  });

  expect(setPrompt).toHaveBeenCalledTimes(1);
  expect(draftStore().getComposerDraft(DraftId.make("draft-r10"))?.prompt).toBe("carry me");
});

it("R11: Continue never acknowledges or sends — only the new-thread handler runs", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  harness.handleNewThread.mockResolvedValueOnce({
    draftId: DraftId.make("draft-r11"),
    threadId: ThreadId.make("thread-r11"),
  });
  registerDraft("draft-r11", "thread-r11");
  seedComposerPrompt(sourceRef, "fresh prompt");
  setPrompt.mockClear();

  await act(async () => click("Continue in new thread"));

  expect(harness.handleNewThread).toHaveBeenCalledTimes(1);
  expect(harness.acknowledge).not.toHaveBeenCalled();
  // The only write is the validated prompt carry; no queue, ack, or send path exists here.
  expect(setPrompt).toHaveBeenCalledTimes(1);
  expect(setPrompt.mock.calls[0]?.[1]).toBe("fresh prompt");
});

it("R12: refresh runs once per scope opening and once per new failure id, never on rerenders", async () => {
  render(baseInput);
  await act(async () => {});
  expect(harness.revalidate).toHaveBeenCalledTimes(1);
  expect(harness.revalidate.mock.calls[0]?.[0]).toEqual({
    environmentId: envId,
    input: { projectId },
  });

  render(baseInput);
  await act(async () => {});
  expect(harness.revalidate).toHaveBeenCalledTimes(1);

  render({
    ...baseInput,
    activities: [{ id: "act-1", kind: "provider.turn.start.failed" }],
  });
  await act(async () => {});
  expect(harness.revalidate).toHaveBeenCalledTimes(2);

  render({
    ...baseInput,
    activities: [{ id: "act-1", kind: "provider.turn.start.failed" }],
  });
  await act(async () => {});
  expect(harness.revalidate).toHaveBeenCalledTimes(2);

  render({
    ...baseInput,
    threadId: ThreadId.make("thread-c"),
  });
  await act(async () => {});
  expect(harness.revalidate).toHaveBeenCalledTimes(3);

  // Capability off drops the marker so the same scope/failure refreshes on return.
  harness.config = null;
  render(baseInput);
  await act(async () => {});
  harness.config = capabilityOn;
  render(baseInput);
  await act(async () => {});
  expect(harness.revalidate).toHaveBeenCalledTimes(4);
});

it("R13: repeated pending renders keep Checking and never show stale row counts", async () => {
  harness.raw = heldRaw(7);
  render(baseInput);
  await act(async () => {});
  expect(bannerText()).toContain("1 updated · 1 deleted");

  harness.raw = AsyncResult.initial(true);
  render(baseInput);
  render(baseInput);
  render(baseInput);
  await act(async () => {});
  expect(bannerText()).toContain("Checking project memory changes…");
  expect(bannerText()).not.toContain("updated ·");
  expect(bannerText()).not.toContain("recorded changes");
});
