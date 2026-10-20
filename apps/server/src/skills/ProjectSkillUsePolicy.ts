import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";

export type ProjectSkillUsePolicyValue = Readonly<{
  readonly enabled: boolean;
  readonly allowsDriver: (driverKind: ProviderDriverKind) => boolean;
}>;

/** Boot-time snapshot: driver kinds are copied into a private Set at construction. */
export const projectSkillUsePolicyFrom = (
  driverKinds: Iterable<ProviderDriverKind>,
): ProjectSkillUsePolicyValue => {
  const allowed = new Set(driverKinds);
  return Object.freeze({
    enabled: allowed.size > 0,
    allowsDriver: (driverKind: ProviderDriverKind) => allowed.has(driverKind),
  });
};

// Driver allowlist injected per build. Production default is empty;
// there is no settings or environment switch. Tests inject the real set
// through this reference so descriptor and future admission read the same
// immutable snapshot.
export const ProjectSkillUsePolicy = Context.Reference<ProjectSkillUsePolicyValue>(
  "t3/skills/ProjectSkillUsePolicy",
  {
    defaultValue: () => projectSkillUsePolicyFrom([]),
  },
);
