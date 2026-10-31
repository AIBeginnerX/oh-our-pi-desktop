import { describe, expect, it } from "vite-plus/test";

import {
  makeFakeSession,
  makeFakeTransport,
  manualSleep,
  statusWatcher,
} from "../testing/fakeTransport.ts";
import {
  makeConfig,
  makeProject,
  makeSnapshot,
  makeThread,
  makeThreadShell,
  messageSentEvent,
  threadSnapshotItem,
} from "../testing/fixtures.ts";
import { backoffDelay, LinkClient, type LinkOptions } from "./client.ts";
import { TransportError } from "./transport.ts";

const snapshotItem = (sequence: number, titles: string[] = ["스레드"]) =>
  ({
    kind: "snapshot",
    snapshot: makeSnapshot(
      [makeProject()],
      titles.map((title, index) => makeThreadShell({ id: `thread-${index + 1}`, title })),
      sequence,
    ),
  }) as const;

const setup = (
  outcomes: Parameters<typeof makeFakeTransport>[0],
  options: Partial<LinkOptions> = {},
) => {
  const transport = makeFakeTransport(outcomes);
  const watcher = statusWatcher();
  const sleeper = manualSleep();
  const failures: Array<{ threadId: string; message: string }> = [];
  const configs: unknown[] = [];
  const client = new LinkClient(
    transport,
    {
      status: watcher.record,
      shell: () => undefined,
      config: (config) => configs.push(config),
      thread: () => undefined,
      threadFailed: (threadId, message) => failures.push({ threadId, message }),
    },
    { sleep: sleeper.sleep, random: () => 0.5, ...options },
  );
  return { client, transport, watcher, sleeper, failures, configs };
};

describe("backoffDelay", () => {
  it("doubles from half a second up to a ten second cap, spread by ±20%", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffDelay(attempt, () => 0.5))).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
    expect(backoffDelay(1, () => 0)).toBe(400);
    expect(backoffDelay(1, () => 1)).toBe(600);
  });
});

describe("LinkClient", () => {
  it("goes online, mirrors the shell, and subscribes from scratch the first time", async () => {
    const session = makeFakeSession();
    const { client, watcher } = setup([session]);
    void client.start();
    await watcher.until((status) => status.phase === "online");
    expect(session.shell[0]?.input).toEqual({});
    session.shell[0]?.handlers.onItem(snapshotItem(7));
    expect(client.shell?.snapshotSequence).toBe(7);
    expect(client.config?.threadSnapshotPagination).toBe(true);
    await client.stop();
    expect(session.closedByClient).toBe(true);
    expect(client.status.phase).toBe("stopped");
  });

  it("applies shell events after the snapshot and ignores stale ones", async () => {
    const session = makeFakeSession();
    const { client, watcher } = setup([session]);
    void client.start();
    await watcher.until((status) => status.phase === "online");
    const handlers = session.shell[0]!.handlers;
    handlers.onItem(snapshotItem(5));
    handlers.onItem({
      kind: "thread-upserted",
      sequence: 6,
      thread: makeThreadShell({ id: "thread-9", title: "새 스레드" }),
    });
    handlers.onItem({
      kind: "thread-upserted",
      sequence: 4,
      thread: makeThreadShell({ id: "thread-8" }),
    });
    expect(client.shell?.threads.map((thread) => thread.title)).toEqual(["스레드", "새 스레드"]);
    expect(client.shell?.snapshotSequence).toBe(6);
    await client.stop();
  });

  it("reconnects after a drop and resumes both streams from the last sequence it applied", async () => {
    const first = makeFakeSession();
    const second = makeFakeSession(
      makeConfig({ shellResumeCompletionMarker: true, threadResumeCompletionMarker: true }),
    );
    const { client, watcher, sleeper } = setup([first, second]);
    void client.start();
    await watcher.until((status) => status.phase === "online");
    first.shell[0]!.handlers.onItem(snapshotItem(10));
    client.openThread(makeThread().id);
    first.threads[0]!.handlers.onItem(threadSnapshotItem(makeThread(), 20));
    first.threads[0]!.handlers.onItem(messageSentEvent(21, { messageId: "m1", text: "안녕" }));

    first.drop("소켓이 닫혔습니다");
    await watcher.until((status) => status.phase === "reconnecting" && status.retryAt !== null);
    expect(first.shell[0]?.cancelled).toBe(true);
    expect(first.threads[0]?.cancelled).toBe(true);
    expect(client.status.detail).toBe("소켓이 닫혔습니다");
    expect(sleeper.delays).toEqual([500]);

    const online = watcher.seen.length;
    sleeper.release();
    await watcher.until(
      (status) => watcher.seen.indexOf(status) >= online && status.phase === "online",
    );
    expect(second.shell[0]?.input).toEqual({ afterSequence: 10, requestCompletionMarker: true });
    expect(second.threads[0]?.input).toMatchObject({
      threadId: "thread-1",
      afterSequence: 21,
      requestCompletionMarker: true,
    });
    // The thread the user was reading is still there while the link was down.
    expect(client.thread.thread?.messages.map((message) => message.text)).toEqual(["안녕"]);
    await client.stop();
  });

  it("asks for a windowed thread load only when the server supports it", async () => {
    const paged = makeFakeSession(makeConfig({ threadSnapshotPagination: true }));
    const legacy = makeFakeSession(makeConfig({ threadSnapshotPagination: false }));
    for (const [session, expectLimit] of [
      [paged, true],
      [legacy, false],
    ] as const) {
      const { client, watcher } = setup([session], { turnLimit: 8 });
      void client.start();
      await watcher.until((status) => status.phase === "online");
      client.openThread(makeThread().id);
      expect(session.threads[0]?.input.turnLimit).toBe(expectLimit ? 8 : undefined);
      await client.stop();
    }
  });

  it("reads a page of older turns as large as the window the thread opened with", async () => {
    const session = makeFakeSession(makeConfig({ threadSnapshotPagination: true }));
    const page = threadSnapshotItem(makeThread({ id: "thread-1" }), 7, false);
    if (page.kind !== "snapshot") throw new Error("not a snapshot");
    session.olderPages["cursor"] = page.snapshot;
    const { client, watcher } = setup([session], { turnLimit: 8 });
    void client.start();
    await watcher.until((status) => status.phase === "online");
    const answer = await client.loadOlderTurns(makeThread().id, "cursor");
    expect(answer).toBe(page.snapshot);
    expect(session.olderRequests).toEqual([
      { threadId: "thread-1", beforeCursor: "cursor", turnLimit: 8 },
    ]);
    await client.stop();
  });

  it("replaces the thread subscription when another thread is opened and ignores the old one", async () => {
    const session = makeFakeSession();
    const { client, watcher } = setup([session]);
    void client.start();
    await watcher.until((status) => status.phase === "online");
    client.openThread(makeThread({ id: "thread-1" }).id);
    const stale = session.threads[0]!;
    client.openThread(makeThread({ id: "thread-2" }).id);
    expect(stale.cancelled).toBe(true);
    stale.handlers.onItem(threadSnapshotItem(makeThread({ id: "thread-1" }), 3));
    expect(client.thread.thread).toBeNull();
    session.threads[1]!.handlers.onItem(threadSnapshotItem(makeThread({ id: "thread-2" }), 4));
    expect(client.thread.thread?.id).toBe("thread-2");
    await client.stop();
  });

  it("treats the end of a thread stream as a lost session and reconnects", async () => {
    const first = makeFakeSession();
    const second = makeFakeSession();
    const { client, watcher, sleeper } = setup([first, second]);
    void client.start();
    await watcher.until((status) => status.phase === "online");
    client.openThread(makeThread().id);
    first.threads[0]!.handlers.onEnd("서버가 스레드 구독을 종료했습니다.");
    await watcher.until((status) => status.phase === "reconnecting");
    expect(first.closedByClient).toBe(true);
    sleeper.release();
    await client.stop();
  });

  it("backs off longer after each failed attempt and starts over once connected", async () => {
    const session = makeFakeSession();
    const { client, watcher, sleeper } = setup([
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
      session,
    ]);
    void client.start();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await watcher.until(
        (status) =>
          status.phase === "reconnecting" && status.attempt === attempt && status.retryAt !== null,
      );
      sleeper.release();
    }
    await watcher.until((status) => status.phase === "online");
    expect(sleeper.delays).toEqual([500, 1000, 2000]);
    expect(client.status.attempt).toBe(0);
    await client.stop();
  });

  it("counts a session that dies at once as a failed attempt, but not one that lasted", async () => {
    let clock = 0;
    const sessions = [makeFakeSession(), makeFakeSession(), makeFakeSession(), makeFakeSession()];
    const { client, watcher, sleeper } = setup([...sessions], { now: () => clock });
    void client.start();
    const cycle = async (index: number, lived: number, expectedDelay: number) => {
      await watcher.until(
        (status) =>
          status.phase === "online" &&
          watcher.seen.filter((s) => s.phase === "online").length === index + 1,
      );
      clock += lived;
      sessions[index]!.drop("끊김");
      await watcher.until(
        () => watcher.seen.filter((status) => status.retryAt !== null).length === index + 1,
      );
      expect(sleeper.delays[index]).toBe(expectedDelay);
      sleeper.release();
    };
    await cycle(0, 100, 500);
    await cycle(1, 100, 1000);
    await cycle(2, 30_000, 500);
    await client.stop();
  });

  it("stops retrying when the server rejects the credential", async () => {
    const { client, watcher, sleeper, transport } = setup([
      new TransportError("blocked", "토큰이 만료되었습니다"),
    ]);
    await client.start();
    expect(client.status).toMatchObject({ phase: "blocked", detail: "토큰이 만료되었습니다" });
    expect(sleeper.delays).toEqual([]);
    expect(transport.opens).toBe(1);
    expect(watcher.seen.at(-1)?.phase).toBe("blocked");
  });

  it("keeps the reason a refusal came with, so the banner can say what to do", async () => {
    const { client } = setup([new TransportError("blocked", "프로토콜이 다릅니다", "unsupported")]);
    await client.start();
    expect(client.status).toMatchObject({ phase: "blocked", reason: "unsupported" });
  });

  it("refuses to dispatch while offline and passes commands through when online", async () => {
    const session = makeFakeSession();
    const { client, watcher } = setup([session]);
    const command = {
      type: "thread.turn.interrupt",
      commandId: "c1",
      threadId: "thread-1",
      createdAt: "2026-10-30T09:00:00.000Z",
    } as never;
    await expect(client.dispatch(command)).rejects.toThrow("연결되어 있지 않습니다");
    void client.start();
    await watcher.until((status) => status.phase === "online");
    await client.dispatch(command);
    expect(session.dispatched).toEqual([command]);
    await client.stop();
  });

  it("stops promptly even while waiting out a backoff", async () => {
    const { client, watcher } = setup([new Error("down")]);
    const loop = client.start();
    await watcher.until((status) => status.phase === "reconnecting" && status.retryAt !== null);
    await client.stop();
    await loop;
    expect(client.status.phase).toBe("stopped");
  });
  it("closes only the thread when the server rejects its subscription", async () => {
    const session = makeFakeSession();
    const { client, watcher, transport, failures } = setup([session]);
    void client.start();
    await watcher.until((status) => status.phase === "online");
    client.openThread(makeThread().id);
    session.threads[0]!.handlers.onEnd("Thread thread-1 was not found", true);

    expect(failures).toEqual([{ threadId: "thread-1", message: "Thread thread-1 was not found" }]);
    expect(client.status.phase).toBe("online");
    expect(transport.opens).toBe(1);
    expect(session.closedByClient).toBe(false);
    expect(client.thread.thread).toBeNull();
    // Reconnecting later must not resubscribe to the thread that does not exist.
    await client.stop();
  });

  it("still replaces the session when a thread stream just breaks", async () => {
    const first = makeFakeSession();
    const second = makeFakeSession();
    const { client, watcher, failures } = setup([first, second]);
    void client.start();
    await watcher.until((status) => status.phase === "online");
    client.openThread(makeThread().id);
    first.threads[0]!.handlers.onEnd("socket reset");
    await watcher.until((status) => status.phase === "reconnecting" && status.retryAt !== null);
    expect(failures).toEqual([]);
    await client.stop();
  });

  it("ignores a late close report from a session that was already replaced", async () => {
    const first = makeFakeSession(makeConfig(), { lateClose: true });
    const second = makeFakeSession();
    const { client, watcher, sleeper, transport } = setup([first, second]);
    void client.start();
    await watcher.until((status) => status.phase === "online");
    first.shell[0]!.handlers.onEnd("서버가 구독을 종료했습니다");
    await watcher.until((status) => status.phase === "reconnecting" && status.retryAt !== null);
    const seen = watcher.seen.length;
    sleeper.release();
    await watcher.until(
      (status) => watcher.seen.indexOf(status) >= seen && status.phase === "online",
    );
    expect(transport.opens).toBe(2);

    first.drop("뒤늦게 닫힘");
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(client.status.phase).toBe("online");
    expect(second.closedByClient).toBe(false);
    expect(second.shell[0]?.cancelled).toBe(false);
    await client.stop();
  });
});

describe("LinkClient and the server's config", () => {
  const goalsOf = (client: LinkClient): object | undefined =>
    (client.config?.settings as unknown as { threadGoals?: object } | undefined)?.threadGoals;
  const settingsEvent = (settings: Record<string, unknown>) =>
    ({ version: 1, type: "settingsUpdated", payload: { settings } }) as never;

  it("follows the config stream: settings and providers change what config says", async () => {
    const session = makeFakeSession(makeConfig({ settings: { threadGoals: {} } }));
    const { client, watcher, configs } = setup([session]);
    void client.start();
    await watcher.until((status) => status.phase === "online");
    expect(session.configs).toHaveLength(1);
    session.configs[0]!.handlers.onItem(settingsEvent({ threadGoals: { t1: { id: "g" } } }));
    expect(goalsOf(client)).toEqual({
      t1: { id: "g" },
    });
    expect(configs).toHaveLength(1);
    session.configs[0]!.handlers.onItem({
      version: 1,
      type: "providerStatuses",
      payload: { providers: [] },
    } as never);
    expect(client.config?.providers).toEqual([]);
    expect(configs).toHaveLength(2);
    await client.stop();
    expect(session.configs[0]?.cancelled).toBe(true);
  });

  it("subscribes again on the next session, from that session's own config", async () => {
    const first = makeFakeSession(makeConfig({ settings: { threadGoals: { old: 1 } } }));
    const second = makeFakeSession(makeConfig({ settings: { threadGoals: {} } }));
    const { client, watcher, sleeper } = setup([first, second]);
    void client.start();
    await watcher.until((status) => status.phase === "online");
    first.drop("소켓이 닫혔습니다");
    await watcher.until((status) => status.phase === "reconnecting" && status.retryAt !== null);
    expect(first.configs[0]?.cancelled).toBe(true);
    const online = watcher.seen.length;
    sleeper.release();
    await watcher.until(
      (status) => watcher.seen.indexOf(status) >= online && status.phase === "online",
    );
    expect(second.configs).toHaveLength(1);
    expect(goalsOf(client)).toEqual({});
    // A late event of the dead session changes nothing.
    first.configs[0]!.handlers.onItem(settingsEvent({ threadGoals: { late: 1 } }));
    expect(goalsOf(client)).toEqual({});
    await client.stop();
  });

  it("passes settings, provider refresh and crew retry through to the session", async () => {
    const session = makeFakeSession(makeConfig({ settings: { threadGoals: {} } }));
    session.settings = { threadGoals: {} };
    const { client, watcher, configs } = setup([session]);
    void client.start();
    await watcher.until((status) => status.phase === "online");
    expect(await client.getSettings()).toEqual({ threadGoals: {} });
    const answered = await client.updateSettings({ threadGoals: { t1: { id: "g" } } } as never);
    expect(session.patches).toEqual([{ threadGoals: { t1: { id: "g" } } }]);
    expect(answered).toMatchObject({ threadGoals: { t1: { id: "g" } } });
    // The answer is in `config` at once, without waiting for the stream to repeat it.
    expect(goalsOf(client)).toEqual({
      t1: { id: "g" },
    });
    expect(configs).toHaveLength(1);
    await client.refreshProviders({ instanceId: "codex", refreshModels: true });
    expect(session.refreshes).toEqual([{ instanceId: "codex", refreshModels: true }]);
    await client.retryCrewTask({ leadThreadId: "thread-1" as never, taskId: "task-1" });
    expect(session.retries).toEqual([{ leadThreadId: "thread-1", taskId: "task-1" }]);
    await client.stop();
  });

  it("fails clearly while offline, and passes the server's error on", async () => {
    const session = makeFakeSession();
    const { client, watcher } = setup([session]);
    await expect(client.getSettings()).rejects.toThrow("연결되어 있지 않습니다");
    await expect(client.updateSettings({} as never)).rejects.toThrow("연결되어 있지 않습니다");
    void client.start();
    await watcher.until((status) => status.phase === "online");
    session.rpcError = new Error("서버가 거절했습니다");
    await expect(client.updateSettings({} as never)).rejects.toThrow("서버가 거절했습니다");
    await client.stop();
  });
});

describe("LinkClient and checkpoint diffs", () => {
  it("asks the session for the turn range, and fails clearly while offline", async () => {
    const session = makeFakeSession();
    session.diff = "diff --git a/x b/x\n";
    const { client, watcher } = setup([session]);
    const range = { threadId: "thread-1" as never, fromTurnCount: 1, toTurnCount: 2 };
    await expect(client.getCheckpointDiff(range)).rejects.toThrow("연결되어 있지 않습니다");
    void client.start();
    await watcher.until((status) => status.phase === "online");
    expect(await client.getCheckpointDiff(range)).toBe("diff --git a/x b/x\n");
    expect(session.diffRequests).toEqual([range]);
    session.rpcError = new Error("서버가 거절했습니다");
    await expect(client.getCheckpointDiff(range)).rejects.toThrow("서버가 거절했습니다");
    await client.stop();
  });
});
