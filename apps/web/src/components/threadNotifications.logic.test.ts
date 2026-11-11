import { describe, expect, it } from "vite-plus/test";

import {
  NO_ACTIVITY_ALERT_CHECK_MS,
  isNoActivityAlertCandidate,
  noActivityAlertKey,
  noActivityAlerts,
  type NoActivityAlertThread,
} from "./threadNotifications.logic";

const T0 = "2026-10-15T00:00:00.000Z";
const T0_MS = Date.parse(T0);
const minutes = (count: number) => new Date(T0_MS + count * 60_000).toISOString();

const thread = (overrides: Partial<NoActivityAlertThread> = {}): NoActivityAlertThread => ({
  archivedAt: null,
  updatedAt: T0,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestTurn: { state: "running", turnId: "turn-1" },
  ...overrides,
});

const alertAt = (
  threads: readonly NoActivityAlertThread[],
  nowMs: number,
  alertMinutes: number | null = 10,
  alerted: Set<string> = new Set(),
) => noActivityAlerts(threads, nowMs, alertMinutes, alerted);

describe("noActivityAlerts", () => {
  it("checks at the server's throttled push cadence", () => {
    expect(NO_ACTIVITY_ALERT_CHECK_MS).toBeGreaterThanOrEqual(30_000);
    expect(NO_ACTIVITY_ALERT_CHECK_MS).toBeLessThanOrEqual(60_000);
  });

  it("alerts the moment the silence reaches the threshold, not before", () => {
    expect(alertAt([thread()], T0_MS + 10 * 60_000 - 1)).toHaveLength(0);
    expect(alertAt([thread()], T0_MS + 10 * 60_000)).toEqual([thread()]);
  });

  it("does not alert a thread waiting on approval or user input", () => {
    expect(alertAt([thread({ hasPendingApprovals: true })], T0_MS + 30 * 60_000)).toHaveLength(0);
    expect(alertAt([thread({ hasPendingUserInput: true })], T0_MS + 30 * 60_000)).toHaveLength(0);
  });

  it("does not alert archived threads or threads whose turn stopped running", () => {
    expect(alertAt([thread({ archivedAt: minutes(1) })], T0_MS + 30 * 60_000)).toHaveLength(0);
    expect(
      alertAt(
        [thread({ latestTurn: { state: "completed", turnId: "turn-1" } })],
        T0_MS + 30 * 60_000,
      ),
    ).toHaveLength(0);
  });

  it("alerts once per silence and skips a thread that already alerted", () => {
    const alerted = new Set<string>();
    expect(alertAt([thread()], T0_MS + 11 * 60_000, 10, alerted)).toHaveLength(1);
    expect(alertAt([thread()], T0_MS + 20 * 60_000, 10, alerted)).toHaveLength(0);
    expect(alerted).toEqual(new Set([noActivityAlertKey(thread())]));
  });

  it("re-arms after new activity and alerts once for the new silence", () => {
    const alerted = new Set<string>();
    expect(alertAt([thread()], T0_MS + 10 * 60_000, 10, alerted)).toHaveLength(1);
    const active = thread({ updatedAt: minutes(12) });
    expect(alertAt([active], T0_MS + 21 * 60_000 + 59_999, 10, alerted)).toHaveLength(0);
    expect(alertAt([active], T0_MS + 22 * 60_000, 10, alerted)).toHaveLength(1);
    expect(alerted).toEqual(new Set([noActivityAlertKey(active)]));
  });

  it("is off with null minutes and reads nothing", () => {
    const trap = new Proxy([], {
      get() {
        throw new Error("read while the setting is off");
      },
    });
    expect(noActivityAlerts(trap, T0_MS, null, trap as unknown as Set<string>)).toEqual([]);
  });

  it("keeps keys of threads that still qualify and drops the rest", () => {
    const alerted = new Set<string>([
      noActivityAlertKey(thread()),
      noActivityAlertKey(thread({ latestTurn: { state: "running", turnId: "turn-0" } })),
    ]);
    expect(alertAt([thread()], T0_MS + 5 * 60_000, 10, alerted)).toHaveLength(0);
    expect(alerted).toEqual(new Set([noActivityAlertKey(thread())]));
  });

  it("skips a silence it cannot measure", () => {
    expect(alertAt([thread({ updatedAt: "not a time" })], T0_MS + 30 * 60_000)).toHaveLength(0);
  });
});

describe("isNoActivityAlertCandidate", () => {
  it("accepts exactly a running, unarchived thread that is not waiting on the user", () => {
    expect(isNoActivityAlertCandidate(thread())).toBe(true);
    expect(isNoActivityAlertCandidate(thread({ latestTurn: null }))).toBe(false);
    expect(isNoActivityAlertCandidate(thread({ hasPendingApprovals: true }))).toBe(false);
    expect(isNoActivityAlertCandidate(thread({ hasPendingUserInput: true }))).toBe(false);
    expect(isNoActivityAlertCandidate(thread({ archivedAt: minutes(1) }))).toBe(false);
  });
});

describe("noActivityAlertKey", () => {
  it("keys a silence by its turn and its last activity", () => {
    expect(noActivityAlertKey(thread())).toBe(`turn-1:${T0}`);
    expect(noActivityAlertKey(thread({ updatedAt: minutes(3) }))).toBe("turn-1:" + minutes(3));
  });
});
