import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports the scoped credential context when preview capability is unavailable", () => {
  const invocation: McpInvocationContext.McpThreadInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
    expect(error.message).toContain("MCP credential does not grant the preview capability");
    expect(error.message).toContain("use a headless browser from the shell");
  });
});

it.effect("reports other missing capabilities with the neutral error", () => {
  const invocation: McpInvocationContext.McpThreadInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["preview"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("pull-requests").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({ capability: "pull-requests", threadId: invocation.threadId });

    const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
    expect(scope).toBe(invocation);
  });
});

it.effect("refuses thread-owned capabilities to a caller signed in from outside OOP", () => {
  const invocation: McpInvocationContext.McpClientInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
    capabilities: new Set(["preview", "threads"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const previewError = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(previewError).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(previewError.threadId).toBeUndefined();
    expect(previewError.message).toContain("agent running inside OOP");

    const threadsError = yield* McpInvocationContext.requireMcpCapability("threads").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(threadsError).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(threadsError.threadId).toBeUndefined();
    expect(threadsError.message).toContain("agent running inside OOP");
  });
});

it("maps clientRuntimeModeCeiling to approval-required for read-only and undefined callers", () => {
  expect(McpInvocationContext.clientRuntimeModeCeiling(undefined)).toBe("approval-required");
  expect(
    McpInvocationContext.clientRuntimeModeCeiling({
      sessionId: "s-1",
      label: "Claude Code",
      access: "read-only",
    }),
  ).toBe("approval-required");
  expect(
    McpInvocationContext.clientRuntimeModeCeiling({
      sessionId: "s-1",
      label: "Claude Code",
      access: "auto",
    }),
  ).toBe("auto");
});
