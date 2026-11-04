// The composer's visible auto-selection of related project memories: off by
// default, gated by the provider allow-list, bounded to three chips, and a chip
// the user removes stays removed. Chips are plain composer references added
// through the real draft store, so the send path is the existing one.
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  ProjectMemoryComposerControl,
  deriveProjectMemoryComposerGate,
} from "./ProjectMemoryPicker";

const { harness, LIST_ATOM } = vi.hoisted(() => ({
  harness: {
    autoSelect: false,
    items: [] as Array<Record<string, unknown>>,
    config: null as unknown,
  },
  LIST_ATOM: { sentinel: "memory-list-atom" },
}));

vi.mock("~/state/projectMemory", () => ({ projectMemory: { list: () => LIST_ATOM } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { items: harness.items, truncated: false },
    dataUpdatedAt: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  useEnvironmentSettings: (_environmentId: unknown, selector: (settings: unknown) => unknown) =>
    selector({ autoSelectProjectMemories: harness.autoSelect }),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => new Map([["env-a", harness.config]]) },
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/popover", () => ({
  Popover: (props: { children: unknown }) => props.children,
  PopoverTrigger: (props: { children: unknown }) => props.children,
  PopoverPopup: () => null,
}));

const environmentId = EnvironmentId.make("env-a");
const projectId = ProjectId.make("project-a");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
const target = DraftId.make("auto-select-draft");

const memory = (memoryId: string, title: string, body: string) => ({
  memoryId,
  projectId,
  kind: "fact",
  title,
  body,
  version: 1,
  validUntil: null,
});

const items = [
  memory("deploy", "배포 절차", "배포 전에 pnpm build 를 실행한다."),
  memory("login", "Login error handling", "Show the inline error when the login request fails."),
  memory("grid", "Spacing", "Use the 4px grid."),
];
const DRAFT = "배포 전에 pnpm build 하고 login error 도 고쳐줘";

let renderer: ReactTestRenderer | null = null;
const mount = (driverAllowed = true) => {
  const gate = deriveProjectMemoryComposerGate({
    send: true,
    sendDriverKinds: driverAllowed ? [CLAUDE] : [],
    selectedDriverKind: CLAUDE,
    providerCatalogPending: false,
    hasReferences: false,
  });
  act(() => {
    renderer = create(
      <ProjectMemoryComposerControl
        environmentId={environmentId}
        projectId={projectId}
        composerDraftTarget={target}
        gate={gate}
        readServerThreadInsertionInstanceId={() => CLAUDE_INSTANCE}
        readServerThreadProjectId={() => projectId}
      />,
    );
  });
};
const settle = () =>
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
const references = () =>
  useComposerDraftStore.getState().getComposerDraft(target)?.projectMemoryReferences ?? [];

describe("ProjectMemoryComposerControl auto-selection", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
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
      .setLogicalProjectDraftThreadId(
        `logical:${target}`,
        scopeProjectRef(environmentId, projectId),
        target,
      );
    useComposerDraftStore
      .getState()
      .setModelSelection(target, createModelSelection(CLAUDE_INSTANCE, "claude-sonnet-4"));
    useComposerDraftStore.getState().setPrompt(target, DRAFT);
    harness.autoSelect = false;
    harness.items = items;
    harness.config = {
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
    };
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("adds nothing while the setting is off, which is the default", () => {
    mount();
    settle();
    expect(references()).toEqual([]);
  });

  it("pre-selects related memories as ordinary references once enabled", () => {
    harness.autoSelect = true;
    mount();
    settle();
    expect(references().map((reference) => reference.memoryId)).toEqual(["deploy", "login"]);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toContain(
      "t3-context://v1/memory/memory_deploy",
    );
  });

  it("adds nothing when the provider fails the allow-list gate", () => {
    harness.autoSelect = true;
    mount(false);
    settle();
    expect(references()).toEqual([]);
  });

  it("keeps a chip the user removed removed", () => {
    harness.autoSelect = true;
    mount();
    settle();
    act(() => {
      useComposerDraftStore.getState().removeProjectMemoryReference(target, "memory_login");
    });
    settle();
    act(() => {
      useComposerDraftStore.getState().setPrompt(target, `${DRAFT} login error handling again`);
    });
    settle();
    expect(references().map((reference) => reference.memoryId)).toEqual(["deploy"]);
  });

  it("keeps a removed chip removed after the composer remounts, until the draft is sent", () => {
    harness.autoSelect = true;
    mount();
    settle();
    act(() => {
      useComposerDraftStore.getState().removeProjectMemoryReference(target, "memory_login");
    });
    settle();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.autoSelectDismissed).toEqual([
      "login",
    ]);

    // Switching to another thread and back unmounts and remounts the control.
    act(() => renderer?.unmount());
    mount();
    settle();
    expect(references().map((reference) => reference.memoryId)).toEqual(["deploy"]);

    act(() => {
      useComposerDraftStore.getState().clearComposerContent(target);
    });
    expect(
      useComposerDraftStore.getState().getComposerDraft(target)?.autoSelectDismissed,
    ).toBeUndefined();
  });

  it("keeps counting already-attached auto chips against the budget after a remount", () => {
    harness.autoSelect = true;
    harness.items = ["a", "b", "c", "d", "e"].map((id) =>
      memory(id, `Deploy ${id}`, `Run the deploy script ${id} before release.`),
    );
    useComposerDraftStore.getState().setPrompt(target, "deploy script release");
    mount();
    settle();
    expect(references()).toHaveLength(3);

    for (let remount = 0; remount < 3; remount++) {
      act(() => renderer?.unmount());
      mount();
      settle();
    }
    expect(references()).toHaveLength(3);
  });
});
