// @effect-diagnostics nodeBuiltinImport:off -- These tests build fake app bundles and launchers in temporary folders.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ensureTerminalApp,
  ensureTerminalCommand,
  installedAppBundle,
  type TerminalIntegrationTools,
} from "./DesktopTerminalIntegration.ts";
import { LAUNCHER_MARK, isOurLauncher, terminalLauncherScript } from "./TerminalLauncher.ts";

const TERMINAL_ID = "com.oop.terminal";

// A fake bundle keeps its identity in Contents/Info.json, so no macOS tool or signature is needed.
const writeBundle = async (bundle: string, info: { id: string; version: string }) => {
  await NodeFSP.mkdir(NodePath.join(bundle, "Contents"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(bundle, "Contents", "Info.json"), JSON.stringify(info));
};

const fakeTools = (): TerminalIntegrationTools & { readonly calls: Array<string> } => {
  const calls: Array<string> = [];
  return {
    calls,
    readBundle: async (bundle) =>
      NodeFSP.readFile(NodePath.join(bundle, "Contents", "Info.json"), "utf8").then(
        (text) => JSON.parse(text) as { id: string; version: string },
        () => undefined,
      ),
    copyBundle: async (source, destination) => {
      calls.push("copy");
      await NodeFSP.cp(source, destination, { recursive: true });
    },
    verifyBundle: async () => {
      calls.push("verify");
    },
    clearQuarantine: async () => {
      calls.push("quarantine");
    },
  };
};

const withTemp = async (body: (root: string) => Promise<void>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-terminal-integration-"));
  try {
    await body(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

// <root>/Applications/OOP.app with the terminal program inside its Resources.
const makeApp = async (root: string, terminalVersion: string | null = "0.0.137") => {
  const applications = NodePath.join(root, "Applications");
  const appBundle = NodePath.join(applications, "OOP.app");
  const resources = NodePath.join(appBundle, "Contents", "Resources");
  await NodeFSP.mkdir(NodePath.join(resources, "oop"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(resources, "oop", "oop-rs"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  if (terminalVersion !== null) {
    await writeBundle(NodePath.join(resources, "oop", "OOP Terminal.app"), {
      id: TERMINAL_ID,
      version: terminalVersion,
    });
  }
  return { applications, appBundle, resources };
};

const readVersion = async (bundle: string) =>
  (
    JSON.parse(await NodeFSP.readFile(NodePath.join(bundle, "Contents", "Info.json"), "utf8")) as {
      version: string;
    }
  ).version;

describe("ensureTerminalApp", () => {
  it("installs OOP Terminal.app beside OOP.app when it is missing", async () => {
    await withTemp(async (root) => {
      const { applications, appBundle, resources } = await makeApp(root);
      const tools = fakeTools();
      assert.equal(
        await ensureTerminalApp({ appBundle, resourcesPath: resources, tools }),
        "installed",
      );
      assert.equal(await readVersion(NodePath.join(applications, "OOP Terminal.app")), "0.0.137");
      assert.deepEqual(tools.calls, ["copy", "verify", "quarantine"]);
      assert.deepEqual(
        (await NodeFSP.readdir(applications)).toSorted(),
        ["OOP Terminal.app", "OOP.app"],
        "no staging folder is left behind",
      );
    });
  });

  it("replaces a copy whose version differs, and leaves a current one untouched", async () => {
    await withTemp(async (root) => {
      const { applications, appBundle, resources } = await makeApp(root);
      const installed = NodePath.join(applications, "OOP Terminal.app");
      await writeBundle(installed, { id: TERMINAL_ID, version: "0.1.0" });
      const tools = fakeTools();
      assert.equal(
        await ensureTerminalApp({ appBundle, resourcesPath: resources, tools }),
        "updated",
      );
      assert.equal(await readVersion(installed), "0.0.137");
      tools.calls.length = 0;
      assert.equal(
        await ensureTerminalApp({ appBundle, resourcesPath: resources, tools }),
        "current",
      );
      assert.deepEqual(tools.calls, []);
      assert.deepEqual((await NodeFSP.readdir(applications)).toSorted(), [
        "OOP Terminal.app",
        "OOP.app",
      ]);
    });
  });

  it("leaves a symlink and an app that is not ours alone", async () => {
    await withTemp(async (root) => {
      const { applications, appBundle, resources } = await makeApp(root);
      const installed = NodePath.join(applications, "OOP Terminal.app");
      const elsewhere = NodePath.join(root, "elsewhere.app");
      await writeBundle(elsewhere, { id: TERMINAL_ID, version: "9.9.9" });
      await NodeFSP.symlink(elsewhere, installed);
      const tools = fakeTools();
      assert.equal(
        await ensureTerminalApp({ appBundle, resourcesPath: resources, tools }),
        "blocked-symlink",
      );
      await NodeFSP.rm(installed);

      await writeBundle(installed, { id: "com.someone.else", version: "1.0.0" });
      assert.equal(
        await ensureTerminalApp({ appBundle, resourcesPath: resources, tools }),
        "blocked-foreign",
      );
      assert.equal(await readVersion(installed), "1.0.0");
      assert.deepEqual(tools.calls, []);
    });
  });

  it("keeps the previous copy when the new one fails its signature check", async () => {
    await withTemp(async (root) => {
      const { applications, appBundle, resources } = await makeApp(root);
      const installed = NodePath.join(applications, "OOP Terminal.app");
      await writeBundle(installed, { id: TERMINAL_ID, version: "0.1.0" });
      const tools = {
        ...fakeTools(),
        verifyBundle: async () => {
          throw new Error("invalid signature");
        },
      };
      assert.equal(
        await ensureTerminalApp({ appBundle, resourcesPath: resources, tools }),
        "failed",
      );
      assert.equal(await readVersion(installed), "0.1.0");
      assert.deepEqual((await NodeFSP.readdir(applications)).toSorted(), [
        "OOP Terminal.app",
        "OOP.app",
      ]);
    });
  });

  it("does nothing for a build without the terminal program, or an unwritable folder", async () => {
    await withTemp(async (root) => {
      const { applications, appBundle, resources } = await makeApp(root, null);
      assert.equal(
        await ensureTerminalApp({ appBundle, resourcesPath: resources, tools: fakeTools() }),
        "no-terminal-app",
      );
      await writeBundle(NodePath.join(resources, "oop", "OOP Terminal.app"), {
        id: TERMINAL_ID,
        version: "0.0.137",
      });
      if (process.getuid?.() !== 0) {
        await NodeFSP.chmod(applications, 0o555);
        try {
          assert.equal(
            await ensureTerminalApp({ appBundle, resourcesPath: resources, tools: fakeTools() }),
            "not-writable",
          );
        } finally {
          await NodeFSP.chmod(applications, 0o755);
        }
      }
    });
  });
});

describe("terminal launcher", () => {
  it("runs only oop-rs, says it runs inside the desktop app, and names the app it runs", () => {
    const script = terminalLauncherScript("/Applications/OOP.app");
    assert.include(script, "for app in '/Applications/OOP.app' ");
    assert.include(script, '[ -x "$app/Contents/MacOS/OOP" ] && [ -x "$res/oop-rs" ]');
    assert.include(script, "OOP_IN_DESKTOP_APP=1");
    assert.include(script, 'exec "$res/oop-rs" "$@"');
    for (const gone of ["OOP_TS_", "OOP_TUI", "ELECTRON_RUN_AS_NODE", "oop.mjs"]) {
      assert.notInclude(script, gone);
    }
    assert.isTrue(isOurLauncher(script));
  });

  it("recognises only launchers that carry our mark", () => {
    assert.isFalse(
      isOurLauncher(
        '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec /Applications/OOP.app/Contents/MacOS/OOP /Applications/OOP.app/Contents/Resources/oop/oop.mjs "$@"\n',
      ),
    );
    assert.isFalse(isOurLauncher(`#!/bin/sh\necho hi\n# ${LAUNCHER_MARK}\n`));
    assert.isFalse(isOurLauncher(`#!/bin/sh\n# ${LAUNCHER_MARK}-fork\n`));
    assert.isFalse(isOurLauncher("#!/usr/bin/env node\n// oop-tui\n"));
    assert.isTrue(isOurLauncher(`#!/bin/sh\n# ${LAUNCHER_MARK}\nexit 0\n`));
  });

  it("accepts only OOP.app in /Applications or ~/Applications", () => {
    assert.equal(installedAppBundle("/Applications/OOP.app", "/Users/a"), "/Applications/OOP.app");
    assert.equal(
      installedAppBundle("/Users/a/Applications/OOP.app", "/Users/a"),
      "/Users/a/Applications/OOP.app",
    );
    assert.isUndefined(installedAppBundle("/tmp/build/OOP.app", "/Users/a"));
    assert.isUndefined(installedAppBundle("/Applications/Other.app", "/Users/a"));
  });
});

describe("ensureTerminalCommand", () => {
  const setup = async (root: string) => {
    const { appBundle } = await makeApp(root);
    const binDirectory = NodePath.join(root, "home", ".local", "bin");
    const markerFile = NodePath.join(root, "state", "terminal-command-installed");
    return { appBundle, binDirectory, markerFile, target: NodePath.join(binDirectory, "oop") };
  };

  it("creates the command once and keeps it current", async () => {
    await withTemp(async (root) => {
      const { appBundle, binDirectory, markerFile, target } = await setup(root);
      assert.equal(await ensureTerminalCommand({ appBundle, binDirectory, markerFile }), "created");
      assert.equal(await NodeFSP.readFile(target, "utf8"), terminalLauncherScript(appBundle));
      assert.equal((await NodeFSP.stat(target)).mode & 0o777, 0o755);
      assert.equal(await ensureTerminalCommand({ appBundle, binDirectory, markerFile }), "current");
      assert.deepEqual(await NodeFSP.readdir(binDirectory), ["oop"]);
    });
  });

  it("does not bring back a launcher the user deleted", async () => {
    await withTemp(async (root) => {
      const { appBundle, binDirectory, markerFile, target } = await setup(root);
      await ensureTerminalCommand({ appBundle, binDirectory, markerFile });
      await NodeFSP.rm(target);
      assert.equal(
        await ensureTerminalCommand({ appBundle, binDirectory, markerFile }),
        "removed-by-user",
      );
      assert.deepEqual(await NodeFSP.readdir(binDirectory), []);
    });
  });

  it("upgrades a launcher written by an older release, which the mark identifies", async () => {
    await withTemp(async (root) => {
      const { appBundle, binDirectory, markerFile, target } = await setup(root);
      await NodeFSP.mkdir(binDirectory, { recursive: true });
      const legacy = `#!/bin/sh\n# ${LAUNCHER_MARK} (written by OOP Desktop install-desktop.sh; safe to delete)\nfor app in '/Applications/OOP.app'; do\n  exec env ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/OOP" "$app/Contents/Resources/oop/oop.mjs" "$@"\ndone\nexit 127\n`;
      await NodeFSP.writeFile(target, legacy, { mode: 0o755 });
      assert.equal(await ensureTerminalCommand({ appBundle, binDirectory, markerFile }), "updated");
      assert.equal(await NodeFSP.readFile(target, "utf8"), terminalLauncherScript(appBundle));
    });
  });

  it("never touches an oop it did not write, or a symlink", async () => {
    await withTemp(async (root) => {
      const { appBundle, binDirectory, markerFile, target } = await setup(root);
      await NodeFSP.mkdir(binDirectory, { recursive: true });
      // The hand-written two-line launcher many users have: ours in behaviour, but not ours to rewrite.
      const handWritten =
        '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec /Applications/OOP.app/Contents/MacOS/OOP /Applications/OOP.app/Contents/Resources/oop/oop.mjs "$@"\n';
      await NodeFSP.writeFile(target, handWritten, { mode: 0o755 });
      assert.equal(await ensureTerminalCommand({ appBundle, binDirectory, markerFile }), "foreign");
      assert.equal(await NodeFSP.readFile(target, "utf8"), handWritten);

      await NodeFSP.rm(target);
      const real = NodePath.join(root, "real-oop");
      await NodeFSP.writeFile(real, terminalLauncherScript(appBundle));
      await NodeFSP.symlink(real, target);
      assert.equal(await ensureTerminalCommand({ appBundle, binDirectory, markerFile }), "foreign");
      assert.isTrue((await NodeFSP.lstat(target)).isSymbolicLink());
    });
  });

  it("writes nothing for an app without oop-rs", async () => {
    await withTemp(async (root) => {
      const { appBundle, binDirectory, markerFile } = await setup(root);
      await NodeFSP.rm(NodePath.join(appBundle, "Contents", "Resources", "oop", "oop-rs"));
      assert.equal(
        await ensureTerminalCommand({ appBundle, binDirectory, markerFile }),
        "no-terminal-client",
      );
      assert.deepEqual(await NodeFSP.readdir(root), ["Applications"]);
    });
  });
});
