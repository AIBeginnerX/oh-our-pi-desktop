#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off - Plain synchronous packaging script that needs no Effect runtime until the externals step.
/**
 * Packages the OOP terminal app (`oop`) for a computer that has no desktop app, no Node.js and no
 * pnpm: one archive per platform that the terminal installers (install-terminal.sh / .ps1 in the
 * public repository) download.
 *
 * `oop` talks to a local server and, when none runs, starts its own through OOP_DAEMON_ENTRY
 * (apps/oop-tui/src/link/daemon.ts), which names a server script that the program running `oop`
 * executes. The archive therefore carries the same pieces the desktop app does, laid out so the
 * existing lookup works unchanged (the pairing step recognises `.../apps/server/dist/bin.mjs` in the
 * server's command line, see parseServerScript in link/localAccess.ts):
 *
 *   node | node.exe               the official Node.js runtime, checksum-verified against nodejs.org
 *   NODE_LICENSE                  its license
 *   oop.mjs                       apps/oop-tui/dist/oop.mjs, a single file
 *   apps/server/dist/             the server bundle, its web client and the resource monitor
 *   node_modules/                 the native packages the server bundle keeps external
 *
 * Needs `vp run --filter t3 --filter oop-tui build` first. The runtime externals come from
 * build-cli-archive.ts, so they are staged and signed exactly like the server archives.
 *
 *   node scripts/build-terminal-archive.ts --platform mac|linux|win --arch arm64|x64 \
 *     --version X.Y.Z [--output-dir DIR] [--node-version X.Y.Z] [--resource-monitor FILE]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

export type TerminalPlatform = "mac" | "linux" | "win";
export type TerminalArch = "arm64" | "x64";

const PLATFORM_LABEL: Record<TerminalPlatform, string> = {
  mac: "macos",
  linux: "linux",
  win: "windows",
};

/** The release asset: `OOP-terminal-<version>-<macos|linux|windows>-<arm64|x64>.<tar.gz|zip>`. */
export function terminalArchiveName(
  version: string,
  platform: TerminalPlatform,
  arch: TerminalArch,
): string {
  return `OOP-terminal-${version}-${PLATFORM_LABEL[platform]}-${arch}.${platform === "win" ? "zip" : "tar.gz"}`;
}

/** The nodejs.org file for a platform, and where the runtime and its license sit inside it. */
export function nodeDistribution(
  nodeVersion: string,
  platform: TerminalPlatform,
  arch: TerminalArch,
): { file: string; runtime: string; license: string; executable: string } {
  const os = platform === "mac" ? "darwin" : platform === "win" ? "win" : "linux";
  const stem = `node-v${nodeVersion}-${os}-${arch}`;
  return {
    file: `${stem}.${platform === "win" ? "zip" : "tar.gz"}`,
    runtime: `${stem}/${platform === "win" ? "node.exe" : "bin/node"}`,
    license: `${stem}/LICENSE`,
    executable: platform === "win" ? "node.exe" : "node",
  };
}

/** The checksum a SHASUMS256.txt lists for `file`, or null. */
export function listedChecksum(shasums: string, file: string): string | null {
  const line = shasums.split("\n").find((entry) => entry.trim().endsWith(`  ${file}`));
  return line?.trim().split(/\s+/u)[0]?.toLowerCase() ?? null;
}

const sha256 = (file: string): string =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

function run(command: string, args: string[], options: NodeChildProcess.SpawnSyncOptions = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} exited with ${result.status ?? result.signal}.`);
  }
}

/** The bsdtar Windows ships in System32; a bare `tar` under Git Bash is GNU tar, which cannot write zip. */
const systemTar = (): string =>
  `${process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows"}\\System32\\tar.exe`;

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

/** Downloads the official Node.js for the target, checks it against SHASUMS256.txt, extracts the runtime and its license. */
async function stageNode(input: {
  nodeVersion: string;
  platform: TerminalPlatform;
  arch: TerminalArch;
  contentDir: string;
  scratch: string;
}): Promise<void> {
  const dist = nodeDistribution(input.nodeVersion, input.platform, input.arch);
  const base = `https://nodejs.org/dist/v${input.nodeVersion}`;
  const archive = NodePath.join(input.scratch, dist.file);
  NodeFS.writeFileSync(archive, await fetchBytes(`${base}/${dist.file}`));
  const shasums = (await fetchBytes(`${base}/SHASUMS256.txt`)).toString("utf8");
  const expected = listedChecksum(shasums, dist.file);
  if (expected === null || expected !== sha256(archive)) {
    throw new Error(`The downloaded ${dist.file} does not match SHASUMS256.txt.`);
  }
  const unpacked = NodePath.join(input.scratch, "node-unpacked");
  NodeFS.mkdirSync(unpacked, { recursive: true });
  run(input.platform === "win" ? systemTar() : "tar", [
    input.platform === "win" ? "-xf" : "-xzf",
    archive,
    "-C",
    unpacked,
    dist.runtime,
    dist.license,
  ]);
  NodeFS.copyFileSync(
    NodePath.join(unpacked, dist.runtime),
    NodePath.join(input.contentDir, dist.executable),
  );
  NodeFS.copyFileSync(
    NodePath.join(unpacked, dist.license),
    NodePath.join(input.contentDir, "NODE_LICENSE"),
  );
  if (input.platform !== "win") NodeFS.chmodSync(NodePath.join(input.contentDir, "node"), 0o755);
}

const walk = (directory: string): string[] =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = NodePath.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

/** Apple Silicon refuses unsigned native code; build-cli-archive.ts signs the same files ad hoc. Node itself keeps its own signature. */
function signMacNativeFiles(contentDir: string): void {
  for (const file of walk(contentDir)) {
    const name = NodePath.basename(file);
    if (
      name.endsWith(".node") ||
      name.endsWith(".dylib") ||
      name === "spawn-helper" ||
      name === "t3-resource-monitor"
    ) {
      run("codesign", ["--force", "--sign", "-", file]);
    }
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = NodeUtil.parseArgs({
    args: argv,
    options: {
      platform: { type: "string" },
      arch: { type: "string" },
      version: { type: "string" },
      "output-dir": { type: "string", default: "terminal-release" },
      "node-version": { type: "string", default: process.versions.node },
      "resource-monitor": { type: "string" },
      // Packaging only, for tests on a machine that cannot stage the native packages.
      "skip-externals": { type: "boolean", default: false },
    },
  });
  const platform = values.platform as TerminalPlatform;
  const arch = values.arch as TerminalArch;
  const version = values.version ?? "";
  if (!["mac", "linux", "win"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error("--platform must be mac, linux or win and --arch arm64 or x64.");
  }
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("--version must be X.Y.Z.");
  const nodeVersion = values["node-version"] ?? process.versions.node;
  if (!/^\d+\.\d+\.\d+$/u.test(nodeVersion)) throw new Error("--node-version must be X.Y.Z.");

  const serverDist = NodePath.join(ROOT, "apps/server/dist");
  const oopBundle = NodePath.join(ROOT, "apps/oop-tui/dist/oop.mjs");
  for (const [file, hint] of [
    [NodePath.join(serverDist, "bin.mjs"), "vp run --filter t3 build"],
    [NodePath.join(serverDist, "client/index.html"), "vp run --filter t3 build"],
    [oopBundle, "vp run --filter oop-tui build"],
  ] as const) {
    if (!NodeFS.existsSync(file)) throw new Error(`Missing ${file}. Run \`${hint}\` first.`);
  }

  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-terminal-archive-"));
  try {
    const contentDir = NodePath.join(scratch, "oop-terminal");
    NodeFS.mkdirSync(contentDir);
    NodeFS.copyFileSync(oopBundle, NodePath.join(contentDir, "oop.mjs"));
    NodeFS.cpSync(serverDist, NodePath.join(contentDir, "apps/server/dist"), {
      recursive: true,
      filter: (source) => !source.endsWith(".map"),
    });
    if (values["resource-monitor"]) {
      const monitor = NodePath.resolve(values["resource-monitor"]);
      const name = platform === "win" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
      const target = NodePath.join(contentDir, "apps/server/dist/resource-monitor", name);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.copyFileSync(monitor, target);
      if (platform !== "win") NodeFS.chmodSync(target, 0o755);
    }
    await stageNode({ nodeVersion, platform, arch, contentDir, scratch });

    if (!values["skip-externals"]) {
      // Imported here so that packaging alone needs none of the workspace's dependencies.
      const { stageRuntimeExternals } = await import("./build-cli-archive.ts");
      const Effect = await import("effect/Effect");
      const NodeServices = await import("@effect/platform-node/NodeServices");
      const externals = NodePath.join(scratch, "externals");
      NodeFS.mkdirSync(externals);
      await Effect.runPromise(
        stageRuntimeExternals({
          repoRoot: ROOT,
          stageDir: externals,
          platform,
          arch,
          version,
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      NodeFS.renameSync(
        NodePath.join(externals, "node_modules"),
        NodePath.join(contentDir, "node_modules"),
      );
    }
    if (platform === "mac") signMacNativeFiles(contentDir);

    const outputDir = NodePath.resolve(values["output-dir"] ?? "terminal-release");
    NodeFS.mkdirSync(outputDir, { recursive: true });
    const name = terminalArchiveName(version, platform, arch);
    const archive = NodePath.join(outputDir, name);
    NodeFS.rmSync(archive, { force: true });
    if (platform === "win") {
      run(systemTar(), ["-a", "-c", "-f", archive, "-C", scratch, "oop-terminal"]);
    } else {
      run(
        "tar",
        [
          ...(platform === "linux" ? ["--hard-dereference"] : []),
          "-czf",
          archive,
          "-C",
          scratch,
          "oop-terminal",
        ],
        { env: { ...process.env, COPYFILE_DISABLE: "1" } },
      );
    }
    NodeFS.writeFileSync(`${archive}.sha256`, `${sha256(archive)}  ${name}\n`);
    console.log(`Wrote ${archive} (${NodeFS.statSync(archive).size} bytes) and its .sha256.`);
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(`[build-terminal-archive] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
