// @effect-diagnostics nodeBuiltinImport:off - The signature-gate fixture creates a temporary macOS app bundle directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  isUsableLocalSignIdentity,
  localIdentitySignatureProblem,
  verifyMacLocalIdentitySignatures,
  verifyMacPackagedAppSignatures,
} from "./mac-signature.ts";

describe("macOS package signature gate", () => {
  it("verifies the packaged app and rejects a failed verification before export", async () => {
    const distDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mac-signature-gate-"));
    try {
      const appPath = NodePath.join(distDir, "mac-arm64", "OOP.app");
      await NodeFSP.mkdir(appPath, { recursive: true });
      const verified: string[] = [];
      await expect(
        verifyMacPackagedAppSignatures({
          distDir,
          productName: "OOP",
          verify: async (path) => {
            verified.push(path);
          },
        }),
      ).resolves.toEqual([appPath]);
      expect(verified).toEqual([appPath]);
      await expect(
        verifyMacPackagedAppSignatures({
          distDir,
          productName: "OOP",
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
        verifyMacPackagedAppSignatures({ distDir, productName: "OOP", verify: async () => {} }),
      ).rejects.toThrow(/No packaged OOP\.app bundle/u);
    } finally {
      await NodeFSP.rm(distDir, { recursive: true, force: true });
    }
  });
});

describe("macOS local identity signature gate", () => {
  const leaf = "0123456789abcdef0123456789abcdef01234567";
  const certificateSigned = {
    stdout: `designated => identifier "com.t3tools.t3code" and certificate leaf = H"${leaf}"\n`,
    stderr: "Signature size=1\nAuthority=OOP Local Signing\nTeamIdentifier=not set\n",
  };
  const adhoc = {
    stdout: 'designated => cdhash H"aabbccddeeff00112233445566778899aabbccdd"\n',
    stderr: "CodeDirectory flags=0x2(adhoc)\nSignature=adhoc\nTeamIdentifier=not set\n",
  };

  it("accepts a certificate-based requirement from the configured name or hash", () => {
    expect(localIdentitySignatureProblem(certificateSigned, "OOP Local Signing")).toBeUndefined();
    expect(localIdentitySignatureProblem(certificateSigned, leaf.toUpperCase())).toBeUndefined();
  });

  it("rejects ad hoc fallback, a cdhash requirement and another signer without echoing hashes", () => {
    expect(localIdentitySignatureProblem(adhoc, "OOP Local Signing")).toBe("signed ad hoc");
    expect(
      localIdentitySignatureProblem(
        { stdout: adhoc.stdout, stderr: certificateSigned.stderr },
        "OOP Local Signing",
      ),
    ).toBe("designated requirement is not certificate-based");
    expect(localIdentitySignatureProblem(certificateSigned, "Other Identity")).toBe(
      "signer does not match",
    );
    expect(localIdentitySignatureProblem(certificateSigned, "f".repeat(40))).toBe(
      "signer does not match",
    );
  });

  it("refuses the ad hoc identity and control characters", () => {
    expect(isUsableLocalSignIdentity("OOP Local Signing")).toBe(true);
    expect(isUsableLocalSignIdentity("-")).toBe(false);
    expect(isUsableLocalSignIdentity("a\nb")).toBe(false);
  });

  it("checks the app, nested bundles and loose Mach-O files, and fails on one ad hoc object", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mac-local-identity-"));
    try {
      const app = NodePath.join(root, "OOP.app");
      const contents = NodePath.join(app, "Contents");
      const helper = NodePath.join(contents, "Frameworks", "OOP Helper.app");
      const framework = NodePath.join(contents, "Frameworks", "Electron Framework.framework");
      const addon = NodePath.join(contents, "Resources", "app.asar.unpacked", "keyring.node");
      const machO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
      for (const directory of [
        NodePath.join(contents, "MacOS"),
        NodePath.join(helper, "Contents", "MacOS"),
        framework,
        NodePath.dirname(addon),
      ]) {
        await NodeFSP.mkdir(directory, { recursive: true });
      }
      await NodeFSP.writeFile(NodePath.join(contents, "MacOS", "OOP"), machO);
      await NodeFSP.writeFile(NodePath.join(helper, "Contents", "MacOS", "Helper"), machO);
      await NodeFSP.writeFile(addon, machO);
      await NodeFSP.writeFile(NodePath.join(contents, "Resources", "app.asar"), "not mach-o");

      const seen: string[] = [];
      await verifyMacLocalIdentitySignatures({
        appPath: app,
        identity: "OOP Local Signing",
        describe: async (target) => {
          seen.push(target);
          return certificateSigned;
        },
      });
      expect(seen.toSorted()).toEqual([app, framework, helper, addon].toSorted());

      await expect(
        verifyMacLocalIdentitySignatures({
          appPath: app,
          identity: "OOP Local Signing",
          describe: async (target) => (target === addon ? adhoc : certificateSigned),
        }),
      ).rejects.toThrow(/not signed with the configured local identity \(signed ad hoc\)/u);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
