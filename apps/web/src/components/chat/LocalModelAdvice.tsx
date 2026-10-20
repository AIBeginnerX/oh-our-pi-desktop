import {
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  selectLocalDecision,
  type LocalDecisionCandidate,
  type LocalDecisionKey,
  type LocalDecisionRole,
} from "@t3tools/client-runtime/local-decision";
import { useState } from "react";
import { Button } from "../ui/button";
import { useClientSettings, persistClientSettingsUpdate } from "~/hooks/useSettings";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

type RolePick = "implementation" | "review";

export function LocalModelAdvice(props: {
  environmentId: EnvironmentId;
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onApply: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const [role, setRole] = useState<LocalDecisionRole>("general");
  const [notice, setNotice] = useState<string | null>(null);
  const favorites = useClientSettings((settings) => settings.favorites);
  const rolePicks = useClientSettings(
    (settings) => settings.localModelRolePicks[props.environmentId],
  );

  const buildCandidates = (): LocalDecisionCandidate[] => {
    const candidates: LocalDecisionCandidate[] = [];
    for (const entry of props.instanceEntries) {
      const discovered = new Map(entry.snapshot.models.map((model) => [model.slug, model]));
      for (const option of props.modelOptionsByInstance.get(entry.instanceId) ?? []) {
        const liveModel = discovered.get(option.slug);
        // The picker may preserve synthetic or unavailable selected rows. They
        // are useful for display, but cannot be a fresh recommendation.
        if (!liveModel) continue;
        const lockedOut =
          props.lockedProvider !== null &&
          (entry.driverKind !== props.lockedProvider ||
            (props.lockedContinuationGroupKey !== null &&
              entry.continuationGroupKey !== props.lockedContinuationGroupKey));
        const disabledReason = props.getModelDisabledReason?.(entry.instanceId, option.slug);
        const eligible =
          isProviderInstancePickerReady(entry) &&
          entry.installed &&
          entry.snapshot.auth.status !== "unauthenticated" &&
          !option.isUnavailable &&
          !lockedOut &&
          !disabledReason;
        const favoriteRank = favorites.findIndex(
          (favorite) => favorite.provider === entry.instanceId && favorite.model === option.slug,
        );
        candidates.push({
          key: {
            environmentId: props.environmentId,
            instanceId: entry.instanceId,
            model: option.slug,
          },
          eligible: Boolean(eligible),
          ...(eligible ? {} : { blockedReason: disabledReason ?? "unavailable" }),
          capabilities:
            liveModel.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id) ?? [],
          ...(favoriteRank >= 0 ? { preferenceRank: favoriteRank } : {}),
        });
      }
    }
    return candidates;
  };

  const currentKey: LocalDecisionKey = {
    environmentId: props.environmentId,
    instanceId: props.activeInstanceId,
    model: props.model,
  };
  const savedPick = role === "general" ? undefined : rolePicks?.[role];
  const choose = () =>
    selectLocalDecision({
      environmentId: props.environmentId,
      role,
      candidates: buildCandidates(),
      requiredCapabilities: [],
      currentKey,
      ...(savedPick
        ? { rolePreferenceKeys: [{ environmentId: props.environmentId, ...savedPick }] }
        : {}),
    });
  const recommendation = choose();
  const currentEligible = buildCandidates().some(
    (candidate) =>
      candidate.eligible &&
      candidate.key.instanceId === currentKey.instanceId &&
      candidate.key.model === currentKey.model,
  );
  const recommendedEntry =
    recommendation.kind === "recommended"
      ? props.instanceEntries.find((entry) => entry.instanceId === recommendation.key.instanceId)
      : undefined;
  const recommendedModel =
    recommendation.kind === "recommended" && recommendedEntry
      ? props.modelOptionsByInstance
          .get(recommendedEntry.instanceId)
          ?.find((option) => option.slug === recommendation.key.model)
      : undefined;
  const message =
    recommendation.kind === "recommended"
      ? recommendation.reasonCodes.includes("current_binding")
        ? "Keep current selection"
        : recommendation.reasonCodes.includes("role_preference")
          ? "Your model for this role"
          : "From your favorites"
      : recommendation.reasonCode === "no_explicit_role_preference"
        ? "Assign a model to this role first"
        : role !== "general" && savedPick
          ? "This role’s model is unavailable; choose another"
          : recommendation.reasonCode === "no_explicit_general_preference"
            ? "Choose a model or mark a favorite first"
            : "No available model for this role";

  const setPick = (next: { instanceId: ProviderInstanceId; model: string } | null) => {
    if (role === "general") return;
    const targetRole: RolePick = role;
    void persistClientSettingsUpdate((settings) => {
      const environmentPicks = { ...settings.localModelRolePicks[props.environmentId] };
      if (next) environmentPicks[targetRole] = next;
      else delete environmentPicks[targetRole];
      return {
        ...settings,
        localModelRolePicks: {
          ...settings.localModelRolePicks,
          [props.environmentId]: environmentPicks,
        },
      };
    }).catch(() => setNotice("Could not save this role choice"));
    setNotice(null);
  };

  const apply = () => {
    if (recommendation.kind !== "recommended") return;
    const latest = choose();
    if (
      latest.kind !== "recommended" ||
      latest.key.instanceId !== recommendation.key.instanceId ||
      latest.key.model !== recommendation.key.model
    ) {
      setNotice("Recommendation changed. Review it again before applying.");
      return;
    }
    const entry = props.instanceEntries.find(
      (candidate) => candidate.instanceId === latest.key.instanceId,
    );
    if (!entry || props.getModelDisabledReason?.(entry.instanceId, latest.key.model)) {
      setNotice("This model is no longer selectable.");
      return;
    }
    props.onApply(entry.instanceId, latest.key.model);
  };

  return (
    <div className="border-t px-3 py-2 text-xs" data-local-model-advice>
      <div className="mb-1.5 font-medium">Local recommendation</div>
      <div className="mb-2 flex gap-1" role="group" aria-label="Recommendation role">
        {(["general", "implementation", "review"] as const).map((nextRole) => (
          <Button
            key={nextRole}
            size="micro"
            variant={role === nextRole ? "secondary" : "ghost-muted"}
            aria-pressed={role === nextRole}
            onClick={() => {
              setRole(nextRole);
              setNotice(null);
            }}
          >
            {nextRole[0]!.toUpperCase() + nextRole.slice(1)}
          </Button>
        ))}
      </div>
      <div className="text-muted-foreground">
        {recommendedEntry && recommendedModel
          ? `${recommendedEntry.displayName} · ${recommendedModel.name} — ${message}`
          : message}
      </div>
      {notice ? (
        <div role="status" className="mt-1 text-warning-foreground">
          {notice}
        </div>
      ) : null}
      <div className="mt-2 flex gap-1">
        {role !== "general" ? (
          <>
            <Button
              size="micro"
              variant="outline"
              disabled={!currentEligible}
              onClick={() => setPick({ instanceId: props.activeInstanceId, model: props.model })}
            >
              Save current for role
            </Button>
            {savedPick ? (
              <Button size="micro" variant="ghost-muted" onClick={() => setPick(null)}>
                Clear
              </Button>
            ) : null}
          </>
        ) : null}
        <Button
          size="micro"
          variant="secondary"
          disabled={recommendation.kind !== "recommended"}
          onClick={apply}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}
