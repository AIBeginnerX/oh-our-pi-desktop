import { ZCODE_DEFAULT_MODEL, ZCodeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildInitialZCodeProviderSnapshot,
  checkZCodeProviderStatus,
  zcodeAcpLaunch,
} from "./ZCodeProvider.ts";

const decodeSettings = Schema.decodeSync(ZCodeSettings);

const settings = (overrides: Partial<ZCodeSettings> = {}): ZCodeSettings => ({
  ...decodeSettings({}),
  ...overrides,
});

describe("ZCode provider", () => {
  it("launches the ACP bridge and points it at a custom ZCode binary only when one is set", () => {
    expect(zcodeAcpLaunch(settings())).toEqual({ command: "zcode-acp-server", args: [] });
    expect(
      zcodeAcpLaunch(settings({ binaryPath: "/opt/zcode", bridgePath: "/opt/zcode-acp" })),
    ).toEqual({ command: "/opt/zcode-acp", args: [], env: { ZCODE_BIN: "/opt/zcode" } });
  });

  it.effect("offers the GLM model ZCode has selected", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialZCodeProviderSnapshot(settings());
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual([ZCODE_DEFAULT_MODEL]);
    }),
  );

  it.effect("tells the user how to install the bridge when it is missing", () =>
    checkZCodeProviderStatus(
      settings({ enabled: true, bridgePath: "/nonexistent/oop-test/zcode-acp-server" }),
    ).pipe(
      Effect.map((snapshot) => {
        expect(snapshot.installed).toBe(false);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toContain("npm i -g zcode-acp-server");
      }),
      Effect.provide(NodeServices.layer),
    ),
  );
});
