import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "device" | "pull-requests" | "crew" | "memory" | "threads";

export interface McpClientCaller {
  readonly sessionId: string;
  readonly label: string;
  /** Read only, or the most the threads it starts or changes may run with. */
  readonly access: AuthMcpClientAccess;
}

/**
 * The runtime mode a client caller's writes are capped at. A read-only client
 * never reaches a write, so it maps to the lowest mode rather than to nothing.
 */
export const clientRuntimeModeCeiling = (client: McpClientCaller | undefined): RuntimeMode =>
  client === undefined || client.access === "read-only" ? "approval-required" : client.access;

export interface McpThreadInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export interface McpClientInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly client: McpClientCaller;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export type McpInvocationScope = McpThreadInvocationScope | McpClientInvocationScope;

export const isMcpThreadInvocationScope = (
  scope: McpInvocationScope,
): scope is McpThreadInvocationScope => "threadId" in scope;

export const isMcpClientInvocationScope = (
  scope: McpInvocationScope,
): scope is McpClientInvocationScope => "client" in scope;

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/** The error a missing capability surfaces as; preview keeps its own so the broker can route it. */
export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = isMcpThreadInvocationScope(invocation)
    ? {
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      }
    : {
        environmentId: invocation.environmentId,
      };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpThreadInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation): invocation is McpThreadInvocationScope =>
        isMcpThreadInvocationScope(invocation) && invocation.capabilities.has(capability),
      // The conditional type narrows what the literal argument decided at runtime.
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );
