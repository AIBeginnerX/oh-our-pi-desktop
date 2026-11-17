import { useMemo } from "react";
import {
  projectMemoryDreamingSupported,
  projectMemoryTidySupported,
} from "@t3tools/client-runtime/state/project-memory-proposals";
import { AuthAccessWriteScope } from "@t3tools/contracts";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { desktopWslStateAtom } from "~/state/desktopWslState";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { usePrimarySessionState } from "~/environments/primary";
import { isWslSettingsRowVisible } from "./ConnectionsSettings.logic";
import { isProviderSettingsEnvironmentAvailable } from "./ProviderSettingsPanel.logic";
import type { SettingsScopeSearch } from "./settingsScope";
import {
  filterAvailableSettingsSearchItems,
  getThreadAutoSettlementSearchAvailability,
} from "./settingsSearch";

export function useAvailableSettingsSearchItems(scopeSearch: SettingsScopeSearch = {}) {
  const { environments } = useEnvironments();
  const primarySessionState = usePrimarySessionState();
  const localEnvironmentDisabled = isLocalEnvironmentDisabled();
  const desktopWsl = useEnvironmentQuery(
    isElectron && !localEnvironmentDisabled ? desktopWslStateAtom : null,
  );
  const canManageLocalBackend =
    !localEnvironmentDisabled &&
    (isElectron ||
      ((primarySessionState.data?.authenticated &&
        primarySessionState.data.scopes?.includes(AuthAccessWriteScope)) ??
        false));

  return useMemo(
    () =>
      filterAvailableSettingsSearchItems({
        localEnvironmentDisabled,
        hasCloudPublicConfig: hasCloudPublicConfig(),
        hasEnvironment: environments.some((environment) => environment.serverConfig !== null),
        hasProviderSettingsEnvironment: environments.some((environment) =>
          isProviderSettingsEnvironmentAvailable({
            connectionPhase: environment.connection.phase,
            hasServerConfig: environment.serverConfig !== null,
          }),
        ),
        hasMacProviderSettingsEnvironment: environments.some(
          (environment) =>
            (scopeSearch.machine === undefined ||
              environment.environmentId === scopeSearch.machine) &&
            environment.serverConfig?.environment.platform.os === "darwin" &&
            isProviderSettingsEnvironmentAvailable({
              connectionPhase: environment.connection.phase,
              hasServerConfig: true,
            }),
        ),
        canManageLocalBackend,
        isWslSettingsRowVisible: isWslSettingsRowVisible({
          state: desktopWsl.data,
          error: desktopWsl.error,
        }),
        hasThreadAutoSettlement:
          getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0,
        // The Dreaming row renders only when every target with loaded config supports it, so
        // a result here would point at an anchor that may be missing.
        hasProjectMemoryTidy:
          environments.some((environment) => environment.serverConfig !== null) &&
          environments
            .filter((environment) => environment.serverConfig !== null)
            .every((environment) => projectMemoryTidySupported(environment.serverConfig)),
        hasProjectMemoryDreaming:
          environments.some((environment) => environment.serverConfig !== null) &&
          environments
            .filter((environment) => environment.serverConfig !== null)
            .every((environment) => projectMemoryDreamingSupported(environment.serverConfig)),
      }),
    [
      canManageLocalBackend,
      desktopWsl.data,
      desktopWsl.error,
      environments,
      localEnvironmentDisabled,
      scopeSearch.machine,
    ],
  );
}
