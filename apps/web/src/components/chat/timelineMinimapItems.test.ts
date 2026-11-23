// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import { act, createElement, Profiler } from "react";
import { createRoot } from "react-dom/client";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { TimelineMinimap } from "./MessagesTimeline.minimap";
import {
  createTimelineMinimapPreviewStore,
  deriveTimelineMinimapItems,
} from "./timelineMinimapItems";
import type { ChatMessage } from "../../types";

vi.mock("../ui/tooltip", () => ({
  Tooltip: () => null,
  TooltipPopup: () => null,
  TooltipTrigger: () => null,
}));

function rows(
  entries: ReadonlyArray<readonly ["user" | "assistant", string]>,
): MessagesTimelineRow[] {
  const messages: ChatMessage[] = entries.map(([role, text], index) => ({
    id: MessageId.make(`message-${index}`),
    role,
    text,
    streaming: false,
    turnId: null,
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString(),
  }));
  return messages.map((message) => ({
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    durationStart: message.createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  }));
}

describe("timeline minimap previews", () => {
  it("keeps a focused preview current through streamed text, completion, and edits", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const source = rows([
      ["user", "Earlier"],
      ["user", "Explain"],
      ["assistant", "First"],
    ]);
    const items = deriveTimelineMinimapItems(source);
    const previewStore = createTimelineMinimapPreviewStore();
    previewStore.setRows(source);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const stripMap = new Map<string, HTMLSpanElement>();
    const onSelect = vi.fn();
    const onRender = vi.fn();
    const preview = () => container.querySelector("[data-minimap-preview]");
    try {
      await act(async () =>
        root.render(
          createElement(
            Profiler,
            { id: "minimap", onRender },
            createElement(TimelineMinimap, {
              hasPersistentGutter: true,
              hitStripWidth: 30,
              currentIndex: 1,
              items,
              previewStore,
              stripMap,
              onSelect,
            }),
          ),
        ),
      );
      expect(preview()).toBeNull();
      const rail = container.querySelector<HTMLButtonElement>(
        'button[aria-label^="Jump to message"]',
      )!;
      await act(async () => rail.focus());
      expect(preview()?.textContent).toBe("ExplainFirst");

      for (const [prompt, answer, expected] of [
        ["Explain", "First\n second", "ExplainFirst second"],
        ["Explain", "Complete", "ExplainComplete"],
        ["Edited prompt", "Edited answer", "Edited promptEdited answer"],
      ] as const) {
        await act(async () =>
          previewStore.setRows(
            rows([
              ["user", "Earlier"],
              ["user", prompt],
              ["assistant", answer],
            ]),
          ),
        );
        expect(preview()?.textContent).toBe(expected);
        expect(rail.getAttribute("aria-label")).toBe(`Jump to message: ${prompt}`);
      }
      await act(async () => rail.blur());
      expect(preview()).toBeNull();
      expect(onRender).toHaveBeenCalled();
      onRender.mockClear();
      await act(async () => previewStore.setRows(source));
      expect(onRender).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("previews the last assistant response before the next prompt and retains jump targets", () => {
    const source = rows([
      ["user", "  Inspect\n this  "],
      ["assistant", "Working"],
      ["assistant", " Done\t now "],
      ["user", "Next"],
      ["assistant", "Second answer"],
    ]);
    const items = deriveTimelineMinimapItems(source);
    const store = createTimelineMinimapPreviewStore();
    store.setRows(source);
    expect(items).toHaveLength(2);
    expect(store.snapshotFor(items[0]!)()).toEqual({
      id: items[0]!.id,
      rowIndex: items[0]!.rowIndex,
      userText: "Inspect this",
      assistantText: "Done now",
    });
    expect(source[items[0]!.rowIndex]!.id).toBe(items[0]!.id);
    expect(store.snapshotFor(items[1]!)().assistantText).toBe("Second answer");
  });

  it("handles an unanswered prompt and empty responses", () => {
    const source = rows([
      ["user", "First"],
      ["assistant", " \n\t"],
      ["user", "Next"],
    ]);
    const items = deriveTimelineMinimapItems(source);
    const store = createTimelineMinimapPreviewStore();
    store.setRows(source);
    expect(items.map((item) => store.snapshotFor(item)().assistantText)).toEqual([null, null]);
  });

  it("shows fresh streaming text without changing the jump target", () => {
    const source = rows([
      ["user", "Explain"],
      ["assistant", "First"],
    ]);
    const items = deriveTimelineMinimapItems(source);
    const store = createTimelineMinimapPreviewStore();
    store.setRows(source);
    const getPreview = store.snapshotFor(items[0]!);
    const first = getPreview();
    expect(first.assistantText).toBe("First");
    expect(getPreview()).toBe(first);
    store.setRows(
      rows([
        ["user", "Explain"],
        ["assistant", "First\n second"],
      ]),
    );
    const updated = getPreview();
    expect(updated).toEqual({
      id: source[0]!.id,
      rowIndex: 0,
      userText: "Explain",
      assistantText: "First second",
    });
    expect(first.assistantText).toBe("First");
    expect(getPreview()).toBe(updated);
  });
});
