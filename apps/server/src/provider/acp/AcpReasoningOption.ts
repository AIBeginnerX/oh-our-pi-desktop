import type * as AcpSchema from "effect-acp/schema";
import * as Effect from "effect/Effect";
import type * as AcpErrors from "effect-acp/errors";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export function acpReasoningOption(
  options: ReadonlyArray<AcpSchema.SessionConfigOption> | null | undefined,
) {
  return options?.find(
    (option) =>
      option.type === "select" &&
      (option.category === "thought_level" || /reason|effort|thinking/i.test(option.id)),
  );
}

export function applyAcpReasoningOption<E>(input: {
  runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  requested: string | undefined;
  mapError: (cause: AcpErrors.AcpError) => E;
}) {
  return Effect.gen(function* () {
    if (input.requested === undefined) return;
    const option = acpReasoningOption(yield* input.runtime.getConfigOptions);
    if (option?.type !== "select" || option.currentValue === input.requested) return;
    const choices = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
    if (!choices.some((choice) => choice.value === input.requested)) return;
    yield* input.runtime
      .setConfigOption(option.id, input.requested)
      .pipe(Effect.mapError(input.mapError));
  });
}
