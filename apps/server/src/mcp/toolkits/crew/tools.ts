import {
  CREW_WHY_MAX_LENGTH,
  CrewProof,
  CrewTodoStatus,
  McpCapabilityUnavailableError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { CrewError } from "../../../crew/CrewService.ts";
import { CrewMemberReport } from "../../../crew/crewLogic.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

const CREW_GUIDE =
  "OOP Crew lets you lead a team of other models. You are the brain: keep the plan and the conversation with the user, and hand self-contained work to the crew.";

export const CrewToolError = Schema.Union([McpCapabilityUnavailableError, CrewError]);

const CrewCoolingEntry = Schema.Struct({
  provider: Schema.String.annotate({
    description: "Display name of the provider that is cooling down.",
  }),
  model: Schema.optional(
    Schema.String.annotate({
      description:
        "Set when only this one model is blocked (its provider refused it), so the provider's other models still work.",
    }),
  ),
  until: Schema.optional(
    Schema.String.annotate({
      description:
        "When the cooling ends, as ISO time. Absent when it ends the next time the provider is checked (a billing or sign-in failure, or a refused model).",
    }),
  ),
  reason: Schema.String.annotate({
    description:
      'Short why, for example "usage limit", "5-hour limit", "billing", "model refused".',
  }),
});

const CrewRosterResult = Schema.Struct({
  enabled: Schema.Boolean,
  roles: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["worker", "expert", "auditor"]),
      model: Schema.NullOr(Schema.String),
      provider: Schema.NullOr(Schema.String),
      fallbacks: Schema.optional(
        Schema.Array(Schema.Struct({ model: Schema.String, provider: Schema.String })).annotate({
          description:
            "The user's fallback models for this role, in the order they are tried when the role's own model fails; absent when none are set.",
        }),
      ),
    }),
  ),
  cooling: Schema.Array(CrewCoolingEntry).annotate({
    description:
      "Providers and single models cooling down after failures right now, so you know which crew members are temporarily unavailable; empty when none.",
  }),
});

const CrewTodoCheckSpec = Schema.Struct({
  command: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "A shell command OOP runs itself in the task's workspace when the member checks the item off; the item is verified only if it exits 0. Keep it fast and deterministic (a focused test or typecheck run).",
    }),
  ),
  files: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({
      description:
        "Repo-relative files or directories that must have changed since the task started for the item to be verified.",
    }),
  ),
});

const CrewTodoInput = Schema.Union([
  TrimmedNonEmptyString,
  Schema.Struct({
    text: TrimmedNonEmptyString.annotate({ description: "One short, concrete step." }),
    check: Schema.optional(CrewTodoCheckSpec),
  }),
]);

const CrewWhy = Schema.optional(
  Schema.String.annotate({
    description: `One sentence: why you chose this, what you considered or rejected. Shown in the decision log; trimmed and cut to ${CREW_WHY_MAX_LENGTH} characters.`,
  }),
);

const CrewDelegateInput = Schema.Struct({
  role: Schema.Literals(["worker", "expert"]).annotate({
    description:
      "worker for routine, well-specified work (searches, edits, tests, boilerplate); expert for hard implementation or debugging.",
  }),
  task: TrimmedNonEmptyString.annotate({
    description:
      "Everything the crew member needs, written for someone who has not seen this conversation: goal, context, and constraints. Put the files it may change in writeScope, the proving command in verify, and the finish line in doneWhen.",
  }),
  writeScope: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({
      description:
        'Repo-relative files or directories this task may modify; end a directory with "/". A trailing "*" or "**" glob is allowed. Crew warns when the scope overlaps a task that is still running.',
    }),
  ),
  verify: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "The literal command or commands that prove the task is done, for example the exact test run. The crew member runs them and reports the result.",
    }),
  ),
  doneWhen: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "What must be true for the task to count as done, beyond the verify command.",
    }),
  ),
  isolation: Schema.optional(
    Schema.Literals(["shared", "worktree", "candidate"]).annotate({
      description:
        'shared (default) works in this same workspace. Use "worktree" for parallel tasks that edit code, so they cannot clobber each other: the member starts from the current tracked state (committed and uncommitted tracked changes, not untracked or ignored files such as node_modules) in its own git worktree, and its changes are applied back to this workspace when it finishes. A conflict keeps the worktree and says so in the report. "candidate" also works in its own worktree but is never applied: the patch and worktree are kept and named in the report so you can compare candidates and pick (see the Arena note in your crew brief).',
    }),
  ),
  differentFrom: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(4)).annotate({
      description:
        "Ids of earlier tasks. This task runs on a model of another family than theirs when one is available; otherwise on another model, or the same one with a warning that its judgment is not independent. Use it for arena candidates and the judge.",
    }),
  ),
  todos: Schema.optional(
    Schema.Array(CrewTodoInput).check(Schema.isMaxLength(12)).annotate({
      description:
        'A checklist for the crew member, at most 12 items, each either a short string or {"text", "check"}. OOP numbers them t1, t2, ... (the result lists the ids), shows the progress, and the member checks each item off as it finishes it. Give an item a check ({"command"} and/or {"files"}) when something can prove it: OOP then runs the check itself, and only a passing check counts as verified. Items without a check count as claimed, never verified. A task that ends with items unfinished or failing comes back as partial.',
    }),
  ),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "A short English summary of the task's core work, at most eight words; the OOP Agents board shows it.",
    }),
  ),
  why: CrewWhy,
});

const CrewDelegateResult = Schema.Struct({
  taskId: Schema.String,
  model: Schema.String,
  warning: Schema.optional(Schema.String),
  todos: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String }))),
});

const CrewAddTodosInput = Schema.Struct({
  taskId: TrimmedNonEmptyString.annotate({
    description: "The taskId crew_delegate returned for a task of yours that is still running.",
  }),
  todos: Schema.Array(CrewTodoInput).check(Schema.isMinLength(1), Schema.isMaxLength(12)).annotate({
    description: "The items to add, in the same shape as crew_delegate todos.",
  }),
});

const CrewAddTodosResult = Schema.Struct({
  todos: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  total: Schema.Number,
});

const CrewTodoCheckInput = Schema.Struct({
  todoId: TrimmedNonEmptyString.annotate({
    description: "The TODO id from your task brief, for example t1.",
  }),
  status: Schema.Literals(["done", "blocked"]).annotate({
    description: "done when you finished the item, blocked when you cannot do it.",
  }),
  note: Schema.optional(
    Schema.String.annotate({
      description:
        "One short line on what you did, or what blocks you. Required for blocked, and for a done item that has no server check.",
    }),
  ),
});

const CrewTodoCheckResult = Schema.Struct({
  todoId: Schema.String,
  status: CrewTodoStatus,
  alreadyChecked: Schema.Boolean,
  remaining: Schema.Array(Schema.String),
  message: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
});

const CrewWaitInput = Schema.Struct({
  taskIds: Schema.Array(Schema.String).annotate({
    description: "Task ids returned by crew_delegate.",
  }),
  timeoutSeconds: Schema.optional(
    Schema.Number.annotate({
      description: "How long to wait this call, at most 50 seconds. Call again while tasks run.",
    }),
  ),
});

const CrewWaitResult = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      taskId: Schema.String,
      role: Schema.NullOr(Schema.String),
      status: Schema.Literals([
        "starting",
        "running",
        "completed",
        "partial",
        "blocked",
        "failed",
        "interrupted",
      ]),
      result: Schema.NullOr(Schema.String),
      report: Schema.optional(CrewMemberReport),
      proof: Schema.optional(Schema.Struct({ verdict: CrewProof, reason: Schema.String })),
    }),
  ),
});

const CrewStopInput = Schema.Struct({
  taskId: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "A taskId crew_delegate returned." }),
  ),
  all: Schema.optional(
    Schema.Boolean.annotate({ description: "Stop every task of yours that is still running." }),
  ),
  why: CrewWhy,
});

const CrewStopResult = Schema.Struct({
  stopped: Schema.Array(Schema.String),
  stopping: Schema.Array(Schema.String).annotate({
    description: "Interrupted tasks that had not ended yet; they still end on their own.",
  }),
});

const CrewRosterTool = Tool.make("crew_roster", {
  description: `${CREW_GUIDE} Shows whether the crew is on for this thread and which model fills each role right now; the user can change it mid-chat, so this is the current crew even if an earlier note differs. Fast-path runs of your Agent tool get no OOP fallback or cooling; only crew_delegate does.`,
  success: CrewRosterResult,
  failure: CrewToolError,
  dependencies,
})
  .annotate(Tool.Title, "Show the crew")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CrewDelegateTool = Tool.make("crew_delegate", {
  description: `${CREW_GUIDE} Hands one task to the worker or expert model, which works in this same workspace (or, with isolation "worktree", its own worktree) as its own thread. Give it a todos checklist and, on each item something can prove, a check the server runs for you (command or files) that fails until the item is done and can run in that task's environment, so prefer a command you know works there (name test files, not a folder) and one that proves the content, since files alone only proves a change; keep each item to one step, and finish or hand on anything left undone, since it comes back partial. Returns at once with a taskId (and a warning when the task's writeScope overlaps one still running); start several in parallel when the work splits cleanly, then collect them with crew_wait. If the crew model fails, OOP hands the same task to the role's fallback models first, then another model of the same level. Fails when the crew is off; then do the work yourself.`,
  parameters: CrewDelegateInput,
  success: CrewDelegateResult,
  failure: CrewToolError,
  dependencies,
})
  .annotate(Tool.Title, "Hand a task to the crew")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CrewWaitTool = Tool.make("crew_wait", {
  description:
    "Waits up to 50 seconds for delegated crew tasks and returns each one's status and, when it finished, its report text (result) and, when the crew member ended with a JSON block, the parsed report with its changed files, verification, and findings. Call it again while any task is still running. Check the reports before telling the user the work is done. `proof` says whether OOP itself could verify the work. Only `verified` may be reported to the user as done; `inconclusive` means nothing proved it.",
  parameters: CrewWaitInput,
  success: CrewWaitResult,
  failure: CrewToolError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for crew tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CrewStopTool = Tool.make("crew_stop", {
  description:
    "Stops a running crew task (taskId) or all of yours (all: true) when the work is no longer wanted. The member stops where it is and the task comes back stopped, never retried; returns the stopped ids, and the ids still stopping if they had not ended yet.",
  parameters: CrewStopInput,
  success: CrewStopResult,
  failure: CrewToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop crew tasks")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CrewAddTodosTool = Tool.make("crew_add_todos", {
  description:
    "Adds checklist items to a task of yours that is still running, for extra work that unavoidably belongs to the same member (other work goes in a new crew_delegate task). Items are numbered after the existing ones and the whole list stays within 12; they reach the member as a follow-up turn once its current turn ends, never in the middle of it. Refused once the task has finished; delegate a new task then.",
  parameters: CrewAddTodosInput,
  success: CrewAddTodosResult,
  failure: CrewToolError,
  dependencies,
})
  .annotate(Tool.Title, "Add TODO items to a crew task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CrewTodoCheckTool = Tool.make("crew_todo_check", {
  description:
    "For crew members only: marks one item of your task's TODO list done or blocked. Call it as soon as you finish each item, not all at the end. If OOP checks the item itself, it runs that check now and answers with the result: verified, or failed with the end of the output so you can fix the cause and call again. Repeating a call for a settled item is harmless.",
  parameters: CrewTodoCheckInput,
  success: CrewTodoCheckResult,
  failure: CrewToolError,
  dependencies,
})
  .annotate(Tool.Title, "Check off a TODO item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CrewToolkit = Toolkit.make(
  CrewRosterTool,
  CrewDelegateTool,
  CrewWaitTool,
  CrewTodoCheckTool,
  CrewAddTodosTool,
  CrewStopTool,
);
