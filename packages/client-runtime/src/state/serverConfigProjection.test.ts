import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import { applyServerConfigProjection } from "./serverConfigProjection.ts";

function provider(id: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-11T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
  };
}

it("rebuilds the ordered catalog and preserves unchanged providers by reference", () => {
  const first = provider("first");
  const second = provider("second");
  const updated = { ...provider("updated"), version: "2" };
  const added = provider("added");
  const config = {
    providers: [first, second, provider("removed"), provider("updated")],
    environment: { capabilities: {} },
  } as unknown as ServerConfig;
  const snapshot = applyServerConfigProjection(Option.none(), {
    version: 1,
    type: "snapshot",
    config,
  });
  const result = applyServerConfigProjection(snapshot, {
    version: 1,
    type: "providerStatusesPatched",
    payload: {
      instanceIds: [
        second.instanceId,
        updated.instanceId,
        added.instanceId,
        first.instanceId,
        ProviderInstanceId.make("unknown"),
      ],
      changed: [updated, added],
    },
  });
  const providers = Option.getOrThrow(result).config.providers;
  expect(providers).toHaveLength(4);
  expect(providers[0]).toBe(second);
  expect(providers[1]).toBe(updated);
  expect(providers[2]).toBe(added);
  expect(providers[3]).toBe(first);
});
