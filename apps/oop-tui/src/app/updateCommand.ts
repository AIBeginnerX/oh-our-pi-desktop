import {
  type CheckUpdate,
  buildUpdateReport,
  LISTED_HIGHLIGHTS,
  listedReleases,
  releaseTitle,
  terminalBehindText,
  terminalIsBehind,
  updateHowTo,
} from "./updateCheck.ts";
import { t } from "../i18n/index.ts";

export interface UpdateCommandDeps {
  /** Version of the terminal app itself. */
  readonly terminalVersion: string;
  /** Version of the desktop app when one is running; null when none answers. Starts nothing. */
  readonly appVersion: () => Promise<string | null>;
  readonly check: CheckUpdate;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * `oop update`: says which version is current, looks up the newest release, and either says there
 * is nothing to do or lists what the newer releases brought and how to get them. It installs
 * nothing. Without a running app the terminal app's own version is the current one.
 */
export const runUpdateCommand = async (deps: UpdateCommandDeps): Promise<number> => {
  const app = await deps.appVersion();
  const current = app ?? deps.terminalVersion;
  deps.out(t("cli.update.current", { version: current }));
  deps.out(t("cli.update.checking"));
  const info = await deps.check({ refresh: true });
  if (info === null) {
    deps.err(t("cli.update.checkFailed"));
    return 1;
  }
  const report = buildUpdateReport(current, info);
  if (report.status === "current") {
    deps.out(t("cli.update.upToDate", { version: current }));
  } else {
    deps.out(t("cli.update.available", { current, latest: report.latest }));
    const { shown, omitted } = listedReleases(report);
    for (const release of shown) {
      deps.out(`  ${releaseTitle(release)}`);
      for (const highlight of release.highlights.slice(0, LISTED_HIGHLIGHTS)) {
        deps.out(`    - ${highlight}`);
      }
    }
    if (omitted > 0) deps.out(t("cli.update.more", { count: omitted }));
    deps.out(updateHowTo());
  }
  if (app !== null && terminalIsBehind(deps.terminalVersion, app)) {
    deps.out(terminalBehindText(deps.terminalVersion, app));
  }
  return 0;
};
