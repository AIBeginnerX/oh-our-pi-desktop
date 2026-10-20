// @effect-diagnostics nodeBuiltinImport:off - The signature-gate fixture creates a temporary macOS app bundle directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { verifyMacPackagedAppSignatures } from "./mac-signature.ts";

describe("macOS package signature gate", () => {
  it("verifies the packaged app and rejects a failed verification before export", async () => {
    const distDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mac-signature-gate-"));
    try {
      const appPath = NodePath.join(distDir, "mac-arm64", "OoP.app");
      await NodeFSP.mkdir(appPath, { recursive: true });
      const verified: string[] = [];
      await expect(
        verifyMacPackagedAppSignatures({
          distDir,
          productName: "OoP",
          verify: async (path) => {
            verified.push(path);
          },
        }),
      ).resolves.toEqual([appPath]);
      expect(verified).toEqual([appPath]);
      await expect(
        verifyMacPackagedAppSignatures({
          distDir,
          productName: "OoP",
          verify: async () => {
            throw new Error("invalid resource seal");
          },
        }),
      ).rejects.toThrow(/signature is invalid/u);
    } finally {
      await NodeFSP.rm(distDir, { recursive: true, force: true });
    }
  });

  it("fails when the expected app bundle is absent", async () => {
    const distDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mac-signature-gate-"));
    try {
      await NodeFSP.mkdir(NodePath.join(distDir, "mac-arm64", "Wrong.app"), { recursive: true });
      await expect(
        verifyMacPackagedAppSignatures({ distDir, productName: "OoP", verify: async () => {} }),
      ).rejects.toThrow(/No packaged OoP\.app bundle/u);
    } finally {
      await NodeFSP.rm(distDir, { recursive: true, force: true });
    }
  });
});
