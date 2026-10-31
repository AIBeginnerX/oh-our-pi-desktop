import type { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { CommandRejectedError } from "../link/transport.ts";
import { createSettingsPatcher } from "./settingsPatch.ts";

const fakeLink = (initial: Record<string, unknown>) => {
  let settings = initial;
  const sent: ServerSettingsPatch[] = [];
  let fail: Error | null = null;
  const gate: { release: () => void; waiting: Promise<void> | null } = {
    release: () => undefined,
    waiting: null,
  };
  return {
    sent,
    failWith: (error: Error | null) => void (fail = error),
    hold: () => {
      gate.waiting = new Promise<void>((resolve) => void (gate.release = resolve));
    },
    release: () => gate.release(),
    now: () => settings,
    link: {
      getSettings: async () => settings as unknown as ServerSettings,
      updateSettings: async (patch: ServerSettingsPatch) => {
        if (gate.waiting) await gate.waiting;
        if (fail) throw fail;
        sent.push(patch);
        settings = { ...settings, ...patch };
        return settings as unknown as ServerSettings;
      },
    },
  };
};

describe("createSettingsPatcher", () => {
  it("builds the patch from the settings it just read", async () => {
    const fake = fakeLink({ threadGoals: { a: 1 } });
    const patch = createSettingsPatcher(fake.link);
    const result = await patch(
      (current) =>
        ({
          threadGoals: { ...(current as unknown as { threadGoals: object }).threadGoals, b: 2 },
        }) as unknown as ServerSettingsPatch,
    );
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(fake.sent).toEqual([{ threadGoals: { a: 1, b: 2 } }]);
  });

  it("sends nothing when the builder has nothing to change", async () => {
    const fake = fakeLink({});
    const result = await createSettingsPatcher(fake.link)(() => null);
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(fake.sent).toEqual([]);
  });

  it("runs patches one at a time, each from what the one before left", async () => {
    const fake = fakeLink({ threadGoals: {} });
    const patch = createSettingsPatcher(fake.link);
    fake.hold();
    const add = (key: string) =>
      patch(
        (current) =>
          ({
            threadGoals: {
              ...(current as unknown as { threadGoals: object }).threadGoals,
              [key]: true,
            },
          }) as unknown as ServerSettingsPatch,
      );
    const first = add("a");
    const second = add("b");
    fake.release();
    await Promise.all([first, second]);
    expect(fake.sent.at(-1)).toEqual({ threadGoals: { a: true, b: true } });
  });

  it("reports a failure as a result, one clean line, and keeps going", async () => {
    const fake = fakeLink({});
    const patch = createSettingsPatcher(fake.link);
    fake.failWith(new Error("끊김\u001b[2J\n두번째 줄"));
    const failed = await patch(() => ({}) as ServerSettingsPatch);
    expect(failed).toEqual({ ok: false, rejected: false, message: "끊김" });
    fake.failWith(new CommandRejectedError("거절"));
    expect(await patch(() => ({}) as ServerSettingsPatch)).toMatchObject({
      ok: false,
      rejected: true,
    });
    fake.failWith(null);
    expect(await patch(() => ({}) as ServerSettingsPatch)).toMatchObject({ ok: true });
  });
});
