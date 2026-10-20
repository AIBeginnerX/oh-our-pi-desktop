// Interaction tests for the project-memory picker and its composer draft
// bindings. The list/search atom boundary is a harness (reads are asserted for
// their environment/project scope), the descriptor/settings/project readers are
// harnesses the tests mutate for current-state checks (settings flow through
// the same settingsValueAtom → appAtomRegistry.get seam the production reader
// uses), the prompt editor is absent so the store's own insertion path runs,
// and the composer draft store is the real one: every scenario drives actual
// clicks and asserts actual store outcomes.
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type ComposerThreadTarget,
  DraftId,
  composerTargetKey,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  ProjectMemoryPicker,
  readCurrentServerThreadInsertionScope,
  useProjectMemoryDraftLink,
  type ProjectMemoryPickerScope,
} from "./ProjectMemoryPicker";

const { harness, registry, LIST_ATOM, SEARCH_ATOM, SETTINGS_ATOM } = vi.hoisted(() => ({
  harness: {
    listData: null as {
      items: Array<{ memoryId: string; title: string; version: number; kind: string }>;
      truncated: boolean;
    } | null,
    searchData: null as {
      items: Array<{ memoryId: string; title: string; version: number; kind: string }>;
      truncated: boolean;
    } | null,
    listPending: false,
    listError: null as string | null,
    listTargets: [] as unknown[],
    searchTargets: [] as unknown[],
    refresh: vi.fn(),
  },
  registry: {
    config: null as unknown,
    thread: null as unknown,
    shell: null as unknown,
    settings: null as unknown,
    project: null as unknown,
  },
  LIST_ATOM: { sentinel: "memory-list-atom" },
  SEARCH_ATOM: { sentinel: "memory-search-atom" },
  SETTINGS_ATOM: { sentinel: "environment-settings-atom" },
}));

vi.mock("~/state/projectMemory", () => ({
  projectMemory: {
    list: (target: unknown) => {
      harness.listTargets.push(target);
      return LIST_ATOM;
    },
    search: (target: unknown) => {
      harness.searchTargets.push(target);
      return SEARCH_ATOM;
    },
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === SEARCH_ATOM
      ? {
          data: harness.searchData,
          dataUpdatedAt: null,
          error: null,
          isPending: false,
          refresh: harness.refresh,
        }
      : {
          data: harness.listData,
          dataUpdatedAt: null,
          error: harness.listError,
          isPending: harness.listPending,
          refresh: harness.refresh,
        },
}));

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === SETTINGS_ATOM ? registry.settings : new Map([["env-a", registry.config]]),
  },
}));
vi.mock("~/state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: () => SETTINGS_ATOM,
    },
  };
});
vi.mock("~/state/entities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/entities")>();
  return {
    ...actual,
    readProject: () => registry.project,
    readThread: () => registry.thread,
    readThreadShell: () => registry.shell,
  };
});

vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));

const environmentId = EnvironmentId.make("env-a");
const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

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

const scopeFor = (target: ComposerThreadTarget): ProjectMemoryPickerScope => ({
  environmentId,
  projectId,
  draftKey: composerTargetKey(target),
});

interface DraftLinkApi {
  selected: ReturnType<typeof useProjectMemoryDraftLink>["selected"];
  toggle: ReturnType<typeof useProjectMemoryDraftLink>["toggle"];
  remove: ReturnType<typeof useProjectMemoryDraftLink>["remove"];
}

// Mirrors the ChatComposer wiring: the real hook binds the picker to the real
// draft store, server-thread scopes resolve through the SAME shared
// production reader ChatComposer's footer callbacks call, and every row click
// carries the picker's rendered scope.
const TestHost = (props: { target: ComposerThreadTarget; api?: (link: DraftLinkApi) => void }) => {
  const link = useProjectMemoryDraftLink({
    environmentId,
    projectId,
    composerDraftTarget: props.target,
    readServerThreadInsertionInstanceId: () =>
      typeof props.target !== "string"
        ? readCurrentServerThreadInsertionScope({
            environmentId,
            threadRef: props.target,
          }).instanceId
        : null,
    readServerThreadProjectId: () =>
      typeof props.target !== "string"
        ? readCurrentServerThreadInsertionScope({
            environmentId,
            threadRef: props.target,
          }).projectId
        : null,
  });
  props.api?.(link);
  return (
    <ProjectMemoryPicker
      environmentId={environmentId}
      projectId={projectId}
      scope={scopeFor(props.target)}
      selected={link.selected}
      onToggle={link.toggle}
      onRemove={link.remove}
    />
  );
};

function resetComposerDraftStoreForTests() {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

/** Registers the live draft session a DraftId target resolves against. */
const registerDraftSession = (draftId: DraftId, project: ProjectId = projectId) => {
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(
      `logical:${draftId}`,
      scopeProjectRef(environmentId, project),
      draftId,
    );
  useComposerDraftStore
    .getState()
    .setModelSelection(draftId, createModelSelection(CLAUDE_INSTANCE, "claude-sonnet-4"));
};

let renderer: ReactTestRenderer | null = null;
let latestLink: DraftLinkApi | null = null;
const render = (target: ComposerThreadTarget) => {
  const element = <TestHost target={target} api={(link) => (latestLink = link)} />;
  act(() => {
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
};

const draft = (target: ComposerThreadTarget) =>
  useComposerDraftStore.getState().getComposerDraft(target);

const row = (memoryId: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.props["data-memory-picker-row"] === memoryId);

const clickRow = (memoryId: string) => {
  const node = row(memoryId);
  if (!node) throw new Error(`missing picker row: ${memoryId}`);
  act(() => {
    node.props.onClick();
  });
};

describe("ProjectMemoryPicker interactions", () => {
  const target = DraftId.make("picker-draft");

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetComposerDraftStoreForTests();
    registry.config = supportedConfig();
    registry.settings = null;
    registry.project = null;
    harness.listData = null;
    harness.searchData = null;
    harness.listPending = false;
    harness.listError = null;
    harness.listTargets = [];
    harness.searchTargets = [];
    harness.refresh.mockReset();
    latestLink = null;
    registerDraftSession(target);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
    resetComposerDraftStoreForTests();
  });

  it("appends an identifier-only selection and its prompt link, then removes both on a second click", () => {
    harness.listData = {
      items: [
        { memoryId: "mem-1", title: "API conventions", version: 3, kind: "fact" },
        { memoryId: "mem-2", title: "Deploy steps", version: 1, kind: "procedure" },
      ],
      truncated: false,
    };
    useComposerDraftStore.getState().setPrompt(target, "Summarize using");
    render(target);

    act(() => {
      clickRow("mem-1");
    });
    expect(draft(target)?.projectMemoryReferences).toEqual([
      { contextId: "memory_mem-1", memoryId: "mem-1", selectedVersion: 3 },
    ]);
    expect(draft(target)?.prompt).toContain(
      "[Project memory](t3-context://v1/memory/memory_mem-1)",
    );
    expect(row("mem-1")!.props["aria-pressed"]).toBe(true);

    act(() => {
      clickRow("mem-1");
    });
    expect(draft(target)?.projectMemoryReferences).toEqual([]);
    expect(draft(target)?.prompt).not.toContain("memory_mem-1");
    // The untouched sibling still selects.
    act(() => {
      clickRow("mem-2");
    });
    expect(draft(target)?.projectMemoryReferences).toEqual([
      { contextId: "memory_mem-2", memoryId: "mem-2", selectedVersion: 1 },
    ]);
  });

  it("refuses a retained toggle after a store project change that React has not flushed", () => {
    harness.listData = {
      items: [{ memoryId: "mem-1", title: "API conventions", version: 2, kind: "fact" }],
      truncated: false,
    };
    render(target);
    useComposerDraftStore.getState().setPrompt(target, "Summarize using");
    act(() => {
      clickRow("mem-1");
    });
    expect(draft(target)?.projectMemoryReferences).toHaveLength(1);

    // The draft's session moves to another project in the store only — no
    // re-render, so every render-flushed ref still claims the old project.
    act(() => {
      useComposerDraftStore
        .getState()
        .setLogicalProjectDraftThreadId(
          `logical:${target}`,
          scopeProjectRef(environmentId, otherProjectId),
          target,
        );
    });

    act(() => {
      expect(latestLink!.toggle("mem-2", 1, scopeFor(target))).toBe(false);
    });
    // The move stripped the old selection; the stale callback added nothing.
    expect(draft(target)?.projectMemoryReferences).toEqual([]);
    expect(draft(target)?.prompt).not.toContain("memory_mem-2");
  });

  it("resolves a server-thread toggle through the shared reader and refuses a store-only unsupported move", () => {
    harness.listData = {
      items: [{ memoryId: "mem-1", title: "API conventions", version: 2, kind: "fact" }],
      truncated: false,
    };
    // Both providers stay in the catalog for the whole test: the move is the
    // composer draft's activeProvider on the scoped thread, not a catalog edit.
    registry.config = {
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
        {
          instanceId: "claude_second",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
        },
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
        },
      ],
    };
    // An existing server thread: shell present, session not yet started, so the
    // composer draft's activeProvider is the first production candidate.
    // Settings are the same source useEnvironmentSettings reads; custom
    // instances only stay enabled with an explicit settings entry, so the
    // fixture supplies them.
    registry.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: { claudeAgent: { enabled: true } },
      providerInstances: {
        claude_second: { driver: "claudeAgent", enabled: true },
        codex: { driver: "codex", enabled: true },
      },
    };
    registry.thread = { projectId, session: null, latestTurn: null, messages: [] };
    registry.shell = { projectId, modelSelection: { instanceId: "claudeAgent", model: "claude" } };
    const serverTarget = scopeThreadRef(environmentId, ThreadId.make("server-memory"));
    useComposerDraftStore
      .getState()
      .setModelSelection(serverTarget, createModelSelection(CLAUDE_INSTANCE, "claude"));
    render(serverTarget);

    // Supported positive control: the shared reader resolves the draft's A.
    act(() => {
      expect(latestLink!.toggle("mem-1", 2, scopeFor(serverTarget))).toBe(true);
    });
    expect(draft(serverTarget)?.projectMemoryReferences).toEqual([
      { contextId: "memory_mem-1", memoryId: "mem-1", selectedVersion: 2 },
    ]);

    // Store-only A→B (unadvertised codex) before any render flush: the shared
    // reader resolves B and refuses, even though A is still ready in the catalog.
    act(() => {
      useComposerDraftStore
        .getState()
        .setModelSelection(
          serverTarget,
          createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
        );
    });
    act(() => {
      expect(latestLink!.toggle("mem-2", 1, scopeFor(serverTarget))).toBe(false);
    });
    expect(draft(serverTarget)?.projectMemoryReferences).toHaveLength(1);

    // Moving to the other advertised instance is supported through the same reader.
    act(() => {
      useComposerDraftStore
        .getState()
        .setModelSelection(
          serverTarget,
          createModelSelection(ProviderInstanceId.make("claude_second"), "claude"),
        );
    });
    act(() => {
      expect(latestLink!.toggle("mem-2", 1, scopeFor(serverTarget))).toBe(true);
    });
    expect(draft(serverTarget)?.projectMemoryReferences).toEqual([
      { contextId: "memory_mem-1", memoryId: "mem-1", selectedVersion: 2 },
      { contextId: "memory_mem-2", memoryId: "mem-2", selectedVersion: 1 },
    ]);
  });

  it("reads the composer's settings: a settings-disabled A cannot ride its ready catalog snapshot", () => {
    harness.listData = {
      items: [{ memoryId: "mem-1", title: "API conventions", version: 2, kind: "fact" }],
      truncated: false,
    };
    // The streamed catalog still shows every instance ready and enabled; the
    // current settings disable A and enable the others — the snapshot/settings
    // skew applyProviderInstanceSettings exists for. All entries stay in the
    // catalog for the whole test: the flip is the settings, not a catalog edit.
    registry.config = {
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
        {
          instanceId: "claude_second",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
        },
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
        },
      ],
    };
    registry.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: { claudeAgent: { enabled: false } },
      providerInstances: {
        claude_second: { driver: "claudeAgent", enabled: true },
        codex: { driver: "codex", enabled: true },
      },
    };
    registry.thread = { projectId, session: null, latestTurn: null, messages: [] };
    registry.shell = { projectId, modelSelection: { instanceId: "claudeAgent", model: "claude" } };
    // The project's resolved default is the composer's fourth candidate: with
    // A settings-disabled it is the actual target, ahead of the sorted catalog
    // fallback claude_second.
    registry.project = { defaultModelSelection: { instanceId: "codex", model: "gpt-5" } };
    const serverTarget = scopeThreadRef(environmentId, ThreadId.make("server-memory"));
    useComposerDraftStore
      .getState()
      .setModelSelection(serverTarget, createModelSelection(CLAUDE_INSTANCE, "claude"));
    render(serverTarget);

    // The reader resolves the composer's actual target — the project default
    // codex — and refuses: codex is not an advertised memory driver.
    act(() => {
      expect(latestLink!.toggle("mem-1", 2, scopeFor(serverTarget))).toBe(false);
    });
    expect(draft(serverTarget)?.projectMemoryReferences ?? []).toEqual([]);

    // Enabling A in the SAME settings source re-authorizes the same selection.
    registry.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: { claudeAgent: { enabled: true } },
      providerInstances: {
        claude_second: { driver: "claudeAgent", enabled: true },
        codex: { driver: "codex", enabled: true },
      },
    };
    act(() => {
      expect(latestLink!.toggle("mem-1", 2, scopeFor(serverTarget))).toBe(true);
    });
    expect(draft(serverTarget)?.projectMemoryReferences).toEqual([
      { contextId: "memory_mem-1", memoryId: "mem-1", selectedVersion: 2 },
    ]);
  });

  it("fails the server-thread scope comparison when the thread's project moved or the shell is gone", () => {
    harness.listData = {
      items: [{ memoryId: "mem-1", title: "API conventions", version: 2, kind: "fact" }],
      truncated: false,
    };
    registry.config = supportedConfig();
    registry.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: { claudeAgent: { enabled: true } },
    };
    registry.thread = { projectId, session: null, latestTurn: null, messages: [] };
    registry.shell = { projectId, modelSelection: { instanceId: "claudeAgent", model: "claude" } };
    const serverTarget = scopeThreadRef(environmentId, ThreadId.make("server-memory"));
    useComposerDraftStore
      .getState()
      .setModelSelection(serverTarget, createModelSelection(CLAUDE_INSTANCE, "claude"));
    render(serverTarget);

    // The thread moved to another project in the current entity store; the
    // shell the reader treats as the project authority moves with it.
    (registry.thread as { projectId: ProjectId }).projectId = otherProjectId;
    (registry.shell as { projectId: ProjectId }).projectId = otherProjectId;
    act(() => {
      expect(latestLink!.toggle("mem-1", 2, scopeFor(serverTarget))).toBe(false);
    });
    expect(draft(serverTarget)?.projectMemoryReferences ?? []).toEqual([]);

    // Restored in place, a live session-bearing thread selects normally…
    registry.thread = {
      projectId,
      session: { providerInstanceId: CLAUDE_INSTANCE },
      latestTurn: null,
      messages: [],
    };
    registry.shell = { projectId, modelSelection: { instanceId: "claudeAgent", model: "claude" } };
    act(() => {
      expect(latestLink!.toggle("mem-1", 2, scopeFor(serverTarget))).toBe(true);
    });
    expect(draft(serverTarget)?.projectMemoryReferences).toEqual([
      { contextId: "memory_mem-1", memoryId: "mem-1", selectedVersion: 2 },
    ]);

    // …and when only the shell is deleted, readThread keeps returning that
    // retained detail (mergeEnvironmentThread), so the null shell alone must
    // fail the scope closed instead of riding the retained project/session.
    registry.shell = null;
    act(() => {
      expect(latestLink!.toggle("mem-2", 1, scopeFor(serverTarget))).toBe(false);
    });
    expect(draft(serverTarget)?.projectMemoryReferences).toHaveLength(1);

    // A deleted thread/shell resolves no project and no instance: nothing is
    // added to the retained selection.
    registry.thread = null;
    registry.shell = null;
    act(() => {
      expect(latestLink!.toggle("mem-1", 2, scopeFor(serverTarget))).toBe(false);
    });
    expect(draft(serverTarget)?.projectMemoryReferences).toHaveLength(1);
  });

  it("refuses a retained toggle after a store-only provider change before render", () => {
    harness.listData = {
      items: [{ memoryId: "mem-1", title: "API conventions", version: 2, kind: "fact" }],
      truncated: false,
    };
    const codexInstance = ProviderInstanceId.make("codex");
    registry.config = {
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
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
        },
      ],
    };
    useComposerDraftStore
      .getState()
      .setModelSelection(target, createModelSelection(CLAUDE_INSTANCE, "claude-sonnet-4"));
    render(target);

    act(() => {
      useComposerDraftStore
        .getState()
        .setModelSelection(target, createModelSelection(codexInstance, "gpt-5"));
    });
    act(() => {
      expect(latestLink!.toggle("mem-1", 2, scopeFor(target))).toBe(false);
    });
    expect(draft(target)?.projectMemoryReferences ?? []).toEqual([]);
  });

  it("refuses a retained toggle after the descriptor drops memory support before a render", () => {
    harness.listData = {
      items: [{ memoryId: "mem-1", title: "API conventions", version: 2, kind: "fact" }],
      truncated: false,
    };
    render(target);

    // The registry flips without any re-render: render props still claim
    // support, but the current descriptor does not.
    registry.config = { environment: { capabilities: { inlineMessageContext: true } } };
    act(() => {
      expect(latestLink!.toggle("mem-1", 2, scopeFor(target))).toBe(false);
    });
    expect(draft(target)?.projectMemoryReferences ?? []).toEqual([]);
  });

  it("refuses a retained toggle when the instance left the current provider catalog", () => {
    harness.listData = {
      items: [{ memoryId: "mem-1", title: "API conventions", version: 2, kind: "fact" }],
      truncated: false,
    };
    render(target);

    registry.config = {
      environment: {
        capabilities: {
          inlineMessageContext: true,
          projectMemory: { send: true, sendDriverKinds: ["claudeAgent"] },
        },
      },
      providers: [],
    };
    act(() => {
      expect(latestLink!.toggle("mem-1", 2, scopeFor(target))).toBe(false);
    });
    expect(draft(target)?.projectMemoryReferences ?? []).toEqual([]);
  });

  it("refuses a stale remove callback against a different draft's selection", () => {
    harness.listData = {
      items: [{ memoryId: "mem-1", title: "API conventions", version: 2, kind: "fact" }],
      truncated: false,
    };
    const firstTarget = DraftId.make("picker-draft-a");
    registerDraftSession(firstTarget);
    render(firstTarget);
    const staleRemove = latestLink!.remove;

    const nextTarget = DraftId.make("picker-draft-b");
    registerDraftSession(nextTarget);
    render(nextTarget);
    act(() => {
      clickRow("mem-1");
    });
    expect(draft(nextTarget)?.projectMemoryReferences).toEqual([
      { contextId: "memory_mem-1", memoryId: "mem-1", selectedVersion: 2 },
    ]);

    // The handler captured under draft A carries A's scope; it must not reach
    // draft B's selection.
    act(() => {
      staleRemove("memory_mem-1", scopeFor(firstTarget));
    });
    expect(draft(nextTarget)?.projectMemoryReferences).toEqual([
      { contextId: "memory_mem-1", memoryId: "mem-1", selectedVersion: 2 },
    ]);

    // The current draft's own removal still works.
    act(() => {
      latestLink!.remove("memory_mem-1", scopeFor(nextTarget));
    });
    expect(draft(nextTarget)?.projectMemoryReferences ?? []).toEqual([]);
  });

  it("allows removal in the current draft even after support disappeared", () => {
    harness.listData = {
      items: [{ memoryId: "mem-1", title: "API conventions", version: 2, kind: "fact" }],
      truncated: false,
    };
    useComposerDraftStore.getState().setPrompt(target, "Summarize using");
    render(target);
    act(() => {
      clickRow("mem-1");
    });
    expect(draft(target)?.projectMemoryReferences).toHaveLength(1);

    registry.config = { environment: { capabilities: { inlineMessageContext: true } } };
    act(() => {
      clickRow("mem-1");
    });
    expect(draft(target)?.projectMemoryReferences).toEqual([]);
    expect(draft(target)?.prompt).not.toContain("memory_mem-1");
  });

  it("refuses a selection whose scope names a different project", () => {
    harness.listData = {
      items: [{ memoryId: "mem-1", title: "API conventions", version: 2, kind: "fact" }],
      truncated: false,
    };
    render(target);
    const refused = latestLink!.toggle("mem-1", 1, {
      environmentId,
      projectId: otherProjectId,
      draftKey: scopeFor(target).draftKey,
    });
    expect(refused).toBe(false);
    expect(draft(target)?.projectMemoryReferences ?? []).toEqual([]);
  });

  it("searches with the typed query and keeps list reads project-scoped", () => {
    harness.listData = { items: [], truncated: false };
    render(target);

    expect(harness.listTargets[0]).toEqual({
      environmentId,
      input: { projectId, limit: 100 },
    });

    const input = renderer!.root.findByType("input");
    harness.searchData = {
      items: [{ memoryId: "mem-q", title: "Query hit", version: 1, kind: "fact" }],
      truncated: false,
    };
    act(() => {
      input.props.onChange({ currentTarget: { value: "deploy" } });
    });
    expect(harness.searchTargets[0]).toEqual({
      environmentId,
      input: { projectId, query: "deploy", limit: 100 },
    });
  });

  it("persists the selection as identifier-only JSON", async () => {
    vi.useFakeTimers();
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      harness.listData = {
        items: [{ memoryId: "mem-1", title: "API conventions", version: 3, kind: "fact" }],
        truncated: false,
      };
      useComposerDraftStore.getState().setPrompt(target, "Summarize using");
      render(target);
      act(() => {
        clickRow("mem-1");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      // The payload handed to the real serializer at flush time must be the
      // identifiers and nothing else — a title could only get here by riding
      // the persisted draft entry. The last flush wins: intermediate
      // schedules may predate the selection.
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
      expect(persistedDraft?.projectMemoryReferences).toEqual([
        { contextId: "memory_mem-1", memoryId: "mem-1", selectedVersion: 3 },
      ]);

      // Real rehydration through the store's own storage gives the same ids back.
      resetComposerDraftStoreForTests();
      registerDraftSession(target);
      await useComposerDraftStore.persist.rehydrate();
      expect(draft(target)?.projectMemoryReferences).toEqual([
        { contextId: "memory_mem-1", memoryId: "mem-1", selectedVersion: 3 },
      ]);
    } finally {
      stringify.mockRestore();
      vi.useRealTimers();
      await useComposerDraftStore.persist.clearStorage();
    }
  });
});
