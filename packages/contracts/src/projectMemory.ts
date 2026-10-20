import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const PROJECT_MEMORY_TITLE_MAX_LENGTH = 200;
export const PROJECT_MEMORY_BODY_MAX_LENGTH = 8000;
export const PROJECT_MEMORY_QUERY_MAX_LENGTH = 256;
export const PROJECT_MEMORY_MAX_LIMIT = 100;
/** Page bound for thread-recovery change listings. Held equal to the send
    ledger's PROJECT_MEMORY_AFFECTED_PAGE_MAX; a server test pins the two. */
export const PROJECT_MEMORY_THREAD_CHANGES_MAX = 50;

export const ProjectMemoryId = TrimmedNonEmptyString.pipe(Schema.brand("ProjectMemoryId"));
export type ProjectMemoryId = typeof ProjectMemoryId.Type;

export const ProjectMemoryKind = Schema.Literals(["fact", "procedure", "work-log"]);
export type ProjectMemoryKind = typeof ProjectMemoryKind.Type;

/**
 * Where a memory came from. `manual` is written directly by the user;
 * `message` records the thread message it was saved from. The server verifies
 * that the thread and message live in the same project before accepting a
 * `message` origin. The origin is provenance only: deleting a memory never
 * deletes the source message.
 */
export const ProjectMemoryOrigin = Schema.Union([
  Schema.Struct({ type: Schema.Literal("manual") }),
  Schema.Struct({
    type: Schema.Literal("message"),
    threadId: ThreadId,
    messageId: MessageId,
  }),
]);
export type ProjectMemoryOrigin = typeof ProjectMemoryOrigin.Type;

export const ProjectMemoryTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_MEMORY_TITLE_MAX_LENGTH),
);
export const ProjectMemoryBody = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_MEMORY_BODY_MAX_LENGTH),
);

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Write-side expiry: an ISO-8601 instant that actually parses. Malformed
    dates fail payload decoding rather than reaching the store. Reads stay on
    the lenient `IsoDateTime` so older stored values still round-trip. */
export const IsoInstant = IsoDateTime.check(
  Schema.makeFilter(
    (value) => ISO_INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value)),
    { expected: "an ISO-8601 instant" },
  ),
);

/**
 * A project-scoped durable memory. `title`/`body` live only in the memory
 * store and its FTS index; they are never copied into events, logs, or
 * provider context. `version` increments on each update and is required for
 * optimistic-concurrency writes. `validUntil` is an ISO instant or null for
 * no expiry; an instant in the past means the memory is already expired.
 */
export const ProjectMemory = Schema.Struct({
  memoryId: ProjectMemoryId,
  projectId: ProjectId,
  kind: ProjectMemoryKind,
  title: ProjectMemoryTitle,
  body: ProjectMemoryBody,
  version: PositiveInt,
  origin: ProjectMemoryOrigin,
  validUntil: Schema.NullOr(IsoDateTime),
  /**
   * Heuristic estimate (roughly chars/4), server-written for budget displays.
   * Not a real tokenizer and not calibrated for non-Latin scripts.
   */
  estimatedTokens: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectMemory = typeof ProjectMemory.Type;

/** List/search rows omit `body`; `projectMemory.get` loads it for editing. */
export const ProjectMemorySummary = Schema.Struct({
  memoryId: ProjectMemoryId,
  projectId: ProjectId,
  kind: ProjectMemoryKind,
  title: ProjectMemoryTitle,
  version: PositiveInt,
  origin: ProjectMemoryOrigin,
  validUntil: Schema.NullOr(IsoDateTime),
  estimatedTokens: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectMemorySummary = typeof ProjectMemorySummary.Type;

const limitField = Schema.optional(
  PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_MEMORY_MAX_LIMIT)),
);

export const ProjectMemoryListInput = Schema.Struct({
  projectId: ProjectId,
  limit: limitField,
});
export type ProjectMemoryListInput = typeof ProjectMemoryListInput.Type;

export const ProjectMemorySearchInput = Schema.Struct({
  projectId: ProjectId,
  /**
   * Optional and untrimmed on the wire (whitespace inside a query is
   * significant to literal matching). Absent or whitespace-only means a
   * bounded browse identical to `projectMemory.list`.
   */
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(PROJECT_MEMORY_QUERY_MAX_LENGTH))),
  limit: limitField,
});
export type ProjectMemorySearchInput = typeof ProjectMemorySearchInput.Type;

export const ProjectMemoryListResult = Schema.Struct({
  items: Schema.Array(ProjectMemorySummary),
  truncated: Schema.Boolean,
});
export type ProjectMemoryListResult = typeof ProjectMemoryListResult.Type;

export const ProjectMemorySearchResult = Schema.Struct({
  items: Schema.Array(ProjectMemorySummary),
  truncated: Schema.Boolean,
});
export type ProjectMemorySearchResult = typeof ProjectMemorySearchResult.Type;

export const ProjectMemoryGetInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: ProjectMemoryId,
});
export type ProjectMemoryGetInput = typeof ProjectMemoryGetInput.Type;

export const ProjectMemoryGetResult = Schema.Struct({
  memory: ProjectMemory,
});
export type ProjectMemoryGetResult = typeof ProjectMemoryGetResult.Type;

export const ProjectMemoryCreateInput = Schema.Struct({
  projectId: ProjectId,
  kind: ProjectMemoryKind,
  title: ProjectMemoryTitle,
  body: ProjectMemoryBody,
  /** Absent means `manual`. A `message` origin is verified server-side. */
  origin: Schema.optional(ProjectMemoryOrigin),
  /** ISO instant; absent or null means no expiry. */
  validUntil: Schema.optional(Schema.NullOr(IsoInstant)),
});
export type ProjectMemoryCreateInput = typeof ProjectMemoryCreateInput.Type;

export const ProjectMemoryUpdateInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: ProjectMemoryId,
  expectedVersion: PositiveInt,
  title: Schema.optional(ProjectMemoryTitle),
  body: Schema.optional(ProjectMemoryBody),
  kind: Schema.optional(ProjectMemoryKind),
  /** Absent keeps the expiry; null clears it; a value replaces it. */
  validUntil: Schema.optional(Schema.NullOr(IsoInstant)),
});
export type ProjectMemoryUpdateInput = typeof ProjectMemoryUpdateInput.Type;

export const ProjectMemoryDeleteInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: ProjectMemoryId,
  expectedVersion: PositiveInt,
});
export type ProjectMemoryDeleteInput = typeof ProjectMemoryDeleteInput.Type;

export const ProjectMemoryWriteResult = Schema.Struct({
  memory: ProjectMemory,
});
export type ProjectMemoryWriteResult = typeof ProjectMemoryWriteResult.Type;

export const ProjectMemoryThreadStateInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  /** Absent means the server-side default of 20. */
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_MEMORY_THREAD_CHANGES_MAX)),
  ),
});
export type ProjectMemoryThreadStateInput = typeof ProjectMemoryThreadStateInput.Type;

export const ProjectMemoryThreadChange = Schema.Struct({
  changeSeq: PositiveInt,
  reason: Schema.Literals(["updated", "deleted"]),
  /** Present only if the memory exists in the requested live project in the read snapshot. */
  memoryId: Schema.optionalKey(ProjectMemoryId),
});
export type ProjectMemoryThreadChange = typeof ProjectMemoryThreadChange.Type;

/** "May have been sent" exposure for this thread ID's retained history. Not a delivery count. */
export const ProjectMemoryThreadState = Schema.Struct({
  /** Whole retained history, independent of the requested page. */
  held: Schema.Boolean,
  latestChangeSeq: Schema.NullOr(PositiveInt),
  acknowledgedThrough: NonNegativeInt,
  /** Unacknowledged page, changeSeq descending; length is not the total count. */
  changes: Schema.Array(ProjectMemoryThreadChange),
  /** Conservative full-page test: true whenever the page is exactly `limit` long. */
  mayHaveMore: Schema.Boolean,
});
export type ProjectMemoryThreadState = typeof ProjectMemoryThreadState.Type;

/** Accepts ALL retained-context changes through the watermark, including ones not shown. Never erases provider context. */
export const ProjectMemoryAcknowledgeThreadInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  throughChangeSeq: PositiveInt,
});
export type ProjectMemoryAcknowledgeThreadInput = typeof ProjectMemoryAcknowledgeThreadInput.Type;

export const ProjectMemoryAcknowledgeThreadResult = Schema.Struct({
  status: Schema.Literals(["applied", "unchanged"]),
  acknowledgedThrough: NonNegativeInt,
});
export type ProjectMemoryAcknowledgeThreadResult = typeof ProjectMemoryAcknowledgeThreadResult.Type;

export const ProjectMemoryRejectedReason = Schema.Literals([
  "sensitive",
  "too-long",
  "empty",
  "project-missing",
  "origin-invalid",
  "thread-missing",
  "acknowledgement-invalid",
]);
export type ProjectMemoryRejectedReason = typeof ProjectMemoryRejectedReason.Type;

const REJECTED_REASON_MESSAGES: Record<ProjectMemoryRejectedReason, string> = {
  sensitive: "Input was rejected as sensitive.",
  "too-long": "Input is too long.",
  empty: "Title and body must not be empty.",
  "project-missing": "Project is missing or deleted.",
  "origin-invalid": "Source message does not belong to this project.",
  "thread-missing": "Thread is missing, deleted, or not in this project.",
  "acknowledgement-invalid": "Acknowledgement watermark is invalid.",
};

type ProjectMemoryErrorContext = {
  readonly message?: string;
  readonly cause?: unknown;
};

function decodedMemoryErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class ProjectMemoryNotFoundError extends Schema.TaggedError<ProjectMemoryNotFoundError>()(
  "ProjectMemoryNotFoundError",
  {
    projectId: Schema.optional(ProjectId),
    memoryId: Schema.optional(ProjectMemoryId),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The structured fields are optional on the wire so newer peers can decode
  // legacy message-only failures. New application code must provide them
  // through this constructor. The message is always a fixed string; memory
  // titles and bodies are never placed on errors.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectMemoryErrorContext & {
      readonly projectId: ProjectId;
      readonly memoryId: ProjectMemoryId;
    },
  ) {
    super({
      ...props,
      message: decodedMemoryErrorMessage(props) ?? "Project memory not found.",
    });
  }
}

export class ProjectMemoryConflictError extends Schema.TaggedError<ProjectMemoryConflictError>()(
  "ProjectMemoryConflictError",
  {
    projectId: Schema.optional(ProjectId),
    memoryId: Schema.optional(ProjectMemoryId),
    currentVersion: Schema.optional(PositiveInt),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectMemoryErrorContext & {
      readonly projectId: ProjectId;
      readonly memoryId: ProjectMemoryId;
      readonly currentVersion: number;
    },
  ) {
    super({
      ...props,
      message: decodedMemoryErrorMessage(props) ?? "Project memory changed since it was loaded.",
    });
  }
}

export class ProjectMemoryRejectedError extends Schema.TaggedError<ProjectMemoryRejectedError>()(
  "ProjectMemoryRejectedError",
  {
    reason: Schema.optional(ProjectMemoryRejectedReason),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // Fixed messages per reason so a rejected title/body never appears on the
  // error — including for the `sensitive` reason, which must not echo secrets.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectMemoryErrorContext & { readonly reason: ProjectMemoryRejectedReason }) {
    super({
      ...props,
      message: decodedMemoryErrorMessage(props) ?? REJECTED_REASON_MESSAGES[props.reason],
    });
  }
}

export class ProjectMemoryStoreError extends Schema.TaggedError<ProjectMemoryStoreError>()(
  "ProjectMemoryStoreError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectMemoryError = Schema.Union([
  ProjectMemoryNotFoundError,
  ProjectMemoryConflictError,
  ProjectMemoryRejectedError,
  ProjectMemoryStoreError,
]);
export type ProjectMemoryError = typeof ProjectMemoryError.Type;
