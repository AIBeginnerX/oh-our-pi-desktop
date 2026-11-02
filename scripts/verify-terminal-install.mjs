#!/usr/bin/env node
// Installs one built terminal archive the way a user does (through install-terminal.sh / .ps1 and a
// local release mirror) and runs what it installed: `oop --version` must print this version, the
// bundled server must start the way `oop` starts it and answer, and it must hand out the pairing
// token that `oop` asks for. Then it reinstalls over the existing install and runs `oop --version`
// again, and removes everything. The same archive that will be attached to the release is verified.
//
//   node scripts/verify-terminal-install.mjs --archive <path> --version X.Y.Z
//
// Everything lives in a throwaway HOME, install folder and OOP home; nothing real is touched.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: { archive: { type: "string" }, version: { type: "string" } },
});
const archive = values.archive && path.resolve(values.archive);
const version = values.version ?? "";
if (!archive || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: verify-terminal-install.mjs --archive <path> --version X.Y.Z");
}
const windows = process.platform === "win32";

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

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oop-terminal-verify-")));
const asset = path.basename(archive);
const bytes = await fs.readFile(archive);
const digest = createHash("sha256").update(bytes).digest("hex");
const mirror = createServer((request, response) => {
  if (request.url === `/v${version}/${asset}`) return response.end(bytes);
  if (request.url === `/v${version}/${asset}.sha256`) return response.end(`${digest}  ${asset}\n`);
  response.writeHead(404).end();
});
await new Promise((resolve) => mirror.listen(0, "127.0.0.1", resolve));
const { port: mirrorPort } = mirror.address();

const home = path.join(root, "home");
const installDir = path.join(root, "install");
const binDir = path.join(root, "bin");
const oopHome = path.join(root, "oop-home");
await fs.mkdir(home, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  OOP_VERSION: version,
  OOP_RELEASE_BASE_URL: `http://127.0.0.1:${mirrorPort}`,
  OOP_INSTALL_DIR: installDir,
  OOP_BIN_DIR: binDir,
};
delete env.OOP_DAEMON_ENTRY;

const install = (label) =>
  windows
    ? must(
        label,
        run(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "install-terminal.ps1")],
          env,
        ),
      )
    : must(label, run("sh", [path.join(scripts, "install-terminal.sh")], env));

const oop = (args, extraEnv = {}) =>
  windows
    ? run("cmd.exe", ["/d", "/c", path.join(binDir, "oop.cmd"), ...args], { ...env, ...extraEnv })
    : run(path.join(binDir, "oop"), args, { ...env, ...extraEnv });

async function verifyVersion(label) {
  const { output } = await must(label, oop(["--version"]));
  const printed = output.trim().split(/\r?\n/).at(-1);
  if (printed !== version) throw new Error(`${label}: oop printed "${printed}", expected ${version}.`);
  // The TypeScript terminal must keep working next to the Rust client: it is the fallback and the
  // OOP_TUI=ts escape hatch.
  const ts = await must(`${label} (OOP_TUI=ts)`, oop(["--version"], { OOP_TUI: "ts" }));
  const tsPrinted = ts.output.trim().split(/\r?\n/).at(-1);
  if (tsPrinted !== version) throw new Error(`${label}: OOP_TUI=ts printed "${tsPrinted}", expected ${version}.`);
}

// Which client the install carries is not asserted: an archive without a binary for its platform is
// valid. Reported so the release log shows whether the Rust client shipped.
async function reportClient() {
  const rust = path.join(installDir, windows ? "oop-rs.exe" : "oop-rs");
  console.log(`info: this archive carries the ${(await exists(rust)) ? "Rust" : "TypeScript"} terminal client`);
}

// Starts the bundled server with the command line `oop` builds (link/daemon.ts daemonCommand), on a
// port of its own, and stops it again. `oop` itself needs a terminal to start one.
async function verifyServer() {
  const node = path.join(installDir, windows ? "node.exe" : "node");
  const entry = path.join(installDir, "apps", "server", "dist", "bin.mjs");
  const serverPort = 39_000 + Math.floor(Math.random() * 900);
  const serverEnv = { ...env, T3CODE_NO_BROWSER: "1", ELECTRON_RUN_AS_NODE: "1" };
  const server = spawn(
    node,
    [entry, "serve", "--daemon", "--base-dir", oopHome, "--host", "127.0.0.1", "--port", String(serverPort)],
    { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  server.stdout.on("data", (chunk) => (log += chunk));
  server.stderr.on("data", (chunk) => (log += chunk));
  const exited = new Promise((resolve) => server.once("exit", resolve));
  try {
    for (let second = 0; ; second += 1) {
      if (server.exitCode !== null) throw new Error(`The bundled server ended with ${server.exitCode}:\n${log}`);
      const answered = await fetch(`http://127.0.0.1:${serverPort}/`, { signal: AbortSignal.timeout(5_000) }).then(
        (response) => response.ok,
        () => false,
      );
      if (answered) {
        console.log(`ok: the bundled server answered after ${second}s`);
        break;
      }
      if (second >= 120) throw new Error(`The bundled server did not answer in 120s:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const pair = await must(
      "the bundled server hands out a pairing token",
      run(node, [entry, "pair", "--base-dir", oopHome, "--label", "verify", "--ttl", "1m"], serverEnv),
    );
    if (!/^Token: \S+$/m.test(pair.output)) throw new Error("The pair command printed no token line.");
  } finally {
    if (server.exitCode === null) {
      server.kill();
      const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(force);
    }
  }
}

let failure;
try {
  await install("first install");
  await verifyVersion("oop --version after install");
  await reportClient();
  await must("oop --help", oop(["--help"]));
  await verifyServer();
  await install("reinstall over the existing install");
  await verifyVersion("oop --version after reinstall");
  await fs.rm(installDir, { recursive: true });
  await fs.rm(path.join(binDir, windows ? "oop.cmd" : "oop"));
  console.log("ok: uninstall");
  if (await exists(path.join(installDir, "oop.mjs"))) throw new Error("Uninstall left the terminal app behind.");
  console.log(`Verified install, run, reinstall, and uninstall of ${asset}.`);
} catch (error) {
  failure = error;
} finally {
  mirror.closeAllConnections();
  mirror.close();
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}
if (failure) {
  console.error(failure instanceof Error ? failure.message : failure);
  process.exitCode = 1;
}
process.exit();
