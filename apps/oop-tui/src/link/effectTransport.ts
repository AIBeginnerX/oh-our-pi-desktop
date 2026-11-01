import {
  AuthStandardClientScopes,
  type AuthClientPresentationMetadata,
  type ClientOrchestrationCommand,
  type ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_WS_METHODS,
  ProviderInstanceId,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  bootstrapRemoteBearerSession,
  resolveRemoteWebSocketConnectionUrl,
} from "@t3tools/client-runtime/authorization";
import {
  deriveWsBaseUrl,
  fetchRemoteEnvironmentDescriptor,
  normalizeHttpBaseUrl,
} from "@t3tools/client-runtime/environment";
import {
  type ConnectionAttemptError,
  PrimaryConnectionTarget,
  type PreparedConnection,
  mapRemoteEnvironmentError,
  orchestrationProtocolCompatibilityError,
} from "@t3tools/client-runtime/connection";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { fetchEnvironmentThreadSnapshot } from "@t3tools/client-runtime/state/thread-snapshot-http";
import { layerWithOptions, RpcSessionFactory } from "@t3tools/client-runtime/rpc/session";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

import {
  CommandRejectedError,
  type StreamHandlers,
  type Transport,
  type TransportSession,
  TransportError,
} from "./transport.ts";
import { t } from "../i18n/index.ts";

const fetchFn: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);

const httpLayer = remoteHttpClientLayer(fetchFn);
const socketLayer = Layer.mergeAll(httpLayer, Socket.layerWebSocketConstructorGlobal);
const sessionLayer = layerWithOptions({}).pipe(Layer.provide(socketLayer));

const describeCause = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : t("link.unknownError");

const toTransportError = (error: ConnectionAttemptError): TransportError =>
  new TransportError(
    error._tag === "ConnectionBlockedError" ? "blocked" : "transient",
    error.detail,
    error._tag === "ConnectionBlockedError" ? error.reason : null,
  );

/** The typed connection failure inside a cause, as the error to throw; anything else is transient. */
const failureOf = (cause: Cause.Cause<unknown>): TransportError => {
  const failure = cause.reasons.find((reason) => reason._tag === "Fail");
  const typed = failure?._tag === "Fail" ? (failure.error as ConnectionAttemptError) : null;
  return typed !== null && typeof typed === "object" && "_tag" in typed
    ? toTransportError(typed)
    : new TransportError("transient", describeCause(cause));
};

export interface OopClientIdentity {
  readonly label: string;
  readonly os: string;
  readonly appVersion: string;
}

export const clientMetadata = (identity: OopClientIdentity): AuthClientPresentationMetadata => ({
  label: identity.label,
  deviceType: "desktop",
  os: identity.os,
  surface: "cli",
  appVersion: identity.appVersion,
});

const withProtocol = (socketUrl: string): string => {
  const url = new URL(socketUrl);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
};

export const probeEnvironment = (
  httpBaseUrl: string,
): Promise<ExecutionEnvironmentDescriptor | null> =>
  Effect.runPromise(
    fetchRemoteEnvironmentDescriptor({ httpBaseUrl, timeoutMs: 3000 }).pipe(
      Effect.provide(httpLayer),
      Effect.match({ onFailure: () => null, onSuccess: (descriptor) => descriptor }),
    ),
  );

/**
 * Opens WebSocket sessions to one server with a saved bearer token. `locateOrigin`, when set, is
 * asked for the address before every connection and ahead of any request that carries the token;
 * its answer replaces `httpBaseUrl`, and a TransportError it throws refuses the attempt.
 */
export const makeEffectTransport = (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly identity: OopClientIdentity;
  readonly locateOrigin: (() => Promise<string>) | undefined;
}): Transport => {
  const open = async (): Promise<TransportSession> => {
    const httpBaseUrl = normalizeHttpBaseUrl(
      input.locateOrigin !== undefined ? await input.locateOrigin() : input.httpBaseUrl,
    );
    const wsBaseUrl = deriveWsBaseUrl(httpBaseUrl);
    const scope = await Effect.runPromise(Scope.make());
    const abort = new AbortController();
    const shutdown = () => Effect.runPromise(Scope.close(scope, Exit.void));

    const connect = Effect.gen(function* () {
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
        Effect.mapError((error) => mapRemoteEnvironmentError(error)),
      );
      const incompatible = orchestrationProtocolCompatibilityError(descriptor);
      if (incompatible !== null) return yield* incompatible;
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl,
        httpBaseUrl,
        bearerToken: input.bearerToken,
        clientMetadata: clientMetadata(input.identity),
        connectionMethod: "direct",
      }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
      const prepared: PreparedConnection = {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl,
        socketUrl: withProtocol(socketUrl),
        httpAuthorization: { _tag: "Bearer", token: input.bearerToken },
        target: new PrimaryConnectionTarget({
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          httpBaseUrl,
          wsBaseUrl,
        }),
      };
      const factory = yield* RpcSessionFactory;
      const session = yield* factory.connect(prepared);
      yield* session.ready;
      const config = yield* session.initialConfig;
      return { session, config, prepared };
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provide(Layer.merge(sessionLayer, httpLayer)),
    );

    const exit = await Effect.runPromiseExit(connect);
    if (Exit.isFailure(exit)) {
      await shutdown().catch(() => undefined);
      throw failureOf(exit.cause);
    }
    const { session, config, prepared } = exit.value;

    const closed = Effect.runPromise(
      session.closed.pipe(
        Effect.match({
          onFailure: (error) => error.detail,
          onSuccess: () => t("link.connectionClosed"),
        }),
      ),
      { signal: abort.signal },
    ).catch(() => t("link.connectionClosed"));

    const subscribe = <Item, E>(stream: Stream.Stream<Item, E>, handlers: StreamHandlers<Item>) => {
      const cancelled = new AbortController();
      Effect.runPromise(
        stream.pipe(Stream.runForEach((item) => Effect.sync(() => handlers.onItem(item)))),
        { signal: cancelled.signal },
      ).then(
        () => {
          if (!cancelled.signal.aborted) handlers.onEnd(null);
        },
        (cause: unknown) => {
          if (!cancelled.signal.aborted)
            handlers.onEnd(describeError(cause), isServerRejection(cause));
        },
      );
      return { cancel: () => cancelled.abort() };
    };

    // A typed refusal means the server read the request and said no; anything else is unknown.
    const call = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
      Effect.runPromise(effect, { signal: abort.signal }).catch((cause: unknown) => {
        throw isCommandRejection(cause)
          ? new CommandRejectedError(describeError(cause))
          : new Error(describeError(cause));
      });

    return {
      config,
      closed,
      subscribeShell: (shellInput, handlers) =>
        subscribe(session.client[ORCHESTRATION_WS_METHODS.subscribeShell](shellInput), handlers),
      subscribeThread: (threadInput, handlers) =>
        subscribe(session.client[ORCHESTRATION_WS_METHODS.subscribeThread](threadInput), handlers),
      subscribeConfig: (handlers) => subscribe(session.subscribeServerConfig({}), handlers),
      dispatch: async (command: ClientOrchestrationCommand) => {
        await call(
          session.client[ORCHESTRATION_WS_METHODS.dispatchCommand](command).pipe(Effect.asVoid),
        );
      },
      getSettings: () => call(session.client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) => call(session.client[WS_METHODS.serverUpdateSettings]({ patch })),
      refreshProviders: async (refresh) => {
        const result = await call(
          session.client[WS_METHODS.serverRefreshProviders]({
            ...(refresh?.instanceId !== undefined
              ? { instanceId: ProviderInstanceId.make(refresh.instanceId) }
              : {}),
            ...(refresh?.cwd !== undefined ? { cwd: refresh.cwd } : {}),
            ...(refresh?.refreshModels === true ? { refreshModels: true } : {}),
          }),
        );
        return result.providers;
      },
      loadOlderTurns: (page) =>
        call(
          fetchEnvironmentThreadSnapshot({
            prepared,
            threadId: page.threadId,
            signer: Option.none(),
            window: { turnLimit: page.turnLimit, beforeCursor: page.beforeCursor },
          }).pipe(Effect.provide(httpLayer)),
        ),
      retryCrewTask: async (retry) => {
        await call(
          session.client[WS_METHODS.crewRetryTask]({
            leadThreadId: retry.leadThreadId,
            taskId: retry.taskId,
          }).pipe(Effect.asVoid),
        );
      },
      // The desktop app reads a turn the same way: the first turn from the thread's start, the
      // others between two checkpoints.
      getCheckpointDiff: async (range) => {
        if (range.fromTurnCount === 0) {
          const result = await call(
            session.client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
              threadId: range.threadId,
              toTurnCount: range.toTurnCount,
            }),
          );
          return result.diff;
        }
        const result = await call(
          session.client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
            threadId: range.threadId,
            fromTurnCount: range.fromTurnCount,
            toTurnCount: range.toTurnCount,
          }),
        );
        return result.diff;
      },
      close: async () => {
        abort.abort();
        await shutdown().catch(() => undefined);
      },
    };
  };

  return { open };
};

/** The server answered a subscription with its own typed error, e.g. a thread that does not exist. */
const isServerRejection = (cause: unknown): boolean =>
  cause !== null &&
  typeof cause === "object" &&
  "_tag" in cause &&
  cause._tag === "OrchestrationGetSnapshotError";

/** The server answered a command with one of its own typed errors, so it did read and refuse it. */
const isCommandRejection = (cause: unknown): boolean =>
  cause !== null &&
  typeof cause === "object" &&
  "_tag" in cause &&
  (cause._tag === "OrchestrationDispatchCommandError" ||
    cause._tag === "EnvironmentAuthorizationError" ||
    cause._tag === "ServerSettingsError" ||
    cause._tag === "ProviderSetupError" ||
    cause._tag === "CrewRetryTaskError" ||
    isDiffRejection(cause));

const isDiffRejection = (cause: unknown): boolean =>
  cause !== null &&
  typeof cause === "object" &&
  "_tag" in cause &&
  (cause._tag === "OrchestrationGetTurnDiffError" ||
    cause._tag === "OrchestrationGetFullThreadDiffError");

const describeError = (cause: unknown): string => {
  if (cause !== null && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      // The server words a failed diff in general terms and keeps the reason (a missing checkpoint,
      // a folder that is not a repository) in the cause.
      const inner = (cause as { cause?: unknown }).cause;
      const reason =
        isDiffRejection(cause) && inner !== null && typeof inner === "object" && "message" in inner
          ? (inner as { message: unknown }).message
          : null;
      return typeof reason === "string" && reason.length > 0 ? `${message}: ${reason}` : message;
    }
  }
  return describeCause(cause);
};

export interface PairingResult {
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly token: string;
}

/** Trades a one-time pairing token for a bearer token. The token is the only thing returned that is secret. */
export const exchangePairingToken = async (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly identity: OopClientIdentity;
}): Promise<PairingResult> => {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const httpBaseUrl = normalizeHttpBaseUrl(input.httpBaseUrl);
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
        Effect.mapError((error) => mapRemoteEnvironmentError(error)),
      );
      const incompatible = orchestrationProtocolCompatibilityError(descriptor);
      if (incompatible !== null) return yield* incompatible;
      const access = yield* bootstrapRemoteBearerSession({
        httpBaseUrl,
        credential: input.credential,
        scopes: AuthStandardClientScopes,
        clientMetadata: clientMetadata(input.identity),
      }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl,
        token: access.access_token,
      } satisfies PairingResult;
    }).pipe(Effect.provide(httpLayer)),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  throw failureOf(exit.cause);
};
