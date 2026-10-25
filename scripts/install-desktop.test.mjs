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

async function fixture(t, { platform = "Linux", checksum = "valid", missing = false } = {}) {
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
