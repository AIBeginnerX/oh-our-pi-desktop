import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  acpPermissionOutcome,
  judgePublishAdmission,
  mapAcpToAdapterError,
  acpSignedOutDetail,
} from "./AcpAdapterSupport.ts";
import type { ProviderSendTurnAdmission } from "../Services/ProviderAdapter.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  it("maps ACP process exits without stderr to a process error instead of a closed session", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/start",
      new EffectAcpErrors.AcpProcessExitedError({ code: 1 }),
    );

    expect(error._tag).toBe("ProviderAdapterProcessError");
    expect(error.message).not.toContain("adapter thread is closed");
    if (error._tag === "ProviderAdapterProcessError") {
      expect(error.detail).toBe("ACP process exited with code 1");
    }
  });

  it("maps ACP process exits to a process error whose detail includes stderr", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/start",
      new EffectAcpErrors.AcpProcessExitedError({
        code: 1,
        stderr:
          "Invalid project config at ~/.cursor/cli.json: schema validation failed. Unrecognized key(s): 'approvalMode', 'sandbox'",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterProcessError");
    expect(error.message).toContain("cli.json");
    expect(error.message).toContain("Unrecognized key");
    expect(error.message).not.toContain("adapter thread is closed");
    if (error._tag === "ProviderAdapterProcessError") {
      expect(error.detail).toContain("Unrecognized key(s): 'approvalMode', 'sandbox'");
    }
  });
});

describe("judgePublishAdmission", () => {
  const context = { stale: false, sessionGeneration: 7, nativeSessionId: "native-1" };

  // `verdict` may return a non-boolean to exercise the `=== true` guard.
  function recordingAdmission(verdict: () => unknown) {
    const observed: unknown[] = [];
    const admission: ProviderSendTurnAdmission = {
      admit: (value) => {
        observed.push(value);
        return verdict() as boolean;
      },
    };
    return { observed, admission };
  }

  it("publishes without a caller admission, even for a stale context", () => {
    expect(judgePublishAdmission(undefined, context)).toBe(true);
    expect(judgePublishAdmission(undefined, { ...context, stale: true })).toBe(true);
  });

  it("refuses a stale context without consulting the admission", () => {
    const { observed, admission } = recordingAdmission(() => true);
    expect(judgePublishAdmission(admission, { ...context, stale: true })).toBe(false);
    expect(observed).toHaveLength(0);
  });

  it("refuses when the admission throws", () => {
    const { admission } = recordingAdmission(() => {
      throw new Error("gate failed");
    });
    expect(judgePublishAdmission(admission, context)).toBe(false);
  });

  it("refuses when the admission does not return exactly true", () => {
    const { admission } = recordingAdmission(() => "yes");
    expect(judgePublishAdmission(admission, context)).toBe(false);
    const { admission: falsy } = recordingAdmission(() => false);
    expect(judgePublishAdmission(falsy, context)).toBe(false);
  });

  it("publishes when the admission returns true, passing the session identity through", () => {
    const { observed, admission } = recordingAdmission(() => true);
    expect(judgePublishAdmission(admission, context)).toBe(true);
    expect(observed).toEqual([{ sessionGeneration: 7, nativeSessionId: "native-1" }]);
  });
});

describe("acpSignedOutDetail", () => {
  const authRequired = "Authentication required: Run `mcode login` and try again.";

  it("names the agent's own sign-in command when the session reports it is signed out", () => {
    expect(acpSignedOutDetail(authRequired, "MiniMax Code", "mcode login --region global")).toBe(
      "MiniMax Code is signed out. Run `mcode login --region global` in a terminal, then try again.",
    );
  });

  it("keeps every other error, and agents without a sign-in command, unchanged", () => {
    expect(
      acpSignedOutDetail("Process exited", "MiniMax Code", "mcode login --region global"),
    ).toBe("Process exited");
    expect(acpSignedOutDetail(authRequired, "Grok", undefined)).toBe(authRequired);
  });
});
