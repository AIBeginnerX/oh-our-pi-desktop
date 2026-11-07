import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GatewayEnvironmentStatus } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

export interface GatewayEnvironmentInfo {
  readonly status: GatewayEnvironmentStatus;
  /** The host the environment is forwarded through, for the "via <host>" hint. */
  readonly hostLabel: string;
}

/** What the host last reported about its forwarded environments; written by the platform source. */
export const gatewayEnvironmentInfoAtom = Atom.make<
  ReadonlyMap<EnvironmentId, GatewayEnvironmentInfo>
>(new Map()).pipe(Atom.withLabel("web-gateway-environment-info"));

/** Null while the host reports the environment online. */
export function gatewayStatusText(status: GatewayEnvironmentStatus | undefined): string | null {
  switch (status) {
    case "offline":
      return "Offline";
    case "auth-failed":
      return "Host cannot sign in";
    case "online":
    case undefined:
      return null;
  }
}

/** "via Studio Mac" or "via Studio Mac · Offline": the small hint beside a gateway environment. */
export function gatewayEnvironmentHint(info: GatewayEnvironmentInfo | undefined): string {
  return [`via ${info?.hostLabel ?? "host"}`, gatewayStatusText(info?.status)]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function useGatewayEnvironmentInfo(
  environmentId: EnvironmentId | null,
): GatewayEnvironmentInfo | null {
  const info = useAtomValue(gatewayEnvironmentInfoAtom);
  return environmentId === null ? null : (info.get(environmentId) ?? null);
}
