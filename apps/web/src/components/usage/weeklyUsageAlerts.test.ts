import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  capWeeklyUsageAlertKeys,
  planWeeklyUsageAlerts,
  selectWeeklyUsageAlerts,
} from "./weeklyUsageAlerts";

const resetsAt = "2026-11-23T00:00:00.000Z";
const weekly = {
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 99,
  resetsAt,
} as const;

function provider(id: string, windows: readonly ServerProviderUsageWindow[]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: resetsAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: resetsAt, windows },
  };
}

function select(...providers: ServerProvider[]) {
  return selectWeeklyUsageAlerts(
    new Map([
      [
        EnvironmentId.make("local"),
        { entry: { target: { label: "Local" } }, serverConfig: { providers } },
      ],
    ]),
  );
}

function alertSequence(...snapshots: ReturnType<typeof select>[]) {
  let stored = new Set<string>();
  return snapshots.map((snapshot) => {
    const { pending, retained } = planWeeklyUsageAlerts(stored, snapshot);
    for (const { key } of pending) retained.add(key);
    capWeeklyUsageAlertKeys(retained, new Set(snapshot.alerts.map(({ key }) => key)));
    stored = retained;
    return pending.length;
  });
}

describe("weekly usage alerts", () => {
  it("re-arms a window without a reset time after usage drops", () => {
    const window = { id: weekly.id, kind: weekly.kind, label: weekly.label, usedPercent: 99 };
    const high = select(provider("codex", [window]));
    const low = select(provider("codex", [{ ...window, usedPercent: 0 }]));
    expect(alertSequence(high, low, high)).toEqual([1, 0, 1]);
  });

  it("remembers a warning when its provider disappears and returns in the same period", () => {
    const high = select(provider("codex", [weekly]));
    expect(alertSequence(high, select(), high)).toEqual([1, 0, 0]);
  });

  it("does not warn again when usage dips below 99% within the same reset period", () => {
    const high = select(provider("codex", [weekly]));
    const dip = select(provider("codex", [{ ...weekly, usedPercent: 98 }]));
    expect(alertSequence(high, dip, high)).toEqual([1, 0, 0]);
  });

  it("warns once per reset period when usage drops before the next warning", () => {
    const first = select(provider("codex", [weekly]));
    const nextWindow = { ...weekly, resetsAt: "2026-11-30T00:00:00.000Z" };
    const low = select(provider("codex", [{ ...nextWindow, usedPercent: 0 }]));
    const next = select(provider("codex", [nextWindow]));
    expect(alertSequence(first, first, low, next)).toEqual([1, 0, 0, 1]);
  });

  it("caps remembered keys at 100 without dropping one that still warns", () => {
    const many = select(
      provider(
        "codex",
        Array.from({ length: 101 }, (_, index) => ({ ...weekly, id: `weekly-${index}` })),
      ),
    );
    expect(alertSequence(many, many, many)).toEqual([101, 0, 0]);
    const keys = new Set(many.alerts.map(({ key }) => key));
    capWeeklyUsageAlertKeys(keys, new Set());
    expect([...keys]).toEqual(many.alerts.slice(1).map(({ key }) => key));
  });

  it("drops malformed stored keys and keeps valid keys for absent windows", () => {
    const key = select(provider("codex", [weekly])).alerts[0]!.key;
    const { retained } = planWeeklyUsageAlerts(new Set(["bad JSON", "null", key]), select());
    expect([...retained]).toEqual([key]);
  });

  it("selects only weekly windows with at least 99% used on enabled providers", () => {
    const { alerts, rearmed } = select(
      provider("codex", [
        weekly,
        { ...weekly, id: "full", usedPercent: 100 },
        { ...weekly, id: "below", usedPercent: 98.99 },
        { id: "no-reset", kind: "weekly", label: "Weekly", usedPercent: 10 },
        { ...weekly, id: "session", kind: "session", usedPercent: 100 },
        { id: "unknown", kind: "weekly", label: "Unknown" } as ServerProviderUsageWindow,
      ]),
      { ...provider("disabled", [weekly]), enabled: false },
    );
    expect(alerts.map(({ window }) => window.id)).toEqual(["weekly", "full"]);
    // Only a window without a reset time re-arms on low usage; the others re-arm by period.
    expect([...rearmed]).toEqual([JSON.stringify(["local:codex", "no-reset"])]);
  });

  it("keys alerts by account, window and reset period, tolerating reset time jitter", () => {
    const first = select(provider("codex", [weekly])).alerts[0]!.key;
    const jittered = select(
      provider("codex", [{ ...weekly, resetsAt: "2026-11-23T00:00:07.412Z" }]),
    );
    expect(jittered.alerts[0]!.key).toBe(first);

    const { alerts } = select(
      provider("codex", [{ ...weekly, resetsAt: "2026-11-30T00:00:00.000Z" }]),
      provider("codex-alt", [weekly, { ...weekly, id: "another" }]),
    );
    expect(alerts.map(({ key }) => key)).not.toContain(first);
    expect(new Set(alerts.map(({ key }) => key)).size).toBe(3);
  });

  it("keeps a merged account's key when its reporting instance changes", () => {
    const auth = { status: "authenticated", email: "account@example.test" } as const;
    const first = select({ ...provider("codex", [weekly]), auth }).alerts[0]!.key;
    const second = select({ ...provider("codex-alt", [weekly]), auth }).alerts[0]!.key;
    expect(second).toBe(first);
  });
});
