import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";
import { runDesktopSmoke } from "./smoke-runner.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const mainJs = NodePath.resolve(desktopDir, "dist-electron/boot.cjs");

console.log("\nLaunching isolated Electron desktop smoke...");

try {
  const electronCommand = resolveElectronLaunchCommand([mainJs]);
  await runDesktopSmoke(electronCommand.electronPath, electronCommand.args);
  console.log(
    "Desktop smoke passed: the desktop activation control socket reported ready. UI and provider behavior were not tested.",
  );
} catch (error) {
  console.error("\nDesktop smoke test failed:");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
