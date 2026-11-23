import { Schema } from "effect";
import { ThreadId } from "./baseSchemas.ts";

export const CONTEXT_BREAKDOWN_MAX_CATEGORIES = 32;
export const CONTEXT_BREAKDOWN_MAX_NAME_LENGTH = 80;

const TokenCount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const ProviderContextCategory = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(CONTEXT_BREAKDOWN_MAX_NAME_LENGTH)),
  tokens: TokenCount,
  kind: Schema.Literals(["used", "free", "buffer", "deferred"]),
});
export type ProviderContextCategory = typeof ProviderContextCategory.Type;

export const ProviderContextBreakdownInput = Schema.Struct({ threadId: ThreadId });

export const ProviderContextBreakdownResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    model: Schema.String,
    totalTokens: TokenCount,
    maxTokens: TokenCount,
    categories: Schema.Array(ProviderContextCategory).check(
      Schema.isMaxLength(CONTEXT_BREAKDOWN_MAX_CATEGORIES),
    ),
    measuredAt: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
export type ProviderContextBreakdownResult = typeof ProviderContextBreakdownResult.Type;
