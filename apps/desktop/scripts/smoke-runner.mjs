import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const DESKTOP_SMOKE_READY_MARKER = "desktop app control socket ready";

const FATAL_PATTERNS = [
  "Cannot find module",
  "MODULE_NOT_FOUND",
  "Refused to execute",
  "Uncaught Error",
  "Uncaught TypeError",
  "Uncaught ReferenceError",
];

const processIsRunning = (child) => child.exitCode === null && child.signalCode === null;

function waitForExit(child, timeoutMs) {
  if (!processIsRunning(child)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error(`Electron process ${child.pid ?? "unknown"} did not exit after SIGTERM.`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function stopChild(child, terminationGraceMs) {
  if (!processIsRunning(child)) return;

  child.kill("SIGTERM");
  try {
    await waitForExit(child, terminationGraceMs);
  } catch {
    // The child handle points at the PID returned by this spawn. Escalate only
    // against that process; never search for Electron by name or path.
    if (processIsRunning(child)) child.kill("SIGKILL");
    await waitForExit(child, terminationGraceMs);
  }
}

function readinessFailure(child, output) {
  return new Error(
    `Electron smoke failed before desktop activation control socket readiness (pid ${child.pid ?? "unknown"}).\n\nFull output:\n${output}`,
  );
}

function waitForReadiness(child, { startupTimeoutMs, getOutput }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.stdout.removeListener("data", onOutput);
      child.stderr.removeListener("data", onOutput);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onError = (error) =>
      finish(
        new Error(
          `Could not start Electron smoke process: ${error.message}\n\nFull output:\n${getOutput()}`,
        ),
      );
    const onExit = (code, signal) =>
      finish(
        readinessFailure(
          child,
          `${getOutput()}\nProcess exited before readiness (code ${code ?? "null"}, signal ${signal ?? "none"}).`,
        ),
      );
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            `Electron smoke timed out after ${startupTimeoutMs}ms waiting for desktop activation control socket readiness (pid ${child.pid ?? "unknown"}).\n\nFull output:\n${getOutput()}`,
          ),
        ),
      startupTimeoutMs,
    );

    child.once("error", onError);
    child.once("exit", onExit);
    const onOutput = () => {
      const output = getOutput();
      const fatalPattern = FATAL_PATTERNS.find((pattern) => output.includes(pattern));
      if (fatalPattern) {
        finish(
          new Error(
            `Desktop smoke reported fatal startup output: ${fatalPattern}\n\nFull output:\n${output}`,
          ),
        );
      } else if (output.includes(DESKTOP_SMOKE_READY_MARKER)) {
        finish();
      }
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
  });
}

/**
 * Launch an isolated desktop process and require the existing activation
 * control-socket readiness log before a controlled shutdown.
 */
export async function runDesktopSmoke(command, args, options = {}) {
  const {
    env: parentEnv = process.env,
    spawn = NodeChildProcess.spawn,
    createTempDir = () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-smoke-")),
    removeTempDir = (directory) => NodeFSP.rm(directory, { recursive: true, force: true }),
    startupTimeoutMs = 60_000,
    terminationGraceMs = 2_000,
  } = options;

  const tempRoot = await createTempDir();
  const isolatedHome = NodePath.join(tempRoot, "t3-home");
  const isolatedUserData = NodePath.join(tempRoot, "electron-user-data");
  const childEnv = {
    ...parentEnv,
    VITE_DEV_SERVER_URL: "",
    ELECTRON_ENABLE_LOGGING: "1",
    T3CODE_HOME: isolatedHome,
    T3CODE_DESKTOP_USER_DATA_DIR: isolatedUserData,
    T3CODE_DISABLE_AUTO_UPDATE: "true",
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  let child;
  let output = "";
  let childPid;
  let result;
  let failure;
  try {
    child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });
    childPid = child.pid;
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    await waitForReadiness(child, { startupTimeoutMs, getOutput: () => output });
    if (childPid === undefined) {
      throw new Error(
        `Electron smoke became ready without a captured child PID.\n\nFull output:\n${output}`,
      );
    }
    const failures = FATAL_PATTERNS.filter((pattern) => output.includes(pattern));
    if (failures.length > 0) {
      throw new Error(
        `Desktop smoke reported fatal startup output: ${failures.join(", ")}\n\nFull output:\n${output}`,
      );
    }

    await stopChild(child, terminationGraceMs);
    result = { pid: childPid, output };
  } catch (error) {
    failure = error;
  }

  if (child && child.pid !== undefined && processIsRunning(child)) {
    try {
      await stopChild(child, terminationGraceMs);
    } catch (cleanupError) {
      failure = failure
        ? new AggregateError(
            [failure, cleanupError],
            "Desktop smoke failed and process cleanup also failed.",
          )
        : cleanupError;
    }
  }

  if (child && child.pid !== undefined && processIsRunning(child)) {
    const preserveProfileError = new Error(
      `Electron smoke process ${childPid} is still running; preserving its isolated profile at ${tempRoot}.`,
    );
    failure = failure
      ? new AggregateError(
          [failure, preserveProfileError],
          "Desktop smoke failed; its isolated profile was preserved.",
        )
      : preserveProfileError;
  } else {
    try {
      await removeTempDir(tempRoot);
    } catch (cleanupError) {
      failure = failure
        ? new AggregateError(
            [failure, cleanupError],
            "Desktop smoke failed and profile cleanup also failed.",
          )
        : cleanupError;
    }
  }

  if (failure) throw failure;
  return result;
}
