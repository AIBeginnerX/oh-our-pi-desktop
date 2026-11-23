import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  SideQuestionInput,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { answerSideQuestion } from "./SideQuestion.ts";

const decodeQuestion = Schema.decodeUnknownResult(SideQuestionInput);
const threadId = ThreadId.make("thread");
const input = { threadId, question: "What changed?" };
const modelSelection = createModelSelection(ProviderInstanceId.make("codex"), "model");
const message = (text: string) => ({ role: "user" as const, text });
const snapshot = (messages: ReadonlyArray<ReturnType<typeof message>>) =>
  Effect.succeed(Option.some({ thread: { modelSelection, messages } }));

it.layer(NodeServices.layer)("side question", (it) => {
  it.effect("validates the question after trimming", () =>
    Effect.sync(() => {
      assert.deepEqual(
        decodeQuestion({ threadId, question: "  " + "x".repeat(2_000) })._tag,
        "Success",
      );
      assert.deepEqual(decodeQuestion({ threadId, question: "x".repeat(2_001) })._tag, "Failure");
      assert.deepEqual(decodeQuestion({ threadId, question: "  " })._tag, "Failure");
    }),
  );

  it.effect("answers using only a bounded read and isolated generation", () =>
    Effect.gen(function* () {
      // Only read and generation ports are provided. The handler requires no
      // orchestration engine or event store to answer the request.
      const calls: string[] = [];
      const result = yield* answerSideQuestion(input, {
        getMemoryEchoState: () => Effect.succeed("clean"),
        getThreadDetailSnapshot: (readThreadId, options) => {
          calls.push("read");
          assert.strictEqual(readThreadId, threadId);
          assert.deepEqual(options, { turnLimit: 20 });
          return Effect.succeed(
            Option.some({
              thread: {
                modelSelection,
                messages: [
                  ...Array.from({ length: 24 }, (_, index) => message(String(index))),
                  { role: "assistant", text: "latest" },
                  { role: "system", text: "internal" },
                ],
              },
            }),
          );
        },
        generateSideAnswer: (request) => {
          calls.push("generate");
          assert.strictEqual(request.modelSelection, modelSelection);
          assert.strictEqual(request.question, input.question);
          assert.deepEqual(request.transcript, [
            ...Array.from({ length: 19 }, (_, index) => message(String(index + 5))),
            { role: "assistant", text: "latest" },
          ]);
          return Effect.succeed({ answer: "a".repeat(8_001) });
        },
      });
      assert.deepEqual(calls, ["read", "generate"]);
      assert.deepEqual(result, { status: "answered", answer: "a".repeat(8_000) });
    }),
  );

  it.effect("keeps the newest 12,000 characters", () =>
    Effect.gen(function* () {
      yield* answerSideQuestion(input, {
        getMemoryEchoState: () => Effect.succeed("clean"),
        getThreadDetailSnapshot: () => snapshot([message("x".repeat(12_000)), message("new")]),
        generateSideAnswer: ({ transcript }) => {
          assert.deepEqual(transcript, [message("x".repeat(11_997)), message("new")]);
          return Effect.succeed({ answer: "answer" });
        },
      });
    }),
  );

  it.effect("gives up after three minutes without an answer", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const timers: number[] = [];
      // A timer ends as soon as it is set, so only the time limit can end this request.
      const elapsedClock: Clock.Clock = {
        currentTimeMillis: clock.currentTimeMillis,
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeNanos: clock.currentTimeNanos,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        sleep: (duration) =>
          Effect.sync(() => {
            timers.push(Duration.toMillis(duration));
          }),
      };
      const result = yield* answerSideQuestion(input, {
        getMemoryEchoState: () => Effect.succeed("clean"),
        getThreadDetailSnapshot: () => snapshot([message("hello")]),
        generateSideAnswer: () => Effect.never,
      }).pipe(Effect.provideService(Clock.Clock, elapsedClock));
      assert.deepEqual(result, { status: "unavailable" });
      assert.include(timers, 180_000);
    }),
  );

  it.effect("is unavailable when the thread is missing, guarded or generation fails", () =>
    Effect.gen(function* () {
      const dependencies = {
        getThreadDetailSnapshot: () => snapshot([]),
        getMemoryEchoState: () => Effect.succeed("clean" as const),
        generateSideAnswer: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateSideAnswer",
              detail: "generation failed",
            }),
          ),
      };
      let unexpectedGenerations = 0;
      const neverGenerate = () => {
        unexpectedGenerations++;
        return Effect.succeed({ answer: "unexpected" });
      };
      const cases = [
        dependencies,
        {
          ...dependencies,
          getThreadDetailSnapshot: () => Effect.succeedNone,
          generateSideAnswer: neverGenerate,
        },
        {
          ...dependencies,
          getMemoryEchoState: () => Effect.succeed("tainted" as const),
          generateSideAnswer: neverGenerate,
        },
        {
          ...dependencies,
          getMemoryEchoState: () => Effect.succeed("unavailable" as const),
          generateSideAnswer: neverGenerate,
        },
      ];
      for (const testCase of cases) {
        assert.deepEqual(yield* answerSideQuestion(input, testCase), { status: "unavailable" });
      }
      assert.strictEqual(unexpectedGenerations, 0);
    }),
  );
});
