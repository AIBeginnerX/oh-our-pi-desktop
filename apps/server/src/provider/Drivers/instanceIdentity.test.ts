import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withInstanceIdentity } from "./instanceIdentity.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

const stamp = (driver: string) =>
  withInstanceIdentity({
    instanceId: ProviderInstanceId.make(driver),
    driverKind: ProviderDriverKind.make(driver),
    displayName: undefined,
    accentColor: undefined,
    continuationGroupKey: driver,
  })({} as ServerProviderDraft);

describe("withInstanceIdentity", () => {
  it("tells clients which providers can lead a crew", () => {
    expect(stamp("claudeAgent").canLeadCrew).toBe(true);
    expect(stamp("codex").canLeadCrew).toBe(true);
    expect(stamp("cursor").canLeadCrew).toBe(false);
    expect(stamp("opencode").canLeadCrew).toBe(false);
  });
});
