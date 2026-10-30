import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
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

const CrewRosterResult = Schema.Struct({
  enabled: Schema.Boolean,
  roles: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["worker", "expert", "auditor"]),
      model: Schema.NullOr(Schema.String),
      provider: Schema.NullOr(Schema.String),
    }),
  ),
});

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
    Schema.Literals(["shared", "worktree"]).annotate({
      description:
        'shared (default) works in this same workspace. Use "worktree" for parallel tasks that edit code, so they cannot clobber each other: the member starts from the current tracked state (committed and uncommitted tracked changes, not untracked or ignored files such as node_modules) in its own git worktree, and its changes are applied back to this workspace when it finishes. A conflict keeps the worktree and says so in the report.',
    }),
  ),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "A short English summary of the task's core work, at most eight words; the OOP Agents board shows it.",
    }),
  ),
});

const CrewDelegateResult = Schema.Struct({
  taskId: Schema.String,
  model: Schema.String,
  warning: Schema.optional(Schema.String),
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
    }),
  ),
});

const CrewRosterTool = Tool.make("crew_roster", {
  description: `${CREW_GUIDE} Shows whether the crew is on for this thread and which model fills each role right now; the user can change it mid-chat, so this is the current crew even if an earlier note differs.`,
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
  description: `${CREW_GUIDE} Hands one task to the worker or expert model, which works in this same workspace (or, with isolation "worktree", its own worktree) as its own thread. Returns at once with a taskId (and a warning when the task's writeScope overlaps one still running); start several in parallel when the work splits cleanly, then collect them with crew_wait. If the crew model fails, OOP hands the same task to another model of the same level on its own. Fails when the crew is off; then do the work yourself.`,
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
    "Waits up to 50 seconds for delegated crew tasks and returns each one's status and, when it finished, its report text (result) and, when the crew member ended with a JSON block, the parsed report with its changed files, verification, and findings. Call it again while any task is still running. Check the reports before telling the user the work is done.",
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

export const CrewToolkit = Toolkit.make(CrewRosterTool, CrewDelegateTool, CrewWaitTool);
