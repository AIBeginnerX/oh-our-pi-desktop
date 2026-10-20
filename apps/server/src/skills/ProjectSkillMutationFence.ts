/**
 * Process-local mutation fence for project-skill lifecycle writers (F).
 */
import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const tokenBrand = Symbol.for("t3/ProjectSkillMutationFenceToken");

export interface ProjectSkillMutationToken {
  readonly [tokenBrand]: typeof tokenBrand;
  readonly projectId: ProjectId;
  readonly projectRevision: number;
  readonly globalRevision: number;
}

export class ProjectSkillMutationFenceStaleExpect extends Data.TaggedError(
  "ProjectSkillMutationFenceStaleExpect",
)<{
  readonly projectId: ProjectId;
}> {}

type ProjectCounters = {
  revision: number;
  pending: number;
};

export interface ProjectSkillMutationFenceShape {
  readonly acquire: (projectId: ProjectId) => ProjectSkillMutationToken | undefined;
  readonly holds: (token: ProjectSkillMutationToken) => boolean;
  readonly withProjectMutation: {
    <A, E, R>(
      projectIds: ReadonlyArray<ProjectId>,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R>;
    <A, E, R>(
      projectIds: ReadonlyArray<ProjectId>,
      effect: Effect.Effect<A, E, R>,
      options: { readonly expect: ProjectSkillMutationToken },
    ): Effect.Effect<A, E | ProjectSkillMutationFenceStaleExpect, R>;
  };
  readonly withGlobalMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly withUseClaimMutation: <A, E, R>(
    projectId: ProjectId,
    effect: Effect.Effect<A, E, R>,
    options: {
      readonly expect: ProjectSkillMutationToken;
      readonly definiteEntered: (value: A) => boolean;
    },
  ) => Effect.Effect<
    { readonly value: A; readonly successor: ProjectSkillMutationToken | undefined },
    E | ProjectSkillMutationFenceStaleExpect,
    R
  >;
  readonly snapshotCounters: () => {
    readonly globalRevision: number;
    readonly globalPending: number;
    readonly projectRevision: (projectId: ProjectId) => number;
    readonly projectPending: (projectId: ProjectId) => number;
  };
}

export class ProjectSkillMutationFence extends Context.Service<
  ProjectSkillMutationFence,
  ProjectSkillMutationFenceShape
>()("t3/skills/ProjectSkillMutationFence") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  let globalRevision = 0;
  let globalPending = 0;
  const projectCounters = new Map<ProjectId, ProjectCounters>();
  const issuedTokens = new WeakSet<ProjectSkillMutationToken>();

  const countersFor = (projectId: ProjectId): ProjectCounters => {
    const existing = projectCounters.get(projectId);
    if (existing !== undefined) return existing;
    const fresh = { revision: 0, pending: 0 };
    projectCounters.set(projectId, fresh);
    return fresh;
  };

  const refuseNestedTransaction = Effect.flatMap(
    Effect.serviceOption(sql.transactionService),
    (active) =>
      Option.isSome(active)
        ? Effect.die(new Error("ProjectSkillMutationFence must not run inside sql.withTransaction"))
        : Effect.void,
  );

  const acquire = (projectId: ProjectId): ProjectSkillMutationToken | undefined => {
    if (globalPending > 0) return undefined;
    const project = countersFor(projectId);
    if (project.pending > 0) return undefined;
    return registerToken(projectId, project.revision, globalRevision);
  };

  const registerToken = (
    projectId: ProjectId,
    projectRevision: number,
    tokenGlobalRevision: number,
  ): ProjectSkillMutationToken => {
    const token = Object.freeze({
      [tokenBrand]: tokenBrand,
      projectId,
      projectRevision,
      globalRevision: tokenGlobalRevision,
    }) as ProjectSkillMutationToken;
    issuedTokens.add(token);
    return token;
  };

  const holds = (token: ProjectSkillMutationToken): boolean => {
    if (!issuedTokens.has(token)) return false;
    if (globalPending > 0) return false;
    const project = countersFor(token.projectId);
    if (project.pending > 0) return false;
    return token.globalRevision === globalRevision && token.projectRevision === project.revision;
  };

  const syncBeginProjectMutation = (
    uniqueProjectIds: ReadonlyArray<ProjectId>,
    expect: ProjectSkillMutationToken | undefined,
  ): void | ProjectSkillMutationFenceStaleExpect => {
    if (expect !== undefined) {
      if (!uniqueProjectIds.includes(expect.projectId)) {
        throw new Error("ProjectSkillMutationFence expect.projectId must belong to mutation set");
      }
      if (!holds(expect)) {
        return new ProjectSkillMutationFenceStaleExpect({ projectId: expect.projectId });
      }
    }
    for (const projectId of uniqueProjectIds) {
      const project = countersFor(projectId);
      project.revision += 1;
      project.pending += 1;
    }
    return undefined;
  };

  const syncEndProjectMutation = (uniqueProjectIds: ReadonlyArray<ProjectId>): void => {
    for (const projectId of uniqueProjectIds) {
      const project = countersFor(projectId);
      project.pending -= 1;
      project.revision += 1;
    }
  };

  const syncBeginGlobalMutation = (): void => {
    globalRevision += 1;
    globalPending += 1;
  };

  const syncEndGlobalMutation = (): void => {
    globalPending -= 1;
    globalRevision += 1;
  };

  function bracketMutation<A, E, EAcquire, R>(
    acquisition: Effect.Effect<void, EAcquire>,
    releaseSync: () => void,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | EAcquire, R> {
    return refuseNestedTransaction.pipe(
      Effect.flatMap(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.acquireUseRelease(
            acquisition,
            () => Effect.interruptible(restore(effect)),
            () => Effect.uninterruptible(Effect.sync(releaseSync)),
          ),
        ),
      ),
    );
  }

  function withProjectMutationNoExpect<A, E, R>(
    projectIds: ReadonlyArray<ProjectId>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    const uniqueProjectIds = [...new Set(projectIds)];
    return bracketMutation(
      Effect.sync(() => {
        syncBeginProjectMutation(uniqueProjectIds, undefined);
      }),
      () => syncEndProjectMutation(uniqueProjectIds),
      effect,
    );
  }

  function withProjectMutationExpect<A, E, R>(
    projectIds: ReadonlyArray<ProjectId>,
    effect: Effect.Effect<A, E, R>,
    options: { readonly expect: ProjectSkillMutationToken },
  ): Effect.Effect<A, E | ProjectSkillMutationFenceStaleExpect, R> {
    const uniqueProjectIds = [...new Set(projectIds)];
    return bracketMutation(
      Effect.suspend((): Effect.Effect<void, ProjectSkillMutationFenceStaleExpect> => {
        const rejected = syncBeginProjectMutation(uniqueProjectIds, options.expect);
        return rejected === undefined ? Effect.void : Effect.fail(rejected);
      }),
      () => syncEndProjectMutation(uniqueProjectIds),
      effect,
    );
  }

  const syncBeginUseClaimMutation = (
    projectId: ProjectId,
    expect: ProjectSkillMutationToken,
  ):
    | { readonly beginRev: number; readonly expectedGlobalRevision: number }
    | ProjectSkillMutationFenceStaleExpect => {
    if (expect.projectId !== projectId) {
      throw new Error("withUseClaimMutation projectId must match expect.projectId");
    }
    if (!holds(expect)) {
      return new ProjectSkillMutationFenceStaleExpect({ projectId: expect.projectId });
    }
    const project = countersFor(projectId);
    const beginRev = project.revision + 1;
    const expectedGlobalRevision = globalRevision;
    project.revision = beginRev;
    project.pending += 1;
    return { beginRev, expectedGlobalRevision };
  };

  const isStrictEntered = (outcome: unknown): boolean => {
    if (outcome !== true || typeof outcome !== "boolean") return false;
    if (typeof outcome === "object" && outcome !== null && "then" in outcome) return false;
    return true;
  };

  const syncEndUseClaimMutation = <A>(
    projectId: ProjectId,
    beginRev: number,
    expectedGlobalRevision: number,
    exit: Exit.Exit<A, unknown>,
    definiteEntered: (value: A) => boolean,
  ): ProjectSkillMutationToken | undefined => {
    const project = countersFor(projectId);
    let issueSuccessor = false;
    try {
      if (Exit.isSuccess(exit)) {
        let entered = false;
        try {
          entered = isStrictEntered(definiteEntered(exit.value));
        } catch {
          entered = false;
        }
        issueSuccessor =
          entered &&
          project.pending === 1 &&
          project.revision === beginRev &&
          globalRevision === expectedGlobalRevision &&
          globalPending === 0;
      }
    } finally {
      project.pending -= 1;
      project.revision += 1;
    }
    return issueSuccessor ? registerToken(projectId, project.revision, globalRevision) : undefined;
  };

  const withUseClaimMutation = <A, E, R>(
    projectId: ProjectId,
    effect: Effect.Effect<A, E, R>,
    options: {
      readonly expect: ProjectSkillMutationToken;
      readonly definiteEntered: (value: A) => boolean;
    },
  ): Effect.Effect<
    { readonly value: A; readonly successor: ProjectSkillMutationToken | undefined },
    E | ProjectSkillMutationFenceStaleExpect,
    R
  > =>
    refuseNestedTransaction.pipe(
      Effect.flatMap(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const begin = yield* Effect.suspend(
              (): Effect.Effect<
                { readonly beginRev: number; readonly expectedGlobalRevision: number },
                ProjectSkillMutationFenceStaleExpect
              > => {
                const rejected = syncBeginUseClaimMutation(projectId, options.expect);
                return rejected instanceof ProjectSkillMutationFenceStaleExpect
                  ? Effect.fail(rejected)
                  : Effect.succeed(rejected);
              },
            );
            const exit = yield* Effect.exit(Effect.interruptible(restore(effect)));
            const successor = yield* Effect.uninterruptible(
              Effect.sync(() =>
                syncEndUseClaimMutation(
                  projectId,
                  begin.beginRev,
                  begin.expectedGlobalRevision,
                  exit,
                  options.definiteEntered,
                ),
              ),
            );
            if (Exit.isFailure(exit)) {
              return yield* Effect.failCause(exit.cause);
            }
            return { value: exit.value, successor };
          }),
        ),
      ),
    );

  const withProjectMutation: ProjectSkillMutationFenceShape["withProjectMutation"] =
    function withProjectMutationOverload<A, E, R>(
      projectIds: ReadonlyArray<ProjectId>,
      effect: Effect.Effect<A, E, R>,
      options?: { readonly expect?: ProjectSkillMutationToken },
    ) {
      if (options?.expect === undefined) {
        return withProjectMutationNoExpect(projectIds, effect);
      }
      return withProjectMutationExpect(projectIds, effect, { expect: options.expect });
    };

  const withGlobalMutation = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    refuseNestedTransaction.pipe(
      Effect.flatMap(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.acquireUseRelease(
            Effect.sync(syncBeginGlobalMutation),
            () => Effect.interruptible(restore(effect)),
            () => Effect.uninterruptible(Effect.sync(syncEndGlobalMutation)),
          ),
        ),
      ),
    );

  return {
    acquire,
    holds,
    withProjectMutation,
    withGlobalMutation,
    withUseClaimMutation,
    snapshotCounters: () => ({
      globalRevision,
      globalPending,
      projectRevision: (projectId: ProjectId) => countersFor(projectId).revision,
      projectPending: (projectId: ProjectId) => countersFor(projectId).pending,
    }),
  } satisfies ProjectSkillMutationFenceShape;
});

export const layer = Layer.effect(ProjectSkillMutationFence, make);
