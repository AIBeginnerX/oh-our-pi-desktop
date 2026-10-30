import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import type { FormInfo1 } from "@opencode/client/promise";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  openCode2FormAnswer,
  openCode2FormQuestions,
  openCode2PermissionRules,
  openCode2ToolItemType,
} from "./OpenCode2Adapter.ts";
import { isOpenCode2Version, openCode2Authorization } from "./OpenCode2Client.ts";
import { selectOpenCodeAdapter } from "./OpenCodeAdapterSelector.ts";

const form = (fields: ReadonlyArray<Record<string, unknown>>) =>
  ({ id: "frm_1", sessionID: "ses_1", title: "Setup", fields }) as unknown as FormInfo1;

it("asks before shell and edits unless the session has full access", () => {
  const effect = (
    mode: "approval-required" | "auto-accept-edits" | "full-access",
    action: string,
  ) =>
    openCode2PermissionRules({ runtimeMode: mode, mcp: false })
      .filter((rule) => rule.action === action || rule.action === "*")
      .at(-1)?.effect;

  NodeAssert.equal(effect("approval-required", "shell"), "ask");
  NodeAssert.equal(effect("approval-required", "edit"), "ask");
  NodeAssert.equal(effect("auto-accept-edits", "shell"), "ask");
  NodeAssert.equal(effect("auto-accept-edits", "edit"), "allow");
  NodeAssert.equal(effect("full-access", "shell"), "allow");
  NodeAssert.deepEqual(
    openCode2PermissionRules({ runtimeMode: "approval-required", mcp: true }).at(-1),
    { action: "t3-code_*", resource: "*", effect: "allow" },
  );
});

it("shows OpenCode 2 tools as the matching OOP work item", () => {
  NodeAssert.deepEqual(
    ["shell", "edit", "apply_patch", "websearch", "task", "t3-code_memory", "read"].map(
      openCode2ToolItemType,
    ),
    [
      "command_execution",
      "file_change",
      "file_change",
      "web_search",
      "collab_agent_tool_call",
      "mcp_tool_call",
      "dynamic_tool_call",
    ],
  );
});

it("maps form fields to questions and declines fields OOP cannot show", () => {
  const mapped = openCode2FormQuestions(
    form([
      { key: "name", type: "string", title: "Name", description: "Project name" },
      {
        key: "tags",
        type: "multiselect",
        options: [{ value: "a", label: "Alpha" }, { value: "b" }],
      },
    ]),
  );
  NodeAssert.ok("questions" in mapped);
  NodeAssert.deepEqual(
    mapped.questions.map((question) => [
      question.id,
      question.header,
      question.question,
      question.multiSelect,
      question.allowCustomAnswer,
      question.options.map((option) => option.label),
    ]),
    [
      ["name", "Name", "Project name", false, true, []],
      ["tags", "Setup", "Setup", true, false, ["Alpha", "b"]],
    ],
  );

  NodeAssert.deepEqual(openCode2FormQuestions(form([{ key: "url", type: "external" }])), {
    unsupported: "a link to open",
  });
  NodeAssert.deepEqual(openCode2FormQuestions(form([{ key: "x", type: "string", hidden: true }])), {
    unsupported: "a hidden field",
  });
});

it("answers multiselect fields with lists and drops empty answers", () => {
  const fields = form([
    { key: "name", type: "string" },
    { key: "tags", type: "multiselect" },
    { key: "skip", type: "string" },
  ]);
  NodeAssert.deepEqual(
    openCode2FormAnswer(fields, { name: ["one", "two"], tags: ["a", " ", "b"], skip: "  " }),
    { name: "one, two", tags: ["a", "b"] },
  );
});

it("detects OpenCode 2 versions and builds its Basic credentials", () => {
  NodeAssert.deepEqual(
    ["2.1.4", "v2.0.0", "1.14.19", "garbage", undefined].map(isOpenCode2Version),
    [true, true, false, false, false],
  );
  NodeAssert.equal(
    openCode2Authorization("pässword"),
    "Basic " + Buffer.from("opencode:pässword", "utf8").toString("base64"),
  );
});

const recordingAdapter = (name: string, calls: Array<string>) =>
  ({
    provider: "opencode",
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (session: { threadId: ThreadId }) =>
      Effect.sync(() => {
        calls.push(name + ".start");
        return { threadId: session.threadId };
      }),
    sendTurn: (turn: { threadId: ThreadId }) =>
      Effect.sync(() => {
        calls.push(name + ".send");
        return { threadId: turn.threadId };
      }),
    stopSession: () => Effect.sync(() => void calls.push(name + ".stop")),
    listSessions: () => Effect.succeed([]),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  }) as unknown as OpenCodeAdapterShape;

it.effect("keeps a thread on the adapter that started it", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const isV2 = yield* Ref.make(true);
    const adapter = selectOpenCodeAdapter({
      v1: recordingAdapter("v1", calls),
      v2: recordingAdapter("v2", calls),
      isV2: Ref.get(isV2),
    });
    const threadId = ThreadId.make("thread-1");
    const start = () => adapter.startSession({ threadId } as never);
    const send = () => adapter.sendTurn({ threadId } as never, undefined as never);

    yield* start();
    yield* Ref.set(isV2, false);
    yield* send();
    yield* start();
    yield* send();

    NodeAssert.deepEqual(calls, ["v2.start", "v2.send", "v2.stop", "v1.start", "v1.send"]);
  }),
);
