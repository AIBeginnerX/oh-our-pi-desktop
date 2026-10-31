import { DEFAULT_CREW_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeConfig, makeThreadShell } from "../testing/fixtures.ts";
import { key } from "../testing/providerFixtures.ts";
import type { WaitingCrewThread } from "./crewBoard.ts";
import { crewContext, crewKey, openCrewView, type CrewView } from "./crewScreen.ts";

const contextOf = (waiting: ReadonlyArray<WaitingCrewThread> = []) =>
  crewContext({
    settings: DEFAULT_CREW_SETTINGS,
    threadId: "lead",
    providers: makeConfig().providers,
    brain: null,
    problem: null,
    board: null,
    waiting,
    now: 0,
  });

const waitingThread = (id: string): WaitingCrewThread => ({
  thread: makeThreadShell({ id, title: "Crew Worker · 작업", hasPendingApprovals: true }),
  kind: "approval",
});

describe("the crew screen's pointer", () => {
  it("stays on its row when a waiting thread is listed ahead of it", () => {
    const before = contextOf();
    // Down once: the pointer is on the preset row.
    const moved = crewKey(openCrewView(before), before, key("down")).view as CrewView;
    expect(crewKey(moved, before, key("enter")).view).toMatchObject({ kind: "preset" });

    // A thread starts waiting; its row goes to the top and every index moves by one.
    const after = contextOf([waitingThread("sub-1")]);
    const entered = crewKey(moved, after, key("enter"));
    expect(entered.view).toMatchObject({ kind: "preset" });
    expect(entered.effect).toEqual({ kind: "none" });
  });

  it("does not run the toggle or open the thread that moved into its place", () => {
    const before = contextOf();
    const onToggle = openCrewView(before);
    expect(crewKey(onToggle, before, key("enter")).effect).toEqual({ kind: "toggle" });

    const after = contextOf([waitingThread("sub-1")]);
    // The pointer was on the toggle, which is now the second row; the waiting thread is the first.
    const result = crewKey(onToggle, after, key("enter"));
    expect(result.effect).toEqual({ kind: "toggle" });
  });

  it("keeps moving from its row, not from the old index", () => {
    const before = contextOf();
    const onToggle = openCrewView(before);
    const after = contextOf([waitingThread("sub-1")]);
    const down = crewKey(onToggle, after, key("down")).view;
    expect(down).toMatchObject({ kind: "main", selected: 2 });
  });

  it("holds the pointer inside the list when its row went away", () => {
    const withThread = contextOf([waitingThread("sub-1")]);
    const onThread = openCrewView(withThread);
    expect(onThread).toMatchObject({ selected: 0, rowId: "thread:sub-1" });
    const gone = contextOf();
    expect(crewKey(onThread, gone, key("down")).view).toMatchObject({ kind: "main", selected: 1 });
  });
});
