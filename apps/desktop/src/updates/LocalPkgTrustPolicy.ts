import * as Schema from "effect/Schema";

/**
 * The publisher trust policy and its build-time marker. This module imports only
 * `effect/Schema` because the runtime, `vite.config.ts` and the artifact builder
 * all share it: one schema decides what a policy is, and one encoding is
 * compiled into the main bundle and scanned for again in the staged copy.
 */

const LegacyUnsignedPolicy = Schema.Struct({ mode: Schema.Literal("legacy-unsigned") });
const DeveloperIdPolicy = Schema.Struct({
  mode: Schema.Literal("developer-id"),
  /** Expected Team ID. Metadata for policy and release checks; never read back from tool output. */
  teamId: Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/)),
  /** SHA256 fingerprints of the accepted `Developer ID Installer` leaf certificates. */
  leafPins: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))).check(
    Schema.isLengthBetween(1, 3),
  ),
});

/**
 * `legacy-unsigned` checks nothing beyond the manifest hash (every build so
 * far); `developer-id` requires the pinned Installer leaf and notarization.
 */
export const TrustPolicy = Schema.Union([LegacyUnsignedPolicy, DeveloperIdPolicy]);
export type TrustPolicy = typeof TrustPolicy.Type;
export type DeveloperIdTrustPolicy = typeof DeveloperIdPolicy.Type;

export const LEGACY_UNSIGNED_POLICY: TrustPolicy = { mode: "legacy-unsigned" };

const decodePolicy = Schema.decodeUnknownOption(TrustPolicy, { onExcessProperty: "error" });

/** The policy, or `undefined` for anything malformed (excess fields and duplicate pins included). */
export const parseTrustPolicy = (raw: unknown): TrustPolicy | undefined => {
  const decoded = decodePolicy(raw);
  if (decoded._tag === "None") return undefined;
  const policy = decoded.value;
  return policy.mode === "developer-id" && new Set(policy.leafPins).size !== policy.leafPins.length
    ? undefined
    : policy;
};

/**
 * The marker is the one string compiled into the main bundle, written as
 * `<tag>:legacy-unsigned` or `<tag>:developer-id:<TEAMID>:<pin>[,<pin>[,<pin>]]`.
 * It has no quotes or backslashes, so any bundler emits it byte for byte and the
 * scan can find it. The tag is never written with its colon as one literal in
 * code: the scan would match that literal inside the bundle as a marker.
 */
const MARKER_TAG = "OOP_LOCAL_PKG_TRUST_V1";
const MARKER_BODY = "[A-Za-z0-9:,-]*";

export const encodeTrustPolicyMarker = (policy: TrustPolicy): string =>
  policy.mode === "legacy-unsigned"
    ? [MARKER_TAG, policy.mode].join(":")
    : [MARKER_TAG, policy.mode, policy.teamId, policy.leafPins.join(",")].join(":");

/** Only a canonical marker decodes: re-encoding the policy must give back the exact input. */
export const decodeTrustPolicyMarker = (marker: string): TrustPolicy | undefined => {
  const [tag, mode, teamId, pins] = marker.split(":");
  if (tag !== MARKER_TAG) return undefined;
  const policy = parseTrustPolicy(
    mode === "developer-id" ? { mode, teamId, leafPins: pins?.split(",") } : { mode },
  );
  return policy !== undefined && encodeTrustPolicyMarker(policy) === marker ? policy : undefined;
};

/** Every marker-shaped string in `source`, in order and with repeats. */
export const findTrustPolicyMarkers = (source: string): string[] =>
  source.match(new RegExp([MARKER_TAG, MARKER_BODY].join(":"), "g")) ?? [];

/**
 * Build-time only: the artifact builder sets it for `vp run build:desktop` and
 * `vite.config.ts` reads it. Its value is the marker itself. Nothing at runtime
 * reads it.
 */
export const LOCAL_PKG_TRUST_BUILD_ENV = "OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST";

/** Absent or empty means every build so far (`legacy-unsigned`); anything else must be a canonical marker. */
export const resolveBuildTrustMarker = (value: string | undefined): string => {
  if (value === undefined || value === "") return encodeTrustPolicyMarker(LEGACY_UNSIGNED_POLICY);
  if (decodeTrustPolicyMarker(value) === undefined) {
    throw new Error(`${LOCAL_PKG_TRUST_BUILD_ENV} is not a valid local package trust marker.`);
  }
  return value;
};
