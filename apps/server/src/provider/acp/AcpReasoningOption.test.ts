import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Errors from "effect-acp/errors";
import { applyAcpReasoningOption } from "./AcpReasoningOption.ts";

describe("ACP reasoning selection", () => {
  it.effect("sets thought at start and on change, skipping unchanged and unknown values", () =>
    Effect.gen(function* () {
      let currentValue = "low";
      const calls: unknown[] = [];
      const runtime = {
        getConfigOptions: Effect.sync(() => [
          {
            id: "thought",
            name: "Thought",
            category: "thought_level" as const,
            type: "select" as const,
            currentValue,
            options: ["low", "high", "max"].map((value) => ({ value, name: value })),
          },
        ]),
        setConfigOption: (id: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push([id, value]);
            currentValue = String(value);
            return { configOptions: [] };
          }),
      };
      for (const requested of ["high", "high", "bogus", undefined, "max"]) {
        yield* applyAcpReasoningOption({ runtime, requested, mapError: (cause) => cause.message });
      }
      expect(calls).toEqual([
        ["thought", "high"],
        ["thought", "max"],
      ]);
    }),
  );
  it.effect("maps transport/request errors", () =>
    Effect.gen(function* () {
      const failure = Errors.AcpRequestError.invalidParams("refused");
      const error = yield* Effect.flip(
        applyAcpReasoningOption({
          runtime: {
            getConfigOptions: Effect.succeed([
              {
                id: "effort",
                name: "Effort",
                type: "select",
                currentValue: "low",
                options: [{ value: "max", name: "Max" }],
              },
            ]),
            setConfigOption: () => Effect.fail(failure),
          },
          requested: "max",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
  it.effect("leaves agents without thought options unchanged", () =>
    applyAcpReasoningOption({
      runtime: {
        getConfigOptions: Effect.succeed([]),
        setConfigOption: () => Effect.die("must not call"),
      },
      requested: "max",
      mapError: (cause) => cause,
    }),
  );
});
