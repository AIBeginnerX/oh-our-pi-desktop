// Queued-send tests for memory references. The dispatch seam is the real
// sendQueuedMessage; the descriptor registry is a harness whose config the
// tests mutate, so the shared send-boundary guard is exercised against
// current-state changes, including a capability drop behind an awaited
// send-preparation barrier.
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { resolveProjectMemoryReferences } from "@t3tools/shared/composerContextReferences";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { formatInlineContextReference } from "../../lib/composerContextReferences";
import {
  buildMessageContext,
  projectMemoryContextId,
  projectMemoryContextReference,
  type ComposerProjectMemoryReference,
} from "../../lib/composerContextRecords";
import {
  enqueueHeldQueuedMemoryConflicts,
  partitionQueuedRestoreByMemoryConflict,
  PROJECT_MEMORY_INLINE_UNSUPPORTED_MESSAGE,
  useQueuedMessageStore,
  type QueuedComposerMessage,
} from "../../queuedMessageStore";
import {
  DirectMemoryDispatchHoldError,
  dispatchDirectThreadTurnMessage,
  PROJECT_MEMORY_PROVIDER_UNAVAILABLE_MESSAGE,
  PROJECT_MEMORY_SEND_DISABLED_MESSAGE,
  PROJECT_MEMORY_SERVER_UNRESOLVED_MESSAGE,
  readProjectMemorySendHold,
  restoreComposerDraftAfterDirectSendFailure,
  sendQueuedMessage,
} from "./sendQueuedMessage";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { newMessageId } from "../../lib/utils";

const { io, ENV_A } = await vi.hoisted(async () => ({
  ENV_A: (await import("@t3tools/contracts")).EnvironmentId.make("env-a"),
  io: {
    run: vi.fn(),
    upload: vi.fn(),
    toast: vi.fn(),
    shell: null as Record<string, unknown> | null,
    config: {} as unknown,
    onUploadsAwaited: () => {},
  },
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (load) => ({
  ...(await load<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (...args: unknown[]) => io.run(...args),
}));

vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => new Map([[ENV_A, io.config]]) },
}));
vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  return { ...actual };
});
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    updateMetadata: "metadata",
    setRuntimeMode: "runtime",
    setInteractionMode: "interaction",
    startTurn: "start",
  },
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: () => io.shell,
  readThread: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: (...args: unknown[]) => io.toast(...args) },
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: (...args: unknown[]) => {
    io.onUploadsAwaited();
    return io.upload(...args);
  },
  getUploadedAttachments: () => [
    { type: "image", id: "img-1", name: "a.png", mimeType: "image/png", sizeBytes: 4 },
  ],
  releaseDraftAttachments: vi.fn(),
}));

const threadRef = scopeThreadRef(ENV_A, ThreadId.make("thread-a"));
const threadKey = scopedThreadKey(threadRef);

const CLAUDE_INSTANCE = ProviderInstanceId.make("claude_personal");

const supportedConfig = () => ({
  environment: {
    capabilities: {
      attachmentUploads: false,
      inlineMessageContext: true,
      projectMemory: { send: true, sendDriverKinds: ["claudeAgent"] },
    },
  },
  providers: [
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      status: "ready",
      availability: "available",
    },
    {
      instanceId: "claude_personal",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      status: "ready",
      availability: "available",
    },
  ],
});

/** The wire message the harness captured for the `startTurn` command. */
interface StartTurnWireMessage {
  text: string;
  context?: { records: ReadonlyArray<import("@t3tools/contracts").ComposerContextRecord> };
}

function makeMessage(
  overrides: Partial<QueuedComposerMessage> = {},
): Omit<QueuedComposerMessage, "id"> {
  return {
    prompt: "follow up",
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    projectMemoryReferences: [],
    sendSettings: {
      modelSelection: { instanceId: CLAUDE_INSTANCE, model: "claude" },
      runtimeMode: "full-access",
      interactionMode: "default",
      promptEffort: null,
    },
    queuedAfterToolActivityId: null,
    createdAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

const startTurnWireMessage = (): StartTurnWireMessage => {
  // runAtomCommand(registry, command, input): the command rides at index 1.
  const startCall = io.run.mock.calls.find((call) => call[1] === "start");
  if (!startCall) throw new Error("startTurn was not dispatched");
  const input = startCall[2] as { input: { message: StartTurnWireMessage } };
  return input.input.message;
};

const memoryLink = formatInlineContextReference(projectMemoryContextReference("mem-1"));

describe("readProjectMemorySendHold", () => {
  beforeEach(() => {
    io.config = supportedConfig();
  });

  it("admits a current custom Claude instance on a supporting descriptor", () => {
    expect(
      readProjectMemorySendHold({ environmentId: ENV_A, instanceId: CLAUDE_INSTANCE }),
    ).toBeNull();
  });

  it("holds every unsupported shape without touching non-memory rules", () => {
    const instanceId = ProviderInstanceId.make("claude_personal");
    // Descriptor unresolved.
    io.config = undefined;
    expect(readProjectMemorySendHold({ environmentId: ENV_A, instanceId })).toBe(
      PROJECT_MEMORY_SERVER_UNRESOLVED_MESSAGE,
    );
    // Default capability: send absent (false).
    io.config = { environment: { capabilities: { inlineMessageContext: true } } };
    expect(readProjectMemorySendHold({ environmentId: ENV_A, instanceId })).toBe(
      PROJECT_MEMORY_SEND_DISABLED_MESSAGE,
    );
    // Driver not in the advertised list.
    io.config = {
      environment: {
        capabilities: {
          inlineMessageContext: true,
          projectMemory: { send: true, sendDriverKinds: ["codex"] },
        },
      },
      providers: supportedConfig().providers,
    };
    expect(readProjectMemorySendHold({ environmentId: ENV_A, instanceId })).toBe(
      PROJECT_MEMORY_SEND_DISABLED_MESSAGE,
    );
    // Advertised list missing entirely.
    io.config = {
      environment: {
        capabilities: { inlineMessageContext: true, projectMemory: { send: true } },
      },
      providers: supportedConfig().providers,
    };
    expect(readProjectMemorySendHold({ environmentId: ENV_A, instanceId })).toBe(
      PROJECT_MEMORY_SEND_DISABLED_MESSAGE,
    );
    // Generic inline support gone.
    io.config = {
      environment: {
        capabilities: { projectMemory: { send: true, sendDriverKinds: ["claudeAgent"] } },
      },
      providers: supportedConfig().providers,
    };
    expect(readProjectMemorySendHold({ environmentId: ENV_A, instanceId })).toBe(
      PROJECT_MEMORY_INLINE_UNSUPPORTED_MESSAGE,
    );
    // Instance gone from the current catalog.
    io.config = supportedConfig();
    expect(
      readProjectMemorySendHold({
        environmentId: ENV_A,
        instanceId: ProviderInstanceId.make("claude_gone"),
      }),
    ).toBe(PROJECT_MEMORY_PROVIDER_UNAVAILABLE_MESSAGE);
    // Instance no longer runnable.
    const disabled = supportedConfig();
    disabled.providers[1]!.enabled = false;
    io.config = disabled;
    expect(readProjectMemorySendHold({ environmentId: ENV_A, instanceId })).toBe(
      PROJECT_MEMORY_PROVIDER_UNAVAILABLE_MESSAGE,
    );
  });
});

describe("dispatchDirectThreadTurnMessage", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      rewindingThreadKeys: new Set(),
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    io.run.mockReset();
    io.run.mockResolvedValue({ _tag: "Success", value: undefined });
    io.config = supportedConfig();
  });

  it("dispatches one direct turn whose wire payload resolves to the exact selected version", async () => {
    const references: Array<ComposerProjectMemoryReference> = [
      { contextId: projectMemoryContextId("mem-1"), memoryId: "mem-1", selectedVersion: 3 },
    ];
    const dispatchContext = buildMessageContext({
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: [],
      projectMemoryReferences: references,
      attachments: [],
    });
    await dispatchDirectThreadTurnMessage({
      environmentId: ENV_A,
      threadId: ThreadId.make("thread-a"),
      instanceId: CLAUDE_INSTANCE,
      outgoingMessageText: `Use ${memoryLink} and answer.`,
      dispatchContext,
      attachments: [],
      modelSelection: { instanceId: CLAUDE_INSTANCE, model: "claude" },
      runtimeMode: "full-access",
      interactionMode: "default",
      messageId: newMessageId(),
      createdAt: "2026-10-12T00:00:00.000Z",
      titleSeed: "memory turn",
    });

    const wireMessage = startTurnWireMessage();
    expect(io.run).toHaveBeenCalled();
    const resolved = resolveProjectMemoryReferences({
      text: wireMessage.text,
      records: wireMessage.context?.records ?? [],
    });
    expect(resolved).toEqual({
      ok: true,
      references: [
        { contextId: projectMemoryContextId("mem-1"), memoryId: "mem-1", selectedVersion: 3 },
      ],
      items: [{ memoryId: "mem-1", selectedVersion: 3 }],
    });
  });

  it("holds after preparation when capability drops and restores the exact draft snapshot", async () => {
    const draftTarget = DraftId.make("direct-hold-draft");
    const references: Array<ComposerProjectMemoryReference> = [
      { contextId: projectMemoryContextId("mem-1"), memoryId: "mem-1", selectedVersion: 2 },
    ];
    const prompt = `Use ${memoryLink} now.`;
    useComposerDraftStore.getState().setPrompt(draftTarget, prompt);
    useComposerDraftStore.getState().setProjectMemoryReferences(draftTarget, references);
    const snapshot = {
      prompt,
      references: [...references],
    };

    useComposerDraftStore.getState().setPrompt(draftTarget, "");
    useComposerDraftStore.getState().setProjectMemoryReferences(draftTarget, []);

    const dispatchContext = buildMessageContext({
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: [],
      projectMemoryReferences: snapshot.references,
      attachments: [],
    });

    await expect(
      dispatchDirectThreadTurnMessage({
        environmentId: ENV_A,
        threadId: ThreadId.make("thread-a"),
        instanceId: CLAUDE_INSTANCE,
        outgoingMessageText: snapshot.prompt,
        dispatchContext,
        attachments: [],
        modelSelection: { instanceId: CLAUDE_INSTANCE, model: "claude" },
        runtimeMode: "full-access",
        interactionMode: "default",
        messageId: newMessageId(),
        createdAt: "2026-10-12T00:00:00.000Z",
        titleSeed: "hold",
        awaitPreparationBarrier: async () => {
          io.config = { environment: { capabilities: { inlineMessageContext: true } } };
        },
      }),
    ).rejects.toBeInstanceOf(DirectMemoryDispatchHoldError);

    expect(io.run).not.toHaveBeenCalled();
    restoreComposerDraftAfterDirectSendFailure({
      composerDraftTarget: draftTarget,
      messageTextForSend: snapshot.prompt,
      projectMemoryReferences: snapshot.references,
      images: [],
      files: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      memoryRestoreMatchesProject: true,
    });
    const restored = useComposerDraftStore.getState().getComposerDraft(draftTarget);
    expect(restored?.prompt).toBe(snapshot.prompt);
    expect(restored?.projectMemoryReferences).toEqual(snapshot.references);
  });
});

describe("sendQueuedMessage with project memory references", () => {
  beforeEach(() => {
    useQueuedMessageStore.setState({ queuesByThreadKey: {}, lastDispatchByThreadKey: {} });
    io.run.mockReset();
    io.run.mockResolvedValue({ _tag: "Success", value: undefined });
    io.upload.mockReset();
    io.upload.mockResolvedValue(undefined);
    io.toast.mockReset();
    io.shell = null;
    io.onUploadsAwaited = () => {};
    io.config = supportedConfig();
  });

  it("re-embeds the exact identifiers and round-trips the production resolver", async () => {
    const references: Array<ComposerProjectMemoryReference> = [
      { contextId: projectMemoryContextId("mem-1"), memoryId: "mem-1", selectedVersion: 3 },
      { contextId: projectMemoryContextId("mem-2"), memoryId: "mem-2", selectedVersion: 1 },
    ];
    const message = useQueuedMessageStore.getState().enqueue(
      threadKey,
      makeMessage({
        prompt: `Use ${memoryLink} and answer.`,
        projectMemoryReferences: references,
      }),
    );

    await sendQueuedMessage(threadRef, message.id);

    const wireMessage = startTurnWireMessage();
    const memoryPayloads = wireMessage.context?.records
      .filter((record) => record.kind === "memory")
      .map((record) => ("payload" in record ? record.payload : undefined));
    expect(memoryPayloads).toEqual([
      { memoryId: "mem-1", selectedVersion: 3 },
      { memoryId: "mem-2", selectedVersion: 1 },
    ]);
    // The production resolver reads the exact wire text and records.
    const resolved = resolveProjectMemoryReferences({
      text: wireMessage.text,
      records: wireMessage.context?.records ?? [],
    });
    expect(resolved).toEqual({
      ok: true,
      references: [
        { contextId: projectMemoryContextId("mem-1"), memoryId: "mem-1", selectedVersion: 3 },
      ],
      items: [{ memoryId: "mem-1", selectedVersion: 3 }],
    });
    // A clean send leaves the queue.
    expect(useQueuedMessageStore.getState().queuesByThreadKey[threadKey]).toBeUndefined();
  });

  it("holds after an awaited send-preparation barrier when the capability dropped", async () => {
    // Uploads are in play so the send has a real awaited barrier; dropping the
    // memory capability during that await must still stop the dispatch.
    io.config = {
      ...supportedConfig(),
      environment: {
        ...supportedConfig().environment,
        capabilities: {
          ...supportedConfig().environment.capabilities,
          attachmentUploads: true,
        },
      },
    };
    io.onUploadsAwaited = () => {
      io.config = { environment: { capabilities: { inlineMessageContext: true } } };
    };
    const references: Array<ComposerProjectMemoryReference> = [
      { contextId: projectMemoryContextId("mem-1"), memoryId: "mem-1", selectedVersion: 2 },
    ];
    const message = useQueuedMessageStore.getState().enqueue(
      threadKey,
      makeMessage({
        prompt: `Use ${memoryLink}.`,
        images: [
          {
            type: "image",
            id: "img-1",
            name: "a.png",
            mimeType: "image/png",
            sizeBytes: 4,
            previewUrl: "blob:a",
            file: new File(["x"], "a.png", { type: "image/png" }),
          },
        ],
        projectMemoryReferences: references,
      }),
    );

    await sendQueuedMessage(threadRef, message.id);

    // Nothing reached the wire.
    expect(io.run).not.toHaveBeenCalled();
    const queue = useQueuedMessageStore.getState().queuesByThreadKey[threadKey] ?? [];
    expect(queue).toHaveLength(1);
    expect(queue[0]?.id).toBe(message.id);
    expect(queue[0]?.holdUntilUserAction).toBe(true);
    expect(queue[0]?.sending).toBeUndefined();
    expect(queue[0]?.projectMemoryReferences).toEqual(references);
    const toast = io.toast.mock.calls[0]?.[0] as { description?: string } | undefined;
    expect(toast?.description).toBe(PROJECT_MEMORY_SEND_DISABLED_MESSAGE);
  });

  it("holds when only generic inline context is available", async () => {
    // The R2 gap, exactly: inlineMessageContext true, memory send absent.
    io.config = { environment: { capabilities: { inlineMessageContext: true } } };
    const references: Array<ComposerProjectMemoryReference> = [
      { contextId: projectMemoryContextId("mem-1"), memoryId: "mem-1", selectedVersion: 2 },
    ];
    const message = useQueuedMessageStore.getState().enqueue(
      threadKey,
      makeMessage({
        prompt: `Use ${memoryLink}.`,
        projectMemoryReferences: references,
      }),
    );

    await sendQueuedMessage(threadRef, message.id);

    expect(io.run).not.toHaveBeenCalled();
    const queue = useQueuedMessageStore.getState().queuesByThreadKey[threadKey] ?? [];
    expect(queue).toHaveLength(1);
    expect(queue[0]?.id).toBe(message.id);
    expect(queue[0]?.holdUntilUserAction).toBe(true);
    expect(queue[0]?.sending).toBeUndefined();
    expect(queue[0]?.projectMemoryReferences).toEqual(references);
    const toast = io.toast.mock.calls[0]?.[0] as { description?: string } | undefined;
    expect(toast?.description).toBe(PROJECT_MEMORY_SEND_DISABLED_MESSAGE);
  });

  it("keeps the legacy text path for non-memory context without inline support", async () => {
    io.config = { environment: { capabilities: { attachmentUploads: false } } };
    const message = useQueuedMessageStore.getState().enqueue(
      threadKey,
      makeMessage({
        prompt: "plain prose",
        reviewComments: [
          {
            id: "rc-1",
            sectionId: "s",
            sectionTitle: "Review",
            filePath: "a.ts",
            startIndex: 0,
            endIndex: 0,
            rangeLabel: "L1",
            text: "legacy payload",
            diff: "",
          },
        ],
      }),
    );

    await sendQueuedMessage(threadRef, message.id);

    const wireMessage = startTurnWireMessage();
    // No context field on the wire, and the record still travels the legacy way.
    expect(wireMessage.context).toBeUndefined();
    expect(wireMessage.text).toContain("legacy payload");
  });

  it("abandons a parked preparation drained into a held conflict, then sends the preserved replacement", async () => {
    // The draft selects v1; the queued message carries the conflicting v2 and
    // an image, so the real sender parks at its upload await.
    io.config = {
      ...supportedConfig(),
      environment: {
        ...supportedConfig().environment,
        capabilities: {
          ...supportedConfig().environment.capabilities,
          attachmentUploads: true,
        },
      },
    };
    const draftTarget = DraftId.make("stop-conflict-draft");
    expect(
      useComposerDraftStore
        .getState()
        .addProjectMemoryReference(draftTarget, { memoryId: "mem-1", selectedVersion: 1 }),
    ).toBe(true);
    const draftReferences =
      useComposerDraftStore.getState().getComposerDraft(draftTarget)?.projectMemoryReferences ?? [];

    let releaseUpload: (() => void) | undefined;
    io.upload.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseUpload = resolve;
        }),
    );
    const references: Array<ComposerProjectMemoryReference> = [
      { contextId: projectMemoryContextId("mem-1"), memoryId: "mem-1", selectedVersion: 2 },
    ];
    const original = useQueuedMessageStore.getState().enqueue(
      threadKey,
      makeMessage({
        prompt: `Use ${memoryLink}.`,
        images: [
          {
            type: "image",
            id: "img-1",
            name: "a.png",
            mimeType: "image/png",
            sizeBytes: 4,
            previewUrl: "blob:a",
            file: new File(["x"], "a.png", { type: "image/png" }),
          },
        ],
        projectMemoryReferences: references,
      }),
    );

    // The real sender begins the preparation and parks at its upload await.
    const originalSend = sendQueuedMessage(threadRef, original.id);
    if (releaseUpload === undefined) {
      throw new Error("sender never reached the upload barrier");
    }
    expect(
      useQueuedMessageStore
        .getState()
        .queuesByThreadKey[threadKey]?.some(
          (message) => message.id === original.id && message.sending === "preparing",
        ),
    ).toBe(true);

    // Stop: the drain hands the parked preparation back (transient sending
    // stripped) and the production restore re-enqueues the conflicting version
    // held under a fresh id.
    const drained = useQueuedMessageStore.getState().drain(threadKey);
    const { compatible, conflicts } = partitionQueuedRestoreByMemoryConflict(
      draftReferences,
      drained,
    );
    expect(compatible).toEqual([]);
    expect(conflicts.map((message) => message.id)).toEqual([original.id]);
    enqueueHeldQueuedMemoryConflicts(threadKey, conflicts);
    const held = useQueuedMessageStore.getState().queuesByThreadKey[threadKey]?.[0];
    if (!held) {
      throw new Error("held conflict row missing");
    }
    expect(held.id).not.toBe(original.id);
    expect(held.sending).toBeUndefined();
    expect(held.holdUntilUserAction).toBe(true);
    expect(held.projectMemoryReferences).toEqual(references);

    // Releasing the parked sender: its entry no longer exists, so the dispatch
    // cancels with zero RPC — the old preparation is abandoned, not resumed.
    releaseUpload();
    await originalSend;
    expect(io.run).not.toHaveBeenCalled();
    expect(useQueuedMessageStore.getState().beginSend(threadKey, original.id, null)).toBeNull();

    // Send now on the preserved replacement: exactly one start carrying the
    // unchanged selected version.
    await sendQueuedMessage(threadRef, held.id);
    const startCalls = io.run.mock.calls.filter((call) => call[1] === "start");
    expect(startCalls).toHaveLength(1);
    const wireMessage = startTurnWireMessage();
    const memoryPayloads = wireMessage.context?.records
      .filter((record) => record.kind === "memory")
      .map((record) => ("payload" in record ? record.payload : undefined));
    expect(memoryPayloads).toEqual([{ memoryId: "mem-1", selectedVersion: 2 }]);
    expect(useQueuedMessageStore.getState().queuesByThreadKey[threadKey]).toBeUndefined();
  });
});
