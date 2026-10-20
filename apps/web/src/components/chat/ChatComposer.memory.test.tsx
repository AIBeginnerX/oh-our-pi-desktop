// Interaction tests for the composer's memory control: the dormant default,
// capability/driver gating on the real footer control, current-state
// reconciliation at the actual row callback, and the editor delete/undo
// lifecycle for memory selections. The popover chrome is a pass-through
// harness; the draft store behind the control is the real one.
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type ComposerProjectMemoryReference,
  type ComposerThreadTarget,
  DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  deriveProjectMemoryComposerGate,
  ProjectMemoryComposerControl,
  ProjectMemoryUnsupportedWarning,
  useProjectMemoryPromptReconciliation,
} from "./ProjectMemoryPicker";

vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ render, children }: { render?: ReactElement; children?: ReactNode }) =>
    render ? cloneElement(render, {}, children) : null,
  PopoverPopup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("~/state/projectMemory", () => ({
  projectMemory: {
    list: () => ({ sentinel: "list-atom" }),
    search: () => ({ sentinel: "search-atom" }),
  },
}));

const { listHarness, registry } = vi.hoisted(() => ({
  listHarness: {
    data: {
      items: [{ memoryId: "mem-1", title: "API conventions", version: 2, kind: "fact" }],
      truncated: false,
    },
  },
  registry: { config: null as unknown },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: listHarness.data,
    dataUpdatedAt: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => new Map([["env-a", registry.config]]) },
}));
vi.mock("~/state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/server")>();
  return { ...actual };
});

const environmentId = EnvironmentId.make("env-a");
const projectId = ProjectId.make("project-a");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

/** Same production hook ChatComposer.onPromptChange calls after parsing contextIds. */
const MemoryReconcileHarness = (props: {
  target: ComposerThreadTarget;
  onReady: (reconcile: (referencedContextIds: ReadonlySet<string>) => void) => void;
}) => {
  const reconcile = useProjectMemoryPromptReconciliation(props.target);
  props.onReady(reconcile);
  return null;
};

const supportedConfig = () => ({
  environment: {
    capabilities: {
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
  ],
});

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("deriveProjectMemoryComposerGate", () => {
  // send defaults to false, the dormant production default: every case names
  // the capability it assumes instead of implying one.
  const base = {
    send: false,
    sendDriverKinds: [CLAUDE],
    selectedDriverKind: CLAUDE,
    providerCatalogPending: false,
    hasReferences: false,
  };

  it("stays hidden while the server keeps the default send:false capability", () => {
    const gate = deriveProjectMemoryComposerGate(base);
    expect(gate.pickerVisible).toBe(false);
    expect(gate.pickerEnabled).toBe(false);
    expect(gate.warnExistingReferences).toBe(false);
  });

  it("enables on send:true plus a resolved driver the server advertises", () => {
    const gate = deriveProjectMemoryComposerGate({ ...base, send: true });
    expect(gate).toMatchObject({ pickerVisible: true, pickerEnabled: true, disabledReason: null });
  });

  it("disables with an explicit reason when the resolved driver is not advertised", () => {
    const gate = deriveProjectMemoryComposerGate({
      ...base,
      send: true,
      selectedDriverKind: CODEX,
    });
    expect(gate.pickerEnabled).toBe(false);
    expect(gate.disabledReason).toContain("지원하지 않습니다");
  });

  it("disables while the provider catalog is pending instead of guessing support", () => {
    const gate = deriveProjectMemoryComposerGate({
      ...base,
      send: true,
      providerCatalogPending: true,
    });
    expect(gate.pickerEnabled).toBe(false);
    expect(gate.disabledReason).toContain("확인하는 중");
  });

  it("treats an unresolved driver as unsupported and warns for existing references", () => {
    const gate = deriveProjectMemoryComposerGate({
      ...base,
      send: true,
      selectedDriverKind: undefined,
      hasReferences: true,
    });
    expect(gate.pickerEnabled).toBe(false);
    expect(gate.warnExistingReferences).toBe(true);
  });

  it("keeps warning while references exist but capability or driver support is gone", () => {
    const withReferences = { ...base, hasReferences: true };
    expect(
      deriveProjectMemoryComposerGate({ ...withReferences, send: true, selectedDriverKind: CODEX })
        .warnExistingReferences,
    ).toBe(true);
    // send still false: the references cannot go out at all.
    expect(deriveProjectMemoryComposerGate(withReferences).warnExistingReferences).toBe(true);
    // References aboard a supported target are not a warning.
    expect(
      deriveProjectMemoryComposerGate({ ...withReferences, send: true }).warnExistingReferences,
    ).toBe(false);
  });
});

describe("ProjectMemoryComposerControl", () => {
  const target: ComposerThreadTarget = DraftId.make("control-draft");
  let mounted: ReactTestRenderer | null = null;

  const renderControl = (input: {
    send: boolean;
    sendDriverKinds: ReadonlyArray<ProviderDriverKind> | undefined;
    selectedDriverKind: ProviderDriverKind | undefined;
    providerCatalogPending?: boolean;
  }): ReactTestRenderer => {
    const gate = deriveProjectMemoryComposerGate({
      send: input.send,
      sendDriverKinds: input.sendDriverKinds,
      selectedDriverKind: input.selectedDriverKind,
      providerCatalogPending: input.providerCatalogPending ?? false,
      hasReferences:
        (useComposerDraftStore.getState().getComposerDraft(target)?.projectMemoryReferences
          .length ?? 0) > 0,
    });
    const harness: { current: ReactTestRenderer | null } = { current: null };
    act(() => {
      harness.current = create(
        <ProjectMemoryComposerControl
          environmentId={environmentId}
          projectId={projectId}
          composerDraftTarget={target}
          gate={gate}
          readServerThreadInsertionInstanceId={() =>
            useComposerDraftStore.getState().getComposerDraft(target)?.activeProvider ?? null
          }
          readServerThreadProjectId={() => projectId}
        />,
      );
    });
    const renderer = harness.current;
    if (renderer === null) {
      throw new Error("control did not render");
    }
    mounted = renderer;
    return renderer;
  };

  const pickerRow = (renderer: ReactTestRenderer, memoryId: string): ReactTestInstance => {
    const row = renderer.root
      .findAllByType("button")
      .find((node: ReactTestInstance) => node.props["data-memory-picker-row"] === memoryId);
    if (!row) {
      throw new Error(`missing picker row: ${memoryId}`);
    }
    return row;
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetComposerDraftStore();
    registry.config = supportedConfig();
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(
        `logical:${target}`,
        scopeProjectRef(environmentId, projectId),
        target,
      );
    useComposerDraftStore
      .getState()
      .setModelSelection(target, createModelSelection(CLAUDE_INSTANCE, "claude-sonnet-4"));
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    vi.unstubAllGlobals();
    resetComposerDraftStore();
  });

  it("renders nothing on the default send:false capability", () => {
    const renderer = renderControl({
      send: false,
      sendDriverKinds: undefined,
      selectedDriverKind: CLAUDE,
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it("enables the trigger when the resolved driver is advertised", () => {
    const renderer = renderControl({
      send: true,
      sendDriverKinds: [CLAUDE],
      selectedDriverKind: CLAUDE,
    });
    const trigger = renderer.root.findByProps({ "data-chat-memory-picker-trigger": "true" });
    expect(trigger.props.disabled).toBe(false);
  });

  it("disables the trigger with the unsupported-provider reason on another driver", () => {
    const renderer = renderControl({
      send: true,
      sendDriverKinds: [CLAUDE],
      selectedDriverKind: CODEX,
    });
    const trigger = renderer.root.findByProps({ "data-chat-memory-picker-trigger": "true" });
    expect(trigger.props.disabled).toBe(true);
    expect(trigger.props.title).toContain("지원하지 않습니다");
  });

  it("keeps a picked selection in the draft as identifiers only through the real store", () => {
    const renderer = renderControl({
      send: true,
      sendDriverKinds: [CLAUDE],
      selectedDriverKind: CLAUDE,
    });
    const row = pickerRow(renderer, "mem-1");
    act(() => {
      row.props.onClick();
    });
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    expect(draft?.projectMemoryReferences).toEqual([
      { contextId: "memory_mem-1", memoryId: "mem-1", selectedVersion: 2 },
    ]);
    expect(draft?.prompt).toContain("t3-context://v1/memory/memory_mem-1");
  });

  it("refuses the row callback when the descriptor dropped support before a render", () => {
    const renderer = renderControl({
      send: true,
      sendDriverKinds: [CLAUDE],
      selectedDriverKind: CLAUDE,
    });
    const row = pickerRow(renderer, "mem-1");
    // The registry flips without a re-render: the trigger still looks enabled,
    // but the mutation-time reader must fail closed.
    registry.config = { environment: { capabilities: { inlineMessageContext: true } } };
    act(() => {
      row.props.onClick();
    });
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    expect(draft?.projectMemoryReferences ?? []).toEqual([]);
    expect(draft?.prompt ?? "").not.toContain("memory_mem-1");
  });
});

describe("memory chip delete → persistence → undo", () => {
  const target: ComposerThreadTarget = DraftId.make("reconcile-draft");
  const store = () => useComposerDraftStore.getState();
  let reconcileFromPrompt: ((referencedContextIds: ReadonlySet<string>) => void) | null = null;

  const mountReconcileHarness = () => {
    act(() => {
      create(
        <MemoryReconcileHarness
          target={target}
          onReady={(reconcile) => {
            reconcileFromPrompt = reconcile;
          }}
        />,
      );
    });
    if (reconcileFromPrompt === null) {
      throw new Error("reconcile harness did not mount");
    }
  };

  const seedSelection = (selectedVersion: number) => {
    store().setPrompt(target, "Summarize using");
    expect(store().addProjectMemoryReference(target, { memoryId: "mem-1", selectedVersion })).toBe(
      true,
    );
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetComposerDraftStore();
    registry.config = supportedConfig();
    store().setLogicalProjectDraftThreadId(
      `logical:${target}`,
      scopeProjectRef(environmentId, projectId),
      target,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetComposerDraftStore();
  });

  it("removes the persisted selection on chip delete so rehydration cannot resurrect it", async () => {
    vi.useFakeTimers();
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      mountReconcileHarness();
      seedSelection(3);
      store().setPrompt(target, "Summarize using");
      reconcileFromPrompt!(new Set<string>());
      expect(store().getComposerDraft(target)?.projectMemoryReferences ?? []).toEqual([]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      // The flush serialized no memory selection, so rehydration cannot
      // resurrect the deleted chip.
      const persistedDraft = (() => {
        for (let index = stringify.mock.calls.length - 1; index >= 0; index -= 1) {
          const arg = stringify.mock.calls[index]?.[0];
          if (typeof arg !== "object" || arg === null || !("state" in arg)) continue;
          const draftsByThreadKey = (
            arg as { state: { draftsByThreadKey?: Record<string, unknown> } }
          ).state.draftsByThreadKey;
          if (draftsByThreadKey && target in draftsByThreadKey) {
            return draftsByThreadKey[target] as { projectMemoryReferences?: unknown[] };
          }
        }
        return undefined;
      })();
      expect(persistedDraft).toBeDefined();
      expect(persistedDraft?.projectMemoryReferences).toBeUndefined();

      resetComposerDraftStore();
      store().setLogicalProjectDraftThreadId(
        `logical:${target}`,
        scopeProjectRef(environmentId, projectId),
        target,
      );
      await useComposerDraftStore.persist.rehydrate();
      expect(store().getComposerDraft(target)?.projectMemoryReferences ?? []).toEqual([]);
    } finally {
      stringify.mockRestore();
      vi.useRealTimers();
      await useComposerDraftStore.persist.clearStorage();
    }
  });

  it("undo restores the exact retained version without rewriting the text", () => {
    mountReconcileHarness();
    seedSelection(3);
    const promptWithLink = store().getComposerDraft(target)?.prompt ?? "";
    store().setPrompt(target, "Summarize using");
    reconcileFromPrompt!(new Set<string>());
    store().setPrompt(target, promptWithLink);
    reconcileFromPrompt!(new Set<string>(["memory_mem-1"]));
    const restored = store().getComposerDraft(target);
    expect(restored?.projectMemoryReferences).toEqual([
      { contextId: "memory_mem-1", memoryId: "mem-1", selectedVersion: 3 },
    ]);
    // The link was already in the text; no duplicate chip was appended.
    expect(restored?.prompt.match(/t3-context:\/\/v1\/memory\//g)).toHaveLength(1);
  });
});

describe("ProjectMemoryUnsupportedWarning", () => {
  it("names the hold instead of promising a send", () => {
    const harness: { current: ReactTestRenderer | null } = { current: null };
    act(() => {
      harness.current = create(<ProjectMemoryUnsupportedWarning />);
    });
    const renderer = harness.current;
    if (renderer === null) {
      throw new Error("warning did not render");
    }
    expect(JSON.stringify(renderer.toJSON())).toContain("보류됩니다");
    renderer.unmount();
  });
});
