// Compatibility shim: hand-written launchers (`ELECTRON_RUN_AS_NODE=1 OOP.app/.../OOP .../oop/oop.mjs "$@"`)
// still point at this file since the TypeScript terminal was removed. It only runs the oop-rs next to it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

const candidates = ["oop-rs", "oop-rs.exe"].map((name) =>
  NodeURL.fileURLToPath(new URL(name, import.meta.url)),
);
const bin = candidates.find((file) => NodeFS.existsSync(file));
if (bin === undefined) {
  console.error(
    `OOP.app is too old or incomplete: ${candidates[0]} is missing. Reinstall or update OOP.app.`,
  );
  process.exit(127);
}
const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env;
// Ctrl-C belongs to the TUI (same foreground process group); the parent must outlive it.
const ignore = () => {};
process.on("SIGINT", ignore);
const child = NodeChildProcess.spawn(bin, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...env, OOP_IN_DESKTOP_APP: "1" },
});
// A signal aimed at the shim alone never reaches the child through the TTY, so pass it on;
// otherwise oop-rs is orphaned.
const forwarded = ["SIGTERM", "SIGHUP"].map((sig) => [sig, () => child.kill(sig)]);
for (const [sig, forward] of forwarded) process.on(sig, forward);
child.on("error", (e) => {
  console.error(`OOP.app is too old or incomplete: cannot run ${bin} (${e.message}).`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (signal === null) process.exit(code ?? 1);
  process.off("SIGINT", ignore);
  for (const [sig, forward] of forwarded) process.off(sig, forward);
  if (["SIGINT", "SIGTERM", "SIGHUP"].includes(signal)) process.kill(process.pid, signal);
  process.exit(128 + (NodeOS.constants.signals[signal] ?? 1));
});
