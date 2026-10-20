// @effect-diagnostics globalDate:off -- Latches alone sequence these tests.
import {
  EnvironmentId,
  ProjectId,
  ProjectSkillStoreConflictError,
  ProjectSkillStoreError,
  ProjectSkillStoreNotFoundError,
  ProjectSkillStoreRejectedError,
  ThreadId,
  WS_METHODS,
  type ProjectId as ProjectIdType,
  type ProjectSkillCheckObservation,
  type ProjectSkillDetail,
  type ProjectSkillId,
  type ProjectSkillJudgmentId,
  type ProjectSkillListResult,
  type ProjectSkillSource,
  type ProjectSkillSummary,
  type ProjectSkillVersionRecord,
  type ProjectSkillVersionView,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createProjectSkillAtoms } from "./projectSkills.ts";
import { runAtomCommand, squashAtomCommandFailure } from "./runtime.ts";

const ENVIRONMENT = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("skill-environment"),
  label: "Skill environment",
  httpBaseUrl: "https://skill.example.test",
  wsBaseUrl: "wss://skill.example.test",
});

const ENVIRONMENT_ID = ENVIRONMENT.environmentId;

function connectionState(): SupervisorConnectionState {
  return {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
}

function makeSession(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.empty,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const SKILL_SHA = "a".repeat(64);
const CREATED_AT = "2026-10-11T00:00:00.000Z";

const SKILL_CONTENT = (title: string) => ({
  title,
  purpose: `Purpose of ${title}`,
  appliesWhen: "When it applies",
  doesNotApplyWhen: "When it does not",
  procedure: "Do the thing.",
  successCheck: "It worked.",
});

const checkObservation = (projectId: ProjectIdType): ProjectSkillCheckObservation => ({
  threadId: ThreadId.make("thread-1"),
  threadAnchorSequence: 1,
  receiptSequence: 2,
  attemptId: "attempt-1",
  revision: 0,
  projectId,
  workspaceRoot: "/work",
  worktreePath: null,
  cwd: "/work",
  envSha256: SKILL_SHA,
  planned: [],
  tree: null,
  environment: {
    environmentId: ENVIRONMENT_ID,
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.6.0",
    serverVersion: "0.0.0-test",
    nodeVersion: "v24.0.0",
  },
  startedAt: CREATED_AT,
  endedAt: null,
  outcome: "failed",
});

const workSource = (projectId: ProjectIdType): ProjectSkillSource => ({
  type: "work",
  check: checkObservation(projectId),
  createdAfterEventSequence: 2,
  draft: { type: "typed" },
});

const versionRecord = (
  projectId: ProjectIdType,
  skillId: string,
  version: number,
  title: string,
): ProjectSkillVersionRecord => ({
  ref: {
    projectId,
    skillId: skillId as ProjectSkillId,
    version,
    contentSha256: SKILL_SHA,
  },
  content: SKILL_CONTENT(title),
  source: workSource(projectId),
  state: "candidate",
  retiredReason: null,
  createdAt: CREATED_AT,
});

const versionView = (
  projectId: ProjectIdType,
  skillId: string,
  version: number,
  title: string,
): ProjectSkillVersionView => ({
  version: versionRecord(projectId, skillId, version, title),
  judgments: [],
  rightsRecorded: false,
  reviewRecorded: false,
});

const summary = (
  projectId: ProjectIdType,
  skillId: string,
  title: string,
  version: number,
): ProjectSkillSummary => ({
  ref: {
    projectId,
    skillId: skillId as ProjectSkillId,
    version,
    contentSha256: SKILL_SHA,
  },
  title,
  state: "candidate",
  createdAt: CREATED_AT,
  rightsRecorded: false,
  reviewRecorded: false,
});

/**
 * An in-memory skill store behind the `projectSkill.*` wire tags. `armListRefetch`
 * / `armGetRefetch` open a latch at the given call count, `armListFailure` fails
 * list calls from one on, and `holdListsFor` holds a project's list responses
 * until `releaseHeld`, so tests await exactly the fetches and failures a write's
 * invalidation triggers. `holdCreate` parks the create RPC itself behind
 * `releaseCreate` so same-project write serialization is observable; every write
 * pushes its method name onto `writeOrder` at wire entry.
 */
function makeSkillClient() {
  const projects = new Map<string, Map<string, { title: string; latestVersion: number }>>();
  const storeFor = (projectId: ProjectIdType) => {
    let store = projects.get(projectId);
    if (store === undefined) {
      store = new Map();
      projects.set(projectId, store);
    }
    return store;
  };

  let listCalls = 0;
  const listCallsByKey = new Map<string, number>();
  let listRefetchThreshold = Number.POSITIVE_INFINITY;
  let listRefetchLatch = Latch.makeUnsafe();
  let failListFromCall = Number.POSITIVE_INFINITY;
  let heldProject: ProjectIdType | null = null;
  const releaseHeld = Latch.makeUnsafe();
  let getCalls = 0;
  const getCallsByKey = new Map<string, number>();
  let getRefetchThreshold = Number.POSITIVE_INFINITY;
  let getRefetchLatch = Latch.makeUnsafe();

  // Wire-boundary invariant: `writeOrder` records each write RPC's entry and
  // `writeCompletions` its exit, while `maxActiveWrites` is the largest number
  // of write RPCs ever in flight at once. One scheduler lane must hold all
  // three: entries in launch order, matching completions, max 1.
  const writeOrder: string[] = [];
  const writeCompletions: string[] = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const trackWrite = <A, E>(name: string, effect: Effect.Effect<A, E>) => {
    writeOrder.push(name);
    activeWrites += 1;
    if (activeWrites > maxActiveWrites) maxActiveWrites = activeWrites;
    return Effect.ensuring(
      effect,
      Effect.sync(() => {
        activeWrites -= 1;
        writeCompletions.push(name);
      }),
    );
  };
  let createCount = 0;
  let holdCreate = false;
  const createStarted = Latch.makeUnsafe();
  const releaseCreate = Latch.makeUnsafe();
  let reviseConflict = false;
  let deleteOutcome: "applied" | "conflict" = "applied";
  let withdrawOutcome: "applied" | "not-found" | "already-withdrawn" = "applied";
  let activateRejected = false;
  let deriveCalls = 0;

  const listResult = (projectId: ProjectIdType): ProjectSkillListResult => ({
    items: [...storeFor(projectId).entries()].map(([skillId, skill]) =>
      summary(projectId, skillId, skill.title, skill.latestVersion),
    ),
    truncated: false,
  });

  const detailFor = (projectId: ProjectIdType, skillId: string): ProjectSkillDetail => {
    const skill = storeFor(projectId).get(skillId);
    return {
      projectId,
      skillId: skillId as ProjectSkillId,
      latestVersion: skill?.latestVersion ?? 1,
      versions:
        skill === undefined
          ? []
          : [versionView(projectId, skillId, skill.latestVersion, skill.title)],
    };
  };

  const bumpKey = (key: string, map: Map<string, number>) => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  const client = {
    [WS_METHODS.projectSkillList]: (input: { projectId: ProjectIdType; limit: number }) => {
      listCalls += 1;
      bumpKey(JSON.stringify(input), listCallsByKey);
      if (listCalls >= listRefetchThreshold) listRefetchLatch.openUnsafe();
      if (listCalls >= failListFromCall) {
        return Effect.fail(new ProjectSkillStoreError({ message: "The skill store failed." }));
      }
      if (heldProject !== null && input.projectId === heldProject) {
        return Effect.andThen(releaseHeld.await, Effect.succeed(listResult(input.projectId)));
      }
      return Effect.succeed(listResult(input.projectId));
    },
    [WS_METHODS.projectSkillGet]: (input: { projectId: ProjectIdType; skillId: string }) => {
      getCalls += 1;
      bumpKey(JSON.stringify(input), getCallsByKey);
      if (getCalls >= getRefetchThreshold) getRefetchLatch.openUnsafe();
      if (storeFor(input.projectId).get(input.skillId) === undefined) {
        return Effect.fail(new ProjectSkillStoreNotFoundError({}));
      }
      return Effect.succeed(detailFor(input.projectId, input.skillId));
    },
    [WS_METHODS.projectSkillCreateCandidate]: (input: {
      projectId: ProjectIdType;
      content: { title: string };
    }) => {
      createStarted.openUnsafe();
      const respond = Effect.sync(() => {
        createCount += 1;
        const skillId = `psk_created${createCount}`;
        storeFor(input.projectId).set(skillId, { title: input.content.title, latestVersion: 1 });
        return versionView(input.projectId, skillId, 1, input.content.title);
      });
      return trackWrite(
        "createCandidate",
        holdCreate ? Effect.andThen(releaseCreate.await, respond) : respond,
      );
    },
    [WS_METHODS.projectSkillRevise]: (input: {
      projectId: ProjectIdType;
      skillId: string;
      expectedLatestVersion: number;
      content: { title: string };
    }) => {
      if (reviseConflict) {
        return trackWrite(
          "revise",
          Effect.fail(
            new ProjectSkillStoreConflictError({
              currentLatestVersion:
                storeFor(input.projectId).get(input.skillId)?.latestVersion ?? 2,
            }),
          ),
        );
      }
      const skill = storeFor(input.projectId).get(input.skillId);
      if (skill === undefined) {
        return trackWrite("revise", Effect.fail(new ProjectSkillStoreNotFoundError({})));
      }
      skill.latestVersion += 1;
      skill.title = input.content.title;
      return trackWrite(
        "revise",
        Effect.succeed(
          versionView(input.projectId, input.skillId, skill.latestVersion, skill.title),
        ),
      );
    },
    [WS_METHODS.projectSkillRecordJudgment]: (input: {
      ref: { projectId: ProjectIdType; skillId: string; version: number };
      judgment: { note: string };
    }) =>
      trackWrite(
        "recordJudgment",
        Effect.succeed({
          judgment: {
            judgmentId: "psj_recorded1" as ProjectSkillJudgmentId,
            ref: { ...input.ref, contentSha256: SKILL_SHA },
            recordedAt: CREATED_AT,
            recordedBy: "authenticated-client",
            kind: "rights",
            basis: "own-work",
            originalSource: null,
            license: null,
            note: input.judgment.note,
          },
          recordedAfterEventSequence: 3,
          withdrawnAt: null,
        }),
      ),
    [WS_METHODS.projectSkillWithdrawJudgment]: (_input: {
      ref: { projectId: ProjectIdType };
      judgmentId: string;
    }) => trackWrite("withdrawJudgment", Effect.succeed({ status: withdrawOutcome })),
    [WS_METHODS.projectSkillActivate]: (input: {
      ref: { projectId: ProjectIdType };
      expectedStateSeq: number;
      target: { threadId: string; scriptIds: ReadonlyArray<string> };
    }) =>
      activateRejected
        ? trackWrite(
            "activate",
            Effect.fail(
              new ProjectSkillStoreRejectedError({
                reason: "not-ready",
                gaps: ["review-missing"],
              }),
            ),
          )
        : trackWrite("activate", Effect.succeed({ stateSeq: input.expectedStateSeq + 1 })),
    [WS_METHODS.projectSkillRetire]: (input: {
      ref: { projectId: ProjectIdType };
      expectedStateSeq: number;
    }) => trackWrite("retire", Effect.succeed({ stateSeq: input.expectedStateSeq + 1 })),
    [WS_METHODS.projectSkillDeriveDraft]: () => {
      deriveCalls += 1;
      return Effect.succeed({ status: "unavailable" as const, reason: "no-procedure-section" });
    },
    [WS_METHODS.projectSkillDelete]: (input: { projectId: ProjectIdType; skillId: string }) => {
      if (deleteOutcome === "conflict") {
        // The row stays and the caller learns the live version; onSuccess
        // still ran because the RPC itself resolved.
        return trackWrite(
          "delete",
          Effect.succeed({
            status: "conflict" as const,
            currentLatestVersion: storeFor(input.projectId).get(input.skillId)?.latestVersion ?? 1,
          }),
        );
      }
      return trackWrite(
        "delete",
        Effect.sync(() => {
          storeFor(input.projectId).delete(input.skillId);
          return { status: "applied" as const };
        }),
      );
    },
  } as unknown as WsRpcProtocolClient;

  return {
    client,
    seed: (projectId: string, skillId: string, title: string, latestVersion = 1) => {
      storeFor(ProjectId.make(projectId)).set(skillId, { title, latestVersion });
    },
    get listCalls() {
      return listCalls;
    },
    get deriveCalls() {
      return deriveCalls;
    },
    listCallsFor: (input: { projectId: string; limit: number }) =>
      listCallsByKey.get(JSON.stringify(input)) ?? 0,
    get listRefetched() {
      return listRefetchLatch;
    },
    armListRefetch: (callCount: number) => {
      listRefetchThreshold = callCount;
      listRefetchLatch = Latch.makeUnsafe();
    },
    armListFailure: (fromCall: number) => {
      failListFromCall = fromCall;
    },
    holdListsFor: (projectId: ProjectIdType) => {
      heldProject = projectId;
    },
    get releaseHeld() {
      return releaseHeld;
    },
    get getCalls() {
      return getCalls;
    },
    getCallsFor: (input: { projectId: string; skillId: string }) =>
      getCallsByKey.get(JSON.stringify(input)) ?? 0,
    get getRefetched() {
      return getRefetchLatch;
    },
    armGetRefetch: (callCount: number) => {
      getRefetchThreshold = callCount;
      getRefetchLatch = Latch.makeUnsafe();
    },
    get writeOrder() {
      return writeOrder;
    },
    get writeCompletions() {
      return writeCompletions;
    },
    get maxActiveWrites() {
      return maxActiveWrites;
    },
    get createStarted() {
      return createStarted;
    },
    get releaseCreate() {
      return releaseCreate;
    },
    holdCreateWrites: () => {
      holdCreate = true;
    },
    failReviseWithConflict: () => {
      reviseConflict = true;
    },
    setDeleteOutcome: (outcome: "applied" | "conflict") => {
      deleteOutcome = outcome;
    },
    setWithdrawOutcome: (outcome: "applied" | "not-found" | "already-withdrawn") => {
      withdrawOutcome = outcome;
    },
    setActivateRejected: (rejected: boolean) => {
      activateRejected = rejected;
    },
  };
}

const makeHarness = Effect.fn("TestProjectSkill.makeHarness")(function* () {
  const skillClient = makeSkillClient();
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: ENVIRONMENT,
    state: yield* SubscriptionRef.make(connectionState()),
    session: yield* SubscriptionRef.make(Option.some(makeSession(skillClient.client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  );
  const atoms = createProjectSkillAtoms(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { atoms, registry, skillClient };
});

const listTarget = (projectId: string, limit: number) => ({
  environmentId: ENVIRONMENT_ID,
  input: { projectId: ProjectId.make(projectId), limit },
});

const getTarget = (projectId: string, skillId: string) => ({
  environmentId: ENVIRONMENT_ID,
  input: { projectId: ProjectId.make(projectId), skillId: skillId as ProjectSkillId },
});

const SILENT_REPORTER = { warn: () => {}, error: () => {} };

describe("project skill state", () => {
  it.effect("a write refreshes every mounted list/get variant of the same project only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, skillClient } = yield* makeHarness();
        skillClient.seed("project-1", "psk_skillaa", "Skill A");
        skillClient.seed("project-1", "psk_skillbb", "Skill B");
        const listAtom = atoms.list(listTarget("project-1", 50));
        const limitedAtom = atoms.list(listTarget("project-1", 5));
        const getA = atoms.get(getTarget("project-1", "psk_skillaa"));
        const getB = atoms.get(getTarget("project-1", "psk_skillbb"));
        const otherList = atoms.list(listTarget("project-2", 50));
        const mounted = [
          registry.mount(listAtom),
          registry.mount(limitedAtom),
          registry.mount(getA),
          registry.mount(getB),
          registry.mount(otherList),
        ];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const unmount of mounted) unmount();
          }),
        );

        // Two skill ids and two list limits stay four distinct reads; each
        // resolves once on mount.
        yield* AtomRegistry.getResult(registry, listAtom, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, limitedAtom, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, getA, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, getB, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, otherList, { suspendOnWaiting: true });
        expect(skillClient.listCallsFor({ projectId: "project-1", limit: 50 })).toBe(1);
        expect(skillClient.listCallsFor({ projectId: "project-1", limit: 5 })).toBe(1);
        expect(skillClient.listCallsFor({ projectId: "project-2", limit: 50 })).toBe(1);
        expect(skillClient.getCallsFor({ projectId: "project-1", skillId: "psk_skillaa" })).toBe(1);
        expect(skillClient.getCallsFor({ projectId: "project-1", skillId: "psk_skillbb" })).toBe(1);

        // Three initial list reads plus two project-1 refetches; two initial
        // gets plus two project-1 refetches.
        skillClient.armListRefetch(5);
        skillClient.armGetRefetch(4);
        const revised = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.revise, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              skillId: "psk_skillaa" as ProjectSkillId,
              fromVersion: 1,
              expectedLatestVersion: 1,
              content: SKILL_CONTENT("Skill A v2"),
            },
          }),
        );
        expect(revised._tag).toBe("Success");
        yield* skillClient.listRefetched.await;
        yield* skillClient.getRefetched.await;

        // Every mounted project-1 variant refetched once; project-2 never did.
        expect(skillClient.listCallsFor({ projectId: "project-1", limit: 50 })).toBe(2);
        expect(skillClient.listCallsFor({ projectId: "project-1", limit: 5 })).toBe(2);
        expect(skillClient.getCallsFor({ projectId: "project-1", skillId: "psk_skillaa" })).toBe(2);
        expect(skillClient.getCallsFor({ projectId: "project-1", skillId: "psk_skillbb" })).toBe(2);
        expect(skillClient.listCallsFor({ projectId: "project-2", limit: 50 })).toBe(1);

        const refreshed = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(refreshed.items.map((item) => item.title)).toEqual(["Skill A v2", "Skill B"]);
      }),
    ),
  );

  it.effect("a write never refetches the same project in another environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, skillClient } = yield* makeHarness();
        skillClient.seed("project-1", "psk_skillaa", "Skill A");
        const otherEnvironment = EnvironmentId.make("other-environment");
        const otherEnvList = atoms.list({
          environmentId: otherEnvironment,
          input: { projectId: ProjectId.make("project-1"), limit: 50 },
        });
        const mounted = registry.mount(otherEnvList);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mounted();
          }),
        );
        const before = yield* AtomRegistry.getResult(registry, otherEnvList, {
          suspendOnWaiting: true,
        });
        expect(before.items.map((item) => item.title)).toEqual(["Skill A"]);
        expect(skillClient.listCalls).toBe(1);

        const revised = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.revise, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              skillId: "psk_skillaa" as ProjectSkillId,
              fromVersion: 1,
              expectedLatestVersion: 1,
              content: SKILL_CONTENT("Skill A v2"),
            },
          }),
        );
        expect(revised._tag).toBe("Success");

        // The write bumped only [ENVIRONMENT_ID, project-1]: no extra RPC and
        // no changed value on the other environment's atom.
        expect(skillClient.listCalls).toBe(1);
        const after = yield* AtomRegistry.getResult(registry, otherEnvList, {
          suspendOnWaiting: true,
        });
        expect(after.items.map((item) => item.title)).toEqual(["Skill A"]);
      }),
    ),
  );

  it.effect("a delayed refetch after delete reports waiting with no stale value", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, skillClient } = yield* makeHarness();
        skillClient.seed("project-1", "psk_doomed1", "Doomed");
        const listAtom = atoms.list(listTarget("project-1", 50));
        const mounted = registry.mount(listAtom);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mounted();
          }),
        );
        const before = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(before.items.map((item) => item.title)).toEqual(["Doomed"]);
        skillClient.armListRefetch(2);
        skillClient.holdListsFor(ProjectId.make("project-1"));

        const deleted = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.delete, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              skillId: "psk_doomed1" as ProjectSkillId,
              expectedLatestVersion: 1,
            },
          }),
        );
        expect(deleted._tag).toBe("Success");
        yield* skillClient.listRefetched.await;

        // The post-write refetch is still in flight: the wrapper reports
        // waiting and exposes no value, so the deleted skill cannot linger.
        const pending = registry.get(listAtom) as AsyncResult.AsyncResult<
          { items: ReadonlyArray<ProjectSkillSummary> },
          unknown
        >;
        expect(pending.waiting).toBe(true);
        expect(Option.isNone(AsyncResult.value(pending))).toBe(true);

        skillClient.releaseHeld.openUnsafe();
        const after = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(after.items).toEqual([]);
      }),
    ),
  );

  it.effect("a failed refetch after delete surfaces an error without the deleted list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, skillClient } = yield* makeHarness();
        skillClient.seed("project-1", "psk_doomed1", "Doomed");
        const listAtom = atoms.list(listTarget("project-1", 50));
        const failed = Latch.makeUnsafe();
        const unsubscribe = registry.subscribe(
          listAtom,
          (result) => {
            if (result._tag === "Failure") failed.openUnsafe();
          },
          { immediate: false },
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
          }),
        );
        const before = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(before.items.map((item) => item.title)).toEqual(["Doomed"]);
        skillClient.armListRefetch(2);
        skillClient.armListFailure(2);

        const deleted = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.delete, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              skillId: "psk_doomed1" as ProjectSkillId,
              expectedLatestVersion: 1,
            },
          }),
        );
        expect(deleted._tag).toBe("Success");
        yield* failed.await;

        // The wrapper forwards the failure without its previousSuccess, so no
        // consumer can read the deleted list back out of the error state.
        const raw = registry.get(listAtom) as AsyncResult.AsyncResult<
          { items: ReadonlyArray<ProjectSkillSummary> },
          unknown
        >;
        expect(raw._tag).toBe("Failure");
        expect(Option.isNone(AsyncResult.value(raw))).toBe(true);
      }),
    ),
  );

  it.effect("all five writes share one serial lane behind a held first write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, skillClient } = yield* makeHarness();
        skillClient.seed("project-1", "psk_held001", "Held");
        skillClient.holdCreateWrites();

        const create = runAtomCommand(registry, atoms.createCandidate, {
          environmentId: ENVIRONMENT_ID,
          input: {
            projectId: ProjectId.make("project-1"),
            threadId: ThreadId.make("thread-1"),
            expected: { attemptId: "attempt-1", revision: 0, receiptSequence: 2 },
            content: SKILL_CONTENT("Queued candidate"),
            draft: { type: "typed" },
          },
        });
        // The create reached the wire and is parked: every same-project write
        // queued behind it must wait for its completion, judgment methods
        // included — they derive the lane from `ref.projectId` alone.
        yield* skillClient.createStarted.await;

        const revise = runAtomCommand(registry, atoms.revise, {
          environmentId: ENVIRONMENT_ID,
          input: {
            projectId: ProjectId.make("project-1"),
            skillId: "psk_held001" as ProjectSkillId,
            fromVersion: 1,
            expectedLatestVersion: 1,
            content: SKILL_CONTENT("Held revised"),
          },
        });
        const record = runAtomCommand(registry, atoms.recordJudgment, {
          environmentId: ENVIRONMENT_ID,
          input: {
            ref: {
              projectId: ProjectId.make("project-1"),
              skillId: "psk_held001" as ProjectSkillId,
              version: 1,
              contentSha256: SKILL_SHA,
            },
            judgment: {
              kind: "review",
              provenanceChecked: true,
              privacyChecked: true,
              scopeChecked: true,
              note: "Reviewed.",
            },
          },
        });
        const withdraw = runAtomCommand(registry, atoms.withdrawJudgment, {
          environmentId: ENVIRONMENT_ID,
          input: {
            ref: {
              projectId: ProjectId.make("project-1"),
              skillId: "psk_held001" as ProjectSkillId,
              version: 1,
              contentSha256: SKILL_SHA,
            },
            judgmentId: "psj_recorded1" as ProjectSkillJudgmentId,
          },
        });
        const remove = runAtomCommand(registry, atoms.delete, {
          environmentId: ENVIRONMENT_ID,
          input: {
            projectId: ProjectId.make("project-1"),
            skillId: "psk_held001" as ProjectSkillId,
            expectedLatestVersion: 2,
          },
        });

        skillClient.releaseCreate.openUnsafe();
        const results = yield* Effect.promise(() =>
          Promise.all([create, revise, record, withdraw, remove]),
        );
        for (const result of results) {
          expect(result._tag).toBe("Success");
        }

        // Durable wire-boundary invariant: at no point were two write RPCs in
        // flight, and each completed before the next entered — FIFO across all
        // five methods on the one project lane.
        expect(skillClient.maxActiveWrites).toBe(1);
        expect(skillClient.writeOrder).toEqual([
          "createCandidate",
          "revise",
          "recordJudgment",
          "withdrawJudgment",
          "delete",
        ]);
        expect(skillClient.writeCompletions).toEqual(skillClient.writeOrder);
      }),
    ),
  );

  it.effect("an explicit revalidate after a typed conflict runs the reads again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, skillClient } = yield* makeHarness();
        skillClient.seed("project-1", "psk_skillaa", "Skill A", 2);
        const listAtom = atoms.list(listTarget("project-1", 50));
        const getAtom = atoms.get(getTarget("project-1", "psk_skillaa"));
        const mounted = [registry.mount(listAtom), registry.mount(getAtom)];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const unmount of mounted) unmount();
          }),
        );
        yield* AtomRegistry.getResult(registry, listAtom, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, getAtom, { suspendOnWaiting: true });
        skillClient.failReviseWithConflict();

        // A typed Conflict surfaces as a command failure, not a written value:
        // the reads are untouched until the caller revalidates.
        const conflicted = yield* Effect.promise(() =>
          runAtomCommand(
            registry,
            atoms.revise,
            {
              environmentId: ENVIRONMENT_ID,
              input: {
                projectId: ProjectId.make("project-1"),
                skillId: "psk_skillaa" as ProjectSkillId,
                fromVersion: 1,
                expectedLatestVersion: 1,
                content: SKILL_CONTENT("Stale write"),
              },
            },
            {},
            SILENT_REPORTER,
          ),
        );
        expect(conflicted._tag).toBe("Failure");
        if (conflicted._tag === "Failure") {
          const squashed = squashAtomCommandFailure(conflicted);
          expect(squashed).toBeInstanceOf(ProjectSkillStoreConflictError);
          expect((squashed as ProjectSkillStoreConflictError).currentLatestVersion).toBe(2);
        }
        expect(skillClient.listCalls).toBe(1);
        expect(skillClient.getCalls).toBe(1);

        skillClient.armListRefetch(2);
        skillClient.armGetRefetch(2);
        const revalidated = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.revalidate, {
            environmentId: ENVIRONMENT_ID,
            input: { projectId: ProjectId.make("project-1") },
          }),
        );
        expect(revalidated._tag).toBe("Success");
        yield* skillClient.listRefetched.await;
        yield* skillClient.getRefetched.await;

        // The bump reached the wire: both mounted reads of that project ran
        // again, not a replayed cached value.
        expect(skillClient.listCallsFor({ projectId: "project-1", limit: 50 })).toBe(2);
        expect(skillClient.getCallsFor({ projectId: "project-1", skillId: "psk_skillaa" })).toBe(2);
      }),
    ),
  );

  it.effect("a judgment withdraw invalidates the project named by ref.projectId", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, skillClient } = yield* makeHarness();
        skillClient.seed("project-1", "psk_skillaa", "Skill A");
        skillClient.seed("project-2", "psk_skillcc", "Skill C");
        const getAtom = atoms.get(getTarget("project-1", "psk_skillaa"));
        const otherList = atoms.list(listTarget("project-2", 50));
        const mounted = [registry.mount(getAtom), registry.mount(otherList)];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const unmount of mounted) unmount();
          }),
        );
        yield* AtomRegistry.getResult(registry, getAtom, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, otherList, { suspendOnWaiting: true });
        skillClient.armGetRefetch(2);

        // The input carries no top-level projectId; the write lane and
        // invalidation scope both come from ref.projectId.
        const withdrawn = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.withdrawJudgment, {
            environmentId: ENVIRONMENT_ID,
            input: {
              ref: {
                projectId: ProjectId.make("project-1"),
                skillId: "psk_skillaa" as ProjectSkillId,
                version: 1,
                contentSha256: SKILL_SHA,
              },
              judgmentId: "psj_recorded1" as ProjectSkillJudgmentId,
            },
          }),
        );
        expect(withdrawn._tag).toBe("Success");
        yield* skillClient.getRefetched.await;

        expect(skillClient.getCallsFor({ projectId: "project-1", skillId: "psk_skillaa" })).toBe(2);
        expect(skillClient.listCallsFor({ projectId: "project-2", limit: 50 })).toBe(1);
      }),
    ),
  );

  it.effect("resolved non-applied write statuses still refresh their project scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, skillClient } = yield* makeHarness();
        skillClient.seed("project-1", "psk_skillaa", "Skill A", 2);
        skillClient.seed("project-2", "psk_skillcc", "Skill C");
        const listAtom = atoms.list(listTarget("project-1", 50));
        const getAtom = atoms.get(getTarget("project-1", "psk_skillaa"));
        const otherList = atoms.list(listTarget("project-2", 50));
        const mounted = [
          registry.mount(listAtom),
          registry.mount(getAtom),
          registry.mount(otherList),
        ];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const unmount of mounted) unmount();
          }),
        );
        yield* AtomRegistry.getResult(registry, listAtom, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, getAtom, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, otherList, { suspendOnWaiting: true });

        // A delete conflict resolves without mutating anything, but the RPC
        // succeeded — the project scope still conservatively refreshes.
        skillClient.setDeleteOutcome("conflict");
        skillClient.armListRefetch(skillClient.listCalls + 1);
        skillClient.armGetRefetch(skillClient.getCalls + 1);
        const deleted = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.delete, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              skillId: "psk_skillaa" as ProjectSkillId,
              expectedLatestVersion: 2,
            },
          }),
        );
        expect(deleted._tag).toBe("Success");
        if (deleted._tag === "Success") {
          expect(deleted.value).toEqual({ status: "conflict", currentLatestVersion: 2 });
        }
        yield* skillClient.listRefetched.await;
        yield* skillClient.getRefetched.await;
        expect(skillClient.listCallsFor({ projectId: "project-1", limit: 50 })).toBe(2);
        expect(skillClient.getCallsFor({ projectId: "project-1", skillId: "psk_skillaa" })).toBe(2);
        expect(skillClient.listCallsFor({ projectId: "project-2", limit: 50 })).toBe(1);

        // Withdrawal outcomes that counted nothing (`not-found` when the
        // judgment is gone, `already-withdrawn` when it already counted as
        // withdrawn) are successful commands carrying their exact status —
        // the project scope refreshes the same way.
        for (const status of ["not-found", "already-withdrawn"] as const) {
          skillClient.setWithdrawOutcome(status);
          const p1ListBefore = skillClient.listCallsFor({ projectId: "project-1", limit: 50 });
          const p1GetBefore = skillClient.getCallsFor({
            projectId: "project-1",
            skillId: "psk_skillaa",
          });
          skillClient.armListRefetch(skillClient.listCalls + 1);
          skillClient.armGetRefetch(skillClient.getCalls + 1);
          const withdrawn = yield* Effect.promise(() =>
            runAtomCommand(registry, atoms.withdrawJudgment, {
              environmentId: ENVIRONMENT_ID,
              input: {
                ref: {
                  projectId: ProjectId.make("project-1"),
                  skillId: "psk_skillaa" as ProjectSkillId,
                  version: 2,
                  contentSha256: SKILL_SHA,
                },
                judgmentId: "psj_recorded1" as ProjectSkillJudgmentId,
              },
            }),
          );
          expect(withdrawn._tag).toBe("Success");
          if (withdrawn._tag === "Success") {
            expect(withdrawn.value).toEqual({ status });
          }
          yield* skillClient.listRefetched.await;
          yield* skillClient.getRefetched.await;
          expect(skillClient.listCallsFor({ projectId: "project-1", limit: 50 })).toBe(
            p1ListBefore + 1,
          );
          expect(skillClient.getCallsFor({ projectId: "project-1", skillId: "psk_skillaa" })).toBe(
            p1GetBefore + 1,
          );
          expect(skillClient.listCallsFor({ projectId: "project-2", limit: 50 })).toBe(1);
        }
      }),
    ),
  );

  it.effect("activate and retire share the ref-scoped lane and bump reads only on success", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, skillClient } = yield* makeHarness();
        skillClient.seed("project-1", "psk_skillaa", "Skill A");
        const getAtom = atoms.get(getTarget("project-1", "psk_skillaa"));
        const mounted = registry.mount(getAtom);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mounted();
          }),
        );
        yield* AtomRegistry.getResult(registry, getAtom, { suspendOnWaiting: true });
        skillClient.armGetRefetch(2);
        const ref = {
          projectId: ProjectId.make("project-1"),
          skillId: "psk_skillaa" as ProjectSkillId,
          version: 1,
          contentSha256: SKILL_SHA,
        };
        const activated = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.activate, {
            environmentId: ENVIRONMENT_ID,
            input: {
              ref,
              expectedStateSeq: 3,
              target: { threadId: ThreadId.make("thread-1"), scriptIds: ["lint"] },
            },
          }),
        );
        expect(activated._tag).toBe("Success");
        yield* skillClient.getRefetched.await;
        expect(skillClient.getCallsFor({ projectId: "project-1", skillId: "psk_skillaa" })).toBe(2);
        skillClient.armGetRefetch(skillClient.getCalls + 1);
        const retired = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.retire, {
            environmentId: ENVIRONMENT_ID,
            input: { ref, expectedStateSeq: 4 },
          }),
        );
        expect(retired._tag).toBe("Success");
        yield* skillClient.getRefetched.await;
        expect(skillClient.writeOrder).toEqual(["activate", "retire"]);
        expect(skillClient.maxActiveWrites).toBe(1);
      }),
    ),
  );

  it.effect("a rejected activate does not bump project invalidation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, skillClient } = yield* makeHarness();
        skillClient.seed("project-1", "psk_skillaa", "Skill A");
        const getAtom = atoms.get(getTarget("project-1", "psk_skillaa"));
        const mounted = registry.mount(getAtom);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mounted();
          }),
        );
        yield* AtomRegistry.getResult(registry, getAtom, { suspendOnWaiting: true });
        const getBefore = skillClient.getCallsFor({
          projectId: "project-1",
          skillId: "psk_skillaa",
        });
        skillClient.setActivateRejected(true);
        const ref = {
          projectId: ProjectId.make("project-1"),
          skillId: "psk_skillaa" as ProjectSkillId,
          version: 1,
          contentSha256: SKILL_SHA,
        };
        const rejected = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.activate, {
            environmentId: ENVIRONMENT_ID,
            input: {
              ref,
              expectedStateSeq: 3,
              target: { threadId: ThreadId.make("thread-1"), scriptIds: ["lint"] },
            },
          }),
        );
        expect(rejected._tag).toBe("Failure");
        expect(skillClient.getCallsFor({ projectId: "project-1", skillId: "psk_skillaa" })).toBe(
          getBefore,
        );
        skillClient.setActivateRejected(false);
      }),
    ),
  );

  it.effect("deriveDraft does not bump project-skill write invalidation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, skillClient } = yield* makeHarness();
        skillClient.seed("project-1", "psk_skillaa", "Skill A");
        const listAtom = atoms.list(listTarget("project-1", 50));
        yield* AtomRegistry.getResult(registry, listAtom, { suspendOnWaiting: true });
        const listBefore = skillClient.listCalls;
        const derived = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.deriveDraft, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
              expected: { attemptId: "attempt-1", revision: 0, receiptSequence: 2 },
            },
          }),
        );
        expect(derived._tag).toBe("Success");
        expect(skillClient.deriveCalls).toBe(1);
        expect(skillClient.listCalls).toBe(listBefore);
        expect(skillClient.writeOrder).toEqual([]);
      }),
    ),
  );

  it.effect("repeated reads of one target reuse one stable wrapper atom", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, skillClient } = yield* makeHarness();
        // The same target must resolve to one wrapper atom instance, so
        // consumers cannot resubscribe to a fresh identity; a different limit
        // or skill id stays its own atom.
        const first = atoms.list(listTarget("project-1", 50));
        expect(atoms.list(listTarget("project-1", 50))).toBe(first);
        expect(atoms.list(listTarget("project-1", 5))).not.toBe(first);
        expect(atoms.get(getTarget("project-1", "psk_skillaa"))).not.toBe(
          atoms.get(getTarget("project-1", "psk_skillbb")),
        );

        const mounted = registry.mount(first);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mounted();
          }),
        );
        yield* AtomRegistry.getResult(registry, first, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, first, { suspendOnWaiting: true });
        // The repeated read is served by the cached query, not a second load.
        expect(skillClient.listCalls).toBe(1);
      }),
    ),
  );
});
