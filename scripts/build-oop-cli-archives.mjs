#!/usr/bin/env node

// Builds the OOP server archives that a desktop installs on an SSH remote (Linux x64 and arm64,
// Apple Silicon Mac) into release/cli/v<version>/ with SHA256SUMS; the release step then copies
// them to Drive.
// Run on the release Mac after `node scripts/macos.mjs package`:
//
//   node scripts/build-oop-cli-archives.mjs [--version X.Y.Z] [--skip-bundle] [--skip-smoke]
//
// Needs Docker (colima profile "ob" is started when Docker is not reachable) for the Linux Rust
// resource monitor and start-up test, cargo for the Mac one, and GNU tar (brew install gnu-tar) for build-cli-archive.ts.
// The single executable needs Node 25.7+ with single-executable support, which Homebrew's node
// lacks, so the official Node it pins is downloaded once into ~/.local/opt.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
// Keep in step with VP_NODE_VERSION in .github/workflows/release-desktop.yml.
const SEA_NODE_VERSION = "26.8.2";
const GNU_TAR_DIR = "/opt/homebrew/opt/gnu-tar/libexec/gnubin";
const COLIMA_PROFILE = "ob";
// Docker (colima) mounts only the home folder, so everything a container reads lives under it.
const CACHE = NodePath.join(NodeOS.homedir(), ".cache", "oop-cli-build");

export const TARGETS = [
  { key: "linux-x64", platform: "linux", arch: "x64", docker: "linux/amd64" },
  { key: "linux-arm64", platform: "linux", arch: "arm64", docker: "linux/arm64" },
  // Built and started on this Mac itself, no container.
  { key: "darwin-arm64", platform: "mac", arch: "arm64", docker: null },
];

export function parseArgs(argv) {
  const options = { version: undefined, skipBundle: false, skipSmoke: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version" && /^\d+\.\d+\.\d+$/u.test(argv[index + 1] ?? "")) {
      options.version = argv[index + 1];
      index += 1;
    } else if (arg === "--skip-bundle") options.skipBundle = true;
    else if (arg === "--skip-smoke") options.skipSmoke = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function checksumListing(entries) {
  return entries.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join("");
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} exited with ${result.status ?? result.signal}.`);
  }
}

const succeeds = (command, args, env = process.env) =>
  NodeChildProcess.spawnSync(command, args, { stdio: "ignore", env }).status === 0;

function seaNode() {
  const dir = NodePath.join(
    NodeOS.homedir(),
    ".local",
    "opt",
    `node-v${SEA_NODE_VERSION}-darwin-arm64`,
  );
  const node = NodePath.join(dir, "bin", "node");
  if (NodeFS.existsSync(node)) return node;
  const base = `https://nodejs.org/dist/v${SEA_NODE_VERSION}`;
  const file = `node-v${SEA_NODE_VERSION}-darwin-arm64.tar.gz`;
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-sea-node-"));
  run("curl", ["-fsSL", "-o", NodePath.join(scratch, file), `${base}/${file}`]);
  run("curl", ["-fsSL", "-o", NodePath.join(scratch, "SHASUMS256.txt"), `${base}/SHASUMS256.txt`]);
  const expected = NodeFS.readFileSync(NodePath.join(scratch, "SHASUMS256.txt"), "utf8")
    .split("\n")
    .find((line) => line.endsWith(`  ${file}`))
    ?.split(" ")[0];
  const actual = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(NodePath.join(scratch, file)))
    .digest("hex");
  if (expected !== actual) throw new Error(`The downloaded ${file} does not match SHASUMS256.txt.`);
  NodeFS.mkdirSync(NodePath.dirname(dir), { recursive: true });
  run("tar", ["-xzf", NodePath.join(scratch, file), "-C", NodePath.dirname(dir)]);
  NodeFS.rmSync(scratch, { recursive: true, force: true });
  return node;
}

// x64 containers run through Rosetta, whose binfmt registration a restart can lose.
function ensureAmd64(env) {
  const probe = ["run", "--rm", "--platform", "linux/amd64", "ubuntu:24.04", "true"];
  if (succeeds("docker", probe, env)) return;
  run("colima", ["restart", COLIMA_PROFILE]);
  if (!succeeds("docker", probe, env)) throw new Error("Docker cannot run linux/amd64 containers.");
}

function dockerEnv() {
  if (succeeds("docker", ["info"])) return process.env;
  const colima = { ...process.env, DOCKER_CONTEXT: `colima-${COLIMA_PROFILE}` };
  if (succeeds("docker", ["info"], colima)) return colima;
  run("colima", [
    "start",
    COLIMA_PROFILE,
    "--cpu",
    "6",
    "--memory",
    "10",
    "--vm-type",
    "vz",
    "--vz-rosetta",
  ]);
  if (!succeeds("docker", ["info"], colima)) throw new Error("Docker is not reachable.");
  return colima;
}

function buildResourceMonitor(target, env) {
  const cargoTarget = NodePath.join(CACHE, `cargo-target-${target.key}`);
  const registry = NodePath.join(CACHE, `cargo-registry-${target.key}`);
  NodeFS.mkdirSync(cargoTarget, { recursive: true });
  NodeFS.mkdirSync(registry, { recursive: true });
  if (target.docker === null) {
    run("cargo", ["build", "--release", "--locked"], {
      cwd: NodePath.join(ROOT, "native", "resource-monitor"),
      env: { ...process.env, CARGO_TARGET_DIR: cargoTarget },
    });
  } else
    run(
      "docker",
      [
        "run",
        "--rm",
        "--platform",
        target.docker,
        // One local tag serves every architecture; resolve it for this run's platform.
        "--pull=always",
        "-v",
        `${NodePath.join(ROOT, "native", "resource-monitor")}:/src:ro`,
        "-v",
        `${cargoTarget}:/target`,
        "-v",
        `${registry}:/usr/local/cargo/registry`,
        "-e",
        "CARGO_TARGET_DIR=/target",
        "-w",
        "/src",
        "rust:1-bookworm",
        "cargo",
        "build",
        "--release",
        "--locked",
      ],
      { env },
    );
  const stage = NodePath.join(CACHE, "resource-monitor");
  NodeFS.mkdirSync(NodePath.join(stage, target.key), { recursive: true });
  NodeFS.copyFileSync(
    NodePath.join(cargoTarget, "release", "t3-resource-monitor"),
    NodePath.join(stage, target.key, "t3-resource-monitor"),
  );
  return stage;
}

// Unpacks the archive in a stock Ubuntu of that architecture and waits for `serve` to answer.
const SMOKE_SCRIPT = `set -eu
apt-get -qq update >/dev/null && apt-get -qq install -y curl libatomic1 >/dev/null
mkdir -p /opt/t3 && tar -xzf "/out/$1" -C /opt/t3 --strip-components=1
/opt/t3/t3 --version
T3CODE_NO_BROWSER=1 /opt/t3/t3 serve --host 127.0.0.1 --port 3999 --base-dir /root/.oop-desktop >/tmp/serve.log 2>&1 &
i=0
until curl -fs -o /dev/null http://127.0.0.1:3999/; do
  i=$((i + 1))
  if [ "$i" -ge 120 ]; then tail -20 /tmp/serve.log >&2; exit 1; fi
  sleep 1
done
echo "serve answered after \${i}s"
`;

async function smokeTestOnThisMac(outDir, name) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-cli-smoke-"));
  try {
    run("tar", ["-xzf", NodePath.join(outDir, name), "-C", dir, "--strip-components=1"]);
    run(NodePath.join(dir, "t3"), ["--version"]);
    const port = 39_000 + Math.floor(Math.random() * 900);
    const args = ["serve", "--host", "127.0.0.1", "--port", String(port)];
    const server = NodeChildProcess.spawn(
      NodePath.join(dir, "t3"),
      [...args, "--base-dir", NodePath.join(dir, "home")],
      { env: { ...process.env, T3CODE_NO_BROWSER: "1" }, stdio: "ignore" },
    );
    try {
      for (let second = 0; second < 120; second += 1) {
        const answered = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(5_000),
        }).then(
          (response) => response.ok,
          () => false,
        );
        if (answered) return console.log(`serve answered after ${second}s`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      throw new Error(`${name} did not answer on this Mac.`);
    } finally {
      // The server writes logs until it exits; remove its folder only after that.
      if (server.exitCode === null && server.signalCode === null) {
        const exited = new Promise((resolve) => server.once("exit", resolve));
        server.kill("SIGTERM");
        const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
        await exited;
        clearTimeout(force);
      }
    }
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

function smokeTest(target, outDir, name, env) {
  if (target.docker === null) return smokeTestOnThisMac(outDir, name);
  run(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      target.docker,
      // One local tag serves every architecture; resolve it for this run's platform.
      "--pull=always",
      "-v",
      `${outDir}:/out:ro`,
      "ubuntu:24.04",
      "sh",
      "-c",
      SMOKE_SCRIPT,
      "smoke",
      name,
    ],
    { env },
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const version =
    options.version ??
    JSON.parse(NodeFS.readFileSync(NodePath.join(ROOT, "OOP_RELEASE.json"), "utf8")).version;
  if (!NodeFS.existsSync(NodePath.join(GNU_TAR_DIR, "tar"))) {
    throw new Error("GNU tar is missing: brew install gnu-tar");
  }
  const outDir = NodePath.join(ROOT, "release", "cli", `v${version}`);
  await NodeFSP.rm(outDir, { recursive: true, force: true });
  await NodeFSP.mkdir(outDir, { recursive: true });
  const bin = NodePath.join(ROOT, "node_modules", ".bin");
  const basePath = `${bin}${NodePath.delimiter}${process.env.PATH}`;
  if (!options.skipBundle)
    run("vp", ["run", "--filter", "t3", "build"], {
      cwd: ROOT,
      env: { ...process.env, PATH: basePath },
    });
  const node = seaNode();
  const docker = dockerEnv();
  ensureAmd64(docker);
  const entries = [];
  for (const target of TARGETS) {
    run(node, ["apps/server/scripts/cli.ts", "build-exe", "--target", target.key], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${NodePath.dirname(node)}${NodePath.delimiter}${basePath}`,
        VP_NODE_VERSION: SEA_NODE_VERSION,
        // Bakes the OOP identity into the executable (apps/server/src/oopBuild.ts).
        T3CODE_OOP_RELEASE: version,
      },
    });
    const resourceMonitorDir = buildResourceMonitor(target, docker);
    run(
      process.execPath,
      [
        "scripts/build-cli-archive.ts",
        "--platform",
        target.platform,
        "--arch",
        target.arch,
        "--version",
        version,
        "--resource-monitor-dir",
        resourceMonitorDir,
        "--output-dir",
        outDir,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, PATH: `${GNU_TAR_DIR}${NodePath.delimiter}${basePath}` },
      },
    );
    const name = `t3-${version}-${target.key}.tar.gz`;
    if (!options.skipSmoke) await smokeTest(target, outDir, name, docker);
    const bytes = await NodeFSP.readFile(NodePath.join(outDir, name));
    entries.push({ name, sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex") });
  }
  await NodeFSP.writeFile(NodePath.join(outDir, "SHA256SUMS"), checksumListing(entries));
  console.log(`Wrote ${entries.length} server archives and SHA256SUMS to ${outDir}`);
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`[build-oop-cli-archives] ${error.message}`);
    process.exitCode = 1;
  });
}
