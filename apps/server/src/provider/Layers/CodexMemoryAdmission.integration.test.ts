/**
 * Project memory on the Codex path: boots the REAL CodexAdapter over the REAL
 * CodexSessionRuntime against the scripted mock app-server peer and checks what
 * the peer receives. The envelope the orchestrator hydrates must arrive in
 * `turn/start`, and the publish admission must be the last word: a refusal, or a
 * session that was replaced after the caller captured its identity, writes no
 * `turn/start` at all.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CodexSettings,
  ComposerContextId,
  type ComposerContextRecord,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { assert, describe } from "vite-plus/test";

import type { ProviderAdmissionObservation } from "../Services/ProviderAdapter.ts";
import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { ServerConfig } from "../../config.ts";
import { makeCodexAdapter } from "./CodexAdapter.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const ROOT = wireFixture.rootThreadId;
const SECRET_BODY = "CODEX-MEMORY-BODY-3c71a9";
const CODEX = ProviderDriverKind.make("codex");

const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.codex-memory-script.json");
const peerPath = NodePath.join(
  import.meta.dirname,
  `../testFixtures/codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
);

const recordedTurnStarts = () => {
  try {
    return NodeFS.readFileSync(`${scriptPath}.requests`, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
      .filter((request) => request.method === "turn/start");
  } catch {
    return [];
  }
};

const memoryRecord: ComposerContextRecord = {
  version: 1,
  contextId: ComposerContextId.make("mem-1"),
  kind: "memory",
  label: "Project memory",
  payload: { memoryId: "mem-1", selectedVersion: 1 },
};

/** What the orchestrator hands the adapter: the reference text hydrated into the version-1 envelope. */
const hydratedInput = projectComposerContextForProvider({
  text: "Use the rule. [Project memory](t3-context://v1/memory/mem-1)",
  records: [memoryRecord],
  hydrated: [{ memoryId: "mem-1", version: 1, kind: "fact", title: "A rule", body: SECRET_BODY }],
});

const setup = Effect.gen(function* () {
  NodeFS.writeFileSync(
    scriptPath,
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    JSON.stringify({ rootThreadId: ROOT, recordRequests: true, recordTurnStarts: true }),
    "utf8",
  );
  NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      NodeFS.rmSync(scriptPath, { force: true });
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
    }),
  );
  const adapter = yield* makeCodexAdapter(decodeCodexSettings({ binaryPath: peerPath }), {
    environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
  });
  yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
  return adapter;
});

const testLayer = ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "t3-codex-memory-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const provide = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | Layer.Success<typeof testLayer>>,
) => effect.pipe(Effect.scoped, Effect.provide(testLayer));

describe("Codex project memory admission", () => {
  it.effect("delivers the hydrated memory envelope in turn/start after the publish admission", () =>
    provide(
      Effect.gen(function* () {
        assert.include(hydratedInput, SECRET_BODY);
        const adapter = yield* setup;
        const threadId = ThreadId.make("thread-codex-memory-ok");
        const session = yield* adapter.startSession({
          provider: CODEX,
          threadId,
          cwd: NodeOS.tmpdir(),
          runtimeMode: "full-access",
        });
        const support = adapter.memoryAdmission;
        assert.isDefined(support);
        const generation = support!.sessionGeneration(threadId);
        assert.isDefined(generation);
        // The same cursor the directory persists names the provider thread the send must publish on.
        assert.equal(support!.nativeSessionId(session.resumeCursor), ROOT);

        const observed: Array<ProviderAdmissionObservation> = [];
        yield* adapter.sendTurn(
          { threadId, input: hydratedInput },
          {
            admit: (observation) => {
              observed.push(observation);
              return true;
            },
          },
        );

        assert.deepEqual(observed, [{ sessionGeneration: generation!, nativeSessionId: ROOT }]);
        const turnStarts = recordedTurnStarts();
        assert.equal(turnStarts.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.include(JSON.stringify(turnStarts[0]?.params.input), SECRET_BODY);
      }),
    ),
  );

  it.effect("writes no turn/start when the publish admission refuses", () =>
    provide(
      Effect.gen(function* () {
        const adapter = yield* setup;
        const threadId = ThreadId.make("thread-codex-memory-refused");
        yield* adapter.startSession({
          provider: CODEX,
          threadId,
          cwd: NodeOS.tmpdir(),
          runtimeMode: "full-access",
        });
        const exit = yield* Effect.exit(
          adapter.sendTurn({ threadId, input: hydratedInput }, { admit: () => false }),
        );
        assert.isTrue(Exit.isFailure(exit));
        // A throwing gate is a refusal too, never a publish.
        const thrown = yield* Effect.exit(
          adapter.sendTurn(
            { threadId, input: hydratedInput },
            {
              admit: () => {
                throw new Error("gate failed");
              },
            },
          ),
        );
        assert.isTrue(Exit.isFailure(thrown));
        assert.deepEqual(recordedTurnStarts(), []);
      }),
    ),
  );

  it.effect(
    "reads a session replaced after the identity was captured as a different generation",
    () =>
      provide(
        Effect.gen(function* () {
          const adapter = yield* setup;
          const threadId = ThreadId.make("thread-codex-memory-replaced");
          const start = adapter.startSession({
            provider: CODEX,
            threadId,
            cwd: NodeOS.tmpdir(),
            runtimeMode: "full-access",
          });
          yield* start;
          const captured = adapter.memoryAdmission!.sessionGeneration(threadId);
          yield* start;
          const current = adapter.memoryAdmission!.sessionGeneration(threadId);
          assert.isDefined(captured);
          assert.notEqual(captured, current);

          // Same gate shape ProviderService installs: the captured generation must still be the one publishing.
          const exit = yield* Effect.exit(
            adapter.sendTurn(
              { threadId, input: hydratedInput },
              { admit: (observation) => observation.sessionGeneration === captured },
            ),
          );
          assert.isTrue(Exit.isFailure(exit));
          assert.deepEqual(recordedTurnStarts(), []);

          yield* adapter.stopSession(threadId);
          assert.isUndefined(adapter.memoryAdmission!.sessionGeneration(threadId));
        }),
      ),
  );
});
