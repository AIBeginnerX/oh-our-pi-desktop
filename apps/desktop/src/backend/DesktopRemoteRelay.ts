import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import type {
  AdvertisedEndpoint,
  AdvertisedEndpointProvider,
  DesktopRemoteRelayState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import { startRemoteRelayTunnel } from "./remoteRelayTunnel.ts";

const RELAY_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "cloudflare-relay",
  label: "Cloudflare relay",
  kind: "tunnel",
  isAddon: false,
};

const RemoteRelayDocument = Schema.Struct({
  url: Schema.NullOr(Schema.String),
  secret: Schema.String,
});
type RemoteRelayDocument = typeof RemoteRelayDocument.Type;
const RemoteRelayJson = Schema.fromJsonString(RemoteRelayDocument);
const decodeRemoteRelayJson = Schema.decodeEffect(RemoteRelayJson);
const encodeRemoteRelayJson = Schema.encodeEffect(RemoteRelayJson);

export class DesktopRemoteRelayUrlError extends Schema.TaggedError<DesktopRemoteRelayUrlError>()(
  "DesktopRemoteRelayUrlError",
  { url: Schema.String },
) {
  override get message(): string {
    return "The relay address must be an https:// URL, such as https://oop-relay.you.workers.dev.";
  }
}

export class DesktopRemoteRelayPersistenceError extends Schema.TaggedError<DesktopRemoteRelayPersistenceError>()(
  "DesktopRemoteRelayPersistenceError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to save the relay settings at ${this.path}.`;
  }
}

/** Accepts the relay's https origin; plain http only for a relay running on this machine. */
export function normalizeRelayUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!URL.canParse(trimmed)) return undefined;
  const url = new URL(trimmed);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) return undefined;
  return url.origin;
}

function generateRelaySecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class DesktopRemoteRelay extends Context.Service<
  DesktopRemoteRelay,
  {
    readonly getState: Effect.Effect<DesktopRemoteRelayState>;
    readonly setUrl: (
      url: string | null,
    ) => Effect.Effect<
      DesktopRemoteRelayState,
      DesktopRemoteRelayUrlError | DesktopRemoteRelayPersistenceError
    >;
    readonly getAdvertisedEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
  }
>()("@t3tools/desktop/backend/DesktopRemoteRelay") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const documentPath = environment.path.join(environment.stateDir, "remote-relay.json");

  const storedDocument = yield* fileSystem
    .readFileString(documentPath)
    .pipe(Effect.flatMap(decodeRemoteRelayJson), Effect.option);
  const documentRef = yield* Ref.make<RemoteRelayDocument>(
    Option.getOrElse(storedDocument, () => ({ url: null, secret: generateRelaySecret() })),
  );
  const connectedRef = yield* Ref.make(false);
  const tunnelRef = yield* Ref.make(Option.none<{ readonly stop: () => void }>());

  const writeDocument = (document: RemoteRelayDocument) =>
    Effect.gen(function* () {
      const encoded = yield* encodeRemoteRelayJson(document);
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(documentPath, `${encoded}\n`);
      // The secret lets anyone attach a desktop to the relay, so keep it private to this user.
      yield* fileSystem.chmod(documentPath, 0o600);
    }).pipe(
      Effect.mapError(
        (cause) => new DesktopRemoteRelayPersistenceError({ path: documentPath, cause }),
      ),
    );

  const stopTunnel = Effect.gen(function* () {
    const tunnel = yield* Ref.getAndSet(tunnelRef, Option.none());
    if (Option.isSome(tunnel)) tunnel.value.stop();
    yield* Ref.set(connectedRef, false);
  });

  // The relay forwards to the backend, so it only runs while the backend accepts paired network
  // clients; in local-only mode pairing tokens are refused anyway.
  const startTunnel = (settings: DesktopAppSettings.DesktopSettings) =>
    Effect.gen(function* () {
      yield* stopTunnel;
      const document = yield* Ref.get(documentRef);
      if (document.url === null || settings.serverExposureMode !== "network-accessible") return;
      const tunnel = startRemoteRelayTunnel({
        relayUrl: document.url,
        secret: document.secret,
        backendPort: () => Effect.runSync(serverExposure.backendConfig).port,
        onConnectedChange: (connected) => Effect.runSync(Ref.set(connectedRef, connected)),
      });
      yield* Ref.set(tunnelRef, Option.some(tunnel));
    });

  // The secret is shown for the user to store on the relay before any address is saved, so a
  // fresh one must survive restarts or it would stop matching the relay.
  if (Option.isNone(storedDocument)) {
    yield* writeDocument(yield* Ref.get(documentRef)).pipe(
      Effect.catch((error) => Effect.logWarning("Failed to save the relay secret", { error })),
    );
  }

  yield* Effect.addFinalizer(() => stopTunnel);
  // Settings are loaded after layers build, so read them from disk rather than `get`.
  yield* desktopSettings.load.pipe(
    Effect.flatMap(startTunnel),
    Effect.catchCause((cause) => Effect.logWarning("Remote relay failed to start", { cause })),
    Effect.forkScoped,
  );

  const getState = Effect.gen(function* () {
    const document = yield* Ref.get(documentRef);
    return {
      url: document.url,
      secret: document.secret,
      connected: yield* Ref.get(connectedRef),
    } satisfies DesktopRemoteRelayState;
  });

  const setUrl = Effect.fn("desktop.remoteRelay.setUrl")(function* (rawUrl: string | null) {
    const url = rawUrl === null ? null : normalizeRelayUrl(rawUrl);
    if (url === undefined) return yield* new DesktopRemoteRelayUrlError({ url: rawUrl ?? "" });
    const nextDocument = { ...(yield* Ref.get(documentRef)), url };
    yield* writeDocument(nextDocument);
    yield* Ref.set(documentRef, nextDocument);
    yield* startTunnel(yield* desktopSettings.get);
    return yield* getState;
  });

  const getAdvertisedEndpoints = Effect.gen(function* () {
    const { url } = yield* Ref.get(documentRef);
    if (url === null) return [];
    const connected = yield* Ref.get(connectedRef);
    return [
      createAdvertisedEndpoint({
        provider: RELAY_ENDPOINT_PROVIDER,
        source: "desktop-core",
        id: `relay:${url}`,
        label: "Cloudflare relay",
        httpBaseUrl: url,
        reachability: "public",
        hostedHttpsCompatibility: "unknown",
        status: connected ? "available" : "unknown",
        description: connected
          ? "Reachable from anywhere through your Cloudflare relay."
          : "This computer is not connected to the relay right now.",
      }),
    ];
  });

  return DesktopRemoteRelay.of({ getState, setUrl, getAdvertisedEndpoints });
});

export const layer = Layer.effect(DesktopRemoteRelay, make);
