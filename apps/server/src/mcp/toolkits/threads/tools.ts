import { McpCapabilityUnavailableError, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { McpInvocationContext } from "../../McpInvocationContext.ts";

export class ThreadsToolRejected extends Schema.TaggedError<ThreadsToolRejected>()(
  "ThreadsToolRejected",
  { message: Schema.String },
) {}

const failure = Schema.Union([McpCapabilityUnavailableError, ThreadsToolRejected]);
const dependencies = [McpInvocationContext];

const ListThreads = Tool.make("list_threads", {
  description:
    "List up to 20 other threads in this project, most recently updated first. Excludes your own thread, crew member threads, archived threads, and deleted threads. Includes each thread's ID, title, update time, and whether it is running, idle, or needs input.",
  success: Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        id: ThreadId,
        title: Schema.String,
        updatedAt: Schema.String,
        status: Schema.Literals(["running", "idle", "needs input"]),
      }),
    ),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadThread = Tool.make("read_thread", {
  description:
    "Read recent user and assistant message text from a thread in your project, oldest first within the result. Returns up to 20 messages and 12,000 text characters, with a truncation flag when older content or long text is omitted. Excludes attachments, reasoning, and tool payloads. Archived and deleted threads are unavailable.",
  parameters: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({
        role: Schema.Literals(["user", "assistant"]),
        text: Schema.String,
      }),
    ),
    truncated: Schema.Boolean,
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SendThreadMessage = Tool.make("send_thread_message", {
  description:
    "Deliver a message on your behalf and start a normal turn in another idle, non-archived, non-crew thread in your project that uses the same access and interaction mode as yours. The message is labeled as agent-sent. Use 1–4,000 characters of plain text after trimming, with no project memory links. You can send at most three messages per turn. A crew member cannot send, and a thread that received one of these messages cannot send for an hour; it can still be read with read_thread.",
  parameters: Schema.Struct({ threadId: ThreadId, text: Schema.String }),
  success: Schema.Struct({ threadId: ThreadId, title: Schema.String }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const SuggestTask = Tool.make("suggest_task", {
  description:
    "Add a task suggestion card to your current thread. The user can open it as a new draft with the proposed prompt. This tool never creates a thread or starts a turn. Use a title of 1–120 characters and a prompt of 1–4,000 characters after trimming. At most five distinct suggestions per turn.",
  parameters: Schema.Struct({ title: Schema.String, prompt: Schema.String }),
  success: Schema.Struct({ suggestionId: Schema.String }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(ListThreads, ReadThread, SendThreadMessage, SuggestTask);
