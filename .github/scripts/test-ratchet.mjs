#!/usr/bin/env node
/**
 * Test ratchet for OoP CI. Runs every workspace package's `test` script one package at a time and
 * compares the failing tests with `.github/test-quarantine.json`. CI fails on any failure that is
 * not quarantined, or when a package fails without naming a failing test (a crash, a suite that
 * cannot load, or a runner other than Vitest), so known breakage is recorded and can only shrink.
 *
 *   node .github/scripts/test-ratchet.mjs           # run tests, check the quarantine
 *   node .github/scripts/test-ratchet.mjs --update  # run tests, record the current failures
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..", "..");
const quarantinePath = NodePath.join(repoRoot, ".github", "test-quarantine.json");
const update = process.argv.includes("--update");
const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const workspaces = JSON.parse(
  NodeChildProcess.execFileSync("pnpm", ["-r", "ls", "--depth", "-1", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  }),
)
  .map((workspace) => workspace.path)
  .filter((path) => path !== repoRoot)
  .filter((path) => {
    const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(path, "package.json"), "utf8"));
    return typeof manifest.scripts?.test === "string";
  })
  .sort();

const failing = new Set();
const unexplained = [];
for (const path of workspaces) {
  const dir = NodePath.relative(repoRoot, path);
  const started = Date.now();
  const result = NodeChildProcess.spawnSync("pnpm", ["run", "test"], {
    cwd: path,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replaceAll(ansiColor, "");
  let named = 0;
  for (const line of output.split("\n")) {
    const match = /^\s*FAIL\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    // Vitest prefixes a project name (`|unit|` or `unit`) when a package defines projects.
    const test = match[1].replace(/^\|?[\w-]+\|?\s+(?=\S*[/.])/, "").replace(/ \d+ms$/, "");
    failing.add(`${dir}: ${test}`);
    named += 1;
  }
  console.log(
    `${dir}: exit ${result.status ?? result.signal}, ${named} failing, ${Math.round((Date.now() - started) / 1000)}s`,
  );
  if (result.status !== 0) {
    console.log(output);
    if (named === 0) unexplained.push(dir);
  }
}

if (update) {
  const previous = NodeFS.existsSync(quarantinePath)
    ? JSON.parse(NodeFS.readFileSync(quarantinePath, "utf8"))
    : {};
  const next = Object.fromEntries(
    [...failing].sort().map((key) => [key, previous[key] ?? "Failing when CI was introduced."]),
  );
  NodeFS.writeFileSync(quarantinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Quarantined ${failing.size} failing tests.`);
  for (const dir of unexplained) console.log(`FAILED without a named failing test: ${dir}`);
  process.exitCode = unexplained.length > 0 ? 1 : 0;
} else {
  const quarantine = NodeFS.existsSync(quarantinePath)
    ? JSON.parse(NodeFS.readFileSync(quarantinePath, "utf8"))
    : {};
  const fresh = [...failing].filter((key) => !(key in quarantine));
  const healed = Object.keys(quarantine).filter((key) => !failing.has(key));

  console.log(`\n${failing.size} failing tests, ${Object.keys(quarantine).length} quarantined.`);
  for (const key of fresh) console.log(`NEW FAILURE  ${key}`);
  if (healed.length > 0) {
    console.log(`${healed.length} quarantined tests pass now; run with --update to release them.`);
  }
  for (const dir of unexplained) console.log(`FAILED without a named failing test: ${dir}`);
  // Set the exit code instead of calling process.exit(): a piped stdout may still hold the
  // package output above, and exiting early would cut the summary off the CI log.
  process.exitCode = fresh.length > 0 || unexplained.length > 0 ? 1 : 0;
}
