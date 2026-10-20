// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import { MINIMAX_MAINTENANCE } from "./MiniMaxDriver.ts";
import { ZCODE_MAINTENANCE } from "./ZCodeDriver.ts";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("maintenance resolution should not spawn a process here"),
);

/** A Windows npm global prefix: `<prefix>\\<bin>.cmd` beside `<prefix>\\node_modules\\<pkg>`. */
function windowsNpmPrefix(bin: string, packageName: string): { prefix: string; shim: string } {
  const prefix = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-acp-maintenance-"));
  const shim = NodePath.join(prefix, `${bin}.cmd`);
  NodeFS.writeFileSync(shim, "@echo off\r\n");
  const manifestDir = NodePath.join(prefix, "node_modules", ...packageName.split("/"));
  NodeFS.mkdirSync(manifestDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(manifestDir, "package.json"), "{}");
  return { prefix, shim };
}

const resolveOnWindows = (resolver: ProviderMaintenanceCapabilitiesResolver, shim: string) =>
  resolveProviderMaintenanceCapabilitiesEffect(resolver, {
    binaryPath: shim,
    env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
  }).pipe(
    Effect.provideService(HostProcessPlatform, "win32"),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
  );

it.layer(NodeServices.layer)("ACP provider maintenance", (it) => {
  it.effect("updates a Windows npm install of MiniMax Code in one click", () =>
    Effect.gen(function* () {
      const { prefix, shim } = windowsNpmPrefix("mcode", "@minimax-ai/code");
      const capabilities = yield* resolveOnWindows(MINIMAX_MAINTENANCE, shim);
      expect(capabilities.update).toMatchObject({
        executable: "npm",
        args: ["install", "-g", "--prefix", prefix, expect.any(String), "@minimax-ai/code@latest"],
      });
    }),
  );

  it.effect("updates a Windows npm install of the ZCode ACP bridge in one click", () =>
    Effect.gen(function* () {
      const { prefix, shim } = windowsNpmPrefix("zcode-acp-server", "zcode-acp-server");
      const capabilities = yield* resolveOnWindows(ZCODE_MAINTENANCE, shim);
      expect(capabilities.update).toMatchObject({
        executable: "npm",
        args: ["install", "-g", "--prefix", prefix, expect.any(String), "zcode-acp-server@latest"],
      });
    }),
  );

  it.effect("keeps an install it cannot prove as manual-only", () =>
    Effect.gen(function* () {
      const prefix = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-acp-unowned-"));
      const shim = NodePath.join(prefix, "mcode.cmd");
      NodeFS.writeFileSync(shim, "@echo off\r\n");
      const capabilities = yield* resolveOnWindows(MINIMAX_MAINTENANCE, shim);
      expect(capabilities.update).toBeNull();
    }),
  );
});
