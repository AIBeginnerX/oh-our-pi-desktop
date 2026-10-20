import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { ProjectId } from "./baseSchemas.ts";
import {
  PROJECT_MEMORY_BODY_MAX_LENGTH,
  PROJECT_MEMORY_MAX_LIMIT,
  PROJECT_MEMORY_QUERY_MAX_LENGTH,
  PROJECT_MEMORY_THREAD_CHANGES_MAX,
  PROJECT_MEMORY_TITLE_MAX_LENGTH,
  ProjectMemoryAcknowledgeThreadInput,
  ProjectMemoryCreateInput,
  ProjectMemoryDeleteInput,
  ProjectMemoryGetInput,
  ProjectMemoryId,
  ProjectMemoryNotFoundError,
  ProjectMemoryRejectedError,
  ProjectMemorySearchInput,
  ProjectMemoryStoreError,
  ProjectMemoryThreadState,
  ProjectMemoryThreadStateInput,
  ProjectMemoryUpdateInput,
} from "./projectMemory.ts";

const decodeCreateInput = Schema.decodeUnknownSync(ProjectMemoryCreateInput);
const decodeUpdateInput = Schema.decodeUnknownSync(ProjectMemoryUpdateInput);
const decodeDeleteInput = Schema.decodeUnknownSync(ProjectMemoryDeleteInput);
const decodeGetInput = Schema.decodeUnknownSync(ProjectMemoryGetInput);
const decodeSearchInput = Schema.decodeUnknownSync(ProjectMemorySearchInput);
const decodeThreadStateInput = Schema.decodeUnknownSync(ProjectMemoryThreadStateInput);
const decodeThreadState = Schema.decodeUnknownSync(ProjectMemoryThreadState);
const decodeAckInput = Schema.decodeUnknownSync(ProjectMemoryAcknowledgeThreadInput);

const baseCreate = {
  projectId: "project-1",
  kind: "fact",
  title: "Release checklist",
  body: "Ship the build, then verify the installer.",
} as const;

describe("projectMemory inputs", () => {
  it("decodes a minimal create input with a default manual origin", () => {
    const decoded = decodeCreateInput(baseCreate);
    expect(decoded.origin).toBeUndefined();
    expect(decoded.validUntil).toBeUndefined();
  });

  it("decodes a message origin and an expiry", () => {
    const decoded = decodeCreateInput({
      ...baseCreate,
      origin: { type: "message", threadId: "thread-1", messageId: "message-1" },
      validUntil: "2027-01-01T00:00:00.000Z",
    });
    expect(decoded.origin).toEqual({
      type: "message",
      threadId: "thread-1",
      messageId: "message-1",
    });
    expect(decoded.validUntil).toBe("2027-01-01T00:00:00.000Z");
  });

  it("rejects malformed expiry dates instead of reaching the store", () => {
    expect(() => decodeCreateInput({ ...baseCreate, validUntil: "next tuesday" })).toThrow();
    expect(() =>
      decodeCreateInput({ ...baseCreate, validUntil: "2027-13-99T99:99:99Z" }),
    ).toThrow();
  });

  it("rejects titles and bodies over the documented limits", () => {
    expect(() =>
      decodeCreateInput({ ...baseCreate, title: "x".repeat(PROJECT_MEMORY_TITLE_MAX_LENGTH + 1) }),
    ).toThrow();
    expect(() =>
      decodeCreateInput({ ...baseCreate, body: "x".repeat(PROJECT_MEMORY_BODY_MAX_LENGTH + 1) }),
    ).toThrow();
    expect(() => decodeCreateInput({ ...baseCreate, title: "   " })).toThrow();
    expect(() => decodeCreateInput({ ...baseCreate, body: "   " })).toThrow();
  });

  it("rejects unknown kinds and malformed origins", () => {
    expect(() => decodeCreateInput({ ...baseCreate, kind: "note" })).toThrow();
    expect(() =>
      decodeCreateInput({ ...baseCreate, origin: { type: "message", threadId: "thread-1" } }),
    ).toThrow();
    expect(() => decodeCreateInput({ ...baseCreate, origin: { type: "guess" } })).toThrow();
  });

  it("requires a positive expectedVersion on update and delete", () => {
    expect(() =>
      decodeUpdateInput({
        projectId: "project-1",
        memoryId: "memory-1",
        expectedVersion: 0,
        title: "x",
      }),
    ).toThrow();
    expect(() =>
      decodeDeleteInput({ projectId: "project-1", memoryId: "memory-1", expectedVersion: -1 }),
    ).toThrow();
    expect(
      decodeUpdateInput({
        projectId: "project-1",
        memoryId: "memory-1",
        expectedVersion: 3,
        title: "x",
      }).expectedVersion,
    ).toBe(3);
  });

  it("bounds search queries and limits while preserving query whitespace", () => {
    const decoded = decodeSearchInput({ projectId: "project-1", query: " foo ", limit: 10 });
    expect(decoded.query).toBe(" foo ");
    expect(() =>
      decodeSearchInput({
        projectId: "project-1",
        query: "x".repeat(PROJECT_MEMORY_QUERY_MAX_LENGTH + 1),
      }),
    ).toThrow();
    expect(() =>
      decodeSearchInput({ projectId: "project-1", limit: PROJECT_MEMORY_MAX_LIMIT + 1 }),
    ).toThrow();
    expect(() => decodeSearchInput({ projectId: "project-1", limit: 0 })).toThrow();
  });

  it("scopes get input by project and memory ids", () => {
    const decoded = decodeGetInput({ projectId: "project-1", memoryId: "memory-1" });
    expect(decoded.projectId).toBe("project-1");
    expect(decoded.memoryId).toBe("memory-1");
  });
});

describe("projectMemory thread-recovery inputs", () => {
  it.each([
    { label: "absent", value: undefined, ok: true },
    { label: "1", value: 1, ok: true },
    {
      label: "PROJECT_MEMORY_THREAD_CHANGES_MAX",
      value: PROJECT_MEMORY_THREAD_CHANGES_MAX,
      ok: true,
    },
    { label: "0", value: 0, ok: false },
    { label: "negative", value: -3, ok: false },
    {
      label: "PROJECT_MEMORY_THREAD_CHANGES_MAX + 1",
      value: PROJECT_MEMORY_THREAD_CHANGES_MAX + 1,
      ok: false,
    },
    { label: "fraction", value: 2.5, ok: false },
    { label: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1, ok: false },
  ])("binds threadStateInput.limit at %s", ({ value, ok }) => {
    const input = { projectId: "project-1", threadId: "thread-1", limit: value };
    if (ok) {
      const decoded = decodeThreadStateInput(input);
      expect(decoded.projectId).toBe("project-1");
      expect(decoded.threadId).toBe("thread-1");
      expect(decoded.limit).toBe(value);
    } else {
      expect(() => decodeThreadStateInput(input)).toThrow();
    }
  });

  it.each([
    { label: "1", value: 1, ok: true },
    { label: "0", value: 0, ok: false },
    { label: "negative", value: -1, ok: false },
    { label: "fraction", value: 1.5, ok: false },
    { label: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 2, ok: false },
  ])("binds acknowledgeThread.throughChangeSeq at %s", ({ value, ok }) => {
    const input = { projectId: "project-1", threadId: "thread-1", throughChangeSeq: value };
    if (ok) {
      const decoded = decodeAckInput(input);
      expect(decoded.throughChangeSeq).toBe(value);
    } else {
      expect(() => decodeAckInput(input)).toThrow();
    }
  });

  it("decodes omitted memory identities and watermark fields", () => {
    const decoded = decodeThreadState({
      held: true,
      latestChangeSeq: 42,
      acknowledgedThrough: 17,
      changes: [
        { changeSeq: 25, reason: "updated" },
        { changeSeq: 24, reason: "deleted" },
      ],
      mayHaveMore: true,
    });
    expect(decoded.changes).toEqual([
      { changeSeq: 25, reason: "updated" },
      { changeSeq: 24, reason: "deleted" },
    ]);
    expect(decoded.mayHaveMore).toBe(true);
    expect(decoded.latestChangeSeq).toBe(42);
    expect(decoded.acknowledgedThrough).toBe(17);
  });

  it("decodes present memory identity", () => {
    const decoded = decodeThreadState({
      held: true,
      latestChangeSeq: 1,
      acknowledgedThrough: 0,
      changes: [{ changeSeq: 1, reason: "updated", memoryId: "memory-1" }],
      mayHaveMore: false,
    });
    expect(decoded.held).toBe(true);
    expect(decoded.latestChangeSeq).toBe(1);
    expect(decoded.acknowledgedThrough).toBe(0);
    expect(decoded.mayHaveMore).toBe(false);
    expect(decoded.changes).toEqual([
      { changeSeq: 1, reason: "updated", memoryId: ProjectMemoryId.make("memory-1") },
    ]);
  });
});

describe("projectMemory errors", () => {
  it("uses fixed messages that never carry rejected input", () => {
    const rejected = new ProjectMemoryRejectedError({ reason: "sensitive" });
    expect(rejected.message).toBe("Input was rejected as sensitive.");
    expect(rejected).not.toHaveProperty("title");
    expect(rejected).not.toHaveProperty("body");

    const missing = new ProjectMemoryNotFoundError({
      projectId: ProjectId.make("project-1"),
      memoryId: ProjectMemoryId.make("memory-1"),
    });
    expect(missing.message).toBe("Project memory not found.");
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const decodeRejected = Schema.decodeUnknownSync(ProjectMemoryRejectedError);
    const decodeStore = Schema.decodeUnknownSync(ProjectMemoryStoreError);

    const rejected = decodeRejected({
      _tag: "ProjectMemoryRejectedError",
      message: "Legacy rejection.",
    });
    expect(rejected.message).toBe("Legacy rejection.");
    expect(rejected.reason).toBeUndefined();

    const store = decodeStore({
      _tag: "ProjectMemoryStoreError",
      message: "Legacy store failure.",
    });
    expect(store.message).toBe("Legacy store failure.");
  });
});

describe("projectMemory capability", () => {
  const descriptor = {
    environmentId: "environment-1",
    label: "Local",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.58",
    capabilities: { repositoryIdentity: true },
  } as const;
  const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

  it("treats a missing projectMemory capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.projectMemory).toBeUndefined();
  });

  it("preserves an advertised manage/send flag pair", () => {
    const decoded = decodeDescriptor({
      ...descriptor,
      capabilities: {
        ...descriptor.capabilities,
        projectMemory: { manage: true, send: false },
      },
    });
    expect(decoded.capabilities.projectMemory).toEqual({ manage: true, send: false });
  });
});
