import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it as effectIt } from "@effect/vitest";
import { describe as describeSync, it } from "vite-plus/test";
import {
  CommandId,
  ComposerContextId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProjectSkillId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { ProjectSkillSendGate } from "../skills/ProjectSkillSendGate.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const normalizerTestLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-retention-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describeSync("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

describe("normalizeDispatchCommand project-skill retention", () => {
  effectIt.effect(
    "merges admitted ref, mode, selection, and server stamp into the turn command",
    () =>
      Effect.gen(function* () {
        const ref = {
          projectId: ProjectId.make("project-1"),
          skillId: ProjectSkillId.make("psk_abcd1234"),
          version: 1,
          contentSha256: "a".repeat(64),
        };
        const selectedScriptIds = ["lint", "unit"];
        const managedRecord = {
          version: 1 as const,
          contextId: ComposerContextId.make("ctx-skill"),
          kind: "project-skill" as const,
          label: "release",
          payload: {
            ref,
            mode: "use" as const,
            selectedScriptIds,
            admittedSkillStateSeq: 42,
            forged: "client-only",
          },
        };
        const command: ClientOrchestrationCommand = {
          type: "thread.turn.start",
          commandId: CommandId.make("command-retention"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "send with skill",
            attachments: [],
            context: { version: 1, records: [managedRecord] },
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-08-01T00:00:00.000Z",
        };

        const normalized = yield* normalizeDispatchCommand(command).pipe(
          Effect.provideService(ProjectSkillSendGate, {
            preflight: (input) =>
              Effect.succeed({
                _tag: "Admitted" as const,
                projectId: ref.projectId,
                ref,
                admittedSkillStateSeq: 9,
                records: input.records.map((record) =>
                  record.kind === "project-skill"
                    ? {
                        ...record,
                        payload: {
                          ref,
                          mode: "use",
                          admittedSkillStateSeq: 9,
                          selectedScriptIds,
                        },
                      }
                    : record,
                ),
              }),
            authorizeInTransaction: () =>
              Effect.die(new Error("unreachable in normalize preflight")),
          }),
        );

        expect(normalized.type).toBe("thread.turn.start");
        if (normalized.type !== "thread.turn.start") return;
        const stamped = normalized.message.context?.records[0];
        if (stamped === undefined) {
          throw new Error("expected a context record");
        }
        if (stamped.kind !== "project-skill" || !("payload" in stamped)) {
          throw new Error("expected a project-skill record with payload");
        }
        expect(stamped).toMatchObject({
          kind: "project-skill",
          contextId: "ctx-skill",
          payload: {
            ref,
            mode: "use",
            admittedSkillStateSeq: 9,
            selectedScriptIds,
          },
        });
        expect(stamped.payload).not.toHaveProperty("forged");
      }).pipe(Effect.provide(normalizerTestLayer)),
  );
});
