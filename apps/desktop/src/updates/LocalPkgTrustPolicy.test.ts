import { describe, expect, it } from "vite-plus/test";

import {
  LEGACY_UNSIGNED_POLICY,
  decodeTrustPolicyMarker,
  encodeTrustPolicyMarker,
  findTrustPolicyMarkers,
  parseTrustPolicy,
  resolveBuildTrustMarker,
  type TrustPolicy,
} from "./LocalPkgTrustPolicy.ts";

const TEAM_ID = "ABCDE12345";
const pin = (digit: string) => digit.repeat(64);
const marker = (pins: ReadonlyArray<string>) =>
  `OOP_LOCAL_PKG_TRUST_V1:developer-id:${TEAM_ID}:${pins.join(",")}`;

describe("LocalPkgTrustPolicy", () => {
  it("round trips legacy and developer-id policies with one or three pins", () => {
    const policies: Array<TrustPolicy> = [
      LEGACY_UNSIGNED_POLICY,
      { mode: "developer-id", teamId: TEAM_ID, leafPins: [pin("a")] },
      {
        mode: "developer-id",
        teamId: TEAM_ID,
        leafPins: [pin("a"), pin("b"), pin("c")],
      },
    ];

    for (const policy of policies) {
      const encoded = encodeTrustPolicyMarker(policy);
      expect(decodeTrustPolicyMarker(encoded)).toEqual(policy);
    }
  });

  it("rejects malformed policies and non-canonical markers", () => {
    for (const pins of [[], [pin("a"), pin("b"), pin("c"), pin("d")], [pin("a"), pin("a")]]) {
      expect(
        parseTrustPolicy({ mode: "developer-id", teamId: TEAM_ID, leafPins: pins }),
      ).toBeUndefined();
    }
    expect(
      parseTrustPolicy({ mode: "developer-id", teamId: TEAM_ID, leafPins: [pin("A")] }),
    ).toBeUndefined();
    expect(
      parseTrustPolicy({ mode: "developer-id", teamId: TEAM_ID, leafPins: ["a".repeat(63)] }),
    ).toBeUndefined();
    expect(
      parseTrustPolicy({ mode: "developer-id", teamId: "bad", leafPins: [pin("a")] }),
    ).toBeUndefined();
    expect(
      parseTrustPolicy({
        mode: "developer-id",
        teamId: TEAM_ID,
        leafPins: [pin("a")],
        extra: true,
      }),
    ).toBeUndefined();

    const valid = marker([pin("a")]);
    for (const invalid of [
      "",
      "OOP_LOCAL_PKG_TRUST_V1:",
      "OOP_LOCAL_PKG_TRUST_V1:legacy-unsigned:",
      valid.replace(":developer-id:", ":Developer-id:"),
      valid.replace(`:${pin("a")}`, `:${pin("a")} `),
      valid.replace(`:${pin("a")}`, `:${pin("a")}:`),
      marker([pin("a"), ""]),
      valid.replace("OOP_LOCAL_PKG_TRUST_V1", "OTHER"),
      valid.replace("TRUST_V1", "TRUST_V2"),
    ]) {
      expect(decodeTrustPolicyMarker(invalid)).toBeUndefined();
    }
  });

  it("finds all marker-shaped strings, including duplicates, in source text", () => {
    const legacy = encodeTrustPolicyMarker(LEGACY_UNSIGNED_POLICY);
    const candidate = marker([pin("a"), pin("b")]);
    expect(
      findTrustPolicyMarkers(`before ${legacy} middle ${candidate} again ${legacy} after`),
    ).toEqual([legacy, candidate, legacy]);
    expect(findTrustPolicyMarkers("no marker here")).toEqual([]);
  });

  it("resolves an absent or empty build value to legacy and rejects malformed input safely", () => {
    const legacy = encodeTrustPolicyMarker(LEGACY_UNSIGNED_POLICY);
    expect(resolveBuildTrustMarker(undefined)).toBe(legacy);
    expect(resolveBuildTrustMarker("")).toBe(legacy);

    const sensitive = pin("a");
    let thrown: unknown;
    try {
      resolveBuildTrustMarker(`invalid:${sensitive}`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(sensitive);
  });
});
