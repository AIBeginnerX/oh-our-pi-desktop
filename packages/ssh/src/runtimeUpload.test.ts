// @effect-diagnostics nodeBuiltinImport:off
// Runs the upload command in a real /bin/sh, synchronously, against a temp HOME.
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  buildRemotePairingScript,
  buildRemoteRuntimeUploadCommand,
  buildRemoteT3RunnerScript,
  remoteCliArchivePlatformKey,
  remoteHomeDirName,
} from "./tunnel.ts";

const VERSION = "0.0.99";

function makeArchive(root: string, t3Script: string): Uint8Array {
  const stem = `t3-${VERSION}-linux-x64`;
  const dir = NodePath.join(root, "src", stem);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "t3"), t3Script, { mode: 0o755 });
  const archivePath = NodePath.join(root, `${stem}.tar.gz`);
  const tar = NodeChildProcess.spawnSync("tar", [
    "-czf",
    archivePath,
    "-C",
    NodePath.join(root, "src"),
    stem,
  ]);
  assert.strictEqual(tar.status, 0, String(tar.stderr));
  return NodeFS.readFileSync(archivePath);
}

function upload(home: string, archive: Uint8Array, sha256: string) {
  const command = buildRemoteRuntimeUploadCommand({
    version: VERSION,
    sha256,
    remoteHomeDirName: ".oop-desktop",
  });
  return NodeChildProcess.spawnSync("/bin/sh", ["-c", command], {
    env: { PATH: process.env.PATH, HOME: home },
    input: archive,
    encoding: "utf8",
  });
}

const sha256Of = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("remote runtime upload", () => {
  it("installs the uploaded archive once and then reports it ready", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upload-"));
    const archive = makeArchive(root, `#!/bin/sh\necho "t3 v${VERSION}"\n`);
    const versions = NodePath.join(root, ".oop-desktop/runtime/versions");

    const first = upload(root, archive, sha256Of(archive));
    assert.strictEqual(first.status, 0, first.stderr);
    assert.strictEqual(first.stdout.trim(), "installed");
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(versions, VERSION, ".install-complete"), "utf8").trim(),
      VERSION,
    );

    const second = upload(root, archive, sha256Of(archive));
    assert.strictEqual(second.status, 0, second.stderr);
    assert.strictEqual(second.stdout.trim(), "ready");
    assert.deepStrictEqual(NodeFS.readdirSync(versions), [VERSION]);
  });

  it("rejects an archive whose checksum does not match and leaves nothing behind", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upload-"));
    const archive = makeArchive(root, `#!/bin/sh\necho "t3 v${VERSION}"\n`);

    const result = upload(root, archive, "0".repeat(64));
    assert.notStrictEqual(result.status, 0);
    assert.include(result.stderr, "Checksum mismatch");
    assert.deepStrictEqual(
      NodeFS.readdirSync(NodePath.join(root, ".oop-desktop/runtime/versions")),
      [],
    );
  });

  it("refuses a binary that does not run here and passes its error on", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upload-"));
    const archive = makeArchive(
      root,
      "#!/bin/sh\necho 'libatomic.so.1: cannot open' >&2\nexit 127\n",
    );

    const result = upload(root, archive, sha256Of(archive));
    assert.notStrictEqual(result.status, 0);
    assert.include(result.stderr, "does not run on this host: libatomic.so.1: cannot open");
    assert.isFalse(
      NodeFS.existsSync(NodePath.join(root, ".oop-desktop/runtime/versions", VERSION)),
    );
  });
});

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("remote runtime installs", () => {
  it("refuses while another live install of the version holds the lock", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upload-"));
    const archive = makeArchive(root, `#!/bin/sh\necho "t3 v${VERSION}"\n`);
    const lock = NodePath.join(root, `.oop-desktop/runtime/versions/.${VERSION}.install.lock`);
    NodeFS.mkdirSync(lock, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(lock, "pid"), `${process.pid}\n`);

    const busy = upload(root, archive, sha256Of(archive));
    assert.notStrictEqual(busy.status, 0);
    assert.include(busy.stderr, "Another install");

    // A lock whose owner is gone is reclaimed.
    NodeFS.writeFileSync(NodePath.join(lock, "pid"), "999999\n");
    const reclaimed = upload(root, archive, sha256Of(archive));
    assert.strictEqual(reclaimed.status, 0, reclaimed.stderr);
    assert.isFalse(NodeFS.existsSync(lock));
  });

  it("never downloads when archive downloads are off and the runtime is missing", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runner-"));
    const script = buildRemoteT3RunnerScript({
      archiveVersion: VERSION,
      remoteHomeDirName: ".oop-desktop",
      archiveDownloads: false,
    });
    // No curl or wget on PATH: a download attempt would fail with a different message.
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-s", "--", "--version"], {
      env: { PATH: "/nonexistent", HOME: home },
      input: script,
      encoding: "utf8",
    });
    assert.notStrictEqual(result.status, 0);
    assert.include(result.stderr, `The server ${VERSION} is not installed`);
    assert.isFalse(NodeFS.existsSync(NodePath.join(home, ".oop-desktop")));
  });

  it("pairing replaces the runner file instead of rewriting it in place", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runner-"));
    const script = buildRemotePairingScript(
      { alias: "h", hostname: "h", username: null, port: null },
      { archiveVersion: VERSION, remoteHomeDirName: ".oop-desktop", archiveDownloads: false },
    );

    const run = () =>
      NodeChildProcess.spawnSync("/bin/sh", ["-s"], {
        env: { PATH: "/nonexistent:/bin:/usr/bin", HOME: home },
        input: script,
        encoding: "utf8",
      });

    const first = run();
    assert.notStrictEqual(first.status, 0);
    assert.include(first.stderr, "is not installed");

    const launchDir = NodePath.join(home, ".oop-desktop", "ssh-launch");
    const stateDirs = NodeFS.readdirSync(launchDir);
    assert.strictEqual(stateDirs.length, 1);
    const stateDir = NodePath.join(launchDir, stateDirs[0]!);
    const runnerPath = NodePath.join(stateDir, "run-t3.sh");
    const firstStat = NodeFS.statSync(runnerPath);

    const second = run();
    assert.notStrictEqual(second.status, 0);
    assert.include(second.stderr, "is not installed");

    const secondStat = NodeFS.statSync(runnerPath);
    assert.notStrictEqual(secondStat.ino, firstStat.ino);
    assert.strictEqual(secondStat.mode & 0o777, 0o700);

    const leftovers = NodeFS.readdirSync(stateDir).filter((name) =>
      name.startsWith("run-t3.pair."),
    );
    assert.deepStrictEqual(leftovers, []);
  });
});

describe("remote runtime naming", () => {
  it("maps uname output to the archive platforms a release builds", () => {
    assert.strictEqual(remoteCliArchivePlatformKey("Linux", "x86_64"), "linux-x64");
    assert.strictEqual(remoteCliArchivePlatformKey("Linux", "aarch64"), "linux-arm64");
    assert.strictEqual(remoteCliArchivePlatformKey("Darwin", "arm64"), "darwin-arm64");
    assert.isNull(remoteCliArchivePlatformKey("Darwin", "x86_64"));
    assert.isNull(remoteCliArchivePlatformKey("FreeBSD", "amd64"));
  });

  it("keeps the remote home a single folder under $HOME", () => {
    assert.strictEqual(remoteHomeDirName(), ".t3");
    assert.strictEqual(remoteHomeDirName({ remoteHomeDirName: ".oop-desktop" }), ".oop-desktop");
    for (const name of ["../x", "a/b", "x y", "$(id)", ".."]) {
      assert.throws(() => remoteHomeDirName({ remoteHomeDirName: name }));
    }
  });
});
