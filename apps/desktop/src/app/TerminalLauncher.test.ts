// @effect-diagnostics nodeBuiltinImport:off - Reads the shell installer from the repository.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { terminalLauncherScript, windowsTerminalLauncherScript } from "./TerminalLauncher.ts";

const installer = NodePath.resolve(
  import.meta.dirname,
  "../../../../tools/public-export/overlay/scripts/install-desktop.sh",
);

// The app writes the same `oop` command install-desktop.sh writes. The installer is private-repo
// only (the public export ships it under scripts/), so the comparison runs where it exists.
describe.skipIf(!NodeFS.existsSync(installer))("oop launcher text", () => {
  it("is byte for byte the one install-desktop.sh writes", () => {
    const shell = NodeFS.readFileSync(installer, "utf8");
    const body = /<<'BODY'\n([\s\S]*?)\nBODY\n/u.exec(shell)?.[1];
    expect(body).toBeTruthy();
    const header = /printf '(#!\/bin\/sh\\n# %s [^']*)\\n' "\$launcher_mark"/u.exec(shell)?.[1];
    expect(header).toBeTruthy();
    const expectedHeader = header!
      .replace("%s", "oop-desktop-terminal-launcher")
      .replaceAll("\\n", "\n");
    const app = "/Applications/OOP.app";
    expect(terminalLauncherScript(app)).toBe(
      `${expectedHeader}\nfor app in '${app}' "$HOME/Applications/OOP.app" /Applications/OOP.app; do\n${body}\n`,
    );
  });
});

const windowsInstaller = installer.replace(/\.sh$/, ".ps1");

// The app writes the `oop.cmd` install-desktop.ps1 writes when it takes over an older
// terminal-only command; each line must still be one of the installer's templates.
describe.skipIf(!NodeFS.existsSync(windowsInstaller))("Windows launcher templates", () => {
  it("matches the installer templates and CRLF output", () => {
    const source = NodeFS.readFileSync(windowsInstaller, "utf8");
    const lines = windowsTerminalLauncherScript("EXE", "CLIENT")!.split("\r\n");
    expect(lines.pop()).toBe("");
    for (const line of lines) {
      const template = line
        .replace("oop-desktop-terminal-launcher", "$launcherMark")
        .replace("EXE", "$exe")
        .replace("CLIENT", "$rustClient")
        .replaceAll('"', '`"');
      expect(source).toContain(`"${template}"`);
    }
  });
});

describe("Windows launcher text", () => {
  it("substitutes Windows environment roots and doubles literal percent signs", () => {
    const local = String.raw`C:\Users\한글\AppData\Local`;
    const script = windowsTerminalLauncherScript(
      `${local}\\OOP\\OOP.exe`,
      `${local}\\OOP\\resources\\oop\\oop-rs.exe`,
      local,
    );
    expect(script).toContain('if not exist "%LOCALAPPDATA%\\OOP\\OOP.exe" (');
    expect(script).toContain('"%LOCALAPPDATA%\\OOP\\resources\\oop\\oop-rs.exe" %*');
    expect(
      windowsTerminalLauncherScript(String.raw`C:\100%\OOP.exe`, String.raw`C:\100%\oop-rs.exe`),
    ).toContain('"C:\\100%%\\oop-rs.exe" %*');
    expect(windowsTerminalLauncherScript(String.raw`D:\한글\OOP.exe`, "client")).toBeUndefined();
    expect(
      windowsTerminalLauncherScript(
        String.raw`C:\프로그램\OOP.exe`,
        String.raw`C:\프로그램\oop-rs.exe`,
        undefined,
        String.raw`C:\프로그램`,
      ),
    ).toContain('"%ProgramFiles%\\oop-rs.exe" %*');
  });
});
