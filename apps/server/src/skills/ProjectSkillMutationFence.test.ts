import { ProjectId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProjectSkillMutationFence,
  ProjectSkillMutationFenceStaleExpect,
  layer as ProjectSkillMutationFenceLayer,
  type ProjectSkillMutationToken,
} from "./ProjectSkillMutationFence.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const fenceLayer = ProjectSkillMutationFenceLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

describe("ProjectSkillMutationFence", () => {
  it.effect("acquire returns undefined only for the project with pending mutation", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const tokenA = fence.acquire(projectA);
      expect(tokenA).toBeDefined();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* fence
        .withProjectMutation(
          [projectA],
          Effect.flatMap(Deferred.succeed(entered, undefined), () => Deferred.await(release)),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(fence.acquire(projectA)).toBeUndefined();
      expect(fence.acquire(projectB)).toBeDefined();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("holds only the same issued token instance and revisions", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      expect(fence.holds(token!)).toBe(true);
      const forged = { ...token! } as ProjectSkillMutationToken;
      expect(fence.holds(forged)).toBe(false);
      yield* fence.withProjectMutation([projectA], Effect.void);
      expect(fence.holds(token!)).toBe(false);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("project mutation invalidates only that project's token", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const tokenA = fence.acquire(projectA);
      const tokenB = fence.acquire(projectB);
      expect(tokenA).toBeDefined();
      expect(tokenB).toBeDefined();
      yield* fence.withProjectMutation([projectA], Effect.void);
      expect(fence.holds(tokenA!)).toBe(false);
      expect(fence.holds(tokenB!)).toBe(true);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("global mutation invalidates every project token", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const tokenA = fence.acquire(projectA);
      const tokenB = fence.acquire(projectB);
      expect(tokenA).toBeDefined();
      expect(tokenB).toBeDefined();
      yield* fence.withGlobalMutation(Effect.void);
      expect(fence.holds(tokenA!)).toBe(false);
      expect(fence.holds(tokenB!)).toBe(false);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("expect must match before the synchronous pending bump", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      yield* fence.withProjectMutation([projectA], Effect.void, { expect: token! });
      const stale = yield* fence
        .withProjectMutation([projectA], Effect.void, { expect: token! })
        .pipe(Effect.flip);
      expect(stale).toBeInstanceOf(ProjectSkillMutationFenceStaleExpect);
      const fresh = fence.acquire(projectA);
      expect(fresh).toBeDefined();
      yield* fence.withProjectMutation([projectA], Effect.void, { expect: fresh! });
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("deduplicates project ids, holds pending 1 in body, and rejects stale expect", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      yield* fence.withProjectMutation(
        [projectA, projectA],
        Effect.sync(() => {
          expect(fence.snapshotCounters().projectPending(projectA)).toBe(1);
        }),
      );
      const exit = yield* fence
        .withProjectMutation([projectA], Effect.void, { expect: token! })
        .pipe(Effect.flip);
      expect(exit).toBeInstanceOf(ProjectSkillMutationFenceStaleExpect);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("rejects expect membership without bumping counters or running body", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const tokenB = fence.acquire(projectB);
      expect(tokenB).toBeDefined();
      const pendingBefore = fence.snapshotCounters().projectPending(projectA);
      let bodyRan = false;
      const exit = yield* fence
        .withProjectMutation(
          [projectA],
          Effect.sync(() => {
            bodyRan = true;
          }),
          { expect: tokenB! },
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(bodyRan).toBe(false);
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(pendingBefore);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("interruption releases project pending without leaking holds", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const started = yield* Deferred.make<void>();
      const fiber = yield* fence
        .withProjectMutation(
          [projectA],
          Effect.flatMap(Deferred.succeed(started, undefined), () => Effect.never),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(1);
      expect(fence.snapshotCounters().projectPending(projectB)).toBe(0);
      yield* Fiber.interrupt(fiber);
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(0);
      expect(fence.holds(token!)).toBe(false);
      expect(fence.acquire(projectA)).toBeDefined();
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("uninterruptible caller still interrupts fenced mutation work and releases", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const started = yield* Deferred.make<void>();
      const fiber = yield* Effect.uninterruptible(
        fence.withProjectMutation(
          [projectA],
          Effect.flatMap(Deferred.succeed(started, undefined), () => Effect.never),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(1);
      yield* Fiber.interrupt(fiber);
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(0);
      expect(fence.holds(token!)).toBe(false);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("refuses nested sql transactions before acquiring or running body", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const sql = yield* SqlClient.SqlClient;
      const pendingBefore = fence.snapshotCounters().projectPending(projectA);
      let bodyRan = false;
      const exit = yield* sql
        .withTransaction(
          fence.withProjectMutation(
            [projectA],
            Effect.sync(() => {
              bodyRan = true;
            }),
          ),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(bodyRan).toBe(false);
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(pendingBefore);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("rolls back nested sql work and preserves mixed fail+interrupt cause", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE project_skill_fence_fixture (id TEXT PRIMARY KEY)`;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const injected = new Error("project-skill-fence-injected");
      const exit = yield* fence
        .withProjectMutation(
          [projectA],
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO project_skill_fence_fixture (id) VALUES ('row')`;
              return yield* Effect.failCause(
                Cause.combine(Cause.fail(injected), Cause.interrupt(42)),
              );
            }),
          ),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failReasons = exit.cause.reasons.filter(Cause.isFailReason);
        const interruptReasons = exit.cause.reasons.filter(Cause.isInterruptReason);
        expect(failReasons.some((reason) => reason.error === injected)).toBe(true);
        expect(interruptReasons.some((reason) => reason.fiberId === 42)).toBe(true);
      }
      const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM project_skill_fence_fixture
      `;
      expect(rows).toHaveLength(0);
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(0);
      expect(fence.holds(token!)).toBe(false);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("withUseClaimMutation mints a live successor and invalidates the expect token", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const { successor } = yield* fence.withUseClaimMutation(projectA, Effect.succeed("entered"), {
        expect: token!,
        definiteEntered: (value) => value === "entered",
      });
      expect(successor).toBeDefined();
      expect(fence.holds(token!)).toBe(false);
      expect(fence.holds(successor!)).toBe(true);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("withUseClaimMutation rejects stale expect before running the body", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      yield* fence.withProjectMutation([projectA], Effect.void);
      let bodyRan = false;
      const stale = yield* fence
        .withUseClaimMutation(
          projectA,
          Effect.sync(() => {
            bodyRan = true;
            return null;
          }),
          { expect: token!, definiteEntered: () => true },
        )
        .pipe(Effect.flip);
      expect(stale).toBeInstanceOf(ProjectSkillMutationFenceStaleExpect);
      expect(bodyRan).toBe(false);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("withUseClaimMutation rejects expect for the wrong project", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const tokenB = fence.acquire(projectB);
      expect(tokenB).toBeDefined();
      const pendingBefore = fence.snapshotCounters().projectPending(projectA);
      let bodyRan = false;
      const exit = yield* fence
        .withUseClaimMutation(
          projectA,
          Effect.sync(() => {
            bodyRan = true;
          }),
          { expect: tokenB!, definiteEntered: () => true },
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(bodyRan).toBe(false);
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(pendingBefore);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("withUseClaimMutation releases without a successor when definiteEntered is false", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const { successor } = yield* fence.withUseClaimMutation(projectA, Effect.succeed(1), {
        expect: token!,
        definiteEntered: () => false,
      });
      expect(successor).toBeUndefined();
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(0);
      expect(fence.holds(token!)).toBe(false);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("withUseClaimMutation releases without a successor when definiteEntered throws", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const { successor } = yield* fence.withUseClaimMutation(projectA, Effect.succeed(null), {
        expect: token!,
        definiteEntered: () => {
          throw new Error("predicate exploded");
        },
      });
      expect(successor).toBeUndefined();
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(0);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect(
    "withUseClaimMutation does not treat truthy non-boolean predicate results as entered",
    () =>
      Effect.gen(function* () {
        const fence = yield* ProjectSkillMutationFence;
        const token = fence.acquire(projectA);
        expect(token).toBeDefined();
        const { successor } = yield* fence.withUseClaimMutation(projectA, Effect.succeed("x"), {
          expect: token!,
          definiteEntered: () => "yes" as unknown as boolean,
        });
        expect(successor).toBeUndefined();
      }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("withUseClaimMutation preserves fail cause and releases without a successor", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const injected = new Error("use-claim-fail");
      const exit = yield* fence
        .withUseClaimMutation(projectA, Effect.fail(injected), {
          expect: token!,
          definiteEntered: () => true,
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failReasons = exit.cause.reasons.filter(Cause.isFailReason);
        expect(failReasons.some((reason) => reason.error === injected)).toBe(true);
      }
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(0);
      expect(fence.holds(token!)).toBe(false);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("withUseClaimMutation releases without a successor on interruption", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const started = yield* Deferred.make<void>();
      const fiber = yield* fence
        .withUseClaimMutation(
          projectA,
          Effect.flatMap(Deferred.succeed(started, undefined), () => Effect.never),
          { expect: token!, definiteEntered: () => true },
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(1);
      yield* Fiber.interrupt(fiber);
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(0);
      expect(fence.holds(token!)).toBe(false);
      expect(fence.acquire(projectA)).toBeDefined();
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("withUseClaimMutation withholds successor when another writer completes first", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const entered = yield* Deferred.make<void>();
      const releaseClaim = yield* Deferred.make<void>();
      const claimFiber = yield* fence
        .withUseClaimMutation(
          projectA,
          Effect.flatMap(Deferred.succeed(entered, undefined), () => Deferred.await(releaseClaim)),
          { expect: token!, definiteEntered: () => true },
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* fence.withProjectMutation([projectA], Effect.void);
      yield* Deferred.succeed(releaseClaim, undefined);
      const exit = yield* Fiber.join(claimFiber);
      expect(exit.successor).toBeUndefined();
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(0);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect(
    "withUseClaimMutation overlap on another project does not block successor issuance",
    () =>
      Effect.gen(function* () {
        const fence = yield* ProjectSkillMutationFence;
        const token = fence.acquire(projectA);
        expect(token).toBeDefined();
        const entered = yield* Deferred.make<void>();
        const releaseClaim = yield* Deferred.make<void>();
        const claimFiber = yield* fence
          .withUseClaimMutation(
            projectA,
            Effect.flatMap(Deferred.succeed(entered, undefined), () =>
              Deferred.await(releaseClaim),
            ),
            { expect: token!, definiteEntered: () => true },
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* fence.withProjectMutation([projectB], Effect.void);
        yield* Deferred.succeed(releaseClaim, undefined);
        const exit = yield* Fiber.join(claimFiber);
        expect(exit.successor).toBeDefined();
        expect(fence.holds(exit.successor!)).toBe(true);
      }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("withUseClaimMutation mints successor only after sql transaction commits", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE project_skill_use_claim_success (id TEXT PRIMARY KEY)`;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const { successor } = yield* fence.withUseClaimMutation(
        projectA,
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO project_skill_use_claim_success (id) VALUES ('row')`;
            return "ok";
          }),
        ),
        {
          expect: token!,
          definiteEntered: (value) => value === "ok",
        },
      );
      expect(successor).toBeDefined();
      expect(fence.holds(successor!)).toBe(true);
      const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM project_skill_use_claim_success
      `;
      expect(rows).toHaveLength(1);
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("withUseClaimMutation rolls back sql work and withholds successor", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE project_skill_use_claim_rollback (id TEXT PRIMARY KEY)`;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const injected = new Error("use-claim-rollback");
      const exit = yield* fence
        .withUseClaimMutation(
          projectA,
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO project_skill_use_claim_rollback (id) VALUES ('row')`;
              return yield* Effect.fail(injected);
            }),
          ),
          { expect: token!, definiteEntered: () => true },
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM project_skill_use_claim_rollback
      `;
      expect(rows).toHaveLength(0);
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(0);
      expect(fence.acquire(projectA)).toBeDefined();
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect(
    "withUseClaimMutation withholds successor when global mutation overlaps before release",
    () =>
      Effect.gen(function* () {
        const fence = yield* ProjectSkillMutationFence;
        const token = fence.acquire(projectA);
        expect(token).toBeDefined();
        const entered = yield* Deferred.make<void>();
        const releaseClaim = yield* Deferred.make<void>();
        const claimFiber = yield* fence
          .withUseClaimMutation(
            projectA,
            Effect.flatMap(Deferred.succeed(entered, undefined), () =>
              Deferred.await(releaseClaim),
            ),
            { expect: token!, definiteEntered: () => true },
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* fence.withGlobalMutation(Effect.void);
        yield* Deferred.succeed(releaseClaim, undefined);
        const exit = yield* Fiber.join(claimFiber);
        expect(exit.successor).toBeUndefined();
      }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("withUseClaimMutation does not treat a thenable predicate result as entered", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const { successor } = yield* fence.withUseClaimMutation(projectA, Effect.succeed(null), {
        expect: token!,
        definiteEntered: () => Promise.resolve(true) as unknown as boolean,
      });
      expect(successor).toBeUndefined();
    }).pipe(Effect.provide(fenceLayer)),
  );

  it.effect("withUseClaimMutation refuses nested sql transactions", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const sql = yield* SqlClient.SqlClient;
      const token = fence.acquire(projectA);
      expect(token).toBeDefined();
      const pendingBefore = fence.snapshotCounters().projectPending(projectA);
      let bodyRan = false;
      const exit = yield* sql
        .withTransaction(
          fence.withUseClaimMutation(
            projectA,
            Effect.sync(() => {
              bodyRan = true;
            }),
            { expect: token!, definiteEntered: () => true },
          ),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(bodyRan).toBe(false);
      expect(fence.snapshotCounters().projectPending(projectA)).toBe(pendingBefore);
    }).pipe(Effect.provide(fenceLayer)),
  );
});
