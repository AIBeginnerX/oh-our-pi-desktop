import { ApprovalRequestId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { McpInvocationContext } from "../../McpInvocationContext.ts";

export class OutsideToolRejected extends Schema.TaggedError<OutsideToolRejected>()(
  "OutsideToolRejected",
  { message: Schema.String },
) {}

const ThreadStatus = Schema.Literals(["running", "idle", "needs input"]);

// An outside client answers one request at a time. Allowing for the session or permanently is
// left out: providers apply their own suggested rules for those, which can include a mode change
// or a lasting rule, and that would take a thread past the access level the client was approved for.
export const OutsideApprovalDecision = Schema.Literals(["accept", "decline", "cancel"]);
export type OutsideApprovalDecision = typeof OutsideApprovalDecision.Type;

const failure = OutsideToolRejected;
const dependencies = [McpInvocationContext];

const OopProjectList = Tool.make("oop_project_list", {
  description:
    "List every active project in this OOP environment, returning each project's id, title, and workspaceRoot. Read-only. Available only to external MCP clients.",
  success: Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        id: ProjectId,
        title: Schema.String,
        workspaceRoot: Schema.String,
      }),
    ),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List OOP projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const OopThreadList = Tool.make("oop_thread_list", {
  description:
    "List active threads in one project (pass projectId) or across every project (pass allProjects: true), most recently updated first. Pass exactly one of projectId or allProjects: true. Returns up to limit threads (1–100, default 50), each with id, projectId, title, updatedAt, and status (running, idle, or needs input). Excludes archived, deleted, and crew member threads. Fails for an unknown projectId. Read-only. Available only to external MCP clients.",
  parameters: Schema.Struct({
    projectId: Schema.optional(
      ProjectId.annotate({
        description:
          "List threads belonging to this project. Pass either projectId or allProjects: true, not both.",
      }),
    ),
    allProjects: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Set to true to list threads across every project. Pass either projectId or allProjects: true, not both.",
      }),
    ),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
        description: "Maximum number of threads to return (1–100, default 50).",
      }),
    ),
  }),
  success: Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        id: ThreadId,
        projectId: ProjectId,
        title: Schema.String,
        updatedAt: Schema.String,
        status: ThreadStatus,
      }),
    ),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List OOP threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const OopThreadRead = Tool.make("oop_thread_read", {
  description:
    "Read recent user and assistant message text from a thread in any project, oldest first within the result, along with the thread's status (running, idle, or needs input) and any pending approval requests or questions it is waiting on. Returns up to 20 messages and 12,000 text characters, with truncated set to true when older messages or long text are omitted. Excludes attachments, reasoning, and tool payloads. Archived and deleted threads are unavailable. Read-only. Available only to external MCP clients.",
  parameters: Schema.Struct({
    threadId: ThreadId.annotate({
      description: "The ID of the thread to read.",
    }),
  }),
  success: Schema.Struct({
    status: ThreadStatus,
    messages: Schema.Array(
      Schema.Struct({
        role: Schema.Literals(["user", "assistant"]),
        text: Schema.String,
      }),
    ),
    truncated: Schema.Boolean,
    pendingApprovals: Schema.Array(
      Schema.Struct({
        requestId: ApprovalRequestId,
        summary: Schema.String,
        detail: Schema.optional(Schema.String),
        decisions: Schema.Array(OutsideApprovalDecision),
      }),
    ),
    pendingQuestions: Schema.Array(
      Schema.Struct({
        requestId: ApprovalRequestId,
        questions: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            header: Schema.String,
            question: Schema.String,
            options: Schema.Array(
              Schema.Struct({
                label: Schema.String,
                description: Schema.String,
              }),
            ),
            multiSelect: Schema.Boolean,
            allowCustomAnswer: Schema.Boolean,
          }),
        ),
      }),
    ),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Read OOP thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const OopThreadStart = Tool.make("oop_thread_start", {
  description:
    "Create a new thread in the chosen project and immediately start a real coding-agent turn with your message. Returns the new threadId and resolved title. Message must be 1–20,000 characters after trimming; title defaults to the message's first line, trimmed to 120 characters. The thread's runtime mode is capped at the lower of the project's default runtime mode and this MCP client's approved access level. Refused for read-only MCP clients. Available only to external MCP clients.",
  parameters: Schema.Struct({
    projectId: ProjectId.annotate({
      description: "The ID of the project to create the thread in.",
    }),
    message: Schema.String.annotate({
      description: "Initial prompt for the agent (1–20,000 characters after trimming).",
    }),
    title: Schema.optional(
      Schema.String.annotate({
        description:
          "Optional thread title, trimmed to 120 characters. Defaults to the first line of message, trimmed to 120 characters.",
      }),
    ),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    title: Schema.String,
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Start OOP thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const OopThreadSend = Tool.make("oop_thread_send", {
  description:
    "Send a message to an existing idle thread and immediately start a real coding-agent turn using that thread's own runtime and interaction mode. Returns threadId and title. Message must be 1–20,000 characters after trimming. Refused for read-only MCP clients, for archived, deleted, crew member, or busy threads, and whenever the thread's runtime mode exceeds this MCP client's approved access ceiling. If a thread is busy or needs input, call oop_thread_read to inspect its pending approvals and questions, then act with oop_thread_approve, oop_thread_answer, or oop_thread_interrupt. Available only to external MCP clients.",
  parameters: Schema.Struct({
    threadId: ThreadId.annotate({
      description: "The ID of the idle thread to message.",
    }),
    message: Schema.String.annotate({
      description: "Message text for the agent (1–20,000 characters after trimming).",
    }),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    title: Schema.String,
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Send message to OOP thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const OopThreadApprove = Tool.make("oop_thread_approve", {
  description:
    "Respond to a pending approval request on a thread using its requestId from oop_thread_read. Accepts accept (this one request only), decline, or cancel, and only when that decision is listed for the pending request. Allowing for the rest of the session or permanently is not offered to external clients, and neither is accepting a request that widens the agent's permissions. Refused for read-only MCP clients, for archived, deleted, or crew member threads, when the thread's runtime mode exceeds this MCP client's approved access ceiling, or when the approval is no longer pending. Available only to external MCP clients.",
  parameters: Schema.Struct({
    threadId: ThreadId.annotate({
      description: "The ID of the thread with the pending approval request.",
    }),
    requestId: ApprovalRequestId.annotate({
      description: "The requestId of the pending approval from oop_thread_read.",
    }),
    decision: OutsideApprovalDecision.annotate({
      description:
        "The approval decision to send (must be one of the decisions listed for the pending approval).",
    }),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: OutsideApprovalDecision,
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Respond to OOP approval")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const OopThreadAnswer = Tool.make("oop_thread_answer", {
  description:
    "Answer a pending question on a thread using its requestId from oop_thread_read. Pass answers mapping each question id to a string, or an array of strings for a multiSelect question. Every question in the request must be answered with a non-empty value, and values outside the listed option labels are refused when allowCustomAnswer is false. Refused for read-only MCP clients, for archived, deleted, or crew member threads, when the thread's runtime mode exceeds this MCP client's approved access ceiling, or when the question is no longer pending. Available only to external MCP clients.",
  parameters: Schema.Struct({
    threadId: ThreadId.annotate({
      description: "The ID of the thread with the pending question.",
    }),
    requestId: ApprovalRequestId.annotate({
      description: "The requestId of the pending question from oop_thread_read.",
    }),
    answers: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Array(Schema.String)]),
    ).annotate({
      description:
        "Map from each question id to a string answer, or an array of strings for a multiSelect question.",
    }),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    requestId: ApprovalRequestId,
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Answer OOP thread question")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const OopThreadInterrupt = Tool.make("oop_thread_interrupt", {
  description:
    "Interrupt the currently running turn or pending request on a thread. Refused for read-only MCP clients, for archived, deleted, or crew member threads, when the thread's runtime mode exceeds this MCP client's approved access ceiling, or when the thread is neither running nor waiting on an open request. Available only to external MCP clients.",
  parameters: Schema.Struct({
    threadId: ThreadId.annotate({
      description: "The ID of the running thread to interrupt.",
    }),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Interrupt OOP thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const OutsideToolkit = Toolkit.make(
  OopProjectList,
  OopThreadList,
  OopThreadRead,
  OopThreadStart,
  OopThreadSend,
  OopThreadApprove,
  OopThreadAnswer,
  OopThreadInterrupt,
);
