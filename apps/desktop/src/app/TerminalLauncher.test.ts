// @effect-diagnostics nodeBuiltinImport:off - Reads the shell installer from the repository.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { terminalLauncherScript } from "./TerminalLauncher.ts";

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
