import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const run = (command, args, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });

// The archive is built for real with tar. Its "node" is a script standing in for the runtime and
// its "oop-rs" one for the Rust client: "works" prints the version for `--version` (what the
// installer runs once) and otherwise shows how the launcher started it. The real node, oop-rs and
// server are the release job's business.
async function makeArchive(root, { version, rust = "works", doctorExit = 0 }) {
  const stage = path.join(root, "archive-stage", "oop-terminal");
  await fs.rm(path.join(root, "archive-stage"), { recursive: true, force: true });
  await fs.mkdir(path.join(stage, "apps", "server", "dist"), { recursive: true });
  await fs.writeFile(path.join(stage, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (rust !== "none") {
    const body = {
      works: `case "$1" in --version) echo ${version}; exit 0;; esac\nprintf 'rust daemon=%s install=%s ts=%s tui=%s path0=%s\\n' "$OOP_DAEMON_ENTRY" "$OOP_TERMINAL_INSTALL" "\${OOP_TS_ENTRY-unset}" "\${OOP_TUI-unset}" "\${PATH%%:*}"\nfor a in "$@"; do printf '[%s]\\n' "$a"; done\n`,
      // Like "works", but appends the arguments of every run other than the installer's own
      // --version probe to $HOME/doctor-args.txt, and answers "doctor" with $doctorExit.
      recording: `case "$1" in --version) echo ${version}; exit 0;; esac\nfor a in "$@"; do printf '%s\\n' "$a" >> "$HOME/doctor-args.txt"; done\nif [ "$1" = doctor ]; then echo 'doctor: claude code ready, codex is missing'; exit ${doctorExit}; fi\nexit 0\n`,
      broken: "echo 'dyld: Library not loaded' >&2\nexit 3\n",
      "wrong-version": "echo 9.9.9\n",
    }[rust];
    await fs.writeFile(path.join(stage, "oop-rs"), `#!/bin/sh\n${body}`, { mode: 0o644 });
  }
  await fs.writeFile(path.join(stage, "apps", "server", "dist", "bin.mjs"), "// fixture server\n");
  await fs.writeFile(path.join(stage, "new-in-this-version.txt"), version);
  const archive = path.join(root, "fixture.tar.gz");
  const created = await run("tar", ["-czf", archive, "-C", path.join(root, "archive-stage"), "oop-terminal"]);
  assert.equal(created.code, 0, created.output);
  return fs.readFile(archive);
}

async function fixture(
  t,
  { system = "Linux", machine = "x86_64", musl = false, checksum = "valid", archive = {} } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oop-terminal-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = path.join(root, "tools");
  const home = path.join(root, "home with spaces");
  await fs.mkdir(tools);
  await fs.mkdir(home);
  // Platform detection is the only host seam; downloads, unpacking and installation run for real.
  await fs.writeFile(
    path.join(tools, "uname"),
    `#!/bin/sh\ncase "$1" in -s) echo ${system};; -m) echo ${machine};; esac\n`,
    { mode: 0o755 },
  );
  if (musl) {
    await fs.writeFile(path.join(tools, "ldd"), "#!/bin/sh\necho 'musl libc (x86_64)' >&2\nexit 1\n", {
      mode: 0o755,
    });
  }
  let bytes = await makeArchive(root, { version: "1.2.3", ...archive });
  const state = {
    requested: [],
    setBytes: (next) => {
      bytes = next;
    },
  };
  const installerScript = await fs.readFile(path.join(scripts, "install-terminal.sh"));
  const server = createServer((request, response) => {
    state.requested.push(request.url);
    if (request.url === "/install-terminal.sh") return response.end(installerScript);
    if (request.url.endsWith(".sha256")) {
      if (checksum === "missing") return response.writeHead(404).end();
      const digest =
        checksum === "valid" ? createHash("sha256").update(bytes).digest("hex") : "0".repeat(64);
      return response.end(`${digest}  download.tar.gz\n`);
    }
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${tools}${path.delimiter}${process.env.PATH}`,
    OOP_VERSION: "1.2.3",
    OOP_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
    OOP_SCRIPT_URL: `http://127.0.0.1:${address.port}/install-terminal.sh`,
    OOP_INSTALL_DIR: path.join(home, "install dir"),
    OOP_BIN_DIR: path.join(home, "bin dir"),
    // The setup check runs the just-installed command; tests that are not about it turn it off.
    OOP_INSTALL_SKIP_DOCTOR: "1",
  };
  delete env.OOP_DAEMON_ENTRY;
  return {
    root,
    home,
    env,
    state,
    installDir: env.OOP_INSTALL_DIR,
    binDir: env.OOP_BIN_DIR,
    install: (over = {}) => run("sh", [path.join(scripts, "install-terminal.sh")], { ...env, ...over }),
  };
}

const exists = (file) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  );

test(
  "one-line install on Linux x64 unpacks the terminal app and a launcher that sets the server entry",
  { timeout: 60_000 },
  async (t) => {
    const setup = await fixture(t);
    const result = await run("sh", ["-c", 'curl -fsSL "$OOP_SCRIPT_URL" | sh'], setup.env);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(setup.state.requested, [
      "/install-terminal.sh",
      "/v1.2.3/OOP-terminal-1.2.3-linux-x64.tar.gz",
      "/v1.2.3/OOP-terminal-1.2.3-linux-x64.tar.gz.sha256",
    ]);
    assert.match(result.output, /is not on PATH yet/);
    assert.match(result.output, /Sign in to a provider CLI/);
    assert.match(result.output, /Uninstall: oop stop; rm -rf /);
    const launch = await run(path.join(setup.binDir, "oop"), ["--continue", "two words"], setup.env);
    assert.equal(launch.code, 0, launch.output);
    assert.match(launch.output, new RegExp(`daemon=${setup.installDir}/apps/server/dist/bin.mjs`.replaceAll(".", "\\.")));
    assert.match(launch.output, /\[--continue\]\n\[two words\]/);
    assert.match(launch.output, /install=1 ts=unset tui=unset path0=.*install dir\n/);
    assert.equal(await fs.readFile(path.join(setup.installDir, ".oop-terminal-install"), "utf8"), "1.2.3\n");
    // The user's own OOP_DAEMON_ENTRY (a test server) wins over the bundled one.
    const named = await run(path.join(setup.binDir, "oop"), ["x"], { ...setup.env, OOP_DAEMON_ENTRY: "/mine/bin.mjs" });
    assert.match(named.output, /daemon=\/mine\/bin\.mjs/);
    // Nothing is left beside the install folder, and no shell profile was touched.
    const leftovers = (await fs.readdir(path.dirname(setup.installDir))).filter((name) => name.startsWith(".oop-terminal-new"));
    assert.deepEqual(leftovers, []);
    assert.equal(await exists(path.join(setup.home, ".zshrc")), false);
    assert.equal(await exists(path.join(setup.home, ".bashrc")), false);
  },
);

test("reinstalling replaces the whole folder and the launcher", { timeout: 60_000 }, async (t) => {
  const setup = await fixture(t);
  assert.equal((await setup.install()).code, 0);
  await fs.writeFile(path.join(setup.installDir, "stale-from-old-version.txt"), "old");
  setup.state.setBytes(await makeArchive(setup.root, { version: "1.2.3" }));
  const again = await setup.install();
  assert.equal(again.code, 0, again.output);
  assert.equal(await exists(path.join(setup.installDir, "stale-from-old-version.txt")), false);
  assert.equal(await exists(path.join(setup.installDir, "new-in-this-version.txt")), true);
  const siblings = await fs.readdir(path.dirname(setup.installDir));
  assert.deepEqual(siblings.filter((name) => name.startsWith(".oop-terminal-new")), []);
});

test("macOS Apple Silicon and Linux arm64 pick their own assets; PATH is not mentioned when oop is on it", { timeout: 60_000 }, async (t) => {
  const mac = await fixture(t, { system: "Darwin", machine: "arm64" });
  const macResult = await mac.install({ PATH: `${mac.binDir}${path.delimiter}${mac.env.PATH}` });
  assert.equal(macResult.code, 0, macResult.output);
  assert.ok(mac.state.requested.includes("/v1.2.3/OOP-terminal-1.2.3-macos-arm64.tar.gz"));
  assert.doesNotMatch(macResult.output, /not on PATH/);
  const arm = await fixture(t, { machine: "aarch64" });
  assert.equal((await arm.install()).code, 0);
  assert.ok(arm.state.requested.includes("/v1.2.3/OOP-terminal-1.2.3-linux-arm64.tar.gz"));
});

for (const [name, options, message] of [
  ["Intel Mac", { system: "Darwin", machine: "x86_64" }, /Intel Macs are not supported/],
  ["32-bit ARM Linux", { machine: "armv7l" }, /Unsupported CPU architecture: armv7l/],
  ["Alpine (musl) Linux", { musl: true }, /musl/],
  ["FreeBSD", { system: "FreeBSD" }, /Use install-terminal\.ps1 on Windows/],
]) {
  test(`${name} stops with a clear message before downloading`, { timeout: 30_000 }, async (t) => {
    const setup = await fixture(t, options);
    const result = await setup.install();
    assert.notEqual(result.code, 0);
    assert.match(result.output, message);
    assert.deepEqual(setup.state.requested, []);
    assert.equal(await exists(setup.installDir), false);
    assert.equal(await exists(path.join(setup.binDir, "oop")), false);
  });
}

test("a checksum mismatch or missing checksum installs nothing", { timeout: 30_000 }, async (t) => {
  for (const checksum of ["wrong", "missing"]) {
    const setup = await fixture(t, { checksum });
    const result = await setup.install();
    assert.notEqual(result.code, 0);
    assert.match(result.output, checksum === "wrong" ? /SHA-256 mismatch; nothing was installed/ : /no checksum/);
    assert.equal(await exists(setup.installDir), false);
    assert.equal(await exists(path.join(setup.binDir, "oop")), false);
  }
});

test("an oop that is not ours is never overwritten and nothing is downloaded", { timeout: 30_000 }, async (t) => {
  const setup = await fixture(t);
  await fs.mkdir(setup.binDir, { recursive: true });
  const foreign = path.join(setup.binDir, "oop");
  await fs.writeFile(foreign, "#!/bin/sh\necho mine\n", { mode: 0o755 });
  const result = await setup.install();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /was not made by OOP, so nothing was installed/);
  assert.equal(await fs.readFile(foreign, "utf8"), "#!/bin/sh\necho mine\n");
  assert.deepEqual(setup.state.requested, []);
  // A symlink is never ours either, even to one of our launchers.
  await fs.rm(foreign);
  await fs.symlink("/bin/echo", foreign);
  const linked = await setup.install();
  assert.notEqual(linked.code, 0);
  assert.equal(await fs.readlink(foreign), "/bin/echo");
});

test("a launcher from the desktop installer is replaced; an unrelated folder is not", { timeout: 60_000 }, async (t) => {
  const setup = await fixture(t);
  await fs.mkdir(setup.binDir, { recursive: true });
  await fs.writeFile(
    path.join(setup.binDir, "oop"),
    "#!/bin/sh\n# oop-desktop-terminal-launcher (written by OOP Desktop install-desktop.sh; safe to delete)\n",
    { mode: 0o755 },
  );
  assert.equal((await setup.install()).code, 0);
  assert.match(await fs.readFile(path.join(setup.binDir, "oop"), "utf8"), /^# oop-terminal-launcher/m);

  const other = await fixture(t);
  await fs.mkdir(other.installDir, { recursive: true });
  await fs.writeFile(path.join(other.installDir, "precious.txt"), "keep");
  const refused = await other.install();
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, /not empty and was not made by this installer/);
  assert.equal(await fs.readFile(path.join(other.installDir, "precious.txt"), "utf8"), "keep");
  assert.deepEqual(other.state.requested, []);
});

test("an app that does not run, is incomplete or reports another version changes nothing", { timeout: 60_000 }, async (t) => {
  const setup = await fixture(t);
  assert.equal((await setup.install()).code, 0);
  const before = await fs.readFile(path.join(setup.binDir, "oop"), "utf8");
  for (const [archive, message] of [
    [{ version: "1.2.3", rust: "broken" }, /does not run on this computer .*dyld: Library not loaded/s],
    [{ version: "1.2.3", rust: "none" }, /not a complete terminal app/],
    [{ version: "9.9.9" }, /reports "9\.9\.9", not 1\.2\.3/],
    [{ version: "1.2.3", rust: "wrong-version" }, /reports "9\.9\.9", not 1\.2\.3/],
  ]) {
    setup.state.setBytes(await makeArchive(setup.root, archive));
    const result = await setup.install();
    assert.notEqual(result.code, 0);
    assert.match(result.output, message);
    // The previous install still works and no staging folder is left.
    assert.equal(await fs.readFile(path.join(setup.binDir, "oop"), "utf8"), before);
    const started = await run(path.join(setup.binDir, "oop"), ["--version"], setup.env);
    assert.equal(started.output.trim(), "1.2.3");
    assert.deepEqual((await fs.readdir(path.dirname(setup.installDir))).filter((name) => name.startsWith(".oop-terminal-new")), []);
  }
});

test("the launcher says so when the terminal app folder is gone", { timeout: 60_000 }, async (t) => {
  const setup = await fixture(t);
  assert.equal((await setup.install()).code, 0);
  await fs.rm(setup.installDir, { recursive: true });
  const result = await run(path.join(setup.binDir, "oop"), [], setup.env);
  assert.equal(result.code, 127);
  assert.match(result.output, /terminal app was not found/);
});

test("the launcher runs the Rust client alone, whatever the old escape hatches say", { timeout: 60_000 }, async (t) => {
  const setup = await fixture(t);
  const result = await setup.install();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\(Rust client\)/);
  const text = await fs.readFile(path.join(setup.binDir, "oop"), "utf8");
  assert.doesNotMatch(text, /OOP_TS_|OOP_TUI|oop\.mjs|exec "\\$root\/node"/);
  // A stale OOP_TUI=ts or OOP_TS_ENTRY from the environment changes nothing: there is nothing else to run.
  const rust = await run(path.join(setup.binDir, "oop"), ["--continue", "two words"], {
    ...setup.env,
    OOP_TUI: "ts",
  });
  assert.equal(rust.code, 0, rust.output);
  assert.ok(rust.output.includes(`daemon=${setup.installDir}/apps/server/dist/bin.mjs `), rust.output);
  // The bundled Node.js comes first on PATH, because the Rust client starts the server with "node".
  assert.ok(rust.output.includes(`path0=${setup.installDir}\n`), rust.output);
  assert.ok(rust.output.includes("[--continue]\n[two words]\n"), rust.output);
});

test("an archive without a working Rust client is refused, never installed as TypeScript only", { timeout: 60_000 }, async (t) => {
  for (const rust of ["broken", "wrong-version", "none"]) {
    const setup = await fixture(t, { archive: { rust } });
    const result = await setup.install();
    assert.notEqual(result.code, 0, result.output);
    assert.equal(await exists(setup.installDir), false);
    assert.equal(await exists(path.join(setup.binDir, "oop")), false);
  }
});

test("the setup check runs the installed doctor once and a failing doctor does not fail the install", { timeout: 60_000 }, async (t) => {
  const argsFile = (setup) => path.join(setup.home, "doctor-args.txt");
  // doctorExit 1: a provider that is missing must not turn a good install into an error.
  const setup = await fixture(t, { archive: { rust: "recording", doctorExit: 1 } });
  const result = await setup.install({ OOP_INSTALL_SKIP_DOCTOR: "" });
  assert.equal(result.code, 0, result.output);
  assert.equal(await fs.readFile(argsFile(setup), "utf8"), "doctor\n");
  assert.match(result.output, /Checking your setup \(oop doctor\):/);
  assert.match(result.output, /codex is missing/);
  assert.match(result.output, /After signing in, run: oop doctor/);
  assert.equal(await exists(path.join(setup.installDir, "oop-rs")), true);

  // The switch tests and CI use leaves the command alone.
  const skipped = await fixture(t, { archive: { rust: "recording" } });
  const skippedResult = await skipped.install();
  assert.equal(skippedResult.code, 0, skippedResult.output);
  assert.equal(await exists(argsFile(skipped)), false);
  assert.doesNotMatch(skippedResult.output, /Checking your setup/);
});
