import { describe, expect, it } from "vite-plus/test";

import { TurnId } from "@t3tools/contracts";

import {
  approvalRequested,
  makeActivity,
  makeSession,
  makeThread,
  T0,
} from "../testing/fixtures.ts";
import { deriveThreadStatus } from "./threadStatus.ts";

describe("deriveThreadStatus", () => {
  it("is idle with nothing happening", () => {
    const status = deriveThreadStatus(makeThread());
    expect(status.phase).toBe("idle");
    expect(status.interruptible).toBe(false);
  });

  it("is working and interruptible while the session runs", () => {
    const status = deriveThreadStatus(makeThread({ session: makeSession("running") }));
    expect(status).toMatchObject({ phase: "working", interruptible: true });
  });

  it("puts a pending approval ahead of the running state", () => {
    const status = deriveThreadStatus(
      makeThread({
        session: makeSession("running"),
        activities: [approvalRequested("req-1")],
      }),
    );
    expect(status.phase).toBe("approval");
    expect(status.pending.approvals).toHaveLength(1);
    expect(status.interruptible).toBe(true);
  });

  it("clears the approval once it is resolved", () => {
    const status = deriveThreadStatus(
      makeThread({
        activities: [
          approvalRequested("req-1"),
          makeActivity({ id: "done", kind: "approval.resolved", payload: { requestId: "req-1" } }),
        ],
      }),
    );
    expect(status.phase).toBe("idle");
  });

  it("names the tool that is still running and forgets it once it completes", () => {
    const started = {
      ...makeActivity({
        id: "t1",
        kind: "tool.started",
        payload: { toolCallId: "call-1", title: "bun test" },
      }),
      turnId: TurnId.make("turn-1"),
    };
    const completed = {
      ...makeActivity({
        id: "t2",
        kind: "tool.completed",
        payload: { toolCallId: "call-1", title: "bun test" },
      }),
      turnId: TurnId.make("turn-1"),
    };
    const running = makeSession("running", { activeTurnId: "turn-1" });
    expect(
      deriveThreadStatus(makeThread({ session: running, activities: [started] })).runningTool,
    ).toBe("bun test");
    expect(
      deriveThreadStatus(makeThread({ session: running, activities: [started, completed] }))
        .runningTool,
    ).toBeNull();
  });

  it("keeps a running tool that carries no turn, and skips one from another turn", () => {
    const running = makeSession("running", { activeTurnId: "turn-1" });
    const tool = (turnId: ReturnType<typeof TurnId.make> | null) => ({
      ...makeActivity({
        id: "t1",
        kind: "tool.started",
        payload: { toolCallId: "call-1", title: "bun test" },
      }),
      turnId,
    });
    expect(
      deriveThreadStatus(makeThread({ session: running, activities: [tool(null)] })).runningTool,
    ).toBe("bun test");
    expect(
      deriveThreadStatus(
        makeThread({ session: running, activities: [tool(TurnId.make("turn-0"))] }),
      ).runningTool,
    ).toBeNull();
  });

  it("reports a failed session as an error with its message", () => {
    const status = deriveThreadStatus(
      makeThread({ session: makeSession("error", { lastError: "프로바이더가 종료되었습니다" }) }),
    );
    expect(status).toMatchObject({ phase: "error", lastError: "프로바이더가 종료되었습니다" });
  });

  describe("what the live region shows", () => {
    const turn = TurnId.make("turn-1");
    const inTurn = (activity: ReturnType<typeof makeActivity>) => ({ ...activity, turnId: turn });
    const runningTurn = {
      session: makeSession("running", { activeTurnId: "turn-1" }),
      latestTurn: {
        turnId: "turn-1",
        state: "running",
        requestedAt: T0,
        startedAt: "2026-10-30T09:00:05.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const finishedTurn = {
      session: makeSession("idle"),
      latestTurn: { ...runningTurn.latestTurn, state: "completed", completedAt: T0 },
    };
    const plan = (id: string, steps: Array<[string, string]>) =>
      inTurn(
        makeActivity({
          id,
          kind: "turn.plan.updated",
          payload: { plan: steps.map(([step, status]) => ({ step, status })) },
        }),
      );
    const agentStarted = (taskId: string, title: string, over: Record<string, unknown> = {}) =>
      inTurn(
        makeActivity({
          id: `start-${taskId}`,
          kind: "task.started",
          payload: { taskId, title, agentKind: "agent", ...over },
        }),
      );

    it("reports when the running turn started, and nothing once it is over", () => {
      expect(deriveThreadStatus(makeThread(runningTurn)).turnStartedAt).toBe(
        Date.parse("2026-10-30T09:00:05.000Z"),
      );
      expect(deriveThreadStatus(makeThread(finishedTurn)).turnStartedAt).toBeNull();
    });

    it("names the running tool's detail next to its title", () => {
      const status = deriveThreadStatus(
        makeThread({
          ...runningTurn,
          activities: [
            inTurn(
              makeActivity({
                id: "t1",
                kind: "tool.started",
                payload: { toolCallId: "c1", title: "Bash", detail: "pnpm test\n--watch" },
              }),
            ),
          ],
        }),
      );
      expect(status).toMatchObject({ runningTool: "Bash", runningToolDetail: "pnpm test" });
    });

    it("takes the latest plan of the running turn and drops it with the turn", () => {
      const activities = [
        plan("p1", [["설계", "inProgress"]]),
        plan("p2", [
          ["설계", "completed"],
          ["구현", "inProgress"],
          ["검증", "pending"],
        ]),
      ];
      expect(deriveThreadStatus(makeThread({ ...runningTurn, activities })).plan).toEqual([
        { step: "설계", status: "completed" },
        { step: "구현", status: "inProgress" },
        { step: "검증", status: "pending" },
      ]);
      expect(deriveThreadStatus(makeThread({ ...finishedTurn, activities })).plan).toEqual([]);
    });

    it("ignores a plan that belongs to an earlier turn", () => {
      const old = { ...plan("p1", [["지난 일", "completed"]]), turnId: TurnId.make("turn-0") };
      expect(deriveThreadStatus(makeThread({ ...runningTurn, activities: [old] })).plan).toEqual(
        [],
      );
    });

    it("lists sub-agents until they finish, and leaves shells out", () => {
      const done = inTurn(
        makeActivity({ id: "done-a", kind: "task.completed", payload: { taskId: "a" } }),
      );
      const shell = inTurn(
        makeActivity({
          id: "start-sh",
          kind: "task.started",
          payload: { taskId: "sh", title: "서버", agentKind: "background" },
        }),
      );
      const progress = inTurn(
        makeActivity({
          id: "prog-b",
          kind: "task.progress",
          payload: { taskId: "b", lastToolName: "Read" },
        }),
      );
      const both = [agentStarted("a", "리뷰어"), agentStarted("b", "탐색기"), shell, progress];
      expect(
        deriveThreadStatus(makeThread({ ...runningTurn, activities: both })).agents.map((agent) => [
          agent.name,
          agent.work,
        ]),
      ).toEqual([
        ["리뷰어", null],
        ["탐색기", "Read"],
      ]);
      expect(
        deriveThreadStatus(makeThread({ ...runningTurn, activities: [...both, done] })).agents.map(
          (agent) => agent.name,
        ),
      ).toEqual(["탐색기"]);
    });

    it("does not bring a finished agent back when its start arrives late", () => {
      const done = inTurn(
        makeActivity({ id: "done-a", kind: "task.completed", payload: { taskId: "a" } }),
      );
      expect(
        deriveThreadStatus(
          makeThread({ ...runningTurn, activities: [done, agentStarted("a", "늦은 시작")] }),
        ).agents,
      ).toEqual([]);
    });

    it("reads the context window from the latest report", () => {
      const report = (id: string, usedTokens: number, maxTokens?: number) =>
        makeActivity({
          id,
          kind: "context-window.updated",
          payload: { usedTokens, ...(maxTokens ? { maxTokens } : {}) },
        });
      const status = (activities: ReturnType<typeof report>[]) =>
        deriveThreadStatus(makeThread({ activities })).context;
      expect(status([report("c1", 10_000, 200_000), report("c2", 84_000, 200_000)])).toEqual({
        usedTokens: 84_000,
        maxTokens: 200_000,
        percent: 42,
      });
      expect(status([report("c1", 5_000)])).toEqual({
        usedTokens: 5_000,
        maxTokens: null,
        percent: null,
      });
      expect(status([])).toBeNull();
    });

    describe("the cost", () => {
      const usage = (
        id: string,
        runtimeEventId: string,
        costUsd?: number,
        driver = "claudeAgent",
        instanceId = "claudeAgent",
      ) =>
        makeActivity({
          id,
          kind: "owned-usage",
          payload: {
            v: 1,
            scope: "main-turn",
            source: { driver, instanceId, runtimeEventId },
            ...(costUsd === undefined ? {} : { costUsd }),
          },
        });
      const cost = (activities: ReturnType<typeof usage>[]) =>
        deriveThreadStatus(makeThread({ activities })).costUsd;

      it("takes Claude's running session total as the spend, not the sum of the totals", () => {
        expect(cost([usage("u1", "e1", 1), usage("u2", "e2", 2.5), usage("u3", "e3", 4)])).toBe(4);
      });

      it("counts a redelivered report once", () => {
        expect(
          cost([usage("u1", "e1", 0.1), usage("u2", "e2", 0.12), usage("u3", "e2", 0.12)]),
        ).toBeCloseTo(0.12);
      });

      it("adds a restarted session to the one before it", () => {
        expect(
          cost([
            usage("u1", "e1", 3),
            usage("u2", "e2", 5),
            usage("u3", "e3", 1),
            usage("u4", "e4", 2),
          ]),
        ).toBe(7);
      });

      it("does not let a zero total restart the baseline", () => {
        expect(cost([usage("u1", "e1", 3), usage("u2", "e2", 0), usage("u3", "e3", 4)])).toBe(4);
      });

      it("keeps the totals of separate sessions apart", () => {
        expect(
          cost([
            usage("u1", "e1", 3, "claudeAgent", "work"),
            usage("u2", "e2", 10, "claudeAgent", "home"),
            usage("u3", "e3", 4, "claudeAgent", "work"),
          ]),
        ).toBe(14);
      });

      it("leaves out a provider whose cost meaning is unknown, and is silent without any", () => {
        expect(cost([usage("u1", "e1", 9, "codex", "codex")])).toBeNull();
        expect(cost([usage("u1", "e1")])).toBeNull();
        expect(cost([])).toBeNull();
      });
    });

    it("shows nothing of the previous turn while the next one is still starting", () => {
      const startingNext = {
        session: makeSession("starting"),
        latestTurn: { ...runningTurn.latestTurn, state: "completed", completedAt: T0 },
        activities: [
          plan("p1", [["지난 단계", "inProgress"]]),
          agentStarted("a", "지난 에이전트"),
          inTurn(
            makeActivity({
              id: "t1",
              kind: "tool.started",
              payload: { toolCallId: "c1", title: "Bash", detail: "sleep 100" },
            }),
          ),
        ],
      };
      expect(deriveThreadStatus(makeThread(startingNext))).toMatchObject({
        phase: "working",
        interruptible: true,
        turnStartedAt: null,
        plan: [],
        agents: [],
        runningTool: null,
        runningToolDetail: null,
      });
      const started = makeThread({
        ...startingNext,
        session: makeSession("running", { activeTurnId: "turn-2" }),
        latestTurn: { ...runningTurn.latestTurn, turnId: "turn-2", state: "running" },
      });
      expect(deriveThreadStatus(started)).toMatchObject({
        turnStartedAt: Date.parse("2026-10-30T09:00:05.000Z"),
        plan: [],
        agents: [],
        runningTool: null,
      });
    });

    it("does not name a tool an earlier turn left open", () => {
      const left = {
        ...makeActivity({
          id: "t0",
          kind: "tool.started",
          payload: { toolCallId: "old", title: "Bash" },
        }),
        turnId: TurnId.make("turn-0"),
      };
      expect(
        deriveThreadStatus(makeThread({ ...runningTurn, activities: [left] })).runningTool,
      ).toBeNull();
    });
  });
});
