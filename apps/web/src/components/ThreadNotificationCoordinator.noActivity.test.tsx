import type { ClientSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  inApp: true,
  noActivityAlertMinutes: null as ClientSettings["noActivityAlertMinutes"],
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  visible: "visible",
  updatedAt: "",
  approval: false,
  input: false,
  // Last activity of a second, busy thread in the same environment; null leaves it out.
  siblingUpdatedAt: null as string | null,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    status: "live",
    snapshot: Option.some({
      threads: [
        {
          id: "thread-1",
          title: "Fix the login form",
          archivedAt: null,
          updatedAt: state.updatedAt,
          hasPendingUserInput: state.input,
          hasPendingApprovals: state.approval,
          session: null,
          latestTurn: { turnId: "turn-1", state: "running", completedAt: null },
        },
        ...(state.siblingUpdatedAt === null
          ? []
          : [
              {
                id: "thread-2",
                title: "Busy sibling",
                archivedAt: null,
                updatedAt: state.siblingUpdatedAt,
                hasPendingUserInput: false,
                hasPendingApprovals: false,
                session: null,
                latestTurn: { turnId: "turn-2", state: "running", completedAt: null },
              },
            ]),
      ],
    }),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.active,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (
      settings: Pick<
        ClientSettings,
        "notificationMode" | "inAppNotificationsEnabled" | "noActivityAlertMinutes"
      >,
    ) => unknown,
  ) =>
    select({
      notificationMode: state.mode,
      inAppNotificationsEnabled: state.inApp,
      noActivityAlertMinutes: state.noActivityAlertMinutes,
    }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "env-1" }] }),
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: vi.fn() },
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, close: state.close },
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

/** A silence that started `minutes` ago, measured from the (fake) current time. */
const updatedAtMinutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  Object.assign(state, {
    mode: "off",
    inApp: true,
    noActivityAlertMinutes: 10,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    approval: false,
    input: false,
    siblingUpdatedAt: null,
  });
  state.updatedAt = updatedAtMinutesAgo(11);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visible;
    },
    hasFocus: () => state.focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("no-activity alerts", () => {
  it("delivers one toast per silence on the coarse interval", async () => {
    await render();
    await act(() => vi.advanceTimersByTime(30_000));
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("No activity for 10 minutes");
    expect(toast?.description).toBe("Fix the login form");
    toast?.actionProps.onClick();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    await act(() => vi.advanceTimersByTime(30_000));
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("delivers a desktop alert instead when the window is unfocused", async () => {
    state.mode = "notifications";
    state.focused = false;
    await render();
    await act(() => vi.advanceTimersByTime(30_000));
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith(
      "No activity for 10 minutes",
      expect.objectContaining({ body: "Fix the login form", tag: "env-1:thread-1" }),
    );
  });

  it("stays quiet while the silent thread is open and in view", async () => {
    state.active = { environmentId: "env-1", threadId: "thread-1" };
    await render();
    await act(() => vi.advanceTimersByTime(30_000));
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("does not run while the thread waits on approval or the setting is off", async () => {
    state.approval = true;
    await render();
    await act(() => vi.advanceTimersByTime(60_000));
    expect(state.add).not.toHaveBeenCalled();

    state.approval = false;
    state.noActivityAlertMinutes = null;
    await render();
    await act(() => vi.advanceTimersByTime(60_000));
    expect(state.add).not.toHaveBeenCalled();
  });

  it("still checks while a busy sibling thread keeps pushing shell updates", async () => {
    // Shell pushes every 10 s, faster than the 30 s interval, must not keep restarting it.
    for (let elapsed = 0; elapsed < 40_000; elapsed += 10_000) {
      state.siblingUpdatedAt = new Date(Date.now()).toISOString();
      await render();
      await act(() => vi.advanceTimersByTime(10_000));
    }
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "Fix the login form" }),
    );
  });

  it("re-arms after new activity and alerts once for the next silence", async () => {
    await render();
    await act(() => vi.advanceTimersByTime(30_000));
    expect(state.add).toHaveBeenCalledTimes(1);
    state.updatedAt = new Date(Date.now()).toISOString();
    await render();
    await act(() => vi.advanceTimersByTime(30_000));
    expect(state.add).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(state.add).toHaveBeenCalledTimes(2);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "No activity for 10 minutes" }),
    );
  });
});
