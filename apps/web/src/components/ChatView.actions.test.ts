import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { useBrowserHistoryStore } from "../browserHistoryStore";
import { useDiffPanelStore } from "../diffPanelStore";
import { useRightPanelStore } from "../rightPanelStore";
import { toastManager } from "./ui/toast";
import { useChatViewActions } from "./ChatView.actions";

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("../sidebarPendingFileDropStore", () => ({
  useSidebarPendingFileDropStore: (select: (state: { pending: [] }) => unknown) =>
    select({ pending: [] }),
}));

it("clears a plan implementation thread's view state after failed start and successful delete", async () => {
  const environmentId = EnvironmentId.make("workspace");
  let created: ReturnType<typeof scopeThreadRef> | undefined;
  const addToast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
  const startFailure = AsyncResult.failure(Cause.fail(new Error("Could not start")));
  const actions = useChatViewActions({
    threadState: {
      activeThread: { id: ThreadId.make("planning"), environmentId, worktreePath: null },
      environmentId,
      isServerThread: true,
      sendInFlightRef: { current: false },
      routeThreadRef: scopeThreadRef(environmentId, ThreadId.make("planning")),
      composerRef: {
        current: {
          validateProviderInput: () => true,
          getSendContext: () => ({
            providerAvailable: true,
            interactionModeEnabled: true,
            selectedProvider: "codex",
            selectedModel: "model",
            selectedProviderModels: [],
            selectedModelSelection: { instanceId: "codex", model: "model" },
          }),
        },
      },
      createThread: async ({ input }: { input: { threadId: ThreadId } }) => {
        created = scopeThreadRef(environmentId, input.threadId);
        useRightPanelStore.getState().open(created, "agents");
        useDiffPanelStore.getState().setDiffFileViewed(created, "a:src/app.ts", true);
        useBrowserHistoryStore.getState().registerThreadProject(created, "project");
        return AsyncResult.success(undefined);
      },
      startThreadTurn: async () => startFailure,
      deleteThread: async () => AsyncResult.success(undefined),
    },
    projectEnvironment: {
      activeProject: { id: ProjectId.make("project") },
      activeProjectSettings: { settings: {} },
    },
    timelineData: {
      activeProposedPlan: { id: "plan", planMarkdown: "Implement the plan." },
      beginLocalDispatch: () => {},
      resetLocalDispatch: () => {},
    },
    terminalsAndScripts: {},
    threadStatus: {},
    shortcutsAndRevert: {},
    sendState: {},
  } as unknown as Parameters<typeof useChatViewActions>[0]);

  try {
    await actions.onImplementPlanInNewThread();
    expect(created).toBeDefined();
    const key = scopedThreadKey(created!);
    expect(useRightPanelStore.getState().byThreadKey[key]).toBeUndefined();
    expect(useDiffPanelStore.getState().viewedMarksByThreadKey[key]).toBeUndefined();
    expect(useBrowserHistoryStore.getState().projectKeyByThreadKey[key]).toBeUndefined();
  } finally {
    addToast.mockRestore();
    if (created) {
      useRightPanelStore.getState().removeThread(created);
      useDiffPanelStore.getState().removeThread(created);
      useBrowserHistoryStore.getState().removeThread(created);
    }
  }
});
