import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { OWNED_RESULT_USAGE_READ_ERROR_DETAIL, OwnedResultUsageReadError } from "./ownedUsage.ts";
import { ProjectSkillId } from "./projectSkill.ts";
import {
  WS_METHODS,
  WsProjectSkillActivateRpc,
  WsProjectSkillDeriveDraftRpc,
  WsProjectSkillRetireRpc,
  WsRpcGroup,
  WsSubscribeServerConfigRpc,
  WsUsageGetThreadResultsRpc,
} from "./rpc.ts";

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema)({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema)({});
    expect(decoded).toEqual({});
  });
});

describe("usage.getThreadResults RPC registration", () => {
  it("registers the method on WS_METHODS and WsRpcGroup", () => {
    expect(WS_METHODS.usageGetThreadResults).toBe("usage.getThreadResults");
    expect(WsUsageGetThreadResultsRpc._tag).toBe("usage.getThreadResults");
    expect(WsRpcGroup.requests.get(WS_METHODS.usageGetThreadResults)).toBe(
      WsUsageGetThreadResultsRpc,
    );
  });

  it("types payload, success, and error unions for the wire", () => {
    const threadId = ThreadId.make("thread-results-1");
    const payload = Schema.decodeSync(WsUsageGetThreadResultsRpc.payloadSchema)({ threadId });
    expect(payload).toEqual({ threadId });

    const success = Schema.decodeSync(WsUsageGetThreadResultsRpc.successSchema)({
      status: "missing-create",
      threadId,
      readThroughSequence: 0,
    });
    expect(success.status).toBe("missing-create");

    const encodedError = Schema.encodeSync(OwnedResultUsageReadError)(
      new OwnedResultUsageReadError({
        reason: "scanFailed",
        detail: OWNED_RESULT_USAGE_READ_ERROR_DETAIL,
      }),
    );
    expect(encodedError).not.toHaveProperty("cause");
    expect(Schema.decodeSync(WsUsageGetThreadResultsRpc.errorSchema)(encodedError)._tag).toBe(
      "OwnedResultUsageReadError",
    );
    expect(
      Exit.isSuccess(
        Schema.decodeUnknownExit(WsUsageGetThreadResultsRpc.errorSchema)({
          _tag: "OwnedResultUsageReadError",
          reason: "scanFailed",
          detail: "internal sqlite failure at /var/...",
        }),
      ),
    ).toBe(false);
  });
});

describe("projectSkill.deriveDraft RPC registration", () => {
  it("registers deriveDraft on WS_METHODS and WsRpcGroup", () => {
    expect(WS_METHODS.projectSkillDeriveDraft).toBe("projectSkill.deriveDraft");
    expect(WsRpcGroup.requests.get(WS_METHODS.projectSkillDeriveDraft)).toBe(
      WsProjectSkillDeriveDraftRpc,
    );
  });
});

describe("projectSkill.activate and projectSkill.retire RPC registration", () => {
  const lifecycleRef = {
    projectId: ProjectId.make("project-1"),
    skillId: ProjectSkillId.make("psk_abc12345"),
    version: 1,
    contentSha256: "d".repeat(64),
  };
  const lifecycleErrorSchemas = [
    WsProjectSkillActivateRpc.errorSchema,
    WsProjectSkillRetireRpc.errorSchema,
  ];

  it("registers both lifecycle methods on WS_METHODS and WsRpcGroup", () => {
    expect(WS_METHODS.projectSkillActivate).toBe("projectSkill.activate");
    expect(WS_METHODS.projectSkillRetire).toBe("projectSkill.retire");
    expect(WsRpcGroup.requests.get(WS_METHODS.projectSkillActivate)).toBe(
      WsProjectSkillActivateRpc,
    );
    expect(WsRpcGroup.requests.get(WS_METHODS.projectSkillRetire)).toBe(WsProjectSkillRetireRpc);
  });

  it("decodes each method's payload and enforces its lifecycle guard", () => {
    const activate = Schema.decodeSync(WsProjectSkillActivateRpc.payloadSchema)({
      ref: lifecycleRef,
      expectedStateSeq: 3,
      target: { threadId: ThreadId.make("thread-1"), scriptIds: ["lint", "typecheck"] },
    });
    expect(activate.expectedStateSeq).toBe(3);
    expect(activate.target.scriptIds).toEqual(["lint", "typecheck"]);
    const retire = Schema.decodeSync(WsProjectSkillRetireRpc.payloadSchema)({
      ref: lifecycleRef,
      expectedStateSeq: 3,
    });
    expect(retire).toEqual({ ref: lifecycleRef, expectedStateSeq: 3 });
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(WsProjectSkillActivateRpc.payloadSchema)({
          ref: lifecycleRef,
          expectedStateSeq: 3,
          target: { threadId: ThreadId.make("thread-1"), scriptIds: [] },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(WsProjectSkillRetireRpc.payloadSchema)({
          ref: lifecycleRef,
          expectedStateSeq: 1.5,
        }),
      ),
    ).toBe(true);
  });

  it("shares the transition result as both methods' success", () => {
    expect(Schema.decodeSync(WsProjectSkillActivateRpc.successSchema)({ stateSeq: 5 })).toEqual({
      stateSeq: 5,
    });
    expect(Schema.decodeSync(WsProjectSkillRetireRpc.successSchema)({ stateSeq: 0 })).toEqual({
      stateSeq: 0,
    });
    for (const successSchema of [
      WsProjectSkillActivateRpc.successSchema,
      WsProjectSkillRetireRpc.successSchema,
    ]) {
      for (const stateSeq of [undefined, null, -1, 1.5, 2 ** 53]) {
        expect(Exit.isFailure(Schema.decodeUnknownExit(successSchema)({ stateSeq }))).toBe(true);
      }
    }
  });

  it("carries rejected, not-found, store, and authorization errors on both methods", () => {
    for (const errorSchema of lifecycleErrorSchemas) {
      expect(
        Exit.isSuccess(
          Schema.decodeUnknownExit(errorSchema)({
            _tag: "ProjectSkillStoreRejectedError",
            reason: "state-changed",
          }),
        ),
      ).toBe(true);
      expect(
        Exit.isSuccess(
          Schema.decodeUnknownExit(errorSchema)({ _tag: "ProjectSkillStoreNotFoundError" }),
        ),
      ).toBe(true);
      expect(
        Exit.isSuccess(
          Schema.decodeUnknownExit(errorSchema)({
            _tag: "ProjectSkillStoreError",
            message: "project-skill store operation failed",
          }),
        ),
      ).toBe(true);
      expect(
        Exit.isSuccess(
          Schema.decodeUnknownExit(errorSchema)({
            _tag: "EnvironmentAuthorizationError",
            message: "missing scope",
            requiredScope: "orchestration:read",
          }),
        ),
      ).toBe(true);
      // The version-revision conflict error is not part of the lifecycle union.
      expect(
        Exit.isFailure(
          Schema.decodeUnknownExit(errorSchema)({
            _tag: "ProjectSkillStoreConflictError",
            currentLatestVersion: 2,
          }),
        ),
      ).toBe(true);
    }
  });
});
