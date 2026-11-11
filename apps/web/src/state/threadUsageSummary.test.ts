import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { decideThreadUsageFetch } from "./threadUsageSummary";

const threadId = ThreadId.make("thread");
const other = ThreadId.make("other");
const base = {
  fetchedKey: null,
  fetchedThread: null,
  threadId,
  latestTurnId: null,
  latestTurnSettled: false,
  unsupported: false,
};

describe("decideThreadUsageFetch", () => {
  it("fetches once when a thread opens", () => {
    const decision = decideThreadUsageFetch(base);
    expect(decision.kind).toBe("fetch");
    expect(decision.kind === "fetch" && decision.key).toBe(JSON.stringify([threadId, null, false]));
    // The same open never reissues.
    expect(
      decideThreadUsageFetch({
        ...base,
        fetchedKey: JSON.stringify([threadId, null, false]),
        fetchedThread: threadId,
      }).kind,
    ).toBe("wait");
  });

  it("refetches when a turn started before the open settles", () => {
    const openKey = JSON.stringify([threadId, "turn-1", false]);
    const settled = decideThreadUsageFetch({
      ...base,
      fetchedKey: openKey,
      fetchedThread: threadId,
      latestTurnId: "turn-1",
      latestTurnSettled: true,
    });
    expect(settled.kind).toBe("fetch");
    expect(settled.kind === "fetch" && settled.key).toBe(
      JSON.stringify([threadId, "turn-1", true]),
    );
  });

  it("fetches a settled thread on open and never again while it stays settled", () => {
    const settledKey = JSON.stringify([threadId, "turn-1", true]);
    expect(
      decideThreadUsageFetch({ ...base, latestTurnId: "turn-1", latestTurnSettled: true }).kind,
    ).toBe("fetch");
    expect(
      decideThreadUsageFetch({
        ...base,
        fetchedKey: settledKey,
        fetchedThread: threadId,
        latestTurnId: "turn-1",
        latestTurnSettled: true,
      }).kind,
    ).toBe("wait");
  });

  it("never fetches because a new turn started, only when it settles", () => {
    const settledKey = JSON.stringify([threadId, "turn-1", true]);
    expect(
      decideThreadUsageFetch({
        ...base,
        fetchedKey: settledKey,
        fetchedThread: threadId,
        latestTurnId: "turn-2",
        latestTurnSettled: false,
      }).kind,
    ).toBe("wait");
    expect(
      decideThreadUsageFetch({
        ...base,
        fetchedKey: settledKey,
        fetchedThread: threadId,
        latestTurnId: "turn-2",
        latestTurnSettled: true,
      }).kind,
    ).toBe("fetch");
  });

  it("treats another thread and an unsupported server as wait", () => {
    expect(decideThreadUsageFetch({ ...base, threadId: other }).kind).toBe("fetch");
    expect(decideThreadUsageFetch({ ...base, threadId: null }).kind).toBe("wait");
    expect(decideThreadUsageFetch({ ...base, unsupported: true }).kind).toBe("wait");
  });
});

it("refetches once after the delayed audit finishes", () => {
  const prior = JSON.stringify([threadId, "turn-1", true]);
  const input = {
    ...base,
    fetchedThread: threadId,
    fetchedKey: prior,
    latestTurnId: "turn-1",
    latestTurnSettled: true,
    completedAuditCount: 1,
  };
  expect(decideThreadUsageFetch({ ...input, auditRunning: true }).kind).toBe("wait");
  const result = decideThreadUsageFetch(input);
  expect(result.kind).toBe("fetch");
  if (result.kind === "fetch")
    expect(decideThreadUsageFetch({ ...input, fetchedKey: result.key }).kind).toBe("wait");
});
