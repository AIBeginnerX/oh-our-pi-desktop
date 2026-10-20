import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { build } from "vite-plus/pack";

import {
  encodeTrustPolicyMarker,
  findTrustPolicyMarkers,
  LEGACY_UNSIGNED_POLICY,
  LOCAL_PKG_TRUST_BUILD_ENV,
} from "../src/updates/LocalPkgTrustPolicy.ts";
import desktopConfig from "../vite.config.ts";
import { verifyStagedTrustMarker } from "../../../scripts/build-desktop-artifact.ts";

const defineKey = "__OOP_BUILD_LOCAL_PKG_TRUST__";
const legacyMarker = encodeTrustPolicyMarker(LEGACY_UNSIGNED_POLICY);
// SYNTHETIC only: there is no real Installer certificate or signed OOP package in E23.
const syntheticSignedPolicy = {
  mode: "developer-id",
  teamId: "ABCDE12345",
  leafPins: ["ab".repeat(32)],
};
const syntheticSignedMarker = encodeTrustPolicyMarker(syntheticSignedPolicy);

const mainPack = () => {
  assert.ok(Array.isArray(desktopConfig.pack));
  const [first, ...otherPacks] = desktopConfig.pack;
  assert.ok(first);
  assert.deepEqual(first.entry, ["src/main.ts"]);
  assert.equal(first.define?.[defineKey], JSON.stringify(legacyMarker));
  for (const packConfig of otherPacks) {
    assert.equal(packConfig.define?.[defineKey], undefined);
  }
  return first;
};

const markerVerdict = (path, expected) =>
  verifyStagedTrustMarker(path, expected).pipe(
    Effect.match({
      onFailure: (error) => ({ kind: "error", found: error.found }),
      onSuccess: () => ({ kind: "ok" }),
    }),
    Effect.provide(NodeServices.layer),
  );

const tempDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-trust-bundle-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);

it.effect(
  "runs the policy compiled into the real main pack and rejects stale emitted markers",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const packConfig = mainPack();
        const directory = yield* tempDirectory;
        yield* Effect.tryPromise(() => NodeFSP.mkdir(NodePath.join(directory, "src")));
        yield* Effect.tryPromise(() =>
          NodeFSP.symlink(
            NodePath.resolve(import.meta.dirname, "../node_modules"),
            NodePath.join(directory, "node_modules"),
            "dir",
          ),
        );
        const actualPolicyModule = NodePath.resolve(
          import.meta.dirname,
          "../src/updates/EmbeddedLocalPkgTrustPolicy.ts",
        );
        yield* Effect.tryPromise(() =>
          NodeFSP.writeFile(
            NodePath.join(directory, "src/main.ts"),
            `import * as Effect from "effect/Effect";
import { EMBEDDED_LOCAL_PKG_TRUST_POLICY, loadEmbeddedTrustPolicy } from ${JSON.stringify(actualPolicyModule)};
const admission = Effect.runSync(Effect.match(loadEmbeddedTrustPolicy, {
  onFailure: (error) => ({ kind: "error", reason: error.reason }),
  onSuccess: (policy) => ({ kind: "accepted", policy }),
}));
console.log("OOP_BUNDLE_RESULT:" + JSON.stringify({ embedded: EMBEDDED_LOCAL_PKG_TRUST_POLICY, admission }));\n`,
          ),
        );

        const mainCjs = NodePath.join(directory, "dist-electron/main.cjs");
        const buildAndRun = (marker, hostileRuntimeValue) =>
          Effect.gen(function* () {
            const define = { ...packConfig.define };
            if (marker === undefined) delete define[defineKey];
            else define[defineKey] = JSON.stringify(marker);
            yield* Effect.tryPromise(() =>
              build({
                ...packConfig,
                config: false,
                cwd: directory,
                tsconfig: false,
                sourcemap: false,
                onSuccess: undefined,
                logLevel: "silent",
                define,
              }),
            );
            const source = yield* Effect.tryPromise(() => NodeFSP.readFile(mainCjs, "utf8"));
            const child = NodeChildProcess.spawnSync(process.execPath, [mainCjs], {
              encoding: "utf8",
              env: { ...process.env, [LOCAL_PKG_TRUST_BUILD_ENV]: hostileRuntimeValue },
            });
            assert.equal(child.status, 0, child.stderr);
            const receipt = child.stdout.match(/^OOP_BUNDLE_RESULT:(.*)$/m);
            assert.ok(receipt, child.stdout);
            return { source, receipt: JSON.parse(receipt[1]) };
          });

        const legacy = yield* buildAndRun(legacyMarker, syntheticSignedMarker);
        assert.deepEqual(legacy.receipt, {
          embedded: LEGACY_UNSIGNED_POLICY,
          admission: { kind: "accepted", policy: LEGACY_UNSIGNED_POLICY },
        });
        const legacyMarkers = findTrustPolicyMarkers(legacy.source);
        assert.ok(legacyMarkers.length > 0);
        assert.ok(legacyMarkers.every((marker) => marker === legacyMarker));
        assert.deepEqual(yield* markerVerdict(mainCjs, legacyMarker), { kind: "ok" });

        const signed = yield* buildAndRun(syntheticSignedMarker, legacyMarker);
        assert.deepEqual(signed.receipt, {
          embedded: syntheticSignedPolicy,
          admission: { kind: "error", reason: "config-invalid" },
        });
        const signedMarkers = findTrustPolicyMarkers(signed.source);
        assert.ok(signedMarkers.length > 0);
        assert.ok(signedMarkers.every((marker) => marker === syntheticSignedMarker));
        assert.deepEqual(yield* markerVerdict(mainCjs, legacyMarker), {
          kind: "error",
          found: "mismatch",
        });

        // Reuse the output directory to catch a stale signed artifact after a legacy build.
        const rebuiltLegacy = yield* buildAndRun(legacyMarker, syntheticSignedMarker);
        assert.deepEqual(rebuiltLegacy.receipt, legacy.receipt);
        const rebuiltMarkers = findTrustPolicyMarkers(rebuiltLegacy.source);
        assert.ok(rebuiltMarkers.length > 0);
        assert.ok(rebuiltMarkers.every((marker) => marker === legacyMarker));

        const preE23 = yield* buildAndRun(undefined, syntheticSignedMarker);
        assert.deepEqual(preE23.receipt, legacy.receipt);
        assert.deepEqual(findTrustPolicyMarkers(preE23.source), []);
        assert.deepEqual(yield* markerVerdict(mainCjs, legacyMarker), {
          kind: "error",
          found: "none",
        });
      }),
    ),
  60_000,
);
