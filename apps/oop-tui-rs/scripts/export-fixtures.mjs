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

// --- write or check -----------------------------------------------------------------------------

const wanted = new Set(files.keys());
const present = [];
const walk = (dir, prefix = "") => {
  if (!NodeFS.existsSync(dir)) return;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(NodePath.join(dir, entry.name), rel);
    else present.push(rel);
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
  NodeFS.rmSync(out, { recursive: true, force: true });
  for (const [path, text] of files) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(out, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(out, path), text);
  }
  console.log(`wrote ${files.size} fixtures to ${out}`);
}
