import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  SshConnectionProfile,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  GatewayConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  connectionCatalogDisplayUrl,
  connectionStatusText,
  connectionStatusTitle,
  environmentMcpUrl,
  presentEnvironmentConnection,
  presentConnectionState,
} from "./presentation.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
  ),
  enabled: true,
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("labels a blocked protocol as unsupported", () => {
    const connection = presentConnectionState(
      supervisorState({
        phase: "blocked",
        lastFailure: new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Update your app.",
        }),
      }),
    );
    expect(connection.phase).toBe("unsupported");
    expect(connection.error).toBe("Update your app.");
    expect(connectionStatusText(connection)).toBe("Client not supported");
  });

  it("preserves profile display information without exposing credentials", () => {
    expect(connectionCatalogDisplayUrl(ENTRY)).toBe("https://environment.example.test");
  });

  it("derives the MCP address from HTTP and HTTPS environment addresses", () => {
    const withBase = (httpBaseUrl: string): ConnectionCatalogEntry => ({
      ...ENTRY,
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: TARGET.connectionId,
          environmentId: TARGET.environmentId,
          label: TARGET.label,
          httpBaseUrl,
          wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
        }),
      ),
    });

    expect(environmentMcpUrl({ entry: ENTRY })).toBe("https://environment.example.test/mcp");
    expect(environmentMcpUrl({ entry: withBase("http://127.0.0.1:3773/") })).toBe(
      "http://127.0.0.1:3773/mcp",
    );
    expect(environmentMcpUrl({ entry: withBase("http://100.115.1.44:3773/app?x=1#top") })).toBe(
      "http://100.115.1.44:3773/mcp",
    );
    expect(
      environmentMcpUrl({
        entry: {
          target: new PrimaryConnectionTarget({
            environmentId: TARGET.environmentId,
            label: "This machine",
            httpBaseUrl: "http://localhost:3773",
            wsBaseUrl: "ws://localhost:3773",
          }),
          profile: Option.none(),
          enabled: true,
        },
      }),
    ).toBe("http://localhost:3773/mcp");
  });

  it("returns null for relay targets along with SSH and gateway environments with no direct address", () => {
    const relayEntry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: new RelayConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
      }),
      profile: Option.none(),
    };
    const sshEntry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: new SshConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        connectionId: "ssh-1",
      }),
      profile: Option.some(
        new SshConnectionProfile({
          connectionId: "ssh-1",
          environmentId: TARGET.environmentId,
          label: TARGET.label,
          target: {
            alias: "box",
            username: "dev",
            hostname: "box.example.test",
            port: 22,
          },
        }),
      ),
    };
    const gatewayEntry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: new GatewayConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        httpBaseUrl: "http://127.0.0.1:3773/gateway/environment-1",
      }),
      profile: Option.none(),
    };

    expect(environmentMcpUrl({ entry: relayEntry })).toBeNull();
    expect(environmentMcpUrl({ entry: sshEntry })).toBeNull();
    expect(environmentMcpUrl({ entry: gatewayEntry })).toBeNull();
  });

  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
      traceId: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
            traceId: "trace-previous",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Socket closed.",
      traceId: "trace-previous",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
            traceId: "trace-1",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Disconnected.",
      traceId: "trace-1",
    });
  });

  it("preserves the latest failure while the next attempt is active", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connecting",
          stage: "opening",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Relay connection timed out.",
            traceId: "trace-retry",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Relay connection timed out.",
      traceId: "trace-retry",
    });
  });

  it("combines reconnect progress with the latest failure", () => {
    const connection = {
      phase: "reconnecting",
      error: "Relay request timed out.",
      traceId: "trace-retry",
    } as const;
    expect(connectionStatusText(connection)).toBe(
      "Failed to connect. Reconnecting... Reason: Relay request timed out.",
    );
    expect(connectionStatusTitle(connection)).toBe("Failed to connect. Reconnecting...");
  });

  it("presents the supervisor's offline state without consulting shell state", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          network: "offline",
          phase: "offline",
          stage: null,
        }),
      ),
    ).toEqual({
      phase: "offline",
      error: null,
      traceId: null,
    });
  });

  it("presents a connected supervisor snapshot as connected", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connected",
          stage: null,
          generation: 1,
        }),
      ),
    ).toEqual({
      phase: "connected",
      error: null,
      traceId: null,
    });
  });

  it("preserves an explicitly available environment while offline", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          desired: false,
          network: "offline",
          phase: "available",
          stage: null,
          attempt: 0,
        }),
      ),
    ).toEqual({
      phase: "available",
      error: null,
      traceId: null,
    });
  });
});
