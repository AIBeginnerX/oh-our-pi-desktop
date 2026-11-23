import {
  SIDE_ANSWER_MAX_LENGTH,
  type OrchestrationThread,
  type SideQuestionInput,
  type SideQuestionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as References from "effect/References";

import type { lookupMemoryEchoThreadState } from "../orchestration/memoryEcho.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type {
  SideAnswerGenerationInput,
  TextGeneration,
} from "../textGeneration/TextGeneration.ts";

const MAX_MESSAGES = 20;
const MAX_TRANSCRIPT_CHARS = 12_000;
// Not every provider bounds its own run, and the card waits for this answer.
const ANSWER_TIMEOUT = "3 minutes";
const unavailable = { status: "unavailable" } satisfies SideQuestionResult;

// An error's detail can quote provider output, so only its kind is logged.
const failed = (reason: string) =>
  Effect.logWarning("Side question failed", { reason }).pipe(Effect.as(unavailable));

interface SideQuestionDependencies {
  readonly getThreadDetailSnapshot: (
    threadId: SideQuestionInput["threadId"],
    options: { turnLimit: number },
  ) => Effect.Effect<
    Option.Option<{
      thread: {
        modelSelection: OrchestrationThread["modelSelection"];
        messages: ReadonlyArray<Pick<OrchestrationThread["messages"][number], "role" | "text">>;
      };
    }>,
    ProjectionRepositoryError
  >;
  readonly getMemoryEchoState: (
    threadId: SideQuestionInput["threadId"],
  ) => ReturnType<typeof lookupMemoryEchoThreadState>;
  readonly generateSideAnswer: TextGeneration["Service"]["generateSideAnswer"];
}

export function answerSideQuestion(
  input: SideQuestionInput,
  dependencies: SideQuestionDependencies,
): Effect.Effect<SideQuestionResult, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const { generateSideAnswer } = dependencies;
    if (!generateSideAnswer) return unavailable;
    const snapshot = yield* dependencies.getThreadDetailSnapshot(input.threadId, {
      turnLimit: MAX_MESSAGES,
    });
    if (Option.isNone(snapshot)) return unavailable;
    if ((yield* dependencies.getMemoryEchoState(input.threadId)) !== "clean") return unavailable;

    const { modelSelection, messages } = snapshot.value.thread;
    const transcript: Array<SideAnswerGenerationInput["transcript"][number]> = [];
    let remaining = MAX_TRANSCRIPT_CHARS;
    for (
      let index = messages.length - 1;
      index >= 0 && remaining > 0 && transcript.length < MAX_MESSAGES;
      index--
    ) {
      const message = messages[index];
      if (!message || (message.role !== "user" && message.role !== "assistant") || !message.text)
        continue;
      const text = message.text.slice(-remaining);
      transcript.push({ role: message.role, text });
      remaining -= text.length;
    }

    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-side-question-" });
    const generated = yield* Effect.suspend(() =>
      generateSideAnswer({
        cwd,
        modelSelection,
        question: input.question,
        transcript: transcript.toReversed(),
      }),
    ).pipe(
      Effect.timeout(ANSWER_TIMEOUT),
      Effect.provideService(References.MinimumLogLevel, "None"),
      Effect.withTracerEnabled(false),
    );
    const answer = generated.answer.trim().slice(0, SIDE_ANSWER_MAX_LENGTH).trimEnd();
    return answer ? ({ status: "answered", answer } as const) : unavailable;
  }).pipe(
    Effect.scoped,
    Effect.catch((error) => failed(error._tag)),
    Effect.catchDefect(() => failed("defect")),
  );
}
