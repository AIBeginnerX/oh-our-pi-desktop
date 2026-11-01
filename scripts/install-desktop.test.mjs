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
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

async function fixture(
  t,
  { platform = "Linux", checksum = "valid", missing = false, terminal = false } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oop-desktop-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "tools");
  const home = path.join(root, "home with spaces");
  await fs.mkdir(bin);
  await fs.mkdir(home);
  // Platform detection is the only host seam; downloads and installation run for real.
  await fs.writeFile(
    path.join(bin, "uname"),
    `#!/bin/sh\ncase "$1" in -s) echo ${platform};; -m) echo ${platform === "Darwin" ? "arm64" : "x86_64"};; esac\n`,
    { mode: 0o755 },
  );
  let bytes = Buffer.from(
    '#!/bin/sh\nprintf "fixture-appimage:%s:%s\\n" "$APPIMAGE_EXTRACT_AND_RUN" "$*"\n',
  );
  const extension = platform === "Darwin" ? "dmg" : "AppImage";
  if (platform === "Darwin") {
    const source = path.join(root, "image");
    await fs.mkdir(path.join(source, "OOP.app", "Contents"), { recursive: true });
    await fs.writeFile(path.join(source, "OOP.app", "Contents", "fixture"), "new app");
    if (terminal) {
      // Stands in for the app's Electron executable: shows what the launcher passed to it.
      const executable = path.join(source, "OOP.app", "Contents", "MacOS", "OOP");
      await fs.mkdir(path.dirname(executable), { recursive: true });
      await fs.writeFile(
        executable,
        '#!/bin/sh\nprintf "run-as-node=%s\\n" "${ELECTRON_RUN_AS_NODE-unset}"\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\n',
        { mode: 0o755 },
      );
      const bundle = path.join(source, "OOP.app", "Contents", "Resources", "oop", "oop.mjs");
      await fs.mkdir(path.dirname(bundle), { recursive: true });
      await fs.writeFile(bundle, "// fixture terminal app\n");
    }
    const image = path.join(root, "fixture.dmg");
    const created = await run("hdiutil", [
      "create",
      "-srcfolder",
      source,
      "-volname",
      "OOP fixture",
      "-format",
      "UDZO",
      image,
    ]);
    assert.equal(created.code, 0, created.output);
    bytes = await fs.readFile(image);
  }
  const requested = [];
  const installerScript = await fs.readFile(path.join(scripts, "install-desktop.sh"));
  const server = createServer((request, response) => {
    requested.push(request.url);
    if (request.url === "/install-desktop.sh") {
      return response.end(installerScript);
    }
    if (request.url.endsWith(".sha256")) {
      if (checksum === "missing") return response.writeHead(404).end();
      const digest =
        checksum === "valid" ? createHash("sha256").update(bytes).digest("hex") : "0".repeat(64);
      return response.end(`${digest}  download.${extension}\n`);
    }
    if (missing) return response.writeHead(404).end();
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
  return {
    root,
    home,
    requested,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      OOP_VERSION: "1.2.3",
      OOP_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
      OOP_SCRIPT_URL: `http://127.0.0.1:${address.port}/install-desktop.sh`,
      OOP_INSTALL_DIR: path.join(home, "install"),
    },
  };
}

test(
  "Linux one-line installer installs an executable launcher with arguments in a spaced path",
  { timeout: 30_000 },
  async (t) => {
    const setup = await fixture(t);
    const result = await run("sh", ["-c", 'curl -fsSL "$OOP_SCRIPT_URL" | sh'], setup.env);
    assert.equal(result.code, 0, result.output);
    const launch = await run(path.join(setup.env.OOP_INSTALL_DIR, "bin", "oop-desktop"), [
      "one",
      "two words",
    ]);
    assert.equal(launch.code, 0, launch.output);
    assert.match(launch.output, /fixture-appimage:1:one two words/);
    assert.deepEqual(setup.requested, [
      "/install-desktop.sh",
      "/v1.2.3/OOP-1.2.3-x86_64.AppImage",
      "/v1.2.3/OOP-1.2.3-x86_64.AppImage.sha256",
    ]);
    const entry = await fs.readFile(
      path.join(setup.env.OOP_INSTALL_DIR, "share", "applications", "oop-desktop.desktop"),
      "utf8",
    );
    assert.ok(entry.includes(`Exec="${setup.env.OOP_INSTALL_DIR}/bin/oop-desktop" %U`));
  },
);

for (const scenario of [{ checksum: "bad" }, { checksum: "missing" }, { missing: true }]) {
  test(
    `failed download or verification preserves the installed app: ${JSON.stringify(scenario)}`,
    { timeout: 30_000 },
    async (t) => {
      const setup = await fixture(t, scenario);
      const previous = path.join(setup.env.OOP_INSTALL_DIR, "share", "oop-desktop", "OOP.AppImage");
      await fs.mkdir(path.dirname(previous), { recursive: true });
      await fs.writeFile(previous, "previous app");
      const result = await run("sh", [path.join(scripts, "install-desktop.sh")], setup.env);
      assert.notEqual(result.code, 0);
      assert.equal(await fs.readFile(previous, "utf8"), "previous app");
    },
  );
}

test("invalid version fails before any HTTP request", async (t) => {
  const setup = await fixture(t);
  const result = await run("sh", [path.join(scripts, "install-desktop.sh")], {
    ...setup.env,
    OOP_VERSION: "../not-a-version",
  });
  assert.notEqual(result.code, 0);
  assert.deepEqual(setup.requested, []);
});

test(
  "macOS installer mounts a real DMG and replaces the bundle without stale files",
  { skip: process.platform !== "darwin", timeout: 60_000 },
  async (t) => {
    const setup = await fixture(t, { platform: "Darwin" });
    const previous = path.join(setup.env.OOP_INSTALL_DIR, "OOP.app", "Contents");
    await fs.mkdir(previous, { recursive: true });
    await fs.writeFile(path.join(previous, "stale"), "old app");
    const result = await run("sh", [path.join(scripts, "install-desktop.sh")], setup.env);
    assert.equal(result.code, 0, result.output);
    assert.equal(await fs.readFile(path.join(previous, "fixture"), "utf8"), "new app");
    await assert.rejects(fs.stat(path.join(previous, "stale")), { code: "ENOENT" });
  },
);

const ownedTerminalFiles = [
  ["a launcher from an earlier install", "#!/bin/sh\n# oop-desktop-terminal-launcher (old)\nexit 1\n"],
  ["the repository's own terminal install", '#!/usr/bin/env node\nconst dir = ".config/oop-tui";\n'],
];

test(
  "macOS installer adds an oop command that runs the app's runtime on the bundled terminal app",
  { skip: process.platform !== "darwin", timeout: 60_000 },
  async (t) => {
    const setup = await fixture(t, { platform: "Darwin", terminal: true });
    const result = await run("sh", [path.join(scripts, "install-desktop.sh")], setup.env);
    assert.equal(result.code, 0, result.output);
    const command = path.join(setup.home, ".local", "bin", "oop");
    assert.match(result.output, /Installed the terminal command/);
    assert.match(result.output, /not on PATH/);
    assert.equal((await fs.stat(command)).mode & 0o777, 0o755);
    // The launcher keeps each argument whole, and the variable reaches only the app's process.
    const { ELECTRON_RUN_AS_NODE: _inherited, ...clean } = process.env;
    const launch = await run(command, ["--version", "two words", "it's", "$HOME", "*"], clean);
    assert.equal(launch.code, 0, launch.output);
    const app = path.join(setup.env.OOP_INSTALL_DIR, "OOP.app", "Contents");
    assert.equal(
      launch.output,
      [
        "run-as-node=1",
        `[${path.join(app, "Resources", "oop", "oop.mjs")}]`,
        "[--version]",
        "[two words]",
        "[it's]",
        "[$HOME]",
        "[*]",
        "",
      ].join("\n"),
    );
    const after = await run(
      "sh",
      ["-c", '"$0" --version > /dev/null; echo "after=${ELECTRON_RUN_AS_NODE-unset}"', command],
      clean,
    );
    assert.equal(after.output, "after=unset\n");
    // Reinstalling replaces our own launcher in place.
    const again = await run("sh", [path.join(scripts, "install-desktop.sh")], setup.env);
    assert.equal(again.code, 0, again.output);
    assert.match(again.output, /Installed the terminal command/);
  },
);

test(
  "macOS installer finds the app again after OOP.app moves, and says so when it is gone",
  { skip: process.platform !== "darwin", timeout: 60_000 },
  async (t) => {
    const setup = await fixture(t, { platform: "Darwin", terminal: true });
    const result = await run("sh", [path.join(scripts, "install-desktop.sh")], setup.env);
    assert.equal(result.code, 0, result.output);
    const command = path.join(setup.home, ".local", "bin", "oop");
    await fs.rm(path.join(setup.env.OOP_INSTALL_DIR, "OOP.app"), { recursive: true });
    const gone = await run(command, ["--version"], { ...process.env, HOME: setup.home });
    assert.equal(gone.code, 127);
    assert.match(gone.output, /OOP\.app was not found/);
    const moved = path.join(setup.home, "Applications");
    await fs.mkdir(moved, { recursive: true });
    await fs.cp(path.join(setup.root, "image", "OOP.app"), path.join(moved, "OOP.app"), {
      recursive: true,
    });
    const found = await run(command, ["--version"], { ...process.env, HOME: setup.home });
    assert.equal(found.code, 0, found.output);
    assert.match(found.output, /\[--version\]/);
  },
);

for (const [name, content] of ownedTerminalFiles) {
  test(
    `macOS installer replaces an existing oop that is ours: ${name}`,
    { skip: process.platform !== "darwin", timeout: 60_000 },
    async (t) => {
      const setup = await fixture(t, { platform: "Darwin", terminal: true });
      const command = path.join(setup.home, ".local", "bin", "oop");
      await fs.mkdir(path.dirname(command), { recursive: true });
      await fs.writeFile(command, content, { mode: 0o755 });
      const result = await run("sh", [path.join(scripts, "install-desktop.sh")], setup.env);
      assert.equal(result.code, 0, result.output);
      assert.match(await fs.readFile(command, "utf8"), /^# oop-desktop-terminal-launcher/m);
    },
  );
}

test(
  "macOS installer leaves an oop that is not ours alone and still installs the app",
  { skip: process.platform !== "darwin", timeout: 60_000 },
  async (t) => {
    const setup = await fixture(t, { platform: "Darwin", terminal: true });
    const bin = path.join(setup.home, ".local", "bin");
    await fs.mkdir(bin, { recursive: true });
    const foreign = path.join(bin, "oop");
    await fs.writeFile(foreign, "#!/bin/sh\necho someone else's oop\n", { mode: 0o755 });
    const result = await run("sh", [path.join(scripts, "install-desktop.sh")], setup.env);
    assert.equal(result.code, 0, result.output);
    assert.equal(await fs.readFile(foreign, "utf8"), "#!/bin/sh\necho someone else's oop\n");
    assert.match(result.output, /already exists and was not made by OOP/);
    assert.equal(
      await fs.readFile(path.join(setup.env.OOP_INSTALL_DIR, "OOP.app", "Contents", "fixture"), "utf8"),
      "new app",
    );
    // A symlink is never ours, whatever it points at.
    await fs.rm(foreign);
    const elsewhere = path.join(setup.root, "elsewhere");
    await fs.writeFile(elsewhere, "# oop-desktop-terminal-launcher\n");
    await fs.symlink(elsewhere, foreign);
    const linked = await run("sh", [path.join(scripts, "install-desktop.sh")], setup.env);
    assert.equal(linked.code, 0, linked.output);
    assert.equal(await fs.readlink(foreign), elsewhere);
    assert.match(linked.output, /already exists and was not made by OOP/);
  },
);

test(
  "macOS installer replaces the oop that install-terminal.sh wrote",
  { skip: process.platform !== "darwin", timeout: 60_000 },
  async (t) => {
    const setup = await fixture(t, { platform: "Darwin", terminal: true });
    const bin = path.join(setup.home, ".local", "bin");
    await fs.mkdir(bin, { recursive: true });
    const command = path.join(bin, "oop");
    await fs.writeFile(command, "#!/bin/sh\n# oop-terminal-launcher (written by install-terminal.sh; safe to delete)\n", { mode: 0o755 });
    const result = await run("sh", [path.join(scripts, "install-desktop.sh")], setup.env);
    assert.equal(result.code, 0, result.output);
    assert.match(await fs.readFile(command, "utf8"), /^# oop-desktop-terminal-launcher/m);
  },
);

test(
  "macOS installer makes no oop command for an app without the terminal app",
  { skip: process.platform !== "darwin", timeout: 60_000 },
  async (t) => {
    const setup = await fixture(t, { platform: "Darwin" });
    const result = await run("sh", [path.join(scripts, "install-desktop.sh")], setup.env);
    assert.equal(result.code, 0, result.output);
    await assert.rejects(fs.stat(path.join(setup.home, ".local", "bin", "oop")), { code: "ENOENT" });
    assert.doesNotMatch(result.output, /terminal command/);
  },
);

test("Linux installer adds no oop command", async (t) => {
  const setup = await fixture(t);
  const result = await run("sh", [path.join(scripts, "install-desktop.sh")], setup.env);
  assert.equal(result.code, 0, result.output);
  await assert.rejects(fs.stat(path.join(setup.home, ".local", "bin", "oop")), { code: "ENOENT" });
});

for (const approved of [true, false]) {
  test(
    `macOS installer routes a location the user cannot change through the approval dialog: ${approved ? "approved" : "declined"}`,
    { skip: process.platform !== "darwin", timeout: 60_000 },
    async (t) => {
      const setup = await fixture(t, { platform: "Darwin" });
      const dir = setup.env.OOP_INSTALL_DIR;
      const previous = path.join(dir, "OOP.app", "Contents");
      await fs.mkdir(previous, { recursive: true });
      await fs.writeFile(path.join(previous, "stale"), "old app");
      // Stands in for the macOS authorization dialog; approval grants the access an
      // administrator would have, refusal changes nothing.
      const calls = path.join(setup.root, "osascript-calls");
      await fs.writeFile(
        path.join(setup.root, "tools", "osascript"),
        approved
          ? `#!/bin/sh\nprintf '%s\\n' "$@" > "${calls}"\nshift 6\nchmod u+w "$3" "$3/OOP.app"\nexec /bin/sh "$@"\n`
          : `#!/bin/sh\nprintf '%s\\n' "$@" > "${calls}"\necho "User canceled." >&2\nexit 1\n`,
        { mode: 0o755 },
      );
      await fs.chmod(path.join(dir, "OOP.app"), 0o555);
      await fs.chmod(dir, 0o555);
      let result;
      try {
        result = await run("sh", [path.join(scripts, "install-desktop.sh")], setup.env);
      } finally {
        await fs.chmod(dir, 0o755);
        await fs.chmod(path.join(dir, "OOP.app"), 0o755);
      }
      const invocation = (await fs.readFile(calls, "utf8")).trim().split("\n");
      assert.match(invocation[3] ?? "", /with administrator privileges/);
      assert.deepEqual(invocation.slice(-2), [invocation.at(-2), dir]);
      assert.match(result.output, /macOS will ask for approval/);
      if (approved) {
        assert.equal(result.code, 0, result.output);
        assert.equal(await fs.readFile(path.join(previous, "fixture"), "utf8"), "new app");
        await assert.rejects(fs.stat(path.join(previous, "stale")), { code: "ENOENT" });
      } else {
        assert.notEqual(result.code, 0);
        assert.match(result.output, /existing app was not changed/);
        assert.equal(await fs.readFile(path.join(previous, "stale"), "utf8"), "old app");
      }
      assert.deepEqual(
        (await fs.readdir(dir)).filter((name) => name.startsWith(".oop-install")),
        [],
      );
    },
  );
}

test("release preparation emits verified hashes for all three installers", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oop-install-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = ["OOP-1.2.3-arm64.dmg", "OOP-1.2.3-x64.exe", "OOP-1.2.3-x86_64.AppImage"];
  for (const name of names) await fs.writeFile(path.join(root, name), `fixture-${name}`);
  const out = path.join(root, "out");
  const result = await run(process.execPath, [
    path.join(scripts, "prepare-desktop-install-assets.mjs"),
    "--version",
    "1.2.3",
    "--mac",
    path.join(root, names[0]),
    "--windows",
    path.join(root, names[1]),
    "--linux",
    path.join(root, names[2]),
    "--out",
    out,
  ]);
  assert.equal(result.code, 0, result.output);
  for (const name of names) {
    const bytes = await fs.readFile(path.join(out, name));
    assert.equal(
      await fs.readFile(path.join(out, `${name}.sha256`), "utf8"),
      `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`,
    );
  }
});

test("release preparation copies the in-app update feeds for its own version only", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oop-install-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = ["OOP-1.2.3-arm64.dmg", "OOP-1.2.3-x64.exe", "OOP-1.2.3-x86_64.AppImage"];
  for (const name of names) await fs.writeFile(path.join(root, name), `fixture-${name}`);
  const feeds = ["oop-update-macos.json", "oop-update-windows.json"];
  await fs.writeFile(path.join(root, feeds[0]), JSON.stringify({ version: "1.2.3", pkg: names[0] }));
  await fs.writeFile(path.join(root, feeds[1]), JSON.stringify({ version: "1.2.3", pkg: names[1] }));
  const prepare = (out, extra) =>
    run(process.execPath, [
      path.join(scripts, "prepare-desktop-install-assets.mjs"),
      "--version", "1.2.3",
      "--mac", path.join(root, names[0]),
      "--windows", path.join(root, names[1]),
      "--linux", path.join(root, names[2]),
      ...extra.flatMap((file) => ["--update-feed", path.join(root, file)]),
      "--out", path.join(root, out),
    ]);
  const ok = await prepare("out", feeds);
  assert.equal(ok.code, 0, ok.output);
  for (const name of feeds) {
    assert.equal(
      await fs.readFile(path.join(root, "out", name), "utf8"),
      await fs.readFile(path.join(root, name), "utf8"),
    );
  }
  await fs.writeFile(
    path.join(root, "oop-update-windows.json"),
    JSON.stringify({ version: "1.2.2", pkg: "OOP-1.2.2-x64.exe" }),
  );
  const stale = await prepare("stale", ["oop-update-windows.json"]);
  assert.notEqual(stale.code, 0);
  await assert.rejects(fs.stat(path.join(root, "stale")));
});

test("release preparation refuses a missing platform before producing output", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oop-install-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const out = path.join(root, "out");
  const result = await run(process.execPath, [
    path.join(scripts, "prepare-desktop-install-assets.mjs"),
    "--version",
    "1.2.3",
    "--mac",
    path.join(root, "missing.dmg"),
    "--out",
    out,
  ]);
  assert.notEqual(result.code, 0);
  await assert.rejects(fs.stat(out), { code: "ENOENT" });
});
