#!/usr/bin/env node
/**
 * Typecheck ratchet for OoP CI. Runs every workspace package's `typecheck` script one at a time
 * and counts errors per file and error code. CI fails when any count grows past
 * `.github/typecheck-baseline.json`, or when a package fails without reporting a type error (a
 * crash or out-of-memory kill), so existing debt is recorded and can only shrink.
 *
 *   node .github/scripts/typecheck-ratchet.mjs           # check against the baseline
 *   node .github/scripts/typecheck-ratchet.mjs --update  # record the current counts
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..", "..");
const baselinePath = NodePath.join(repoRoot, ".github", "typecheck-baseline.json");
const update = process.argv.includes("--update");

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
    return typeof manifest.scripts?.typecheck === "string";
  })
  .sort();

const counts = {};
const crashed = [];
for (const path of workspaces) {
  const dir = NodePath.relative(repoRoot, path);
  const started = Date.now();
  const result = NodeChildProcess.spawnSync("pnpm", ["run", "--silent", "typecheck"], {
    cwd: path,
    encoding: "utf8",
    maxBuffer: 256 << 20,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  let found = 0;
  for (const line of output.split("\n")) {
    const match = /^(\S.*?)\(\d+,\d+\): error (TS\d+):/.exec(line);
    if (!match) continue;
    const key = `${dir}/${match[1]} ${match[2]}`;
    counts[key] = (counts[key] ?? 0) + 1;
    found += 1;
  }
  console.log(
    `${dir}: exit ${result.status ?? result.signal}, ${found} errors, ${Math.round((Date.now() - started) / 1000)}s`,
  );
  if (result.status !== 0 && found === 0) {
    crashed.push(dir);
    console.log(output.slice(-2000));
  }
}

const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

if (update) {
  NodeFS.writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Recorded ${total} errors in ${Object.keys(sorted).length} file/code pairs.`);
  process.exit(crashed.length > 0 ? 1 : 0);
}

const baseline = NodeFS.existsSync(baselinePath)
  ? JSON.parse(NodeFS.readFileSync(baselinePath, "utf8"))
  : {};
const grown = Object.entries(sorted).filter(([key, count]) => count > (baseline[key] ?? 0));
const shrunk = Object.entries(baseline).filter(([key, count]) => (sorted[key] ?? 0) < count);
const baselineTotal = Object.values(baseline).reduce((sum, count) => sum + count, 0);

console.log(`\n${total} type errors now, ${baselineTotal} in the baseline.`);
for (const [key, count] of grown) {
  console.log(`NEW  ${key}: ${baseline[key] ?? 0} -> ${count}`);
}
if (shrunk.length > 0) {
  console.log(
    `${shrunk.length} file/code pairs improved; run with --update to lock the improvement in.`,
  );
}
for (const dir of crashed) console.log(`FAILED without type errors: ${dir}`);
process.exit(grown.length > 0 || crashed.length > 0 ? 1 : 0);
