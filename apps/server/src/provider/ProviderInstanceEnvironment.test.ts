import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeProviderProcessEnvironment,
  mergeProviderInstanceEnvironment,
} from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join(NodeOS.homedir(), tail),
        CLAUDE_CONFIG_DIR: path.join(NodeOS.homedir(), tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("leaves inherited provider homes unchanged", () => {
    const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
        baseEnv,
      ),
    ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
  });

  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });
});

describe("makeProviderProcessEnvironment", () => {
  it.each([undefined, []])(
    "adds privacy defaults without mutating the base environment (%j)",
    (overrides) => {
      const baseEnv = { PATH: "/bin" };
      const environment = makeProviderProcessEnvironment(overrides, baseEnv);

      expect(environment).toEqual({
        PATH: "/bin",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        GROK_TELEMETRY_ENABLED: "false",
        ZCODE_MODEL_TELEMETRY_ENABLED: "false",
      });
      expect(environment).not.toBe(baseEnv);
      expect(baseEnv).toEqual({ PATH: "/bin" });
    },
  );

  it.each([
    ["claudeCode", { GROK_TELEMETRY_ENABLED: "false", ZCODE_MODEL_TELEMETRY_ENABLED: "false" }],
    ["grok", { ZCODE_MODEL_TELEMETRY_ENABLED: "false" }],
    [
      "zcode",
      { DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", GROK_TELEMETRY_ENABLED: "false" },
    ],
  ] as const)("leaves only %s's own defaults out when its switch is on", (cli, expected) => {
    expect(
      makeProviderProcessEnvironment(undefined, { PATH: "/bin" }, { telemetryOn: cli }),
    ).toEqual({ PATH: "/bin", ...expected });
  });

  it("keeps a value the user set even when that CLI's switch is on", () => {
    expect(
      makeProviderProcessEnvironment(
        undefined,
        { DISABLE_TELEMETRY: "1" },
        { telemetryOn: "claudeCode" },
      ),
    ).toEqual({ DISABLE_TELEMETRY: "1", ZCODE_MODEL_TELEMETRY_ENABLED: "false" });
  });

  it.each(["0", "", "false", "1"])("preserves explicit disable values (%j)", (value) => {
    expect(
      makeProviderProcessEnvironment(undefined, {
        DISABLE_TELEMETRY: value,
        DISABLE_ERROR_REPORTING: value,
      }),
    ).toEqual({
      DISABLE_TELEMETRY: value,
      DISABLE_ERROR_REPORTING: value,
      ZCODE_MODEL_TELEMETRY_ENABLED: "false",
    });
  });

  it.each([false, true])(
    "honors telemetry opt-ins from the instance or host (%j)",
    (fromInstance) => {
      const choices = {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        GROK_TELEMETRY_ENABLED: "true",
        GROK_ERROR_REPORTING: "1",
      };
      const overrides = Object.entries(choices).map(([name, value]) => ({
        name,
        value,
        sensitive: false,
      }));

      expect(
        makeProviderProcessEnvironment(
          fromInstance ? overrides : undefined,
          fromInstance ? {} : choices,
        ),
      ).toEqual({ ...choices, ZCODE_MODEL_TELEMETRY_ENABLED: "false" });
    },
  );

  it("does not counteract an explicit ZCode telemetry choice", () => {
    expect(
      makeProviderProcessEnvironment(undefined, { ZCODE_MODEL_TELEMETRY_ENABLED: "true" })
        .ZCODE_MODEL_TELEMETRY_ENABLED,
    ).toBe("true");
  });

  it.each(["CLAUDE_CODE_ENABLE_TELEMETRY", "GROK_TELEMETRY_ENABLED"])(
    "does not counteract an explicit %s choice",
    (name) => {
      const environment = makeProviderProcessEnvironment(undefined, { [name]: "1" });

      expect(environment[name]).toBe("1");
      expect(environment.DISABLE_TELEMETRY).toBeUndefined();
    },
  );

  it("does not counteract an explicit Grok error reporting choice", () => {
    const environment = makeProviderProcessEnvironment(undefined, { GROK_ERROR_REPORTING: "1" });

    expect(environment.GROK_ERROR_REPORTING).toBe("1");
    expect(environment.DISABLE_ERROR_REPORTING).toBeUndefined();
  });

  it("lets instance overrides win over inherited values and defaults", () => {
    expect(
      makeProviderProcessEnvironment(
        [
          { name: "DISABLE_TELEMETRY", value: "", sensitive: false },
          { name: "DISABLE_ERROR_REPORTING", value: "0", sensitive: false },
          { name: "GROK_TELEMETRY_ENABLED", value: "true", sensitive: false },
        ],
        {
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1",
          GROK_TELEMETRY_ENABLED: "false",
        },
      ),
    ).toEqual({
      DISABLE_TELEMETRY: "",
      DISABLE_ERROR_REPORTING: "0",
      GROK_TELEMETRY_ENABLED: "true",
      ZCODE_MODEL_TELEMETRY_ENABLED: "false",
    });
  });
});
