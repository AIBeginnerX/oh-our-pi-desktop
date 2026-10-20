// Behavior regression for the conflict reload gate: a React render of the real
// editor with the RPC/query boundary mocked. Per the Astra round-5 proof, the
// enabled-button workflow must reject the pre-write response after a conflict
// (delayed revalidate start, or the command failing without touching the
// query), then install a genuinely fresh version with its own content and
// write it with the matching expectedVersion.
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ComponentProps } from "react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectMemory,
  type ProjectMemoryId,
} from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  query: {} as any,
  raw: null as any,
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  revalidate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../state/projectMemory", () => ({
  projectMemory: {
    create: "create",
    update: "update",
    delete: "delete",
    revalidate: "revalidate",
    get: (target: any) => target,
    list: () => null,
    search: () => null,
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: string) => (harness as Record<string, unknown>)[name],
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => harness.query }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => harness.raw }));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: any) => value }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => null },
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, isPending: false, error: null }),
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "env-a" }));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, isPending: false, hasError: false }),
}));
vi.mock("./ProviderSettingsPanel.logic", () => ({
  resolvePrimaryOperateAccess: () => "granted",
  resolveRemoteOperateAccess: () => "granted",
}));
vi.mock("../ui/alert", () => ({ Alert: "aside", AlertDescription: "span" }));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
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

import { ProjectMemoryEditorDialog } from "./ProjectMemorySection";

let renderer: ReactTestRenderer | null = null;
const onOpenChange = vi.fn();
const base: ComponentProps<typeof ProjectMemoryEditorDialog> = {
  environmentId: "env-a" as EnvironmentId,
  projectId: "project-a" as ProjectId,
  open: true,
  origin: { type: "manual" },
  onOpenChange,
};
const memoryA = "memory-a" as ProjectMemoryId;
// v1 and v2 carry different bodies so the assertions prove which content was
// actually installed.
const memoryV1: ProjectMemory = {
  memoryId: memoryA,
  projectId: "project-a" as ProjectId,
  kind: "fact",
  title: "new-title",
  body: "v1-body",
  version: 1,
  origin: { type: "manual" },
  validUntil: null,
  estimatedTokens: 2,
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
};
const memoryV2: ProjectMemory = { ...memoryV1, version: 2, body: "v2-body" };

const render = (props: ComponentProps<typeof ProjectMemoryEditorDialog>) => {
  const element = (
    <StrictMode>
      <ProjectMemoryEditorDialog {...props} />
    </StrictMode>
  );
  act(() => {
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
};
const button = (text: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.some((c) => c === text))!;
const editBody = (value: string) =>
  act(() =>
    renderer!.root
      .findByProps({ "aria-label": "Memory body" })
      .props.onChange({ currentTarget: { value } }),
  );

/** Query and update stubs for a v1 load that will hit Conflict(currentVersion 2). */
const conflictSetup = () => {
  harness.query = { data: { memory: memoryV1 }, error: null, isPending: false };
  harness.raw = AsyncResult.success({ memory: memoryV1 });
  harness.update.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail({ _tag: "ProjectMemoryConflictError", currentVersion: 2 })),
  );
};

/** Loads v1, edits the body, and saves into a Conflict(currentVersion 2). */
const editAndSaveIntoConflict = async () => {
  render({ ...base, memoryId: memoryA });
  editBody("edited-body");
  await act(async () => button("Save changes").props.onClick());
  expect(harness.update).toHaveBeenCalledTimes(1);
  expect(harness.update.mock.calls[0]![0].input.expectedVersion).toBe(1);
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.query = { data: null, error: null, isPending: false };
  harness.raw = AsyncResult.initial(false);
  for (const key of ["create", "update", "delete", "revalidate", "toast"] as const) {
    harness[key].mockReset();
  }
  onOpenChange.mockReset();
  harness.update.mockResolvedValue(AsyncResult.success({ memory: memoryV2 }));
  harness.delete.mockResolvedValue(AsyncResult.success(undefined));
  harness.revalidate.mockResolvedValue(AsyncResult.success(undefined));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

it("installs the fetched v2 directly when the automatic refetch already delivered it", async () => {
  conflictSetup();
  // The conflict's automatic revalidate leaves the fresh read pending, so Load
  // starts disabled.
  harness.revalidate.mockImplementation(() => {
    harness.query = { data: null, error: null, isPending: true };
    harness.raw = AsyncResult.initial(true);
    return Promise.resolve(AsyncResult.success(undefined));
  });
  await editAndSaveIntoConflict();
  expect(button("Load current version").props.disabled).toBe(true);
  expect(button("Save changes").props.disabled).toBe(true);

  // The fresh v2 lands: Load becomes enabled and installs it directly — the
  // conflict's revalidate was the only one, no second refresh is launched.
  harness.query = { data: { memory: memoryV2 }, error: null, isPending: false };
  harness.raw = AsyncResult.success({ memory: memoryV2 });
  render({ ...base, memoryId: memoryA });
  await act(async () => {});
  const load = button("Load current version");
  expect(load.props.disabled).toBe(false);
  act(() => load.props.onClick());
  await act(async () => {});
  expect(harness.revalidate).toHaveBeenCalledTimes(1);
  expect(renderer!.root.findByProps({ "aria-label": "Memory body" }).props.value).toBe("v2-body");
  expect(button("Save changes").props.disabled).toBe(false);

  await act(async () => button("Save changes").props.onClick());
  expect(harness.update).toHaveBeenCalledTimes(2);
  expect(harness.update.mock.calls[1]![0].input.expectedVersion).toBe(2);
  expect(harness.update.mock.calls[1]![0].input.body).toBe("v2-body");
});

it("rejects the cached pre-write response when the revalidate starts late, then proceeds on fresh v2", async () => {
  conflictSetup();
  // The command boundary delays the revalidate and the query keeps showing the
  // settled pre-write v1 — both are real outcomes at this boundary.
  let resolveRevalidate: (result: unknown) => void = () => {};
  harness.revalidate.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRevalidate = resolve;
      }),
  );
  await editAndSaveIntoConflict();

  // Load is enabled (the query is settled); clicking it starts the intent.
  const load = button("Load current version");
  expect(load.props.disabled).toBe(false);
  act(() => load.props.onClick());
  await act(async () => {});

  // The still-cached v1 must NOT be consumed: the draft and the conflict gate
  // survive, Save is gated, and no second write can carry version 1.
  expect(renderer!.root.findByProps({ "aria-label": "Memory body" }).props.value).toBe(
    "edited-body",
  );
  expect(button("Save changes").props.disabled).toBe(true);
  await act(async () => button("Save changes").props.onClick());
  expect(harness.update).toHaveBeenCalledTimes(1);

  resolveRevalidate(AsyncResult.success(undefined));
  harness.query = { data: { memory: memoryV2 }, error: null, isPending: false };
  harness.raw = AsyncResult.success({ memory: memoryV2 });
  render({ ...base, memoryId: memoryA });
  await act(async () => {});

  expect(renderer!.root.findByProps({ "aria-label": "Memory body" }).props.value).toBe("v2-body");
  expect(button("Save changes").props.disabled).toBe(false);
  await act(async () => button("Save changes").props.onClick());
  expect(harness.update).toHaveBeenCalledTimes(2);
  expect(harness.update.mock.calls[1]![0].input.expectedVersion).toBe(2);
  expect(harness.update.mock.calls[1]![0].input.body).toBe("v2-body");
});

it("keeps the gate and offers a retry when the revalidate command fails without a query change", async () => {
  conflictSetup();
  await editAndSaveIntoConflict();

  // The next revalidate — the explicit Load retry — fails at the command level
  // without touching the query, which still shows the settled pre-write v1.
  harness.revalidate.mockRejectedValueOnce(new Error("revalidate transport failed"));
  const load = button("Load current version");
  expect(load.props.disabled).toBe(false);
  act(() => load.props.onClick());
  await act(async () => {});

  expect(renderer!.root.findByProps({ "aria-label": "Memory body" }).props.value).toBe(
    "edited-body",
  );
  expect(button("Save changes").props.disabled).toBe(true);
  expect(button("Delete").props.disabled).toBe(true);
  await act(async () => button("Save changes").props.onClick());
  expect(harness.update).toHaveBeenCalledTimes(1);
  // The failed Load leaves the button as the retry.
  expect(button("Load current version").props.disabled).toBe(false);

  // A successful retry with fresh v2 releases the gate and the write uses v2.
  harness.revalidate.mockResolvedValue(AsyncResult.success(undefined));
  const retry = button("Load current version");
  act(() => retry.props.onClick());
  harness.query = { data: { memory: memoryV2 }, error: null, isPending: false };
  harness.raw = AsyncResult.success({ memory: memoryV2 });
  render({ ...base, memoryId: memoryA });
  await act(async () => {});

  expect(renderer!.root.findByProps({ "aria-label": "Memory body" }).props.value).toBe("v2-body");
  expect(button("Save changes").props.disabled).toBe(false);
  await act(async () => button("Save changes").props.onClick());
  expect(harness.update).toHaveBeenCalledTimes(2);
  expect(harness.update.mock.calls[1]![0].input.expectedVersion).toBe(2);
});

it("keeps writes gated and the draft when the conflict refetch fails at the query level", async () => {
  conflictSetup();
  harness.revalidate.mockImplementation(() => {
    harness.query = { data: null, error: "Environment offline", isPending: false };
    harness.raw = AsyncResult.failure(Cause.fail(new Error("Environment offline")));
    return Promise.resolve(AsyncResult.success(undefined));
  });
  await editAndSaveIntoConflict();
  const load = button("Load current version");
  expect(load.props.disabled).toBe(false);
  act(() => load.props.onClick());
  await act(async () => {});

  expect(renderer!.root.findByProps({ "aria-label": "Memory body" }).props.value).toBe(
    "edited-body",
  );
  expect(button("Save changes").props.disabled).toBe(true);
  expect(button("Delete").props.disabled).toBe(true);
  // The retry route stays available on query failure.
  expect(load.props.disabled).toBe(false);
});

it("hides content when the conflict refetch ends typed NotFound", async () => {
  conflictSetup();
  harness.revalidate.mockImplementation(() => {
    harness.query = { data: null, error: "Memory not found", isPending: false };
    harness.raw = AsyncResult.failure(Cause.fail({ _tag: "ProjectMemoryNotFoundError" }));
    return Promise.resolve(AsyncResult.success(undefined));
  });
  await editAndSaveIntoConflict();
  // A typed NotFound removes the editor immediately: there is no Load current
  // button left to click.
  render({ ...base, memoryId: memoryA });

  expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
  expect(renderer!.root.findAllByType("button").map((node) => node.children)).toEqual([["Close"]]);
});
