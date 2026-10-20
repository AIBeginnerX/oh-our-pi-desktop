import { MINIMAX_CODE_DEFAULT_MODEL, MiniMaxCodeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildInitialMiniMaxProviderSnapshot,
  checkMiniMaxProviderStatus,
  MINIMAX_CODE_PRESENTATION,
  miniMaxCodeAcpLaunch,
} from "./MiniMaxProvider.ts";
import { acpConfigOptionModels, acpProbeMessage } from "./AcpAgentProvider.ts";

const decodeSettings = Schema.decodeSync(MiniMaxCodeSettings);

const settings = (overrides: Partial<MiniMaxCodeSettings> = {}): MiniMaxCodeSettings => ({
  ...decodeSettings({}),
  ...overrides,
});

describe("MiniMax Code provider", () => {
  it("launches MiniMax Code as an ACP agent without an explicit sign-in method", () => {
    expect(miniMaxCodeAcpLaunch(settings())).toEqual({
      command: "mcode",
      args: ["acp"],
      env: { MAVIS_REGION: "en" },
    });
    expect(miniMaxCodeAcpLaunch(settings({ binaryPath: "/opt/mcode" })).command).toBe("/opt/mcode");
  });

  it.effect("starts disabled with the product model that keeps the session's own model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialMiniMaxProviderSnapshot(settings());
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual([MINIMAX_CODE_DEFAULT_MODEL]);
    }),
  );

  it.effect("tells the user how to install and sign in when the CLI is missing", () =>
    checkMiniMaxProviderStatus(
      settings({ enabled: true, binaryPath: "/nonexistent/oop-test/mcode" }),
    ).pipe(
      Effect.map((snapshot) => {
        expect(snapshot.installed).toBe(false);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toContain("mcode login --region global");
      }),
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("acpConfigOptionModels", () => {
  it("lists the selectable models of a session's model option once each, in order", () => {
    const models = acpConfigOptionModels([
      {
        id: "permissionMode",
        name: "Mode",
        category: "_permission",
        type: "select",
        currentValue: "a",
        options: [{ value: "a", name: "A" }],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "m:minimax:MiniMax-M3:v:thinking",
        options: [
          { value: "m:minimax:MiniMax-M3:v:", name: "M3" },
          { value: "m:minimax:MiniMax-M3:v:thinking", name: "M3 · thinking" },
          { value: "m:minimax:MiniMax-M3:v:", name: "M3 again" },
          { value: "  ", name: "blank" },
        ],
      },
    ]);
    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["m:minimax:MiniMax-M3:v:", "M3"],
      ["m:minimax:MiniMax-M3:v:thinking", "M3 · thinking"],
    ]);
    expect(acpConfigOptionModels(undefined)).toEqual([]);
  });

  it("does not send the user to sign in when the agent is only slow to start", () => {
    const agent = {
      presentation: MINIMAX_CODE_PRESENTATION,
      noAnswerMessage: "MiniMax Code did not answer. If you are signed out, run mcode login.",
    };
    expect(acpProbeMessage(agent, true)).toBe(
      "MiniMax Code is taking longer than usual to start. OoP checks it again on the next refresh.",
    );
    expect(acpProbeMessage(agent, false)).toBe(agent.noAnswerMessage);
  });
});
