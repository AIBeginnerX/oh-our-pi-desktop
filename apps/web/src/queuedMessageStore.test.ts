import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createLocalDispatchSnapshot } from "./components/ChatView.logic";
import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import { projectMemoryContextId } from "./lib/composerContextRecords";
import {
  isQueuedMessageDue,
  latestCompletedToolActivityId,
  enqueueHeldQueuedMemoryConflicts,
  partitionQueuedRestoreByMemoryConflict,
  useQueuedMessageStore,
  type QueuedComposerMessage,
} from "./queuedMessageStore";

function makeMessage(prompt: string): Omit<QueuedComposerMessage, "id"> {
  return {
    prompt,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    projectMemoryReferences: [],
    sendSettings: {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      promptEffort: null,
    },
    queuedAfterToolActivityId: null,
    createdAt: "2026-09-11T00:00:00.000Z",
  };
}

const queue = (threadKey: string) =>
  useQueuedMessageStore.getState().queuesByThreadKey[threadKey] ?? [];

describe("queuedMessageStore", () => {
  beforeEach(() => {
    useQueuedMessageStore.setState({ queuesByThreadKey: {}, lastDispatchByThreadKey: {} });
  });

  it("keeps messages in submission order per thread", () => {
    const { enqueue } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    enqueue("thread-b", makeMessage("other"));

    expect(queue("thread-a").map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(queue("thread-b").map((message) => message.prompt)).toEqual(["other"]);
  });

  it("allows one send per thread and re-anchors the rest to the current tool boundary", () => {
    const { enqueue, beginSend } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));

    expect(beginSend("thread-a", first.id, "tool-2")?.prompt).toBe("first");
    expect(beginSend("thread-a", first.id, "tool-2")).toBeNull();
    expect(beginSend("thread-a", second.id, "tool-2")).toBeNull();

    const [sending, waiting] = queue("thread-a");
    expect(sending?.sending).toBe("preparing");
    expect(waiting?.queuedAfterToolActivityId).toBe("tool-2");
    expect(
      isQueuedMessageDue({ message: waiting!, phase: "running", latestToolActivityId: "tool-2" }),
    ).toBe(false);
  });

  it("finishSend drops the sent message", () => {
    const { enqueue, beginSend, finishSend } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    beginSend("thread-a", first.id, null);

    finishSend("thread-a", first.id);

    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toBeUndefined();
  });

  it("failSend returns the message to the head, held", () => {
    const { enqueue, beginSend, failSend } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));
    beginSend("thread-a", second.id, null);

    expect(failSend("thread-a", second.id)).toBe(true);

    const [head] = queue("thread-a");
    expect(queue("thread-a").map((message) => message.prompt)).toEqual(["second", "first"]);
    expect(head?.sending).toBeUndefined();
    expect(isQueuedMessageDue({ message: head!, phase: "ready", latestToolActivityId: null })).toBe(
      false,
    );
  });

  it("remove keeps the other messages' anchors and refuses a message being sent", () => {
    const { enqueue, remove, beginSend } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", { ...makeMessage("first"), queuedAfterToolActivityId: "t1" });
    const second = enqueue("thread-a", makeMessage("second"));

    expect(remove("thread-a", second.id)?.prompt).toBe("second");
    expect(remove("thread-a", second.id)).toBeNull();
    expect(queue("thread-a")).toEqual([first]);

    beginSend("thread-a", first.id, "t1");
    expect(remove("thread-a", first.id)).toBeNull();
  });

  it("a failed send keeps waiting on the dispatch before it", () => {
    const { enqueue, beginSend, markDispatching, finishSend, failSend } =
      useQueuedMessageStore.getState();
    const earlier = createLocalDispatchSnapshot(undefined);
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));
    const third = enqueue("thread-a", makeMessage("third"));
    const lastDispatch = () => useQueuedMessageStore.getState().lastDispatchByThreadKey["thread-a"];
    beginSend("thread-a", first.id, null);
    markDispatching("thread-a", first.id, earlier);
    finishSend("thread-a", first.id);

    // Fails before its turn start went out: the first send is still the one to wait on.
    beginSend("thread-a", second.id, null);
    failSend("thread-a", second.id);
    expect(lastDispatch()?.thread).toBe(earlier);

    // Fails after going out: it never reached the server, so the first still counts.
    beginSend("thread-a", third.id, null);
    markDispatching("thread-a", third.id, { ...earlier, startedAt: "later" });
    failSend("thread-a", third.id);
    expect(lastDispatch()?.thread).toBe(earlier);
  });

  it("abandons the original preparation after a held conflict re-enqueue", () => {
    const { enqueue, beginSend, drain, markDispatching } = useQueuedMessageStore.getState();
    const original = enqueue("thread-a", makeMessage("preparing conflict"));
    beginSend("thread-a", original.id, null);
    const drained = drain("thread-a");
    enqueueHeldQueuedMemoryConflicts("thread-a", drained);
    expect(markDispatching("thread-a", original.id, createLocalDispatchSnapshot(undefined))).toBe(
      false,
    );
    const held = queue("thread-a")[0];
    expect(held?.sending).toBeUndefined();
    expect(useQueuedMessageStore.getState().beginSend("thread-a", held!.id, null)?.prompt).toBe(
      "preparing conflict",
    );
  });

  it("clears preparing sending on drain so a held re-enqueue can send again", () => {
    const { enqueue, beginSend, drain } = useQueuedMessageStore.getState();
    const preparing = enqueue("thread-a", makeMessage("preparing"));
    beginSend("thread-a", preparing.id, null);
    const [drained] = drain("thread-a");
    expect(drained?.sending).toBeUndefined();
    const { id: _id, ...rest } = drained!;
    const held = useQueuedMessageStore.getState().enqueue("thread-a", {
      ...rest,
      holdUntilUserAction: true,
    });
    expect(useQueuedMessageStore.getState().beginSend("thread-a", held.id, null)?.prompt).toBe(
      "preparing",
    );
  });

  it("Stop takes back a preparing send but not one already dispatching", () => {
    const { enqueue, beginSend, markDispatching, drain, failSend } =
      useQueuedMessageStore.getState();
    const preparing = enqueue("thread-a", makeMessage("preparing"));
    enqueue("thread-a", makeMessage("waiting"));
    beginSend("thread-a", preparing.id, null);

    expect(drain("thread-a").map((message) => message.prompt)).toEqual(["preparing", "waiting"]);
    expect(markDispatching("thread-a", preparing.id, createLocalDispatchSnapshot(undefined))).toBe(
      false,
    );
    expect(failSend("thread-a", preparing.id)).toBe(false);

    const dispatching = enqueue("thread-b", makeMessage("dispatching"));
    enqueue("thread-b", makeMessage("waiting"));
    beginSend("thread-b", dispatching.id, null);
    expect(
      markDispatching("thread-b", dispatching.id, createLocalDispatchSnapshot(undefined)),
    ).toBe(true);

    expect(drain("thread-b").map((message) => message.prompt)).toEqual(["waiting"]);
    expect(queue("thread-b").map((message) => message.prompt)).toEqual(["dispatching"]);
  });

  it("carries memory identifiers verbatim through a failed send and a drain", () => {
    const { enqueue, beginSend, failSend, drain } = useQueuedMessageStore.getState();
    const references = [
      { contextId: projectMemoryContextId("mem-1"), memoryId: "mem-1", selectedVersion: 3 },
      { contextId: projectMemoryContextId("mem-2"), memoryId: "mem-2", selectedVersion: 1 },
    ];
    const message = enqueue("thread-a", {
      ...makeMessage("with memory"),
      projectMemoryReferences: references,
    });
    beginSend("thread-a", message.id, null);
    expect(failSend("thread-a", message.id)).toBe(true);

    // The failed send returns to the head with the same identifiers, and the
    // next boundary drains them unchanged.
    expect(queue("thread-a")[0]?.projectMemoryReferences).toEqual(references);
    expect(drain("thread-a")[0]?.projectMemoryReferences).toEqual(references);
  });
});

describe("queued message dispatch timing", () => {
  const activities = [
    { id: "a1", kind: "tool.started", sequence: 1, createdAt: "2026-01-01T00:00:01Z" },
    { id: "a2", kind: "tool.completed", sequence: 2, createdAt: "2026-01-01T00:00:02Z" },
    { id: "a3", kind: "tool.updated", sequence: 3, createdAt: "2026-01-01T00:00:03Z" },
  ];

  it("finds the newest completed tool call by sequence, not position", () => {
    expect(latestCompletedToolActivityId(activities)).toBe("a2");
    expect(latestCompletedToolActivityId([])).toBeNull();
    expect(
      latestCompletedToolActivityId([
        { id: "late", kind: "tool.completed", sequence: 9, createdAt: "2026-01-01T00:00:09Z" },
        { id: "early", kind: "tool.completed", sequence: 4, createdAt: "2026-01-01T00:00:04Z" },
      ]),
    ).toBe("late");
  });

  it("waits mid-turn until a tool call finishes after the message was queued", () => {
    const message = { queuedAfterToolActivityId: "a2" };
    expect(isQueuedMessageDue({ message, phase: "running", latestToolActivityId: "a2" })).toBe(
      false,
    );
    expect(isQueuedMessageDue({ message, phase: "running", latestToolActivityId: "a4" })).toBe(
      true,
    );
  });

  it("never auto-sends a message held for user action", () => {
    const message = { queuedAfterToolActivityId: null, holdUntilUserAction: true };
    expect(isQueuedMessageDue({ message, phase: "ready", latestToolActivityId: "a4" })).toBe(false);
  });

  it("is due as soon as the turn is over, but not while a send is connecting", () => {
    const message = { queuedAfterToolActivityId: "a2" };
    expect(isQueuedMessageDue({ message, phase: "ready", latestToolActivityId: "a2" })).toBe(true);
    expect(isQueuedMessageDue({ message, phase: "connecting", latestToolActivityId: "a4" })).toBe(
      false,
    );
  });
});

describe("queued restore memory conflicts", () => {
  const draftId = DraftId.make("restore-draft");
  const threadKey = "thread-restore";
  const projectRef = scopeProjectRef(EnvironmentId.make("env-r"), ProjectId.make("project-r"));
  const draftSelection = (memoryId: string, selectedVersion: number) => ({
    contextId: projectMemoryContextId(memoryId),
    memoryId,
    selectedVersion,
  });
  const queue = () => useQueuedMessageStore.getState().queuesByThreadKey[threadKey] ?? [];

  const seedDraftSelection = (memoryId: string, selectedVersion: number) => {
    expect(
      useComposerDraftStore
        .getState()
        .addProjectMemoryReference(draftId, { memoryId, selectedVersion }),
    ).toBe(true);
  };

  beforeEach(() => {
    useQueuedMessageStore.setState({ queuesByThreadKey: {}, lastDispatchByThreadKey: {} });
    useComposerDraftStore.setState({
      rewindingThreadKeys: new Set(),
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId("logical:restore-draft", projectRef, draftId);
  });

  afterEach(() => {
    useQueuedMessageStore.setState({ queuesByThreadKey: {}, lastDispatchByThreadKey: {} });
    useComposerDraftStore.setState({
      rewindingThreadKeys: new Set(),
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("keeps draft v1 and holds queued v2/v3 conflicts intact instead of rewriting a version", () => {
    seedDraftSelection("mem-1", 1);
    const conflictA = useQueuedMessageStore.getState().enqueue(threadKey, {
      ...makeMessage("queued v2"),
      projectMemoryReferences: [draftSelection("mem-1", 2)],
    });
    const conflictB = useQueuedMessageStore.getState().enqueue(threadKey, {
      ...makeMessage("queued v3"),
      projectMemoryReferences: [draftSelection("mem-1", 3)],
    });

    // The real Stop-path drain, then the production partition ChatView runs
    // before merging anything into the draft.
    const drained = useQueuedMessageStore.getState().drain(threadKey);
    const draftReferences =
      useComposerDraftStore.getState().getComposerDraft(draftId)?.projectMemoryReferences ?? [];
    const { compatible, conflicts } = partitionQueuedRestoreByMemoryConflict(
      draftReferences,
      drained,
    );
    expect(compatible).toEqual([]);
    expect(conflicts.map((message) => message.id)).toEqual([conflictA.id, conflictB.id]);

    // The restore outcome: conflicts return to the queue held, nothing else.
    enqueueHeldQueuedMemoryConflicts(threadKey, conflicts);
    expect(
      useComposerDraftStore.getState().getComposerDraft(draftId)?.projectMemoryReferences,
    ).toEqual([draftSelection("mem-1", 1)]);
    expect(queue().map((message) => message.prompt)).toEqual(["queued v2", "queued v3"]);
    expect(queue().map((message) => message.holdUntilUserAction)).toEqual([true, true]);
    expect(queue().map((message) => message.projectMemoryReferences)).toEqual([
      [draftSelection("mem-1", 2)],
      [draftSelection("mem-1", 3)],
    ]);
  });

  it("restores compatible duplicates and merges them without duplicating a selection", () => {
    seedDraftSelection("mem-1", 1);
    const duplicate = useQueuedMessageStore.getState().enqueue(threadKey, {
      ...makeMessage("same version"),
      projectMemoryReferences: [draftSelection("mem-1", 1), draftSelection("mem-9", 4)],
    });
    const plain = useQueuedMessageStore.getState().enqueue(threadKey, makeMessage("no memory"));

    const drained = useQueuedMessageStore.getState().drain(threadKey);
    const draftReferences =
      useComposerDraftStore.getState().getComposerDraft(draftId)?.projectMemoryReferences ?? [];
    const { compatible, conflicts } = partitionQueuedRestoreByMemoryConflict(
      draftReferences,
      drained,
    );
    expect(conflicts).toEqual([]);
    expect(compatible.map((message) => message.id)).toEqual([duplicate.id, plain.id]);

    // The restore outcome: the merge keeps one M/v1 and adds N/v4 exactly.
    const draftAfterContextRestore =
      useComposerDraftStore.getState().getComposerDraft(draftId)?.projectMemoryReferences ?? [];
    useComposerDraftStore
      .getState()
      .setProjectMemoryReferences(draftId, [
        ...draftAfterContextRestore,
        ...compatible.flatMap((message) => message.projectMemoryReferences ?? []),
      ]);
    expect(
      useComposerDraftStore.getState().getComposerDraft(draftId)?.projectMemoryReferences,
    ).toEqual([draftSelection("mem-1", 1), draftSelection("mem-9", 4)]);
    expect(queue()).toEqual([]);
  });
});
