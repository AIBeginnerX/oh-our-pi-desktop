import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { LocalModelAdvice } from "./LocalModelAdvice";

vi.mock("../ui/button", () => ({ Button: "button" }));

let settings = DEFAULT_CLIENT_SETTINGS;
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (value: typeof settings) => unknown) => selector(settings),
  persistClientSettingsUpdate: (update: (value: typeof settings) => typeof settings) => {
    settings = update(settings);
    return Promise.resolve(settings);
  },
}));

const environmentId = EnvironmentId.make("local-test");
const instanceId = ProviderInstanceId.make("codex");
function entry(
  status: "ready" | "warning" = "ready",
  auth: "authenticated" | "unknown" = "authenticated",
) {
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status,
    auth: { status: auth },
    checkedAt: "2026-10-01T00:00:00.000Z",
    models: [{ slug: "observed", name: "Observed", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

let renderer: ReactTestRenderer | null = null;
const onApply = vi.fn();
function advice(
  status: "ready" | "warning" = "ready",
  auth: "authenticated" | "unknown" = "authenticated",
  model = "observed",
) {
  return (
    <LocalModelAdvice
      environmentId={environmentId}
      activeInstanceId={instanceId}
      model={model}
      lockedProvider={null}
      lockedContinuationGroupKey={null}
      instanceEntries={[entry(status, auth)]}
      modelOptionsByInstance={
        new Map([
          [
            instanceId,
            [
              { slug: "observed", name: "Observed" },
              { slug: "synthetic", name: "Synthetic" },
            ],
          ],
        ])
      }
      onApply={onApply}
    />
  );
}

function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  settings = DEFAULT_CLIENT_SETTINGS;
  onApply.mockClear();
});
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

it("keeps advice read-only until Apply is clicked", async () => {
  await act(() => {
    renderer = create(advice());
  });
  expect(onApply).not.toHaveBeenCalled();
  await act(() => button("Apply").props.onClick());
  expect(onApply).toHaveBeenCalledExactlyOnceWith(instanceId, "observed");
});

it("rechecks live readiness before applying", async () => {
  await act(() => {
    renderer = create(advice());
  });
  await act(() => {
    renderer!.update(advice("warning"));
  });
  await act(() => button("Apply").props.onClick());
  expect(onApply).not.toHaveBeenCalled();
  expect(button("Apply").props.disabled).toBe(true);
});

it("accepts a ready provider whose auth status is unknown", async () => {
  await act(() => {
    renderer = create(advice("ready", "unknown"));
  });
  expect(button("Apply").props.disabled).toBe(false);
});

it("does not recommend a model absent from the live catalog", async () => {
  await act(() => {
    renderer = create(advice("ready", "authenticated", "synthetic"));
  });
  expect(button("Apply").props.disabled).toBe(true);
  await act(() => button("Implementation").props.onClick());
  expect(button("Save current for role").props.disabled).toBe(true);
});

it("requires an explicit role choice and allows it to be cleared", async () => {
  await act(() => {
    renderer = create(advice());
  });
  await act(() => button("Implementation").props.onClick());
  expect(button("Apply").props.disabled).toBe(true);
  await act(() => button("Save current for role").props.onClick());
  await act(() => {
    renderer!.update(advice());
  });
  expect(button("Apply").props.disabled).toBe(false);
  expect(onApply).not.toHaveBeenCalled();
  await act(() => button("Clear").props.onClick());
  await act(() => {
    renderer!.update(advice());
  });
  expect(button("Apply").props.disabled).toBe(true);
});
