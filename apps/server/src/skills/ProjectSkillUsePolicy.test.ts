import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ProjectSkillUsePolicy, projectSkillUsePolicyFrom } from "./ProjectSkillUsePolicy.ts";

it("defaults to disabled with no exposed driver collection", () => {
  const policy = projectSkillUsePolicyFrom([]);
  expect(policy.enabled).toBe(false);
  expect("driverKinds" in policy).toBe(false);
  expect(policy.allowsDriver(ProviderDriverKind.make("claudeAgent"))).toBe(false);
});

it("captures injected driver kinds at construction", () =>
  Effect.gen(function* () {
    const claudeAgent = ProviderDriverKind.make("claudeAgent");
    const codex = ProviderDriverKind.make("codex");
    const policy = yield* ProjectSkillUsePolicy;
    expect(policy.enabled).toBe(true);
    expect(policy.allowsDriver(claudeAgent)).toBe(true);
    expect(policy.allowsDriver(codex)).toBe(false);
  }).pipe(
    Effect.provideService(
      ProjectSkillUsePolicy,
      projectSkillUsePolicyFrom([ProviderDriverKind.make("claudeAgent")]),
    ),
  ));

it("does not observe mutations to the caller's Set after capture", () => {
  const claudeAgent = ProviderDriverKind.make("claudeAgent");
  const codex = ProviderDriverKind.make("codex");
  const mutable = new Set<ProviderDriverKind>([claudeAgent]);
  const policy = projectSkillUsePolicyFrom(mutable);
  mutable.add(codex);
  expect(policy.enabled).toBe(true);
  expect(policy.allowsDriver(claudeAgent)).toBe(true);
  expect(policy.allowsDriver(codex)).toBe(false);
});

it("freezes the policy object at construction", () => {
  const policy = projectSkillUsePolicyFrom([ProviderDriverKind.make("claudeAgent")]);
  expect(Object.isFrozen(policy)).toBe(true);
});
