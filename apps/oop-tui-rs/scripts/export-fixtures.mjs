#!/usr/bin/env node
// Golden fixtures for the Rust terminal app. Every value here is built, then decoded and encoded
// through the real Effect schemas of packages/contracts, so a payload the server could not send or
// a command the server would refuse cannot become a fixture. The Rust tests (src/fixtures.rs) parse
// what this writes; run it again when the contracts change and look at the diff.
//
//   node apps/oop-tui-rs/scripts/export-fixtures.mjs          write fixtures/
//   node apps/oop-tui-rs/scripts/export-fixtures.mjs --check  fail when fixtures/ is out of date
//
// Needs Node 22.18+ (it imports the contracts' TypeScript source directly) and the repo's
// node_modules (the contracts' own copy of effect).

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const root = NodePath.join(here, "..");
const contractsDir = NodePath.join(root, "..", "..", "packages", "contracts");
const contracts = await import(
  NodeURL.pathToFileURL(NodePath.join(contractsDir, "src", "index.ts")).href
);
const Schema = await import(
  NodeURL.pathToFileURL(NodePath.join(contractsDir, "node_modules", "effect", "dist", "Schema.js"))
    .href
);

const out = NodePath.join(root, "fixtures");
const check = process.argv.includes("--check");

/** What would be written, by relative path; compared or written at the end. */
const files = new Map();
const put = (path, value) => files.set(path, `${JSON.stringify(value, null, 2)}\n`);

const roundTrip = (schema, value, what) => {
  try {
    return Schema.encodeUnknownSync(schema)(Schema.decodeUnknownSync(schema)(value));
  } catch (cause) {
    throw new Error(`${what} does not pass its schema: ${cause?.message ?? cause}`);
  }
};

// --- constants shared with the Rust tests (fixtures/constants.json) -----------------------------

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:05.000Z";
const T2 = "2026-01-01T00:00:10.000Z";
const THREAD = "thread-1";
const PROJECT = "project-1";
const TURN = "turn-1";
const MODEL = { instanceId: "codex", model: "gpt-5" };
const MODEL_EFFORT = {
  instanceId: "codex",
  model: "gpt-5",
  options: [{ id: "reasoningEffort", value: "high" }],
};
put("constants.json", {
  now: T0,
  threadId: THREAD,
  projectId: PROJECT,
  turnId: TURN,
  commandId: "cmd-1",
  messageId: "msg-1",
  requestId: "req-1",
  model: MODEL,
});

// --- events: one per type the contracts define --------------------------------------------------

const base = (sequence, type, aggregateKind, aggregateId) => ({
  sequence,
  eventId: `evt-${sequence}`,
  aggregateKind,
  aggregateId,
  occurredAt: T1,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type,
});

const session = (status, extra = {}) => ({
  threadId: THREAD,
  status,
  providerName: "codex",
  providerInstanceId: "codex",
  runtimeMode: "full-access",
  activeTurnId: status === "running" ? TURN : null,
  lastError: status === "error" ? "boom" : null,
  updatedAt: T1,
  ...extra,
});

const prKey = { host: "github.com", repository: "t3tools/oop", number: 7 };
const prSnapshot = {
  state: "open",
  title: "Add the Rust terminal",
  headBranch: "rust-tui",
  baseBranch: "main",
  isDraft: false,
  updatedAt: T1,
  syncedAt: T1,
};

const threadPayloads = {
  "thread.created": {
    threadId: THREAD,
    projectId: PROJECT,
    title: "hello",
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: T0,
    updatedAt: T0,
  },
  "thread.deleted": { threadId: THREAD, deletedAt: T1 },
  "thread.archived": { threadId: THREAD, archivedAt: T1, updatedAt: T1 },
  "thread.unarchived": { threadId: THREAD, updatedAt: T1 },
  "thread.settled": { threadId: THREAD, settledAt: T1, updatedAt: T1 },
  "thread.unsettled": { threadId: THREAD, reason: "user", updatedAt: T1 },
  "thread.snoozed": { threadId: THREAD, snoozedUntil: T2, snoozedAt: T1, updatedAt: T1 },
  "thread.unsnoozed": { threadId: THREAD, reason: "user", updatedAt: T1 },
  "thread.pinned": { threadId: THREAD, pinnedAt: T1, pinOrderKey: "a0", updatedAt: T1 },
  "thread.unpinned": { threadId: THREAD, updatedAt: T1 },
  "thread.pin-reordered": { threadId: THREAD, orderKey: "a1", updatedAt: T1 },
  "thread.auto-settle-set": { threadId: THREAD, autoSettleDisabledAt: T1, updatedAt: T1 },
  "thread.meta-updated": {
    threadId: THREAD,
    title: "renamed",
    modelSelection: MODEL_EFFORT,
    branch: "main",
    updatedAt: T1,
  },
  "thread.pull-request-linked": {
    threadId: THREAD,
    link: {
      ...prKey,
      url: "https://github.com/t3tools/oop/pull/7",
      source: "manual",
      linkedAt: T1,
      snapshot: null,
      stack: null,
    },
    updatedAt: T1,
  },
  "thread.pull-request-unlinked": { threadId: THREAD, ...prKey, updatedAt: T1 },
  "thread.pull-request-synced": {
    threadId: THREAD,
    ...prKey,
    snapshot: prSnapshot,
    stack: null,
    updatedAt: T1,
  },
  "thread.runtime-mode-set": { threadId: THREAD, runtimeMode: "approval-required", updatedAt: T1 },
  "thread.crew-set": { threadId: THREAD, crew: { enabled: true }, updatedAt: T1 },
  "thread.interaction-mode-set": { threadId: THREAD, interactionMode: "plan", updatedAt: T1 },
  "thread.message-sent": {
    threadId: THREAD,
    messageId: "msg-2",
    role: "assistant",
    text: "hi",
    turnId: TURN,
    streaming: true,
    createdAt: T1,
    updatedAt: T1,
  },
  "thread.turn-start-requested": {
    threadId: THREAD,
    messageId: "msg-1",
    modelSelection: MODEL,
    titleSeed: "hello",
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: T0,
  },
  "thread.turn-interrupt-requested": { threadId: THREAD, turnId: TURN, createdAt: T1 },
  "thread.approval-response-requested": {
    threadId: THREAD,
    requestId: "req-1",
    decision: "accept",
    createdAt: T1,
  },
  "thread.user-input-response-requested": {
    threadId: THREAD,
    requestId: "req-2",
    answers: { color: "blue" },
    createdAt: T1,
  },
  "thread.checkpoint-revert-requested": { threadId: THREAD, turnCount: 1, createdAt: T1 },
  "thread.reverted": { threadId: THREAD, turnCount: 1 },
  "thread.session-stop-requested": { threadId: THREAD, createdAt: T1 },
  "thread.session-set": { threadId: THREAD, session: session("running") },
  "thread.proposed-plan-upserted": {
    threadId: THREAD,
    proposedPlan: {
      id: "plan-1",
      turnId: TURN,
      planMarkdown: "# Plan\n- one",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: T1,
      updatedAt: T1,
    },
  },
  "thread.turn-diff-completed": {
    threadId: THREAD,
    turnId: TURN,
    checkpointTurnCount: 1,
    checkpointRef: "refs/oop/checkpoints/1",
    status: "ready",
    files: [{ path: "src/a.rs", kind: "modified", additions: 3, deletions: 1 }],
    assistantMessageId: "msg-2",
    completedAt: T2,
  },
  "thread.activity-appended": {
    threadId: THREAD,
    activity: {
      id: "act-1",
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran ls",
      payload: { title: "Ran command", detail: "ls -la", status: "completed" },
      turnId: TURN,
      createdAt: T1,
    },
  },
};

const projectPayloads = {
  "project.created": {
    projectId: PROJECT,
    title: "demo",
    workspaceRoot: "/work/demo",
    defaultModelSelection: null,
    scripts: [],
    createdAt: T0,
    updatedAt: T0,
  },
  "project.meta-updated": { projectId: PROJECT, title: "demo2", updatedAt: T1 },
  "project.deleted": { projectId: PROJECT, deletedAt: T1 },
};

const types = [...contracts.OrchestrationEventType.literals];
put("events/_types.json", types);
let sequence = 10;
for (const type of types) {
  const project = type.startsWith("project.");
  const payload = (project ? projectPayloads : threadPayloads)[type];
  if (payload === undefined) {
    throw new Error(
      `no fixture payload for the event type ${type}: add one to export-fixtures.mjs`,
    );
  }
  const event = base(
    (sequence += 1),
    type,
    project ? "project" : "thread",
    project ? PROJECT : THREAD,
  );
  put(`events/${type}.json`, roundTrip(contracts.OrchestrationEvent, { ...event, payload }, type));
}

// A second flavour of the events the reducer folds with care.
const extraEvents = {
  "thread.message-sent.final": [
    "thread.message-sent",
    {
      threadId: THREAD,
      messageId: "msg-2",
      role: "assistant",
      text: "hi there",
      turnId: TURN,
      streaming: false,
      createdAt: T1,
      updatedAt: T2,
    },
  ],
  "thread.session-set.idle": [
    "thread.session-set",
    { threadId: THREAD, session: session("ready") },
  ],
  "thread.session-set.error": [
    "thread.session-set",
    { threadId: THREAD, session: session("error") },
  ],
  "thread.activity-appended.approval": [
    "thread.activity-appended",
    {
      threadId: THREAD,
      activity: {
        id: "act-approval",
        tone: "approval",
        kind: "approval.requested",
        summary: "Command approval requested",
        payload: { requestId: "req-1", requestKind: "command", detail: "rm -rf build" },
        turnId: TURN,
        createdAt: T1,
      },
    },
  ],
  "thread.activity-appended.approval-resolved": [
    "thread.activity-appended",
    {
      threadId: THREAD,
      activity: {
        id: "act-approval-done",
        tone: "approval",
        kind: "approval.resolved",
        summary: "Approval resolved",
        payload: { requestId: "req-1", decision: "accept" },
        turnId: TURN,
        createdAt: T2,
      },
    },
  ],
  "thread.activity-appended.user-input": [
    "thread.activity-appended",
    {
      threadId: THREAD,
      activity: {
        id: "act-input",
        tone: "info",
        kind: "user-input.requested",
        summary: "User input requested",
        payload: {
          requestId: "req-2",
          questions: [
            {
              id: "color",
              header: "Color",
              question: "Which color?",
              options: [
                { label: "red", description: "warm" },
                { label: "blue", description: "cold" },
              ],
            },
          ],
        },
        turnId: TURN,
        createdAt: T1,
      },
    },
  ],
  "thread.activity-appended.user-input-resolved": [
    "thread.activity-appended",
    {
      threadId: THREAD,
      activity: {
        id: "act-input-done",
        tone: "info",
        kind: "user-input.resolved",
        summary: "User input submitted",
        payload: { requestId: "req-2", answers: { color: "blue" } },
        turnId: TURN,
        createdAt: T2,
      },
    },
  ],
  "thread.activity-appended.tool-started": [
    "thread.activity-appended",
    {
      threadId: THREAD,
      activity: {
        id: "act-start",
        tone: "tool",
        kind: "tool.started",
        summary: "Ran command",
        payload: { title: "Ran command", detail: "/bin/zsh -lc 'cargo test'", itemId: "item-1" },
        turnId: TURN,
        createdAt: T0,
      },
    },
  ],
  "thread.activity-appended.tool-failed": [
    "thread.activity-appended",
    {
      threadId: THREAD,
      activity: {
        id: "act-fail",
        tone: "tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          title: "Ran command",
          detail: "false",
          status: "failed",
          itemId: "item-2",
          data: { item: { error: "exit 1" } },
        },
        turnId: TURN,
        createdAt: T2,
      },
    },
  ],
  "thread.activity-appended.error": [
    "thread.activity-appended",
    {
      threadId: THREAD,
      activity: {
        id: "act-error",
        tone: "error",
        kind: "runtime.error",
        summary: "Provider failed",
        payload: {},
        turnId: TURN,
        createdAt: T2,
      },
    },
  ],
};
for (const [name, [type, payload]] of Object.entries(extraEvents)) {
  sequence += 1;
  put(
    `events/variants/${name}.json`,
    roundTrip(
      contracts.OrchestrationEvent,
      { ...base(sequence, type, "thread", THREAD), payload },
      name,
    ),
  );
}

// --- snapshots and stream items -----------------------------------------------------------------

const threadShell = (over = {}) => ({
  id: THREAD,
  projectId: PROJECT,
  title: "hello",
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: T0,
  updatedAt: T1,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: session("ready"),
  latestUserMessageAt: T0,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...over,
});
const projectShell = (over = {}) => ({
  id: PROJECT,
  title: "demo",
  workspaceRoot: "/work/demo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const shellItems = {
  snapshot: {
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 9,
      projects: [
        projectShell(),
        projectShell({ id: "project-2", title: "other", workspaceRoot: "/work/other" }),
      ],
      threads: [
        threadShell(),
        threadShell({ id: "thread-2", title: "pinned one", pinnedAt: T1, pinOrderKey: "a0" }),
        threadShell({
          id: "thread-3",
          title: "settled one",
          settledOverride: "settled",
          settledAt: T1,
        }),
        threadShell({
          id: "thread-4",
          title: "snoozed one",
          snoozedUntil: "2099-01-01T00:00:00.000Z",
          snoozedAt: T1,
        }),
        threadShell({
          id: "thread-5",
          title: "waiting",
          hasPendingApprovals: true,
          session: session("running"),
        }),
        threadShell({ id: "thread-6", title: "archived", archivedAt: T1 }),
      ],
      updatedAt: T1,
    },
  },
  synchronized: { kind: "synchronized" },
  "project-upserted": {
    kind: "project-upserted",
    sequence: 12,
    project: projectShell({ title: "demo renamed" }),
  },
  "project-removed": { kind: "project-removed", sequence: 13, projectId: PROJECT },
  "thread-upserted": {
    kind: "thread-upserted",
    sequence: 14,
    thread: threadShell({ title: "again" }),
  },
  "thread-removed": { kind: "thread-removed", sequence: 15, threadId: THREAD },
};
for (const [name, item] of Object.entries(shellItems)) {
  put(
    `shell/${name}.json`,
    roundTrip(contracts.OrchestrationShellStreamItem, item, `shell ${name}`),
  );
}

const message = (id, role, text, createdAt, over = {}) => ({
  id,
  role,
  text,
  turnId: role === "user" ? null : TURN,
  streaming: false,
  createdAt,
  updatedAt: createdAt,
  ...over,
});
const thread = (over = {}) => ({
  ...threadShell(),
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  ...over,
});
delete thread().latestUserMessageAt;
const detail = (over) => {
  const t = thread(over);
  for (const key of [
    "latestUserMessageAt",
    "hasPendingApprovals",
    "hasPendingUserInput",
    "hasActionableProposedPlan",
  ]) {
    delete t[key];
  }
  return t;
};

const threadItems = {
  snapshot: {
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 20,
      thread: detail({
        messages: [
          message("msg-1", "user", "안녕? run the tests", T0),
          message("msg-r", "reasoning", "thinking about it", T0, { turnId: TURN }),
          message(
            "msg-2",
            "assistant",
            "# Done\n\nAll **green**.\n\n```rust\nfn main() {}\n```\n",
            T1,
          ),
        ],
        activities: [
          {
            id: "act-1",
            tone: "tool",
            kind: "tool.completed",
            summary: "Ran command",
            payload: {
              title: "Ran command",
              detail: "cargo test",
              status: "completed",
              data: { item: { aggregatedOutput: "ok. 12 passed", durationMs: 2300 } },
            },
            turnId: TURN,
            createdAt: T0,
          },
        ],
        latestTurn: {
          turnId: TURN,
          state: "completed",
          requestedAt: T0,
          startedAt: T0,
          completedAt: T2,
          assistantMessageId: "msg-2",
        },
      }),
    },
  },
  "snapshot-windowed": {
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 20,
      thread: detail({
        messages: [
          message("msg-9", "user", "newest question", T2),
          message("msg-10", "assistant", "newest answer", T2),
        ],
      }),
      page: { beforeCursor: "cursor-1", hasMore: true, snapshotSequence: 20, threadSequence: 18 },
    },
  },
  "snapshot-older-page": {
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 20,
      thread: detail({
        messages: [
          message("msg-5", "user", "older question", T0),
          message("msg-6", "assistant", "older answer", T0),
        ],
      }),
      page: { beforeCursor: null, hasMore: false, snapshotSequence: 20, threadSequence: 18 },
    },
  },
  synchronized: { kind: "synchronized" },
};
for (const [name, item] of Object.entries(threadItems)) {
  put(
    `thread/${name}.json`,
    roundTrip(contracts.OrchestrationThreadStreamItem, item, `thread ${name}`),
  );
}

// --- commands: every one oop-rs sends -----------------------------------------------------------
// Each file holds the arguments the Rust builder is called with and the command the contracts
// accept for them. The Rust test builds the command from `args` and compares it to `command`.

const command = (name, args, built) =>
  put(`commands/${name}.json`, {
    args,
    command: roundTrip(contracts.ClientOrchestrationCommand, built, name),
  });

const msg = (text) => ({ messageId: "msg-1", role: "user", text, attachments: [] });
command(
  "project.create",
  { title: "demo", workspaceRoot: "/work/demo" },
  {
    type: "project.create",
    commandId: "cmd-1",
    projectId: PROJECT,
    title: "demo",
    workspaceRoot: "/work/demo",
    createdAt: T0,
  },
);
command(
  "turn.start.new-thread",
  { text: "build it", model: MODEL_EFFORT, runtimeMode: "full-access", interactionMode: "default" },
  {
    type: "thread.turn.start",
    commandId: "cmd-1",
    threadId: THREAD,
    message: msg("build it"),
    modelSelection: MODEL_EFFORT,
    titleSeed: "build it",
    runtimeMode: "full-access",
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId: PROJECT,
        title: "build it",
        modelSelection: MODEL_EFFORT,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: T0,
      },
    },
    createdAt: T0,
  },
);
command(
  "turn.start.existing",
  { text: "and then?", model: null, runtimeMode: "approval-required", interactionMode: "plan" },
  {
    type: "thread.turn.start",
    commandId: "cmd-1",
    threadId: THREAD,
    message: msg("and then?"),
    runtimeMode: "approval-required",
    interactionMode: "plan",
    createdAt: T0,
  },
);
command(
  "turn.start.existing-with-model",
  { text: "switch", model: MODEL_EFFORT, runtimeMode: "full-access", interactionMode: "default" },
  {
    type: "thread.turn.start",
    commandId: "cmd-1",
    threadId: THREAD,
    message: msg("switch"),
    modelSelection: MODEL_EFFORT,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: T0,
  },
);
command(
  "turn.start.implement-plan",
  {
    text: "PLEASE IMPLEMENT THIS PLAN:\n# Plan\n- one",
    planId: "plan-1",
    runtimeMode: "full-access",
    interactionMode: "default",
  },
  {
    type: "thread.turn.start",
    commandId: "cmd-1",
    threadId: THREAD,
    message: msg("PLEASE IMPLEMENT THIS PLAN:\n# Plan\n- one"),
    runtimeMode: "full-access",
    interactionMode: "default",
    sourceProposedPlan: { threadId: THREAD, planId: "plan-1" },
    createdAt: T0,
  },
);
command(
  "checkpoint.revert",
  { turnCount: 1 },
  {
    type: "thread.checkpoint.revert",
    commandId: "cmd-1",
    threadId: THREAD,
    turnCount: 1,
    createdAt: T0,
  },
);
command(
  "conversation.revert",
  { turnCount: 1 },
  {
    type: "thread.conversation.revert",
    commandId: "cmd-1",
    threadId: THREAD,
    turnCount: 1,
    createdAt: T0,
  },
);
command(
  "turn.interrupt",
  { turnId: TURN },
  {
    type: "thread.turn.interrupt",
    commandId: "cmd-1",
    threadId: THREAD,
    turnId: TURN,
    createdAt: T0,
  },
);
command(
  "turn.interrupt.no-turn",
  { turnId: null },
  { type: "thread.turn.interrupt", commandId: "cmd-1", threadId: THREAD, createdAt: T0 },
);
command(
  "approval.respond",
  { requestId: "req-1", decision: "acceptForSession" },
  {
    type: "thread.approval.respond",
    commandId: "cmd-1",
    threadId: THREAD,
    requestId: "req-1",
    decision: "acceptForSession",
    createdAt: T0,
  },
);
command(
  "user-input.respond",
  { requestId: "req-2", answers: { color: "blue" } },
  {
    type: "thread.user-input.respond",
    commandId: "cmd-1",
    threadId: THREAD,
    requestId: "req-2",
    answers: { color: "blue" },
    createdAt: T0,
  },
);
command(
  "runtime-mode.set",
  { runtimeMode: "auto-accept-edits" },
  {
    type: "thread.runtime-mode.set",
    commandId: "cmd-1",
    threadId: THREAD,
    runtimeMode: "auto-accept-edits",
    createdAt: T0,
  },
);
command(
  "interaction-mode.set",
  { interactionMode: "plan" },
  {
    type: "thread.interaction-mode.set",
    commandId: "cmd-1",
    threadId: THREAD,
    interactionMode: "plan",
    createdAt: T0,
  },
);

// --- config: the files in OOP_CONFIG_DIR and the part of server.getConfig that oop-rs reads -----

put("config/last-model.json", roundTrip(contracts.ModelSelection, MODEL_EFFORT, "last-model.json"));
put("config/settings.json", {
  theme: "lavender",
  symbols: "unicode",
  animations: true,
  banner: true,
  statusLine: "auto",
  notify: true,
  language: "ko",
  sidebar: true,
  workflow: true,
  pet: true,
});
put("config/settings-invalid.json", {
  theme: "../evil",
  symbols: "emoji",
  animations: "yes",
  language: "fr",
  extra: 1,
});
const provider = roundTrip(
  contracts.ServerProvider,
  {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: T0,
    models: [
      { slug: "gpt-5", name: "GPT-5", isCustom: false, isDefault: true, capabilities: null },
      { slug: "gpt-5-mini", name: "GPT-5 mini", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  },
  "provider",
);
put("config/server-config.json", {
  providers: [provider],
  threadSnapshotPagination: true,
  reasoningMessages: true,
  threadResumeCompletionMarker: true,
  environment: { serverVersion: "0.0.43" },
});

// --- vectors: named inputs and what packages/client-runtime answers --------------------------------
//
// The Rust port (src/flow.rs) must give the same answer as the TypeScript it was ported from. Each
// case below is an input; the expected value is whatever the real client-runtime code returns for
// it, never worked out here. toolState and taskState are private to threadFlow.ts, so they are read
// back through the public turnGraphs: a step's node state is the state those functions gave it.

const clientSrc = NodePath.join(root, "..", "..", "packages", "client-runtime", "src");
const loadClient = (rel) => import(NodeURL.pathToFileURL(NodePath.join(clientSrc, rel)).href);
const threadFlow = await loadClient("threadFlow.ts");
const subagentRuntime = await loadClient("state/subagentRuntime.ts");

const sec = (s) => new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString();
let activitySeq = 0;
const A = (kind, turnId, s, payload) => ({
  id: `act-${++activitySeq}`,
  tone: kind.startsWith("task.") ? "info" : "tool",
  kind,
  summary: kind,
  payload,
  turnId,
  createdAt: sec(s),
});
const withStatus = (c) => ("status" in c ? { status: c.status } : {});

/** A thread as the Rust side reads it: `live` is a running turn, `last` the newest finished one. */
const threadOf = (activities, { live = null, last = null } = {}) => ({
  id: THREAD,
  projectId: PROJECT,
  title: "Vector",
  activities,
  latestTurn: live
    ? {
        turnId: live.turnId,
        state: "running",
        requestedAt: sec(live.requestedAt ?? live.startedAt),
        startedAt: live.startedAt === null ? null : sec(live.startedAt),
        completedAt: null,
      }
    : last
      ? {
          turnId: last.turnId,
          state: "completed",
          requestedAt: sec(last.startedAt),
          startedAt: sec(last.startedAt),
          completedAt: sec(last.completedAt),
        }
      : null,
  session: live
    ? { status: "running", activeTurnId: live.turnId, updatedAt: sec(0) }
    : last
      ? { status: last.sessionStatus ?? "ready", activeTurnId: null, updatedAt: sec(0) }
      : null,
});
const activeOf = (live) => ({
  activeTurnId: live ? live.turnId : null,
  activeTurnStartedAt: live ? sec(live.startedAt ?? live.requestedAt) : null,
});
// How the web client says whether the session is live (ChatView.tsx: phase !== "disconnected").
const sessionLiveOf = (thread) =>
  thread.session !== null && !["stopped", "interrupted", "error"].includes(thread.session.status);

// tool-state.json: one tool.* activity with the status, read back as the node's state.
const toolStatuses = [
  { name: "completed", status: "completed" },
  { name: "failed", status: "failed" },
  { name: "error", status: "error" },
  { name: "declined", status: "declined" },
  { name: "cancelled", status: "cancelled" },
  { name: "stopped", status: "stopped" },
  { name: "inProgress", status: "inProgress" },
  { name: "running", status: "running" },
  { name: "pending", status: "pending" },
  { name: "in_progress", status: "in_progress" },
  { name: "capitalised COMPLETED is not completed", status: "COMPLETED" },
  { name: "padded completed is not completed", status: " completed" },
  { name: "empty string", status: "" },
  { name: "null status", status: null },
  { name: "number status", status: 1 },
  { name: "object status", status: { value: "completed" } },
  { name: "missing status" },
];
put("vectors/tool-state.json", {
  cases: toolStatuses.map((c) => ({
    ...c,
    expected: threadFlow.turnGraphs([
      A("tool.updated", "turn-1", 1, { toolCallId: "call-1", ...withStatus(c) }),
    ])[0].nodes[0].state,
  })),
});

// task-state.json: a step already in a known state, then one task.* activity for it. A kind that
// says nothing leaves the step as it was, so the answer is null when the result follows the
// step's earlier state (tried from two different ones) and the state when it does not.
const taskKinds = [
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
  "task.stopped",
  "task.other",
];
const taskStatuses = [
  { name: "completed", status: "completed" },
  { name: "failed", status: "failed" },
  { name: "partial", status: "partial" },
  { name: "blocked", status: "blocked" },
  { name: "stopped", status: "stopped" },
  { name: "cancelled", status: "cancelled" },
  { name: "error", status: "error" },
  { name: "running", status: "running" },
  { name: "empty string", status: "" },
  { name: "null", status: null },
  { name: "number", status: 0 },
  { name: "missing" },
];
const taskStateAfter = (kind, c, before) =>
  threadFlow.turnGraphs([
    A("tool.completed", "turn-1", 1, { toolCallId: "call-1", status: before }),
    A(kind, "turn-1", 2, { taskId: "task-1", toolUseId: "call-1", ...withStatus(c) }),
  ])[0].nodes[0].state;
put("vectors/task-state.json", {
  cases: taskKinds.flatMap((kind) =>
    taskStatuses.map((c) => {
      const fromCompleted = taskStateAfter(kind, c, "completed");
      const fromFailed = taskStateAfter(kind, c, "failed");
      return {
        name: `${kind} ${c.name}`,
        kind,
        ...withStatus(c),
        expected: fromCompleted === fromFailed ? fromCompleted : null,
      };
    }),
  ),
});

// crew-board.json: the lead's crew board, from crewGraphs settled against the running turn. A
// task's phase is how the board words its node: running while the node runs, otherwise the report
// it ended on, and stopped for any other end.
const crewTask = (kind, turn, s, id, role, payload = {}) =>
  A(kind, turn, s, { taskId: id, crewRole: role, ...payload });
const usage = (input, output, costUsd) => ({
  usage: {
    inputTokens: input,
    outputTokens: output,
    ...(costUsd === undefined ? {} : { costUsd }),
  },
});
const REPORTS = new Set(["completed", "partial", "blocked", "failed"]);
const phaseOfNode = (node) =>
  node.state === "running"
    ? "running"
    : REPORTS.has(node.info.crew.outcome)
      ? node.info.crew.outcome
      : "stopped";
const crewBoardOf = (thread, live) => {
  const { activeTurnId } = activeOf(live);
  const graphs = threadFlow
    .crewGraphs(thread.activities)
    .map((graph) => threadFlow.settleWithTurn(graph, activeTurnId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const graph = graphs[0];
  if (graph === undefined) return null;
  const brain = graph.nodes.find((node) => node.id.startsWith("brain:"));
  const nodes = graph.nodes
    .filter((node) => node !== brain)
    .sort((a, b) => a.info.startedAt.localeCompare(b.info.startedAt));
  const tasks = nodes.map((node) => ({
    taskId: node.info.crew.taskId,
    role: node.info.crew.role,
    phase: phaseOfNode(node),
    evidence: node.info.evidence,
    proof: node.info.proof,
    tokens: node.info.tokens,
    costUsd: node.info.costUsd,
    todos: node.info.todos,
  }));
  const running = tasks.filter((task) => task.phase === "running").length;
  return {
    tasks,
    running,
    settled: tasks.length - running,
    usage:
      brain.info.tokens === undefined
        ? undefined
        : { tokens: brain.info.tokens, costUsd: brain.info.costUsd },
  };
};

const LEAD = "turn-1";
const liveT1 = { turnId: LEAD, startedAt: 0 };
const lastT1 = { turnId: LEAD, startedAt: 0, completedAt: 100 };
const crewCases = [
  ["no activities", [], null],
  [
    "task activities without a crew role are not crew",
    [A("task.started", LEAD, 1, { taskId: "x" })],
    liveT1,
  ],
  [
    "worker running while the turn runs",
    [crewTask("task.started", LEAD, 1, "w1", "worker", { title: "Fix parser", model: "gpt-5" })],
    liveT1,
  ],
  [
    "worker running when the turn ended reads stopped",
    [crewTask("task.started", LEAD, 1, "w1", "worker", { title: "Fix parser" })],
    lastT1,
  ],
  [
    "stop asked for: progress status stopped before the report",
    [
      crewTask("task.started", LEAD, 1, "w1", "worker"),
      crewTask("task.progress", LEAD, 2, "w1", "worker", { status: "stopped" }),
    ],
    liveT1,
  ],
  [
    "completed and reported, verified proof, priced usage, todo counts",
    [
      crewTask("task.started", LEAD, 1, "w1", "worker", { threadId: "crew-1" }),
      crewTask("task.completed", LEAD, 9, "w1", "worker", {
        status: "completed",
        proof: "verified",
        todoTotal: 3,
        todoVerified: 2,
        todoClaimed: 1,
        ...usage(100, 50, 0.25),
      }),
    ],
    liveT1,
  ],
  [
    "completed with passing tests is tested",
    [
      crewTask("task.started", LEAD, 1, "w1", "worker"),
      crewTask("task.completed", LEAD, 9, "w1", "worker", { status: "completed", tested: true }),
    ],
    lastT1,
  ],
  [
    "approving audit after the worker makes it audited; the auditor has none",
    [
      crewTask("task.started", LEAD, 1, "w1", "worker"),
      crewTask("task.completed", LEAD, 9, "w1", "worker", { status: "completed", tested: true }),
      crewTask("task.started", LEAD, 10, "a1", "auditor"),
      crewTask("task.completed", LEAD, 20, "a1", "auditor", {
        status: "completed",
        verdict: "approve",
      }),
    ],
    lastT1,
  ],
  [
    "rejecting audit leaves the worker tested",
    [
      crewTask("task.started", LEAD, 1, "w1", "worker"),
      crewTask("task.completed", LEAD, 9, "w1", "worker", { status: "completed", tested: true }),
      crewTask("task.started", LEAD, 10, "a1", "auditor"),
      crewTask("task.completed", LEAD, 20, "a1", "auditor", {
        status: "completed",
        verdict: "reject",
      }),
    ],
    lastT1,
  ],
  [
    "an audit that finished before the worker does not count",
    [
      crewTask("task.started", LEAD, 1, "a1", "auditor"),
      crewTask("task.completed", LEAD, 5, "a1", "auditor", {
        status: "completed",
        verdict: "approve",
      }),
      crewTask("task.started", LEAD, 6, "w1", "worker"),
      crewTask("task.completed", LEAD, 9, "w1", "worker", { status: "completed" }),
    ],
    lastT1,
  ],
  [
    "the latest audit after the worker decides",
    [
      crewTask("task.started", LEAD, 1, "w1", "worker"),
      crewTask("task.completed", LEAD, 5, "w1", "worker", { status: "completed" }),
      crewTask("task.started", LEAD, 6, "a1", "auditor"),
      crewTask("task.completed", LEAD, 20, "a1", "auditor", {
        status: "completed",
        verdict: "approve",
      }),
      crewTask("task.started", LEAD, 21, "a2", "auditor"),
      crewTask("task.completed", LEAD, 30, "a2", "auditor", {
        status: "completed",
        verdict: "reject",
      }),
    ],
    lastT1,
  ],
  [
    "every report status",
    [
      "completed",
      "partial",
      "blocked",
      "failed",
      "stopped",
      "error",
      "declined",
      "cancelled",
      "weird",
    ].flatMap((status, i) => [
      crewTask("task.started", LEAD, 1 + i * 2, `w-${status}`, "worker"),
      crewTask("task.completed", LEAD, 2 + i * 2, `w-${status}`, "worker", { status }),
    ]),
    lastT1,
  ],
  [
    "every proof verdict",
    ["verified", "not-verified", "inconclusive", "maybe", undefined].flatMap((proof, i) => [
      crewTask("task.started", LEAD, 1 + i * 2, `w${i}`, "worker"),
      crewTask("task.completed", LEAD, 2 + i * 2, `w${i}`, "worker", {
        status: "completed",
        ...(proof === undefined ? {} : { proof }),
      }),
    ]),
    lastT1,
  ],
  [
    "todo counts: clamped, floored, ignored when not positive numbers",
    [
      ["full", { todoTotal: 4, todoVerified: 2, todoClaimed: 1, todoFailed: 1, todoBlocked: 0 }],
      ["floored", { todoTotal: 5.9, todoVerified: 2.7 }],
      ["zero total", { todoTotal: 0, todoVerified: 1 }],
      ["negative", { todoTotal: -3 }],
      ["string total", { todoTotal: "4" }],
      ["bad part", { todoTotal: 3, todoVerified: -1, todoClaimed: "x", todoFailed: Infinity }],
      ["more proven than total", { todoTotal: 2, todoVerified: 5, todoClaimed: 5 }],
    ].flatMap(([name, todos], i) => [
      crewTask("task.started", LEAD, 1 + i * 2, `todo-${name}`, "worker"),
      crewTask("task.completed", LEAD, 2 + i * 2, `todo-${name}`, "worker", {
        status: "completed",
        ...todos,
      }),
    ]),
    lastT1,
  ],
  [
    "todo counts follow progress; the final report's counts stay",
    [
      crewTask("task.started", LEAD, 1, "w1", "worker"),
      crewTask("task.progress", LEAD, 2, "w1", "worker", { todoTotal: 4, todoVerified: 1 }),
      crewTask("task.progress", LEAD, 3, "w1", "worker", { todoTotal: 4, todoVerified: 3 }),
      crewTask("task.completed", LEAD, 4, "w1", "worker", { status: "completed" }),
      crewTask("task.progress", LEAD, 5, "w1", "worker", { todoTotal: 4, todoVerified: 0 }),
      crewTask("task.started", LEAD, 6, "w2", "worker"),
      crewTask("task.progress", LEAD, 7, "w2", "worker", { todoTotal: 2, todoClaimed: 2 }),
      crewTask("task.progress", LEAD, 8, "w2", "worker", { summary: "no counts this time" }),
    ],
    liveT1,
  ],
  [
    "usage: priced and unpriced tasks add up, bad usage is none",
    [
      crewTask("task.started", LEAD, 1, "w1", "worker"),
      crewTask("task.completed", LEAD, 2, "w1", "worker", {
        status: "completed",
        ...usage(1000, 500, 0.5),
      }),
      crewTask("task.started", LEAD, 3, "w2", "expert"),
      crewTask("task.completed", LEAD, 4, "w2", "expert", {
        status: "completed",
        ...usage(200, 100),
      }),
      crewTask("task.started", LEAD, 5, "w3", "worker"),
      crewTask("task.completed", LEAD, 6, "w3", "worker", {
        status: "completed",
        usage: { inputTokens: "1", outputTokens: 2 },
      }),
      crewTask("task.started", LEAD, 7, "w4", "worker"),
      crewTask("task.completed", LEAD, 8, "w4", "worker", {
        status: "completed",
        ...usage(10, 5, 0.25),
      }),
    ],
    lastT1,
  ],
  [
    "usage with no reported cost at all",
    [
      crewTask("task.started", LEAD, 1, "w1", "worker"),
      crewTask("task.completed", LEAD, 2, "w1", "worker", {
        status: "completed",
        ...usage(300, 100),
      }),
    ],
    lastT1,
  ],
  [
    "no usage on any task",
    [
      crewTask("task.started", LEAD, 1, "w1", "worker"),
      crewTask("task.completed", LEAD, 2, "w1", "worker", { status: "completed" }),
    ],
    lastT1,
  ],
  [
    "unknown and expert roles",
    [
      crewTask("task.started", LEAD, 1, "e1", "expert"),
      crewTask("task.completed", LEAD, 2, "e1", "expert", { status: "completed", tested: true }),
      crewTask("task.started", LEAD, 3, "r1", "reviewer"),
      crewTask("task.completed", LEAD, 4, "r1", "reviewer", { status: "partial" }),
    ],
    lastT1,
  ],
  [
    "parallel tasks, one still running",
    [
      crewTask("task.started", LEAD, 1, "w1", "worker"),
      crewTask("task.started", LEAD, 2, "w2", "worker"),
      crewTask("task.completed", LEAD, 6, "w1", "worker", { status: "completed" }),
    ],
    liveT1,
  ],
  [
    "the last task.completed wins",
    [
      crewTask("task.started", LEAD, 1, "w1", "worker"),
      crewTask("task.completed", LEAD, 2, "w1", "worker", { status: "failed" }),
      crewTask("task.completed", LEAD, 3, "w1", "worker", {
        status: "completed",
        proof: "verified",
      }),
    ],
    lastT1,
  ],
  [
    "the newest crew turn is the board",
    [
      crewTask("task.started", "turn-1", 1, "old", "worker"),
      crewTask("task.completed", "turn-1", 2, "old", "worker", { status: "completed" }),
      crewTask("task.started", "turn-2", 11, "new", "worker"),
      crewTask("task.completed", "turn-2", 12, "new", "worker", { status: "failed" }),
    ],
    { turnId: "turn-2", startedAt: 10, completedAt: 20 },
  ],
  [
    "a running lead turn with no crew leaves an earlier turn's unreported task stopped",
    [
      crewTask("task.started", "turn-1", 1, "old", "worker"),
      A("tool.completed", "turn-2", 11, { toolCallId: "c1", status: "completed" }),
    ],
    { turnId: "turn-2", startedAt: 10 },
  ],
  [
    "a task with no turn is untracked",
    [
      crewTask("task.started", null, 1, "w1", "worker"),
      crewTask("task.completed", null, 2, "w1", "worker", { status: "completed" }),
    ],
    null,
  ],
];
put("vectors/crew-board.json", {
  cases: crewCases.map(([name, activities, turn]) => {
    const live = turn !== null && "completedAt" in turn ? null : turn;
    const last = turn !== null && "completedAt" in turn ? turn : null;
    const thread = threadOf(activities, { live, last });
    return { name, thread, expected: crewBoardOf(thread, live) };
  }),
});

// thread-flow.json: every flow of a thread, newest first, drawn as the agents doing the work
// (actorFlows): the main agent, its crew, what it launched, and the provider workflows.
const nodeView = (node) => {
  const actor = node.info.actor;
  return {
    id: node.id,
    state: node.state,
    wave: node.wave,
    role: actor?.role,
    task: actor?.task,
    model: node.info.model,
    progress: node.info.progress,
    startedAt: node.info.startedAt,
    completedAt: node.info.completedAt,
    tokens: node.info.tokens,
    costUsd: node.info.costUsd,
    evidence: node.info.evidence,
    outcome: node.info.crew?.outcome,
    error: node.info.error,
    ...(actor?.role === "main"
      ? { tools: actor.tools, doing: actor.doing, delegated: actor.delegated }
      : {}),
  };
};
const graphView = (graph) => ({
  id: graph.id,
  kind: graph.kind,
  name: graph.name,
  status: graph.status,
  turnIndex: graph.turnIndex,
  startedAt: graph.startedAt,
  updatedAt: graph.updatedAt,
  waveTitles: graph.waveTitles,
  nodes: graph.nodes.map(nodeView),
  edges: graph.edges.map((edge) => [edge.from, edge.to]),
});
const flowsOf = (thread, live, leadModel) =>
  threadFlow
    .actorFlows({
      activities: thread.activities,
      agents: subagentRuntime.deriveAgentPanelModel({
        agents: subagentRuntime.foldSubagentActivities(thread.activities, {
          sessionLive: sessionLiveOf(thread),
        }),
      }),
      ...activeOf(live),
      leadModel,
    })
    .map(graphView);

const bash = (turn, s, id, payload = {}) =>
  A("tool.completed", turn, s, {
    toolCallId: id,
    status: "completed",
    data: { toolName: "Bash" },
    ...payload,
  });
const launch = (turn, s, id, taskId, payload) => [
  A("tool.started", turn, s, { toolCallId: id, status: "inProgress", data: { toolName: "Task" } }),
  A("task.started", turn, s + 0.5, { taskId, toolUseId: id, agentKind: "agent", ...payload }),
];
const member = (id, parent, phaseIndex, agentIndex, status, s, extra = {}) => [
  A("task.started", null, s, {
    taskId: id,
    agentKind: "agent",
    parentAgentId: parent,
    phaseIndex,
    agentIndex,
    title: `agent ${id}`,
    model: "gpt-5",
    ...extra,
  }),
  ...(status === "running"
    ? []
    : [A("task.updated", null, s + 1, { taskId: id, agentKind: "agent", status })]),
];
const coordinator = (id, s, phases, status) => [
  A("task.started", null, s, {
    taskId: id,
    agentKind: "agent",
    taskType: "local_workflow",
    title: "Review",
    workflowName: "Deep review",
    ...(phases === undefined ? {} : { phases }),
  }),
  ...(status === undefined
    ? []
    : [A("task.updated", null, s + 1, { taskId: id, agentKind: "agent", status })]),
];

const flowCases = [
  ["empty thread", [], null, null],
  ["running turn with no tool call yet", [], { turnId: "turn-1", startedAt: 5 }, "gpt-5"],
  [
    "running turn not started: the request time stands in",
    [],
    { turnId: "turn-1", startedAt: null, requestedAt: 4 },
    null,
  ],
  [
    "finished turn: one tool of every category",
    [
      bash("turn-1", 1, "c1"),
      A("tool.completed", "turn-1", 2, {
        toolCallId: "c2",
        status: "completed",
        data: { toolName: "Read" },
      }),
      A("tool.completed", "turn-1", 3, {
        toolCallId: "c3",
        status: "completed",
        data: { toolName: "Edit" },
      }),
      A("tool.completed", "turn-1", 4, {
        toolCallId: "c4",
        status: "completed",
        data: { toolName: "Grep" },
      }),
      A("tool.completed", "turn-1", 5, {
        toolCallId: "c5",
        status: "completed",
        data: { toolName: "WebSearch" },
      }),
      A("tool.completed", "turn-1", 6, {
        toolCallId: "c6",
        status: "completed",
        itemType: "mcp_tool_call",
      }),
      A("tool.completed", "turn-1", 7, {
        toolCallId: "c7",
        status: "completed",
        data: { toolName: "TodoWrite" },
      }),
      A("tool.completed", "turn-1", 8, {
        toolCallId: "c8",
        status: "completed",
        itemType: "command_execution",
      }),
      A("tool.completed", "turn-1", 9, {
        toolCallId: "c9",
        status: "completed",
        data: { kind: "think" },
      }),
      bash("turn-1", 10, "c10"),
    ],
    { turnId: "turn-1", startedAt: 0, completedAt: 20 },
    "gpt-5",
  ],
  [
    "running turn: the running tool names what the agent is doing",
    [
      bash("turn-1", 1, "c1"),
      A("tool.started", "turn-1", 2, {
        toolCallId: "c2",
        status: "inProgress",
        data: { toolName: "Read" },
      }),
    ],
    { turnId: "turn-1", startedAt: 0 },
    null,
  ],
  [
    "running turn between steps is thinking",
    [bash("turn-1", 1, "c1")],
    { turnId: "turn-1", startedAt: 0 },
    "gpt-5",
  ],
  [
    "turn that ended with a step that never reported",
    [
      A("tool.started", "turn-1", 1, {
        toolCallId: "c1",
        status: "inProgress",
        data: { toolName: "Bash" },
      }),
    ],
    { turnId: "turn-1", startedAt: 0, completedAt: 9 },
    null,
  ],
  [
    "tool updates: the last status wins, a later update keeps the name",
    [
      A("tool.started", "turn-1", 1, {
        toolCallId: "c1",
        status: "inProgress",
        data: { toolName: "Bash" },
      }),
      A("tool.updated", "turn-1", 2, { toolCallId: "c1", status: "failed" }),
      A("tool.started", "turn-1", 3, {
        toolCallId: "c2",
        status: "completed",
        data: { toolName: "Read" },
      }),
      A("tool.updated", "turn-1", 4, { toolCallId: "c2", status: "inProgress" }),
    ],
    { turnId: "turn-1", startedAt: 0, completedAt: 9 },
    null,
  ],
  [
    "tool activities without a turn, a call id or an object payload are skipped",
    [
      A("tool.completed", null, 1, { toolCallId: "c1", status: "completed" }),
      A("tool.completed", "turn-1", 2, { status: "completed" }),
      A("tool.completed", "turn-1", 3, "not an object"),
      bash("turn-1", 4, "c4"),
    ],
    { turnId: "turn-1", startedAt: 0, completedAt: 9 },
    null,
  ],
  [
    "three turns, newest running: named by order, newest first",
    [
      bash("turn-1", 1, "a1"),
      bash("turn-2", 11, "b1"),
      A("tool.started", "turn-3", 21, {
        toolCallId: "c1",
        status: "inProgress",
        data: { toolName: "Edit" },
      }),
    ],
    { turnId: "turn-3", startedAt: 20 },
    "gpt-5",
  ],
  [
    "subagent launched by a tool call, running while the turn runs",
    launch("turn-1", 1, "c1", "sub-1", {
      title: "Explore auth",
      model: "gpt-5",
      effort: "high",
      summary: "reading",
    }),
    { turnId: "turn-1", startedAt: 0 },
    null,
  ],
  [
    "subagents: completed, failed with its summary as the error, stopped",
    [
      ...launch("turn-1", 1, "c1", "sub-1", { title: "Explore" }),
      A("task.completed", "turn-1", 3, {
        taskId: "sub-1",
        status: "completed",
        summary: "found it",
      }),
      ...launch("turn-1", 4, "c2", "sub-2", { title: "Fix" }),
      A("task.completed", "turn-1", 6, {
        taskId: "sub-2",
        status: "failed",
        summary: "build broke",
      }),
      ...launch("turn-1", 7, "c3", "sub-3", { title: "Try" }),
      A("task.updated", "turn-1", 9, {
        taskId: "sub-3",
        status: "stopped",
        detail: "asked to stop",
      }),
    ],
    { turnId: "turn-1", startedAt: 0, completedAt: 20 },
    "gpt-5",
  ],
  [
    "subagent usage in tokens, two spellings",
    [
      ...launch("turn-1", 1, "c1", "sub-1", { title: "A", usage: { totalTokens: 1200 } }),
      ...launch("turn-1", 2, "c2", "sub-2", { title: "B", usage: { total_tokens: 800 } }),
    ],
    { turnId: "turn-1", startedAt: 0, completedAt: 20 },
    null,
  ],
  [
    "workflow launched by a tool call",
    launch("turn-1", 1, "c1", "wf-1", {
      taskType: "local_workflow",
      workflowName: "Deep review",
      title: "ignored",
    }),
    { turnId: "turn-1", startedAt: 0 },
    null,
  ],
  [
    "crew: two overlapping workers and an auditor",
    [
      crewTask("task.started", "turn-1", 1, "w1", "worker", {
        title: "Parser",
        model: "gpt-5",
        summary: "on it",
      }),
      crewTask("task.started", "turn-1", 2, "w2", "expert", { title: "Docs" }),
      crewTask("task.completed", "turn-1", 8, "w1", "worker", {
        status: "completed",
        tested: true,
        ...usage(100, 50, 0.25),
      }),
      crewTask("task.completed", "turn-1", 9, "w2", "expert", {
        status: "completed",
        ...usage(40, 10),
      }),
      crewTask("task.started", "turn-1", 10, "a1", "auditor", { title: "Audit" }),
      crewTask("task.completed", "turn-1", 14, "a1", "auditor", {
        status: "completed",
        verdict: "approve",
      }),
    ],
    { turnId: "turn-1", startedAt: 0, completedAt: 20 },
    "gpt-5",
  ],
  [
    "crew: sequential workers take a column each",
    [
      crewTask("task.started", "turn-1", 1, "w1", "worker", { title: "One" }),
      crewTask("task.completed", "turn-1", 2, "w1", "worker", { status: "completed" }),
      crewTask("task.started", "turn-1", 3, "w2", "worker", { title: "Two" }),
      crewTask("task.completed", "turn-1", 4, "w2", "worker", { status: "partial" }),
      crewTask("task.started", "turn-1", 5, "w3", "worker", { title: "Three" }),
      crewTask("task.completed", "turn-1", 6, "w3", "worker", { status: "blocked" }),
    ],
    { turnId: "turn-1", startedAt: 0, completedAt: 20 },
    null,
  ],
  [
    "crew still running under a running turn: the main agent waits",
    [
      bash("turn-1", 1, "c1"),
      crewTask("task.started", "turn-1", 2, "w1", "worker", { title: "Parser" }),
    ],
    { turnId: "turn-1", startedAt: 0 },
    "gpt-5",
  ],
  [
    "crew task with no report when the turn ended reads stopped",
    [crewTask("task.started", "turn-1", 2, "w1", "worker", { title: "Parser" })],
    { turnId: "turn-1", startedAt: 0, completedAt: 20 },
    null,
  ],
  [
    "crew and tool steps in one turn plus an earlier plain turn",
    [
      bash("turn-1", 1, "a1"),
      bash("turn-2", 11, "b1"),
      crewTask("task.started", "turn-2", 12, "w1", "worker", { title: "Do it" }),
      crewTask("task.completed", "turn-2", 15, "w1", "worker", {
        status: "failed",
        ...usage(5, 5, 0.125),
      }),
    ],
    { turnId: "turn-2", startedAt: 10, completedAt: 30 },
    "gpt-5",
  ],
  [
    "provider workflow with several waves, between two turns",
    [
      bash("turn-1", 1, "a1"),
      ...coordinator("wf1", 20, [
        { index: 0, title: "Plan" },
        { index: 1, title: "Build" },
        { index: 2, title: "Verify" },
        { index: 3, title: "Empty" },
      ]),
      ...member("wf1:wf:p1", "wf1", 0, 0, "completed", 21),
      ...member("wf1:wf:b1", "wf1", 1, 0, "completed", 23),
      ...member("wf1:wf:b2", "wf1", 1, 1, "running", 23),
      ...member("wf1:wf:v1", "wf1", 2, 0, "failed", 25),
      ...member("wf1:wf:o1", "wf1", 9, 0, "running", 26),
      bash("turn-2", 40, "b1"),
    ],
    { turnId: "turn-2", startedAt: 39 },
    "gpt-5",
  ],
  [
    "workflow phases taken from its members when it names none",
    [
      ...coordinator("wf1", 1, undefined),
      ...member("wf1:wf:a", "wf1", 0, 0, "running", 2, { phaseTitle: "Scan" }),
      ...member("wf1:wf:b", "wf1", 1, 0, "running", 3),
      ...member("wf1:wf:c", "wf1", null, 1, "running", 4),
    ],
    { turnId: "turn-1", startedAt: 0 },
    null,
  ],
  [
    "workflow members in every status",
    [
      ...coordinator("wf1", 1, [{ index: 0, title: "All" }]),
      ...[
        "pending",
        "running",
        "waiting",
        "idle",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ].flatMap((status, i) =>
        member(`wf1:wf:${status}`, "wf1", 0, i, status, 2 + i * 2, { phaseIndex: 0 }),
      ),
    ],
    { turnId: "turn-1", startedAt: 0 },
    null,
  ],
  [
    "a settled workflow settles members that never reported",
    [
      ...coordinator("wf1", 1, [{ index: 0, title: "Only" }], "completed"),
      ...member("wf1:wf:a", "wf1", 0, 0, "running", 3),
      ...coordinator("wf2", 10, [{ index: 0, title: "Only" }], "failed"),
      ...member("wf2:wf:a", "wf2", 0, 0, "running", 12),
    ],
    { turnId: "turn-1", startedAt: 0, completedAt: 50 },
    null,
  ],
  [
    "a dead session interrupts workflow members",
    [
      ...coordinator("wf1", 1, [{ index: 0, title: "Only" }]),
      ...member("wf1:wf:a", "wf1", 0, 0, "running", 3),
    ],
    { turnId: "turn-1", startedAt: 0, completedAt: 50, sessionStatus: "stopped" },
    null,
  ],
  [
    "agent activity that is not a stamped agent stays off the board",
    [
      A("task.started", null, 1, { taskId: "shell-1", title: "Run tests" }),
      ...launch("turn-1", 2, "c1", "shell-2", { agentKind: "shell", title: "Watch" }),
    ],
    { turnId: "turn-1", startedAt: 0, completedAt: 20 },
    null,
  ],
];
put("vectors/thread-flow.json", {
  cases: flowCases.map(([name, activities, turn, leadModel]) => {
    const live = turn !== null && !("completedAt" in turn) ? turn : null;
    const last = turn !== null && "completedAt" in turn ? turn : null;
    const thread = threadOf(activities, { live, last });
    return { name, thread, leadModel, expected: flowsOf(thread, live, leadModel) };
  }),
});

// --- write or check -----------------------------------------------------------------------------

// Files in fixtures/ that the Rust app owns and this script neither writes nor judges: Mocha's art
// and golden cells (pet/mocha.json) were exported once from the TypeScript terminal's renderer,
// which is gone; the file is now maintained by hand next to src/pet.rs.
const owned = new Set(["pet/mocha.json"]);
if (!NodeFS.existsSync(NodePath.join(out, "pet", "mocha.json"))) {
  console.error("fixtures/pet/mocha.json is missing; src/pet.rs embeds it");
  process.exit(1);
}

const wanted = new Set(files.keys());
const present = [];
const walk = (dir, prefix = "") => {
  if (!NodeFS.existsSync(dir)) return;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(NodePath.join(dir, entry.name), rel);
    else if (!owned.has(rel)) present.push(rel);
  }
};
walk(out);

if (check) {
  const stale = [
    ...[...wanted].filter(
      (p) =>
        !NodeFS.existsSync(NodePath.join(out, p)) ||
        NodeFS.readFileSync(NodePath.join(out, p), "utf8") !== files.get(p),
    ),
    ...present.filter((p) => !wanted.has(p)),
  ];
  if (stale.length > 0) {
    console.error(`fixtures are out of date: ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log(`${wanted.size} fixtures are current`);
} else {
  for (const path of present) NodeFS.rmSync(NodePath.join(out, path));
  for (const [path, text] of files) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(out, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(out, path), text);
  }
  console.log(`wrote ${files.size} fixtures to ${out}`);
}
