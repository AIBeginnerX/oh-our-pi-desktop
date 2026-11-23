import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const ScheduledPromptId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const ScheduledPrompt = Schema.Struct({
  // Part of the id of every thread the schedule creates.
  id: ScheduledPromptId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  // Sent as written, so it is not trimmed; it must still say something.
  prompt: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(8_000)),
  enabled: Schema.Boolean,
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 })),
});
export type ScheduledPrompt = typeof ScheduledPrompt.Type;

export const MAX_SCHEDULED_PROMPTS = 20;
export const ScheduledPrompts = Schema.Array(ScheduledPrompt).check(
  Schema.isMaxLength(MAX_SCHEDULED_PROMPTS),
);

export const ScheduledPromptOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("upsert"), entry: ScheduledPrompt }),
  Schema.Struct({
    type: Schema.Literal("update"),
    id: ScheduledPromptId,
    changes: Schema.Struct({
      title: Schema.optionalKey(ScheduledPrompt.fields.title),
      prompt: Schema.optionalKey(ScheduledPrompt.fields.prompt),
      enabled: Schema.optionalKey(ScheduledPrompt.fields.enabled),
      hour: Schema.optionalKey(ScheduledPrompt.fields.hour),
      minute: Schema.optionalKey(ScheduledPrompt.fields.minute),
    }),
  }),
  Schema.Struct({ type: Schema.Literal("remove"), id: ScheduledPromptId }),
  Schema.Struct({ type: Schema.Literal("removeProject"), projectId: ProjectId }),
]);
export type ScheduledPromptOperation = typeof ScheduledPromptOperation.Type;
