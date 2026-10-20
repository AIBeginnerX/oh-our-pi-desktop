import { act, createElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { buildMessageContext, projectMemoryContextId } from "~/lib/composerContextRecords";
import {
  ComposerContextReferenceChip,
  ComposerContextRecordsContext,
  ComposerMemoryTitleContext,
  composerContextRecordsFromDraft,
  type ComposerMemoryTitleState,
  uploadedContextRecordFromDraft,
} from "./composerContextPresentation";

vi.mock("./ui/tooltip", async () => {
  const { createElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    TooltipTrigger: ({ render }: { render?: ReactElement }) =>
      isValidElement(render) ? render : null,
    TooltipPopup: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    TooltipProvider: ({ children }: { children?: ReactNode }) =>
      createElement("div", null, children),
  };
});

describe("composerContextRecordsFromDraft", () => {
  it("recovers the uploaded record when clipboard data points at an attachment already in the draft", () => {
    const file = {
      type: "file" as const,
      id: "file-1",
      name: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      file: new File(["test"], "file.txt"),
      uploadedAttachmentId: "attachment-1",
    };
    const draftRecord = composerContextRecordsFromDraft({
      terminalContexts: [],
      files: [file],
    }).get("file_file-1");

    expect(draftRecord && uploadedContextRecordFromDraft(draftRecord)).toMatchObject({
      kind: "file",
      contextId: "file_file-1",
      attachmentId: "attachment-1",
    });
  });

  it("resolves each wire reference to its own backing draft even when producer ids collide", () => {
    const id = "same.id:1";
    const terminal = {
      id,
      threadId: ThreadId.make("t1"),
      terminalId: "default",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 1,
      text: "output",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const image = {
      type: "image" as const,
      id,
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 1,
      file: new File(["x"], "shot.png"),
      previewUrl: "blob:shot",
    };
    const file = {
      type: "file" as const,
      id,
      name: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      file: null,
    };
    const draftRecords = composerContextRecordsFromDraft({
      terminalContexts: [terminal],
      images: [image],
      files: [file],
    });
    const message = buildMessageContext({
      terminalContexts: [terminal],
      reviewComments: [],
      previewAnnotations: [],
      attachments: [
        { attachment: image, attachmentId: "uploaded-image" },
        { attachment: file, attachmentId: "uploaded-file" },
      ],
    })!;
    expect(draftRecords.size).toBe(3);
    for (const record of message.records) {
      expect(draftRecords.get(record.contextId)?.kind).toBe(record.kind);
    }
  });
});

describe("composer memory chips", () => {
  const memoryLinkContextId = "memory_mem-1";
  const reference = {
    contextId: projectMemoryContextId("mem-1"),
    memoryId: "mem-1",
    selectedVersion: 2,
  };
  const mounted: Array<ReactTestRenderer> = [];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    while (mounted.length > 0) {
      const renderer = mounted.pop();
      await act(async () => renderer?.unmount());
    }
    vi.unstubAllGlobals();
  });

  const renderChip = (
    records: Parameters<typeof composerContextRecordsFromDraft>[0],
    resolveTitle: (memoryId: string, selectedVersion: number) => ComposerMemoryTitleState,
  ): ReactTestRenderer => {
    const harness: { current: ReactTestRenderer | null } = { current: null };
    act(() => {
      harness.current = create(
        createElement(
          ComposerMemoryTitleContext,
          { value: resolveTitle },
          createElement(
            ComposerContextRecordsContext,
            { value: composerContextRecordsFromDraft(records) },
            createElement(ComposerContextReferenceChip, {
              kind: "memory",
              contextId: memoryLinkContextId,
              label: "Project memory",
            }),
          ),
        ),
      );
    });
    const renderer = harness.current;
    if (renderer === null) {
      throw new Error("chip did not render");
    }
    mounted.push(renderer);
    return renderer;
  };

  const chipText = (renderer: ReactTestRenderer): string => {
    const label = renderer.root
      .findAllByType("span")
      .find((node: ReactTestInstance) => node.props["data-slot"] === "context-chip-label");
    if (!label) throw new Error("missing chip label");
    if (typeof label.props.children !== "string") {
      throw new Error("chip label is not plain text");
    }
    return label.props.children;
  };

  it("indexes memory selections by their canonical context id", () => {
    const records = composerContextRecordsFromDraft({
      terminalContexts: [],
      projectMemoryReferences: [reference],
    });
    expect(records.get(memoryLinkContextId)).toMatchObject({ kind: "memory", record: reference });
  });

  it("shows the live title from the list and marks a version mismatch stale", () => {
    const renderer = renderChip(
      { terminalContexts: [], projectMemoryReferences: [reference] },
      (memoryId) =>
        memoryId === "mem-1"
          ? { status: "resolved", title: "API conventions" }
          : { status: "unknown" },
    );
    expect(chipText(renderer)).toBe("API conventions");

    const stale = renderChip(
      { terminalContexts: [], projectMemoryReferences: [reference] },
      () => ({ status: "stale", title: "API conventions", currentVersion: 5 }),
    );
    expect(chipText(stale)).toBe("API conventions · 이전 버전");
  });

  it("renders unknown for pending or truncated reads and unavailable only for a complete loaded list", () => {
    const unknown = renderChip(
      { terminalContexts: [], projectMemoryReferences: [reference] },
      () => ({ status: "unknown" }),
    );
    // A selected version stays visible while the state is unknown.
    expect(chipText(unknown)).toBe("Project memory v2");

    const missing = renderChip(
      { terminalContexts: [], projectMemoryReferences: [reference] },
      () => ({ status: "missing" }),
    );
    expect(chipText(missing)).toBe("Project memory · 사용 불가");
    const unresolved = missing.root
      .findAllByType("span")
      .find((node: ReactTestInstance) => node.props["data-context-unresolved"] === "true");
    expect(unresolved).toBeDefined();
  });

  it("falls back to the generic chip when no draft record backs the link", () => {
    const renderer = renderChip({ terminalContexts: [] }, () => ({
      status: "resolved",
      title: "unreachable",
    }));
    expect(chipText(renderer)).toBe("Project memory");
  });
});
