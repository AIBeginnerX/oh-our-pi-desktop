import * as NodeServices from "@effect/platform-node/NodeServices";
import { ORCHESTRATION_PROTOCOL_VERSION, ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import {
  ProjectMemorySendPolicy,
  make as makeProjectMemorySendGate,
} from "../memory/ProjectMemorySendGate.ts";
import {
  ProjectSkillUsePolicy,
  projectSkillUsePolicyFrom,
} from "../skills/ProjectSkillUsePolicy.ts";
import { ProjectMemorySendLedger } from "../persistence/ProjectMemorySendLedger.ts";
import * as ServerEnvironment from "./ServerEnvironment.ts";

const isServerEnvironmentIdPersistenceError = Schema.is(
  ServerEnvironment.ServerEnvironmentIdPersistenceError,
);

const makeServerEnvironmentLayer = (baseDir: string) =>
  ServerEnvironment.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

// `driverAllowed` reads only the injected policy; the ledger is stubbed just
// to satisfy `make`'s context requirements.
const unreachableSendLedger = {
  commitDispatch: () => Effect.die("unreachable"),
  captureMutationFence: () => {
    throw new Error("unreachable");
  },
  mutationFenceHolds: () => {
    throw new Error("unreachable");
  },
  withMemoryMutation: () => {
    throw new Error("unreachable");
  },
  revalidateDispatch: () => Effect.die("unreachable"),
  settle: () => Effect.die("unreachable"),
  reconcileOtherOwners: () => Effect.die("unreachable"),
  acknowledge: () => Effect.die("unreachable"),
  affectedState: () => Effect.die("unreachable"),
} satisfies ProjectMemorySendLedger["Service"];

const emptySecretStoreLayer = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeedNone,
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
    remove: () => Effect.void,
  }),
);

const makeServerConfig = Effect.fn(function* (baseDir: string) {
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

  return {
    ...derivedPaths,
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    cwd: process.cwd(),
    baseDir,
    mode: "web",
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    port: 0,
    host: undefined,
    desktopBootstrapToken: undefined,
    staticDir: undefined,
    devUrl: undefined,
    devAllowedOrigins: [],
    noBrowser: false,
    startupPresentation: "browser",
  } satisfies ServerConfig.ServerConfig["Service"];
});

it.layer(NodeServices.layer)("ServerEnvironmentLive", (it) => {
  it.effect.each([
    { name: "missing", content: undefined },
    { name: "empty", content: "" },
    { name: "whitespace-only", content: " \t\n" },
  ])("concurrent initializers recover a $name environment id file", ({ content }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-environment-concurrent-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      yield* fileSystem.makeDirectory(serverConfig.stateDir, { recursive: true });
      if (content !== undefined) {
        yield* fileSystem.writeFileString(serverConfig.environmentIdPath, content);
      }
      const bothGenerated = yield* Deferred.make<void>();
      const bothReadEmpty = yield* Deferred.make<void>();
      const firstInitialized = yield* Deferred.make<void>();
      let remaining = 2;
      let emptyReads = 0;
      const readIdentity = Effect.gen(function* () {
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        return yield* identity.getEnvironmentId;
      }).pipe(
        Effect.tap(() => Deferred.succeed(firstInitialized, undefined)),
        Effect.provide(Layer.fresh(ServerEnvironment.identityLayer)),
        Effect.provideService(ServerConfig.ServerConfig, serverConfig),
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          readFileString: (path) =>
            fileSystem.readFileString(path).pipe(
              Effect.tap(
                Effect.fn(function* (value) {
                  if (path !== serverConfig.environmentIdPath || remaining > 0 || value.trim()) {
                    return;
                  }
                  // Both observe the empty file, but one repairs it after the other has finished.
                  if (++emptyReads === 2) {
                    yield* Deferred.succeed(bothReadEmpty, undefined);
                    yield* Deferred.await(firstInitialized);
                  } else {
                    yield* Deferred.await(bothReadEmpty);
                  }
                }),
              ),
            ),
        }),
        Effect.provideService(Crypto.Crypto, {
          ...crypto,
          randomUUIDv4: Effect.gen(function* () {
            const id = yield* crypto.randomUUIDv4;
            if (--remaining === 0) {
              yield* Deferred.succeed(bothGenerated, undefined);
            }
            yield* Deferred.await(bothGenerated);
            return id;
          }),
        }),
      );

      const [first, second] = yield* Effect.all([readIdentity, readIdentity], {
        concurrency: "unbounded",
      });
      const persisted = yield* fileSystem.readFileString(serverConfig.environmentIdPath);

      expect(first).toBe(second);
      expect(persisted.trim()).toBe(first);
    }),
  );

  it.effect("persists the environment id across service restarts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-environment-test-",
      });

      const first = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeServerEnvironmentLayer(baseDir)));
      const second = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeServerEnvironmentLayer(baseDir)));

      expect(first.environmentId).toBe(second.environmentId);
      expect(first.orchestrationProtocolVersion).toBe(ORCHESTRATION_PROTOCOL_VERSION);
      expect(second.capabilities.repositoryIdentity).toBe(true);
      expect(second.capabilities.connectionProbe).toBe(true);
      expect(second.capabilities.attachmentUploads).toBe(true);
      expect(second.capabilities.fileAttachments).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
      expect(second.capabilities.pullRequests).toBe(true);
      expect(second.capabilities.requiredWorktreeBootstrap).toBe(true);
      expect(second.capabilities.usagePriceOverrides).toBe(true);
      expect(second.capabilities.threadActiveReorder).toBe(true);
      expect(second.capabilities.threadTitleRegeneration).toBe(true);
      expect(second.capabilities.threadPullRequests).toBe(true);
      expect(second.capabilities.threadPullRequestLinking).toBe(true);
      expect(second.capabilities.agentActivityPublishing).toBe(false);
      // Storage-only tranche: management and the recovery API exist, provider sending is off.
      expect(second.capabilities.projectMemory).toEqual({
        manage: true,
        send: false,
        threadRecovery: true,
      });
      // Same version-skew contract as memory: manage plus explicit trial, and older servers
      // leave the key absent instead of advertising a partial surface.
      expect(second.capabilities.projectSkills).toEqual({
        manage: true,
        trial: true,
        generatedDraft: true,
        lifecycle: true,
        use: false,
      });
    }),
  );

  it.effect("derives the projectSkills use capability from the injected use policy", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-environment-skill-use-test-",
      });
      const claudeAgent = ProviderDriverKind.make("claudeAgent");
      const codex = ProviderDriverKind.make("codex");
      const descriptorWith = (driverKinds: ReadonlySet<ProviderDriverKind>) =>
        Effect.gen(function* () {
          const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
          return yield* serverEnvironment.getDescriptor;
        }).pipe(
          Effect.provide(
            makeServerEnvironmentLayer(baseDir).pipe(
              Layer.provide(
                Layer.succeed(ProjectSkillUsePolicy, projectSkillUsePolicyFrom(driverKinds)),
              ),
            ),
          ),
        );

      const empty = yield* descriptorWith(new Set());
      expect(empty.capabilities.projectSkills).toEqual({
        manage: true,
        trial: true,
        generatedDraft: true,
        lifecycle: true,
        use: false,
      });

      const claudeOnly = yield* descriptorWith(new Set([claudeAgent]));
      expect(claudeOnly.capabilities.projectSkills).toEqual({
        manage: true,
        trial: true,
        generatedDraft: true,
        lifecycle: true,
        use: true,
      });

      const policy = projectSkillUsePolicyFrom([claudeAgent]);
      expect(policy.enabled).toBe(true);
      expect(policy.allowsDriver(claudeAgent)).toBe(true);
      expect(policy.allowsDriver(codex)).toBe(false);
    }),
  );

  it.effect("derives the projectMemory send capability from the injected send policy", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-environment-memory-send-test-",
      });
      const claudeAgent = ProviderDriverKind.make("claudeAgent");
      const codex = ProviderDriverKind.make("codex");
      const descriptorWith = (driverKinds: ReadonlySet<ProviderDriverKind>) =>
        Effect.gen(function* () {
          const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
          return yield* serverEnvironment.getDescriptor;
        }).pipe(
          Effect.provide(
            makeServerEnvironmentLayer(baseDir).pipe(
              Layer.provide(Layer.succeed(ProjectMemorySendPolicy, { driverKinds })),
            ),
          ),
        );

      // An injected allowlist flips `send` on and advertises the kinds; the
      // restart test above already covers the default empty allowlist.
      const claudeOnly = yield* descriptorWith(new Set([claudeAgent]));
      expect(claudeOnly.capabilities.projectMemory).toEqual({
        manage: true,
        send: true,
        threadRecovery: true,
        sendDriverKinds: ["claudeAgent"],
      });

      // The capability and the gate read the same ProjectMemorySendPolicy
      // Reference, so the advertised kinds agree with admission.
      const gate = yield* makeProjectMemorySendGate.pipe(
        Effect.provideService(ProjectMemorySendPolicy, { driverKinds: new Set([claudeAgent]) }),
        Effect.provideService(ProjectMemorySendLedger, unreachableSendLedger),
      );
      expect(gate.driverAllowed(claudeAgent)).toBe(true);
      expect(gate.driverAllowed(codex)).toBe(false);

      // The wire list is sorted unique regardless of policy insertion order.
      const multiple = yield* descriptorWith(new Set([codex, claudeAgent]));
      expect(multiple.capabilities.projectMemory?.sendDriverKinds).toEqual([
        "claudeAgent",
        "codex",
      ]);
    }),
  );

  it.effect("reports agent activity publishing from the current secret state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-environment-publish-test-",
      });
      const testLayer = Layer.mergeAll(
        ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer)),
        ServerSecretStore.layer,
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

      yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        const encode = (value: string) => new TextEncoder().encode(value);

        const unlinked = yield* serverEnvironment.getDescriptor;
        expect(unlinked.capabilities.agentActivityPublishing).toBe(false);

        // The opt-in alone is not enough: without relay link credentials no
        // publish would leave this environment.
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, encode("true"));
        const withoutLink = yield* serverEnvironment.getDescriptor;
        expect(withoutLink.capabilities.agentActivityPublishing).toBe(false);

        // Empty credentials are as unconfigured as missing ones: the
        // publisher's truthiness gate skips them, so the capability must not
        // advertise publishing.
        yield* secrets.set(RELAY_URL_SECRET, encode(""));
        yield* secrets.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("credential"));
        const emptyUrl = yield* serverEnvironment.getDescriptor;
        expect(emptyUrl.capabilities.agentActivityPublishing).toBe(false);

        yield* secrets.set(RELAY_URL_SECRET, encode("https://relay.example"));
        const linked = yield* serverEnvironment.getDescriptor;
        expect(linked.capabilities.agentActivityPublishing).toBe(true);

        // The toggle changes at runtime, so the same service instance must
        // reflect a flip without a restart.
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, encode("false"));
        const disabled = yield* serverEnvironment.getDescriptor;
        expect(disabled.capabilities.agentActivityPublishing).toBe(false);
      }).pipe(Effect.provide(testLayer));
    }),
  );

  it.effect("reports the embedded app version without changing standalone server versions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-environment-desktop-update-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      yield* fileSystem.makeDirectory(serverConfig.stateDir, { recursive: true });

      const describeWith = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
        Effect.gen(function* () {
          const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
          return yield* serverEnvironment.getDescriptor;
        }).pipe(
          Effect.provide(
            ServerEnvironment.layer.pipe(
              Layer.provide(ServerSecretStore.layer),
              Layer.provide(ServerConfig.layer({ ...serverConfig, ...overrides })),
            ),
          ),
        );

      const withFd = yield* describeWith({
        mode: "desktop",
        desktopTelemetryControlFd: 5,
        desktopAppVersion: "9.8.7",
      });
      expect(withFd.serverVersion).toBe("9.8.7");
      expect(withFd.capabilities.serverSelfUpdate).toBe("desktop-managed");
      expect(withFd.capabilities.desktopAppUpdate).toBe(true);
      expect(withFd.capabilities.serverSelfUpdateProgress).toBe(true);
      expect(withFd.capabilities.serverUpdateThreadContinuation).toBe(true);

      const withoutFd = yield* describeWith({ mode: "desktop" });
      expect(withoutFd.serverVersion).toBe(packageJson.version);
      expect(withoutFd.capabilities.serverSelfUpdate).toBe("desktop-managed");
      expect(withoutFd.capabilities.desktopAppUpdate).toBeUndefined();
      expect(withoutFd.capabilities.serverSelfUpdateProgress).toBeUndefined();
      expect(withoutFd.capabilities.serverUpdateThreadContinuation).toBeUndefined();

      const web = yield* describeWith({
        mode: "web",
        desktopTelemetryControlFd: 5,
        desktopAppVersion: "9.8.7",
      });
      expect(web.serverVersion).toBe(packageJson.version);
      expect(web.capabilities.desktopAppUpdate).toBeUndefined();
    }),
  );

  it.effect("structures persisted environment id filesystem failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-environment-error-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      const environmentIdPath = serverConfig.environmentIdPath;
      const tempPath = `${environmentIdPath}.tmp`;
      const methodByOperation = {
        check: "exists",
        read: "readFileString",
        write: "writeFileString",
      } as const;

      for (const operation of ["check", "read", "write"] as const) {
        const writeAttempts: string[] = [];
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: methodByOperation[operation],
          description: "permission denied",
          pathOrDescriptor: environmentIdPath,
        });
        const failingFileSystemLayer = FileSystem.layerNoop({
          exists: () =>
            operation === "check" ? Effect.fail(cause) : Effect.succeed(operation === "read"),
          readFileString: () => Effect.fail(cause),
          makeTempFileScoped: () => Effect.succeed(tempPath),
          writeFileString: (path) => {
            writeAttempts.push(path);
            return Effect.fail(cause);
          },
        });

        const error = yield* Effect.gen(function* () {
          const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
          return yield* serverEnvironment.getDescriptor;
        }).pipe(
          Effect.provide(
            ServerEnvironment.layer.pipe(
              Layer.provide(emptySecretStoreLayer),
              Layer.provide(Layer.merge(ServerConfig.layer(serverConfig), failingFileSystemLayer)),
            ),
          ),
          Effect.flip,
        );

        expect(isServerEnvironmentIdPersistenceError(error)).toBe(true);
        if (!isServerEnvironmentIdPersistenceError(error)) {
          throw error;
        }
        expect(error.operation).toBe(operation);
        expect(error.environmentIdPath).toBe(environmentIdPath);
        expect(error.cause).toBe(cause);
        expect(error.message).toBe(
          `Server environment ID ${operation} failed at '${environmentIdPath}'.`,
        );
        expect(writeAttempts).toEqual(operation === "write" ? [tempPath] : []);
      }
    }),
  );
});
