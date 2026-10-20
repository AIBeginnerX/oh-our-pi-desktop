import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { LocalPkgUpdateError } from "./LocalPkgUpdateError.ts";
import {
  decodeTrustPolicy,
  verifyBinding,
  verifyPublisher,
  type TrustPolicy,
} from "./LocalPkgTrust.ts";
import { LEGACY_UNSIGNED_POLICY, decodeTrustPolicyMarker } from "./LocalPkgTrustPolicy.ts";

declare const __OOP_BUILD_LOCAL_PKG_TRUST__: string | undefined;

/**
 * The publisher trust policy bundled with this app. It is a build-time constant
 * on purpose: the bundler replaces `__OOP_BUILD_LOCAL_PKG_TRUST__` with the
 * marker string, so no config file, environment variable, update feed or
 * userData value can select or relax it at runtime, and it is independent of the
 * build profile. Every build that sets nothing is explicitly `legacy-unsigned`,
 * which is today's behavior (the manifest hash only). Unbundled source has no
 * define and is also `legacy-unsigned`; the artifact builder proves that every
 * packaged `main.cjs` carries only the marker it expects.
 *
 * A `developer-id` policy is valid for `LocalPkgTrust` itself but is not
 * admitted at runtime yet: the publisher and release-binding checks have not
 * run against a real signed, notarized package. Until activation is approved
 * on that evidence, a `developer-id` policy fails as `config-invalid` like a
 * malformed one.
 */
export const EMBEDDED_LOCAL_PKG_TRUST_POLICY: unknown =
  typeof __OOP_BUILD_LOCAL_PKG_TRUST__ === "undefined"
    ? LEGACY_UNSIGNED_POLICY
    : decodeTrustPolicyMarker(__OOP_BUILD_LOCAL_PKG_TRUST__);

/** Decodes a raw policy and applies the runtime admission rule; there is no fallback policy. */
export const loadRuntimeTrustPolicy = (
  raw: unknown,
): Effect.Effect<TrustPolicy, LocalPkgUpdateError> =>
  decodeTrustPolicy(raw).pipe(
    Effect.flatMap((policy) =>
      policy.mode === "developer-id"
        ? Effect.fail(new LocalPkgUpdateError({ reason: "config-invalid" }))
        : Effect.succeed<TrustPolicy>(policy),
    ),
  );

export const loadEmbeddedTrustPolicy: Effect.Effect<TrustPolicy, LocalPkgUpdateError> =
  Effect.suspend(() => loadRuntimeTrustPolicy(EMBEDDED_LOCAL_PKG_TRUST_POLICY));

/**
 * What DesktopUpdates uses to load the policy and verify a staged package.
 * Production never provides it, so the defaults (the embedded policy and the
 * real checks) always apply; tests provide a value to inject failures at the
 * same composition point.
 */
export class LocalPkgTrustRuntime extends Context.Reference<{
  readonly loadPolicy: Effect.Effect<TrustPolicy, LocalPkgUpdateError>;
  readonly verifyPublisher: typeof verifyPublisher;
  readonly verifyBinding: typeof verifyBinding;
}>("@t3tools/desktop/updates/LocalPkgTrustRuntime", {
  defaultValue: () => ({ loadPolicy: loadEmbeddedTrustPolicy, verifyPublisher, verifyBinding }),
}) {}
