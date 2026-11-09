import { DEFAULT_CREW_SETTINGS, type ServerProvider } from "@t3tools/contracts";
import {
  applyDefaultCrewChange,
  crewModelOptions,
  recommendCrew,
  resolveCrew,
  type CrewChange,
} from "@t3tools/shared/crew";
import * as Equal from "effect/Equal";
import { useMemo } from "react";

import { useT } from "../../i18n";

import { CREW_PRESETS, CrewEditor } from "../chat/CrewEditor";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SelectButton } from "../ui/select";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * The "Crew" row of the new-threads defaults: the OOP Crew every chat starts
 * with until it picks a crew of its own. Crew is environment-level — it is no
 * project override — so at a project scope the row shows the inherited value
 * with an inert control, like the other environment-wide rows.
 */
export function DefaultCrewSetting({
  providers,
}: {
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const t = useT();
  const defaults = useScopedSettings((settings) => settings.crew);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["crew"]);
  const options = useMemo(() => crewModelOptions(providers), [providers]);
  const crew = useMemo(
    () => resolveCrew({ settings: defaults, override: undefined, providers, brain: null }),
    [defaults, providers],
  );
  const autoPicks = useMemo(
    () => recommendCrew(options, null, crew.preset),
    [options, crew.preset],
  );
  const presetLabel =
    CREW_PRESETS.find((preset) => preset.value === crew.preset)?.label ?? crew.preset;
  const summary = mixed ? t("Mixed") : crew.enabled ? `${t("On")} · ${t(presetLabel)}` : t("Off");

  return (
    <SettingsRow
      serverScoped
      settingKeys={["crew"]}
      mixed={mixed}
      {...searchableSetting("default-crew")}
      title={t(searchableSetting("default-crew").title)}
      description={t("New chats start with this crew. A chat with its own crew keeps it.")}
      resetAction={
        !Equal.equals(defaults, DEFAULT_CREW_SETTINGS) ? (
          <SettingResetButton
            label={t("default crew")}
            onClick={() => updateSettings({ crew: DEFAULT_CREW_SETTINGS })}
          />
        ) : null
      }
      control={
        <Popover>
          <PopoverTrigger render={<SelectButton size="sm" aria-label={t("Default crew")} />}>
            {summary}
          </PopoverTrigger>
          <PopoverPopup align="end" className="w-80">
            <CrewEditor
              crew={crew}
              options={options}
              autoPicks={autoPicks}
              onChange={(change: CrewChange) =>
                updateSettings({ crew: applyDefaultCrewChange(defaults, change) })
              }
              brainLabel="the new chat's model"
            />
          </PopoverPopup>
        </Popover>
      }
    />
  );
}
