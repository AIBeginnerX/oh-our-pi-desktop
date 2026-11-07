// @effect-diagnostics nodeBuiltinImport:off - Electron Builder's post-package signature gate uses the native codesign process and filesystem layout.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

/**
 * Opt-in local signing mode for macOS builds. The value is the common name (or
 * the SHA-1 hash) of a code-signing identity in the user's keychain. A stable
 * identity keeps the designated requirement identical across builds, so keychain
 * "Always Allow" grants for safeStorage and the keyring survive an update.
 */
export const MAC_LOCAL_SIGN_IDENTITY_ENV = "OOP_MAC_LOCAL_SIGN_IDENTITY";

const SHA1_HEX = /^[0-9a-fA-F]{40}$/u;

/** Trimmed identity, or `undefined` when the variable is unset or blank. */
export function normalizeLocalSignIdentity(raw: string | undefined): string | undefined {
  const identity = raw?.trim();
  return identity ? identity : undefined;
}

/** `-` is codesign's ad hoc identity, which would silently defeat the mode. */
export function isUsableLocalSignIdentity(identity: string): boolean {
  return identity !== "-" && !/\p{Cc}/u.test(identity);
}

export interface CodesignDescription {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Judges `codesign -d -r- --verbose=2` output. The mode only works when the
 * signature carries a certificate-based designated requirement of the configured
 * identity, so an ad hoc signature (the cdhash requirement electron-builder falls
 * back to when it cannot find the identity) or another signer is rejected. The
 * messages never repeat a hash.
 */
export function localIdentitySignatureProblem(
  description: CodesignDescription,
  identity: string,
): string | undefined {
  if (/^Signature=adhoc$/mu.test(description.stderr)) return "signed ad hoc";
  const requirement = /designated => (.+)$/mu.exec(description.stdout)?.[1] ?? "";
  const leaf = /certificate leaf = H"([0-9a-fA-F]{40})"/u.exec(requirement)?.[1];
  if (leaf === undefined || /\bcdhash\b/u.test(requirement)) {
    return "designated requirement is not certificate-based";
  }
  if (SHA1_HEX.test(identity)) {
    return leaf.toLowerCase() === identity.toLowerCase() ? undefined : "signer does not match";
  }
  return /^Authority=(.+)$/mu.exec(description.stderr)?.[1] === identity
    ? undefined
    : "signer does not match";
}

const MACH_O_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]);

async function isMachO(filePath: string): Promise<boolean> {
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, 4, 0);
    return bytesRead === 4 && MACH_O_MAGICS.has(magic.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}

/**
 * Every code object the identity must have signed: the app, each nested
 * `.app`/`.framework` bundle, and each loose Mach-O (native addons, helper
 * binaries) outside frameworks. A bundle's own `MacOS` executables are covered
 * by the bundle. The server and the keyring addon run inside the main app
 * executable (Electron with ELECTRON_RUN_AS_NODE), which the app bundle covers.
 */
export async function listLocalIdentityTargets(appPath: string): Promise<readonly string[]> {
  const targets = [appPath];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const entryPath = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".framework")) targets.push(entryPath);
        else if (entry.name === "MacOS") continue;
        else {
          if (entry.name.endsWith(".app")) targets.push(entryPath);
          await walk(entryPath);
        }
      } else if (entry.isFile() && (await isMachO(entryPath))) {
        targets.push(entryPath);
      }
    }
  };
  await walk(NodePath.join(appPath, "Contents"));
  return targets;
}

const describeWithCodesign = async (target: string): Promise<CodesignDescription> => {
  const { stdout, stderr } = await execFileAsync("/usr/bin/codesign", [
    "-d",
    "-r-",
    "--verbose=2",
    target,
  ]);
  return { stdout, stderr };
};

/**
 * Fails when any code object in the app was not signed with the configured local
 * identity. electron-builder skips signing, with only a warning, when the
 * identity is missing or untrusted, so this is what makes the mode fail loudly.
 */
export async function verifyMacLocalIdentitySignatures(input: {
  readonly appPath: string;
  readonly identity: string;
  readonly describe?: (target: string) => Promise<CodesignDescription>;
}): Promise<void> {
  const describe = input.describe ?? describeWithCodesign;
  for (const target of await listLocalIdentityTargets(input.appPath)) {
    const problem = localIdentitySignatureProblem(await describe(target), input.identity);
    if (problem !== undefined) {
      throw new Error(
        `Packaged macOS app is not signed with the configured local identity (${problem}): ${target}`,
      );
    }
  }
}

/** Verify the final app bundle before its DMG or ZIP is copied to the output directory. */
export async function verifyMacPackagedAppSignatures(input: {
  readonly distDir: string;
  readonly productName: string;
  readonly verify?: (appPath: string) => Promise<void>;
}): Promise<readonly string[]> {
  const entries = await NodeFSP.readdir(input.distDir, { withFileTypes: true });
  const appPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^mac(?:-.+)?$/u.test(entry.name)) continue;
    const appPath = NodePath.join(input.distDir, entry.name, `${input.productName}.app`);
    const stat = await NodeFSP.stat(appPath).catch(() => undefined);
    if (stat?.isDirectory()) appPaths.push(appPath);
  }
  if (appPaths.length === 0) {
    throw new Error(`No packaged ${input.productName}.app bundle exists in ${input.distDir}.`);
  }

  const verify =
    input.verify ??
    (async (appPath: string) => {
      await execFileAsync("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        appPath,
      ]);
    });
  for (const appPath of appPaths) {
    try {
      await verify(appPath);
    } catch (cause) {
      throw new Error(`Packaged macOS app signature is invalid: ${appPath}`, { cause });
    }
  }
  return appPaths;
}
