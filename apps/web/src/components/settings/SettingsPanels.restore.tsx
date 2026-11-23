import { useCallback, useMemo } from "react";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";
import * as Equal from "effect/Equal";
import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from "../../hooks/useTheme";
import {
  mergeEnvironmentSettings,
  persistClientSettingsPatch,
  useClientSettings,
} from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planScopedSettingsPatch,
  type ScopedSettingsPatch,
} from "./scopedSettings";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { getChangedBrowserSettingLabels } from "./SettingsPanels.logic";

const restoreLabels = {
  appearanceContrast: "Contrast",
  diffColorScheme: "Diff colors",
  chatWidth: "Chat width",
  transcriptViewMode: "Transcript view",
  timestampFormat: "Time format",
  notificationMode: "Thread notifications",
  inAppNotificationsEnabled: "In-app notifications",
  noActivityAlertMinutes: "No-activity alerts",
  setupNotificationsEnabled: "Setup notifications",
  wordWrap: "Word wrap",
  diffFilesCollapsed: "Default diff file state",
  diffIgnoreWhitespace: "Diff whitespace changes",
  diffLayout: "Diff layout",
  proactivePanelsEnabled: "Proactive panels",
  turnStallNoticeEnabled: "Quiet turn notice",
  showSkillsInSlashMenu: "Show skills in slash menu",
  composerCollapseOnScroll: "Collapse composer on scroll",
  composerRichTextEnabled: "Rich text composer",
  sendShortcut: "Send shortcut",
  followUpBehavior: "Follow-up behavior",
  contextWindowMeterEnabled: "Context window indicator",
  environmentIdentificationMode: "Environment identification",
  glassOpacity: "Glass opacity",
  panelAnimationDurationMs: "Panel animations",
  sidebarThreadPreviewCount: "Visible threads",
  sidebarRunningThreadsFirst: "Running threads first",
  sidebarProjectGroupingMode: "Project Grouping",
  sidebarAutoSettleAfterDays: "Auto-settle inactive threads",
  sidebarAutoSettleOnMerge: "Auto-settle merged threads",
  sidebarAutoArchiveAfterDays: "Auto-archive settled threads",
  responseStreamingMode: "Response streaming",
  enableProviderUpdateChecks: "Provider update checks",
  autoSelectProjectMemories: "Auto-select related memories",
  projectMemoryTidy: "Memory tidy-up",
  projectMemoryAnalyser: "Work analyser",
  projectMemoryDreaming: "Dreaming",
  projectMemoryDreamingHour: "Dreaming",
  continueThreadsAfterServerUpdate: "Continue threads after restarts",
  continueUnfinishedPlans: "Continue unfinished plans",
  backgroundActivity: "Background activity",
  backgroundActivityProfile: "Background activity",
  automaticGitFetchInterval: "Background activity",
  providerHealthRefreshInterval: "Background activity",
  defaultThreadEnvMode: "New thread mode",
  newWorktreesStartFromOrigin: "New worktrees start from origin",
  addProjectBaseDirectory: "Add project base directory",
  confirmThreadArchive: "Archive confirmation",
  confirmThreadDelete: "Delete confirmation",
  confirmThreadUnpin: "Unpin confirmation",
  confirmQuit: "Quit shortcut",
  textGenerationModelSelection: "Text generation model",
  fontFamilySans: "Interface font",
  fontFamilyComposer: "Prompt font",
  fontFamilyCode: "Code font",
  fontFamilyTerminal: "Terminal font",
  fontSizeInterface: "Interface font",
  fontSizePrompt: "Prompt font",
  fontSizeCode: "Code font",
  fontSizeTerminal: "Terminal font",
  browserDefaultViewport: "Browser viewport",
  browserDefaultZoomFactor: "Browser zoom",
  browserDefaultAppearance: "Browser appearance",
  browserRecordingFrameRate: "Recording frame rate",
  browserRecordingShowKeyPresses: "Recording key presses",
  browserRecordingShowMousePresses: "Recording mouse presses",
  browserLinkTarget: "Open links in",
  browserAutoShowFloatingPreview: "Floating preview",
  enableAgentBrowserAccess: "Agent browser access",
} satisfies Partial<Record<keyof UnifiedSettings, string>>;

const restoreKeys = Object.keys(restoreLabels) as (keyof typeof restoreLabels)[];

function changedRestoreKeys(settings: UnifiedSettings) {
  return restoreKeys.filter((key) =>
    key === "browserDefaultViewport"
      ? getChangedBrowserSettingLabels(settings).includes(restoreLabels[key])
      : !Equal.equals(settings[key] ?? null, DEFAULT_UNIFIED_SETTINGS[key] ?? null),
  );
}

function defaultsPatch(keys: ReturnType<typeof changedRestoreKeys>): ScopedSettingsPatch {
  return Object.fromEntries(keys.map((key) => [key, DEFAULT_UNIFIED_SETTINGS[key]]));
}

export function useSettingsRestore(onRestored?: () => void) {
  const {
    theme,
    setTheme,
    followSystem,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    themeHalves,
  } = useTheme();
  const { scope, connectedEnvironments } = useSettingsScope();
  const clientSettings = useClientSettings();
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const { plan, settingLabels } = useMemo(() => {
    const deviceKeys = changedRestoreKeys(
      mergeEnvironmentSettings(DEFAULT_SERVER_SETTINGS, clientSettings),
    );
    const devicePlan = planScopedSettingsPatch(scope, [], defaultsPatch(deviceKeys));
    const labels = new Set(deviceKeys.map((key) => restoreLabels[key]));
    const serverWrites = connectedEnvironments.flatMap((environment) => {
      if (!environment.serverConfig || (scope.kind !== "all" && scope.kind !== "environment")) {
        return [];
      }
      const keys = changedRestoreKeys(
        mergeEnvironmentSettings(environment.serverConfig.settings, clientSettings),
      ).filter((key) => !deviceKeys.includes(key));
      const { serverWrites } = planScopedSettingsPatch(scope, [environment], defaultsPatch(keys));
      if (serverWrites.length > 0) {
        for (const key of keys) labels.add(restoreLabels[key]);
      }
      return serverWrites;
    });
    return { plan: { ...devicePlan, serverWrites }, settingLabels: [...labels] };
  }, [clientSettings, connectedEnvironments, scope]);
  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(!followSystem ? ["Follow system"] : []),
      ...(themeHalves !== null ? ["Theme mix"] : []),
      ...settingLabels,
    ],
    [theme, followSystem, themeHalves, settingLabels],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
      { variant: "destructive" },
    );
    if (!confirmed) return;

    // Only touch the theme keys that are actually dirty, so a theme-storage
    // failure cannot block restoring unrelated settings. Preferences are
    // re-read after the confirmation dialog: they may have changed (another
    // tab, an OS flip) while it was open, and rollback must restore the live
    // values rather than the ones captured at render time.
    let previousTheme = theme;
    try {
      previousTheme = readThemePreference();
    } catch {
      // Storage is unreadable; the render-time value is the best rollback.
    }
    // The mix may have changed while the confirmation dialog was open; both
    // the dirty check and the rollback must see the live value.
    const liveHalves = readThemeHalves();
    const needsThemeReset = previousTheme !== "system";
    const needsMixReset = liveHalves !== null;
    // Same for the appearance mode: trusting the render-time value would skip
    // the reset and report success while a non-system mode stayed in storage.
    const needsFollowSystemReset = readAppearanceModePreference(previousTheme) !== "system";
    const notifyThemeRestoreFailure = () => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn’t restore theme settings",
          description: "Try again.",
        }),
      );
    };
    // Rollback restores the base preference first (which clears any mix) and
    // then re-applies the captured mix on top, so no failure path can leave
    // the pair of keys half-restored.
    const previousHalves = liveHalves;
    const rollbackThemeState = () => {
      if (needsThemeReset) setTheme(previousTheme);
      if (previousHalves?.light) setThemeHalf("light", previousHalves.light);
      if (previousHalves?.dark) setThemeHalf("dark", previousHalves.dark);
    };
    if (needsThemeReset && !setTheme("system")) {
      notifyThemeRestoreFailure();
      return;
    }
    if (needsMixReset && !clearThemeHalves()) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    if (needsFollowSystemReset && !setFollowSystem(true)) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    const { failedEnvironments, savedEnvironmentCount } = await persistScopedSettingsPatch(
      plan,
      persistServer,
      persistClientSettingsPatch,
    );
    if (failedEnvironments.length > 0) {
      toastManager.add({
        type: "error",
        title:
          savedEnvironmentCount > 0
            ? "Settings restored on some environments"
            : "Settings not restored",
        description: `Could not update ${failedEnvironments.map((environment) => environment.label).join(", ")}.`,
      });
    }
    onRestored?.();
  }, [
    changedSettingLabels,
    clearThemeHalves,
    onRestored,
    setFollowSystem,
    setTheme,
    setThemeHalf,
    theme,
    plan,
    persistServer,
  ]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

/**
 * Gate in front of the legacy token-by-token mode. The primary action steers
 * the user to paragraph streaming; the legacy path is the quiet option.
 */
