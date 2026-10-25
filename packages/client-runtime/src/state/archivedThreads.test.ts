import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
} from "./archivedThreads.ts";

it("round-trips environment keys in sorted order", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeArchivedThreadsEnvironmentKey([envB, envA]);

  expect(parseArchivedThreadsEnvironmentKey(key)).toEqual([envA, envB]);
});

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])))).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    failedEnvironmentIds: [environmentId],
    isLoading: false,
  });

  registry.dispose();
});

it("separates a loading, failed, and loaded archive by environment", () => {
  const loaded = EnvironmentId.make("env-loaded");
  const failed = EnvironmentId.make("env-failed");
  const loading = EnvironmentId.make("env-loading");
  const snapshot = {
    snapshotSequence: 1,
    projects: [],
    threads: [],
  } as unknown as OrchestrationShellSnapshot;
  const results = new Map<
    EnvironmentId,
    Atom.Atom<AsyncResult.AsyncResult<OrchestrationShellSnapshot, Error>>
  >([
    [loaded, Atom.make(AsyncResult.success<OrchestrationShellSnapshot, Error>(snapshot))],
    [
      failed,
      Atom.make(
        AsyncResult.failure<OrchestrationShellSnapshot, Error>(Cause.fail(new Error("down"))),
      ),
    ],
    [loading, Atom.make(AsyncResult.initial<OrchestrationShellSnapshot, Error>(true))],
  ]);
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: (environmentId) => results.get(environmentId)!,
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  const state = registry.get(
    snapshotsAtom(makeArchivedThreadsEnvironmentKey([loaded, failed, loading])),
  );
  expect(state.snapshots).toEqual([{ environmentId: loaded, snapshot }]);
  expect(state.failedEnvironmentIds).toEqual([failed]);
  expect(state.isLoading).toBe(true);

  const empty = registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([loaded])));
  expect(empty).toEqual({
    snapshots: [{ environmentId: loaded, snapshot }],
    error: null,
    failedEnvironmentIds: [],
    isLoading: false,
  });

  registry.dispose();
});
