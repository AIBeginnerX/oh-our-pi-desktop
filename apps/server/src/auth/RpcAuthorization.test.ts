import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("lets a read-only token browse memories but keeps writes behind operate", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.projectMemoryList)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectMemorySearch)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectMemoryGet)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.projectMemoryCreate)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectMemoryUpdate)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectMemoryDelete)).toBe(
      AuthOrchestrationOperateScope,
    );
    // Inspecting held recovery state is a read; accepting a thread's memory
    // watermark is a user-fact write like the other memory mutations.
    expect(requiredScopeForRpcMethod(WS_METHODS.projectMemoryThreadState)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectMemoryAcknowledgeThread)).toBe(
      AuthOrchestrationOperateScope,
    );
    // Agent proposals: reading the queue is a read; deciding one is a write.
    expect(requiredScopeForRpcMethod(WS_METHODS.projectMemoryListProposals)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectMemoryApproveProposal)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectMemoryRejectProposal)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("lets a read-only token list and read inactive skill candidates but keeps writes behind operate", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.projectSkillList)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.projectSkillGet)).toBe(AuthOrchestrationReadScope);
    // Deriving a review draft reads source history only; saving it stays a write.
    expect(requiredScopeForRpcMethod(WS_METHODS.projectSkillDeriveDraft)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectSkillCreateCandidate)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectSkillRevise)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectSkillRecordJudgment)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectSkillWithdrawJudgment)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectSkillDelete)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectSkillActivate)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectSkillRetire)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("exposes lifecycle operate methods alongside inactive candidate reads and writes", () => {
    expect(
      Object.values(WS_METHODS)
        .filter((method) => method.startsWith("projectSkill."))
        .sort(),
    ).toEqual([
      "projectSkill.activate",
      "projectSkill.createCandidate",
      "projectSkill.delete",
      "projectSkill.deriveDraft",
      "projectSkill.get",
      "projectSkill.list",
      "projectSkill.recordJudgment",
      "projectSkill.retire",
      "projectSkill.revise",
      "projectSkill.withdrawJudgment",
    ]);
  });

  it("lets a read-only token read release verification but not run or cancel it", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.releaseVerificationGet)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.releaseVerificationRun)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.releaseVerificationCancel)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("lets a read-only token read owned thread result usage", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.usageGetThreadResults)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("maps every selected-checks websocket method to read or operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.selectedChecksGet)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.selectedChecksRun)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.selectedChecksCancel)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.selectedChecksResolveOwnership)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("lets a read-only token read a task result but keeps mutations behind operate", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.taskResultGet)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.taskResultSetRequirements)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.taskResultAccept)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.taskResultWithdraw)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});
