import { describe, expect, it } from "vite-plus/test";

import {
  makeMessage,
  makeThread,
  messageSentEvent,
  threadDeletedEvent,
  threadSnapshotItem,
} from "../testing/fixtures.ts";
import { applyThreadItem, emptyThreadMirror } from "./threadMirror.ts";

describe("applyThreadItem", () => {
  it("takes the snapshot as the whole thread and remembers how far it reaches", () => {
    const state = applyThreadItem(emptyThreadMirror, threadSnapshotItem(makeThread(), 5));
    expect(state.thread?.id).toBe("thread-1");
    expect(state.sequence).toBe(5);
    expect(state.hasOlder).toBe(false);
  });

  it("notes when a windowed load left older turns behind", () => {
    const state = applyThreadItem(emptyThreadMirror, threadSnapshotItem(makeThread(), 5, true));
    expect(state.hasOlder).toBe(true);
    expect(state.olderCursor).toBe("cursor");
    expect(
      applyThreadItem(emptyThreadMirror, threadSnapshotItem(makeThread(), 5, false)).olderCursor,
    ).toBeNull();
  });

  it("applies later events and ignores ones the snapshot already contains", () => {
    let state = applyThreadItem(emptyThreadMirror, threadSnapshotItem(makeThread(), 5));
    state = applyThreadItem(state, messageSentEvent(5, { messageId: "old", text: "이미 포함됨" }));
    expect(state.thread?.messages).toEqual([]);
    state = applyThreadItem(state, messageSentEvent(6, { messageId: "m1", text: "새 메시지" }));
    expect(state.thread?.messages.map((message) => message.text)).toEqual(["새 메시지"]);
    expect(state.sequence).toBe(6);
  });

  it("appends streamed deltas to the same message", () => {
    let state = applyThreadItem(emptyThreadMirror, threadSnapshotItem(makeThread(), 1));
    state = applyThreadItem(
      state,
      messageSentEvent(2, { messageId: "m1", text: "안녕", streaming: true }),
    );
    state = applyThreadItem(
      state,
      messageSentEvent(3, { messageId: "m1", text: "하세요", streaming: true }),
    );
    expect(state.thread?.messages[0]).toMatchObject({ text: "안녕하세요", streaming: true });
    state = applyThreadItem(
      state,
      messageSentEvent(4, { messageId: "m1", text: "안녕하세요!", streaming: false }),
    );
    expect(state.thread?.messages[0]).toMatchObject({ text: "안녕하세요!", streaming: false });
  });

  it("marks the mirror deleted when the thread is removed, with or without a loaded snapshot", () => {
    const loaded = applyThreadItem(
      applyThreadItem(
        emptyThreadMirror,
        threadSnapshotItem(makeThread({ messages: [makeMessage({ id: "m" })] }), 1),
      ),
      threadDeletedEvent(2),
    );
    expect(loaded.deleted).toBe(true);
    expect(applyThreadItem(emptyThreadMirror, threadDeletedEvent(2)).deleted).toBe(true);
  });

  it("flags the end of the replay without touching the thread", () => {
    const base = applyThreadItem(emptyThreadMirror, threadSnapshotItem(makeThread(), 1));
    const state = applyThreadItem(base, { kind: "synchronized" });
    expect(state.synchronized).toBe(true);
    expect(state.thread).toBe(base.thread);
  });

  it("still tracks the sequence of events that arrive before any snapshot", () => {
    const state = applyThreadItem(
      emptyThreadMirror,
      messageSentEvent(3, { messageId: "m", text: "x" }),
    );
    expect(state.thread).toBeNull();
    expect(state.sequence).toBe(3);
  });
});
