import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ServerSettings,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { PULL_REQUEST_AUTO_FIX_ACTIVITY as activity } from "@t3tools/shared/pullRequestAutoFix";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { PullRequestAutoFixReactor, layer } from "./PullRequestAutoFixReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EARLIER = "2025-12-31T00:00:00.000Z";
const THREAD = ThreadId.make("thread");
const OTHER = ThreadId.make("earlier");
const snapshot: ThreadPullRequestSnapshot = {
  state: "open",
  isDraft: false,
  title: "PR title to exclude",
  headBranch: "feature",
  baseBranch: "main",
  updatedAt: NOW,
  syncedAt: NOW,
  checksState: "failing",
};
const link: ThreadPullRequestLink = {
  host: "github.com",
  repository: "owner/repo",
  number: 42,
  url: "https://github.com/owner/repo/pull/42",
  source: "manual",
  linkedAt: NOW,
  snapshot,
  stack: null,
};

function makeThread(id = THREAD): OrchestrationThread {
  return {
    id,
    projectId: ProjectId.make("project"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    pullRequests: [link],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

type Checks = NonNullable<
  Effect.Success<ReturnType<NonNullable<PullRequestService["Service"]["readChecks"]>>>
>;
const failure = {
  name: "unit tests",
  status: "failure",
  description: "assertion failed",
  url: null,
} as const;
const failedHead = (headSha: string): Checks => ({
  open: true,
  headSha,
  checks: [failure, { ...failure, name: "integration", status: "pending" }],
});

const packetStream = <A>(queue: Queue.Queue<{ value: A; consumed: Deferred.Deferred<void> }>) =>
  Stream.fromQueue(queue).pipe(
    Stream.flatMap(({ value, consumed }) =>
      Stream.make(value).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(consumed, undefined)).pipe(Stream.drain)),
      ),
    ),
  );

const makeHarness = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(NOW));
  const startup = yield* Deferred.make<void>();
  const events = yield* Queue.unbounded<{
    value: OrchestrationEvent;
    consumed: Deferred.Deferred<void>;
  }>();
  const changes = yield* Queue.unbounded<{
    value: ServerSettings;
    consumed: Deferred.Deferred<void>;
  }>();
  const threads = new Map([[THREAD, makeThread()]]);
  const commands: OrchestrationCommand[] = [];
  const reads: number[] = [];
  let settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    threadPullRequestAutoFix: { [THREAD]: { enabled: true, setAt: NOW } },
  };
  let checks: Checks | "unavailable" = failedHead("0123456789abcdef");
  let duringRead = () => {};
  let nextUuid = 0;
  const mock = Layer.mergeAll(
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(++nextUuid),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.sync(() => settings),
      subscribeChanges: Effect.succeed(
        Stream.fromEffect(Deferred.succeed(startup, undefined)).pipe(
          Stream.drain,
          Stream.concat(packetStream(changes)),
        ),
      ),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: (id) => Effect.sync(() => Option.fromNullishOr(threads.get(id))),
      listThreadsWithPullRequests: () => Effect.sync(() => [...threads.values()]),
    }),
    Layer.mock(PullRequestService)({
      readChecks: (ref) =>
        Effect.suspend(() => {
          reads.push(ref.number);
          duringRead();
          return checks === "unavailable"
            ? Effect.fail(
                new PullRequestOperationError({ operation: "readChecks", detail: "offline" }),
              )
            : Effect.succeed(checks);
        }),
    }),
    Layer.mock(OrchestrationEngineService)({
      subscribeDomainEvents: Effect.succeed(packetStream(events)),
      latestSequence: Effect.sync(() => commands.length),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          const sequence = commands.length;
          if (command.type === "thread.activity.append") {
            const thread = threads.get(command.threadId)!;
            threads.set(thread.id, {
              ...thread,
              activities: [...thread.activities, { ...command.activity, sequence }],
            });
          }
          return { sequence };
        }),
    }),
  );
  const services = yield* Layer.build(layer.pipe(Layer.provide(mock)));
  const reactor = Context.get(services, PullRequestAutoFixReactor);
  const send = <A>(queue: Queue.Queue<{ value: A; consumed: Deferred.Deferred<void> }>, value: A) =>
    Effect.gen(function* () {
      const consumed = yield* Deferred.make<void>();
      yield* Queue.offer(queue, { value, consumed });
      yield* Deferred.await(consumed);
      yield* reactor.drain;
    });
  return {
    threads,
    drain: reactor.drain,
    reads,
    turns: () => commands.filter((command) => command.type === "thread.turn.start"),
    activities: () =>
      commands.flatMap((command) =>
        command.type === "thread.activity.append" ? [command.activity.kind] : [],
      ),
    setChecks: (value: Checks | "unavailable") => {
      checks = value;
    },
    /** Changes state while the host read is in flight, without waking the reactor. */
    duringRead: (run: () => void) => {
      duringRead = run;
    },
    disableQuietly: () => {
      settings = { ...settings, threadPullRequestAutoFix: {} };
    },
    setSettings: (map: ServerSettings["threadPullRequestAutoFix"]) => {
      settings = { ...settings, threadPullRequestAutoFix: map };
      return send(changes, settings);
    },
    start: Effect.gen(function* () {
      yield* reactor.start();
      yield* Deferred.await(startup);
      yield* reactor.drain;
    }),
    sync: (id = THREAD, fields: Partial<ThreadPullRequestSnapshot> = {}) =>
      Effect.gen(function* () {
        const thread = threads.get(id)!;
        const next = { ...snapshot, ...fields };
        threads.set(id, { ...thread, pullRequests: [{ ...link, snapshot: next }] });
        yield* send(events, {
          type: "thread.pull-request-synced",
          eventId: EventId.make("pull-request-sync"),
          sequence: 1,
          aggregateKind: "thread",
          aggregateId: id,
          occurredAt: DateTime.formatIso(yield* DateTime.now),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { ...link, snapshot: next, threadId: id, updatedAt: NOW },
        });
      }),
  };
});

it.layer(Layer.empty)("PullRequestAutoFixReactor", (it) => {
  it.effect("starts once with only failing checks and keeps the thread's modes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness;
      yield* fixture.start;
      yield* fixture.sync();
      assert.lengthOf(fixture.turns(), 1);
      const turn = fixture.turns()[0]!;
      assert.equal(turn.runtimeMode, "approval-required");
      assert.equal(turn.interactionMode, "default");
      assert.equal(turn.message.role, "user");
      assert.include(turn.message.text, "PR auto-fix · #42 · attempt 1/3");
      assert.include(turn.message.text, 'push it to the PR\'s branch "feature"');
      assert.include(turn.message.text, '> "unit tests" — "assertion failed"');
      assert.notInclude(turn.message.text, "PR title to exclude");
      assert.notInclude(turn.message.text, "integration");
      assert.deepEqual(fixture.activities(), [activity.started]);
    }),
  );

  it.effect("does not read checks when off and wakes when enabled", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness;
      const disabled = fixture.setSettings({});
      yield* fixture.start;
      yield* disabled;
      yield* fixture.sync();
      assert.isEmpty(fixture.reads);
      yield* fixture.setSettings({ [THREAD]: { enabled: true, setAt: NOW } });
      assert.lengthOf(fixture.turns(), 1);
    }),
  );

  const guarded: Record<string, Partial<OrchestrationThread>> = {
    busy: {
      session: {
        threadId: THREAD,
        status: "running",
        providerName: null,
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    },
    approval: {
      activities: [
        {
          id: EventId.make("approval"),
          tone: "info",
          kind: "approval.requested",
          summary: "Awaiting approval",
          payload: { requestId: "approval" },
          turnId: null,
          createdAt: NOW,
        },
      ],
    },
    stopped: {
      latestTurn: {
        turnId: TurnId.make("stopped-turn"),
        state: "interrupted",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: null,
      },
    },
    settled: { settledOverride: "settled" },
    snoozed: { snoozedUntil: "2026-01-02T00:00:00.000Z" },
    archived: { archivedAt: NOW },
    deleted: { deletedAt: NOW },
    closed: { pullRequests: [{ ...link, snapshot: { ...snapshot, state: "closed" } }] },
    // The agent pushes its own branch, so a pull request headed elsewhere is not its to fix.
    "other-branch": { branch: "elsewhere" },
  };
  for (const [name, override] of Object.entries(guarded)) {
    it.effect(`ignores a ${name} thread or link`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeHarness;
        fixture.threads.set(THREAD, { ...makeThread(), ...override });
        yield* fixture.start;
        assert.isEmpty(fixture.turns());
        assert.isEmpty(fixture.reads);
      }),
    );
  }

  for (const [name, checks] of [
    ["cancelled checks", { ...failedHead("a"), checks: [{ ...failure, status: "cancelled" }] }],
    ["a closed PR from the live read", { ...failedHead("a"), open: false }],
    ["a failed detail read", "unavailable"],
  ] as const) {
    it.effect(`does not start on ${name}`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeHarness;
        fixture.setChecks(checks);
        yield* fixture.start;
        assert.deepEqual(fixture.reads, [42]);
        assert.isEmpty(fixture.turns());
        assert.isEmpty(fixture.activities());
      }),
    );
  }

  it.effect("backs off persistent checks lookup failures exponentially", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness;
      fixture.setChecks("unavailable");
      yield* fixture.start;
      assert.deepEqual(fixture.reads, [42]);
      yield* TestClock.adjust("1 minute");
      yield* fixture.drain;
      assert.deepEqual(fixture.reads, [42, 42]);
      yield* TestClock.adjust("1 minute");
      yield* fixture.drain;
      assert.deepEqual(fixture.reads, [42, 42]);
      yield* TestClock.adjust("1 minute");
      yield* fixture.drain;
      assert.deepEqual(fixture.reads, [42, 42, 42]);
      assert.isEmpty(fixture.turns());
      assert.isEmpty(fixture.activities());
    }),
  );

  it.effect("retries a failed checks lookup without a changed PR snapshot", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness;
      fixture.setChecks("unavailable");
      yield* fixture.start;
      assert.deepEqual(fixture.reads, [42]);
      assert.isEmpty(fixture.activities());

      fixture.setChecks(failedHead("recovered"));
      yield* TestClock.adjust("1 minute");
      yield* fixture.drain;
      assert.deepEqual(fixture.reads, [42, 42]);
      assert.lengthOf(fixture.turns(), 1);
      assert.deepEqual(fixture.activities(), [activity.started]);

      yield* TestClock.adjust("1 minute");
      yield* fixture.drain;
      assert.deepEqual(fixture.reads, [42, 42]);
      yield* fixture.sync();
      assert.lengthOf(fixture.turns(), 1);
    }),
  );

  it.effect("stops after three, resets when passing, and never reuses a head", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness;
      fixture.setChecks(failedHead("a"));
      yield* fixture.start;
      for (const head of ["b", "a", "c", "d", "d"]) {
        fixture.setChecks(failedHead(head));
        yield* fixture.sync();
      }
      assert.lengthOf(fixture.turns(), 3);
      assert.deepEqual(fixture.activities(), [
        activity.started,
        activity.started,
        activity.started,
        activity.exhausted,
      ]);
      yield* fixture.sync(THREAD, { checksState: "passing" });
      yield* fixture.sync(THREAD, { checksState: "passing" });
      fixture.setChecks(failedHead("a"));
      yield* fixture.sync();
      fixture.setChecks(failedHead("d"));
      yield* fixture.sync();
      assert.lengthOf(fixture.turns(), 4);
      assert.include(fixture.turns()[3]!.message.text, "attempt 1/3");
      assert.equal(fixture.activities().filter((kind) => kind === activity.passed).length, 1);
    }),
  );

  it.effect("starts a new run of three when switched off and on again", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness;
      fixture.setChecks(failedHead("a"));
      yield* fixture.start;
      for (const head of ["b", "c", "d"]) {
        fixture.setChecks(failedHead(head));
        yield* fixture.sync();
      }
      assert.lengthOf(fixture.turns(), 3);
      yield* fixture.setSettings({ [THREAD]: { enabled: false, setAt: NOW } });
      yield* TestClock.adjust("1 minute");
      const later = DateTime.formatIso(yield* DateTime.now);
      fixture.setChecks(failedHead("e"));
      yield* fixture.setSettings({ [THREAD]: { enabled: true, setAt: later } });
      assert.lengthOf(fixture.turns(), 4);
      assert.include(fixture.turns()[3]!.message.text, "attempt 1/3");
      // A commit tried in the earlier run stays tried.
      fixture.setChecks(failedHead("a"));
      yield* fixture.sync();
      assert.lengthOf(fixture.turns(), 4);
    }),
  );

  it.effect("does not start when the switch goes off while the checks are being read", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness;
      fixture.duringRead(fixture.disableQuietly);
      yield* fixture.start;
      assert.deepEqual(fixture.reads, [42]);
      assert.isEmpty(fixture.turns());
      assert.isEmpty(fixture.activities());
    }),
  );

  it.effect("allows only the earlier-enabled thread to start", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness;
      fixture.threads.set(OTHER, makeThread(OTHER));
      const publish = fixture.setSettings({
        [THREAD]: { enabled: true, setAt: NOW },
        [OTHER]: { enabled: true, setAt: EARLIER },
      });
      yield* fixture.start;
      yield* publish;
      assert.deepEqual(
        fixture.turns().map((turn) => turn.threadId),
        [OTHER],
      );
      assert.deepEqual(fixture.reads, [42]);
    }),
  );

  it.effect("does not yield the PR to an earlier thread that watches another one", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness;
      const newer = {
        ...link,
        number: 43,
        url: "https://github.com/owner/repo/pull/43",
        linkedAt: "2026-01-01T00:00:01.000Z",
      };
      // The earlier thread still links #42, but its current pull request is #43.
      fixture.threads.set(OTHER, { ...makeThread(OTHER), pullRequests: [link, newer] });
      const publish = fixture.setSettings({
        [THREAD]: { enabled: true, setAt: NOW },
        [OTHER]: { enabled: true, setAt: EARLIER },
      });
      yield* fixture.start;
      yield* publish;
      assert.include(
        fixture.turns().map((turn) => turn.threadId),
        THREAD,
      );
    }),
  );

  it.effect("does not yield the PR to an earlier thread on another branch", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness;
      fixture.threads.set(OTHER, { ...makeThread(OTHER), branch: "elsewhere" });
      const publish = fixture.setSettings({
        [THREAD]: { enabled: true, setAt: NOW },
        [OTHER]: { enabled: true, setAt: EARLIER },
      });
      yield* fixture.start;
      yield* publish;
      assert.deepEqual(
        fixture.turns().map((turn) => turn.threadId),
        [THREAD],
      );
    }),
  );

  it.effect("does not yield the PR to an earlier thread that is settled", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness;
      fixture.threads.set(OTHER, { ...makeThread(OTHER), settledOverride: "settled" });
      const publish = fixture.setSettings({
        [THREAD]: { enabled: true, setAt: NOW },
        [OTHER]: { enabled: true, setAt: EARLIER },
      });
      yield* fixture.start;
      yield* publish;
      assert.deepEqual(
        fixture.turns().map((turn) => turn.threadId),
        [THREAD],
      );
    }),
  );
});
