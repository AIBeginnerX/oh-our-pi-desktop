import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SIDE_QUESTION_MAX_LENGTH = 2_000;
export const SIDE_ANSWER_MAX_LENGTH = 8_000;

export const SideQuestionInput = Schema.Struct({
  threadId: ThreadId,
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(SIDE_QUESTION_MAX_LENGTH)),
});
export type SideQuestionInput = typeof SideQuestionInput.Type;

export const SideQuestionResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("answered"),
    answer: TrimmedNonEmptyString.check(Schema.isMaxLength(SIDE_ANSWER_MAX_LENGTH)),
  }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
export type SideQuestionResult = typeof SideQuestionResult.Type;
