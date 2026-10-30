import {
  McpCapabilityUnavailableError,
  PROJECT_MEMORY_QUERY_MAX_LENGTH,
  PROJECT_MEMORY_REASON_MAX_LENGTH,
  ProjectMemoryRejectedError,
  ProjectMemoryStoreError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

/** Recall and proposals stay short: they are read and reviewed by people and models alike. */
export const MEMORY_RECALL_MAX_RESULTS = 10;
export const MEMORY_RECALL_TEXT_MAX_CHARS = 1_200;
export const MEMORY_PROPOSE_TEXT_MAX_CHARS = 2_000;

export const MemoryToolError = Schema.Union([
  McpCapabilityUnavailableError,
  ProjectMemoryRejectedError,
  ProjectMemoryStoreError,
]);

const MemoryRecallInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_MEMORY_QUERY_MAX_LENGTH)).annotate({
    description:
      "Words to look for, such as a topic, file, or tool name. Every word must match, so a few specific words work best.",
  }),
});

const MemoryRecallResult = Schema.Struct({
  memories: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      kind: Schema.Literals(["fact", "procedure", "work-log"]),
      text: Schema.String.annotate({
        description: `Clipped to ${MEMORY_RECALL_TEXT_MAX_CHARS} characters.`,
      }),
    }),
  ),
  moreAvailable: Schema.Boolean.annotate({
    description: "True when more memories match; narrow the query to see them.",
  }),
});

const MemoryProposeInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(MEMORY_PROPOSE_TEXT_MAX_CHARS)).annotate({
    description:
      "One self-contained durable fact, written so a future session can use it without this conversation. Put the key point in the first line. Include the rationale for a decision. Never include secrets, credentials, or personal data.",
  }),
  reason: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_MEMORY_REASON_MAX_LENGTH),
  ).annotate({
    description: "One or two sentences telling the user why this is worth remembering.",
  }),
});

const MemoryProposeResult = Schema.Struct({
  status: Schema.Literal("pending"),
  note: Schema.String,
});

const MemoryRecallTool = Tool.make("memory_recall", {
  description:
    "Search this project's saved memory for facts earlier sessions or the user wanted kept: decisions and why they were made, approaches that failed, user preferences and corrections, project conventions. Returns at most 10 matches with clipped text. Read-only. Fails when project memory is not shared with this thread's provider; then continue without it.",
  parameters: MemoryRecallInput,
  success: MemoryRecallResult,
  failure: MemoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "Recall project memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const MemoryProposeTool = Tool.make("memory_propose", {
  description:
    "Propose one durable memory for this project. Only propose what will still matter in later sessions: a decision with its rationale, an approach that failed and must not be retried, a correction or preference the user stated, or a project convention. Do not propose task progress, file contents, code you can read from the repository, or anything secret. The proposal waits for the user's approval and is not saved or searchable until they approve it, so do not rely on it. Propose rarely, one fact per call.",
  parameters: MemoryProposeInput,
  success: MemoryProposeResult,
  failure: MemoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "Propose a project memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const MemoryToolkit = Toolkit.make(MemoryRecallTool, MemoryProposeTool);
