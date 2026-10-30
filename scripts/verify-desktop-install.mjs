#!/usr/bin/env node
// Installs one built OOP installer the way a user does (through install-desktop.sh / .ps1 and a
// local release mirror), launches the installed app to its readiness signal, reinstalls over it,
// launches again, then uninstalls and checks that the app is gone. The same artifact that will be
// attached to the release is the one verified; signing checks and the Electron sandbox stay on.
//
//   node scripts/verify-desktop-install.mjs --installer <path> --version X.Y.Z
//
// macOS and Linux run in a throwaway HOME and install directory. Windows installs per user into
// the real profile, so it only runs when CI is set.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runDesktopSmoke } from "../apps/desktop/scripts/smoke-runner.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: { installer: { type: "string" }, version: { type: "string" } },
});
const installer = values.installer && path.resolve(values.installer);
const version = values.version ?? "";
if (!installer || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: verify-desktop-install.mjs --installer <path> --version X.Y.Z");
}
if (process.platform === "win32" && !process.env.CI) {
  throw new Error("Windows installs into the real user profile; run this only on a CI runner.");
}

const run = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
const must = async (label, promise) => {
  const result = await promise;
  if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code}):\n${result.output}`);
  console.log(`ok: ${label}`);
  return result;
};
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oop-install-verify-")));
const asset = path.basename(installer);
const bytes = await fs.readFile(installer);
const digest = createHash("sha256").update(bytes).digest("hex");
const server = createServer((request, response) => {
  if (request.url === `/v${version}/${asset}`) return response.end(bytes);
  if (request.url === `/v${version}/${asset}.sha256`) return response.end(`${digest}  ${asset}\n`);
  response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const home = path.join(root, "home");
const installDir = path.join(root, process.platform === "darwin" ? "Applications" : "prefix");
await fs.mkdir(home, { recursive: true });
const env = {
  ...process.env,
  OOP_VERSION: version,
  OOP_RELEASE_BASE_URL: `http://127.0.0.1:${port}`,
  ...(process.platform === "win32" ? {} : { HOME: home, OOP_INSTALL_DIR: installDir }),
};

const install = (label) =>
  process.platform === "win32"
    ? must(
        label,
        run(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "install-desktop.ps1")],
          env,
        ),
      )
    : must(label, run("sh", [path.join(scripts, "install-desktop.sh")], env));

// electron-builder's NSIS template writes InstallLocation under HKCU\Software\<app guid>, not into the
// Uninstall key, which only holds DisplayName, DisplayIcon ("<install dir>\OOP.exe,0") and the
// uninstall commands. So the install directory comes from DisplayIcon.
async function windowsInstall() {
  const query =
    "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | " +
    "Where-Object { $_.DisplayName -like 'OOP*' } | Select-Object -First 1 DisplayIcon | ConvertTo-Json";
  const { output } = await must("read the per-user uninstall entry", run("powershell", ["-NoProfile", "-Command", query], env));
  const entry = JSON.parse(output.trim() || "null");
  if (!entry?.DisplayIcon) throw new Error("No per-user OOP uninstall entry with a DisplayIcon was registered.");
  const executable = String(entry.DisplayIcon).replace(/^"|"?,\d+$|"$/g, "");
  return { executable, installLocation: path.dirname(executable) };
}

async function installedExecutable() {
  if (process.platform === "linux") return path.join(installDir, "bin", "oop-desktop");
  if (process.platform === "darwin") {
    const plist = path.join(installDir, "OOP.app", "Contents", "Info.plist");
    const { output } = await must(
      "read the installed bundle executable",
      run("plutil", ["-extract", "CFBundleExecutable", "raw", plist], env),
    );
    return path.join(installDir, "OOP.app", "Contents", "MacOS", output.trim());
  }
  return (await windowsInstall()).executable;
}

async function launch(label) {
  const executable = await installedExecutable();
  if (!(await exists(executable))) throw new Error(`${label}: ${executable} is missing.`);
  // The installed app reaches the same activation readiness signal as the source smoke, in an
  // isolated profile; nothing here touches the user's own OOP data.
  await runDesktopSmoke(executable, [], { env });
  console.log(`ok: ${label}`);
  return executable;
}

let failure;
try {
  await install("first install");
  const executable = await launch("first launch");
  await install("reinstall over the existing app");
  await launch("launch after reinstall");

  if (process.platform === "win32") {
    const { installLocation } = await windowsInstall();
    const uninstaller = (await fs.readdir(installLocation)).find((name) => /^Uninstall .*\.exe$/i.test(name));
    if (!uninstaller) throw new Error("The installation has no uninstaller.");
    // `_?=` keeps NSIS from copying itself away, so the call returns only once removal is done.
    // It runs from a copy outside the install folder, as the installer runs an old uninstaller:
    // its "is the app still running" check stops every process under the install folder, and an
    // uninstaller started in place would be one of them.
    const copy = path.join(root, "uninstaller.exe");
    await fs.copyFile(path.join(installLocation, uninstaller), copy);
    await must("uninstall", run(copy, ["/S", "/currentuser", `_?=${installLocation}`], env));
  } else if (process.platform === "darwin") {
    await fs.rm(path.join(installDir, "OOP.app"), { recursive: true });
    console.log("ok: uninstall");
  } else {
    for (const file of [
      path.join(installDir, "bin", "oop-desktop"),
      path.join(installDir, "share", "oop-desktop"),
      path.join(installDir, "share", "applications", "oop-desktop.desktop"),
    ]) {
      await fs.rm(file, { recursive: true });
    }
    console.log("ok: uninstall");
  }
  if (await exists(executable)) throw new Error(`Uninstall left ${executable} behind.`);
  console.log(`Verified install, launch, reinstall, and uninstall of ${asset}.`);
} catch (error) {
  failure = error;
} finally {
  server.closeAllConnections();
  server.close();
  await fs.rm(root, { recursive: true, force: true });
}
if (failure) {
  console.error(failure instanceof Error ? failure.message : failure);
  process.exitCode = 1;
}
// Everything is verified and cleaned up. Exit explicitly so that nothing an app run left behind
// can keep this step alive until the job times out.
process.exit();
