// @effect-diagnostics nodeBuiltinImport:off - Electron Builder's post-package signature gate uses the native codesign process and filesystem layout.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

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
