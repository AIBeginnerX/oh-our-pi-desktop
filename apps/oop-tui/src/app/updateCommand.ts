import {
  type CheckUpdate,
  buildUpdateReport,
  LISTED_HIGHLIGHTS,
  listedReleases,
  releaseTitle,
  terminalBehindText,
  terminalIsBehind,
  UPDATE_HOW_TO,
} from "./updateCheck.ts";

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
  deps.out(`현재 버전: ${current}`);
  deps.out("업데이트 확인 중…");
  const info = await deps.check({ refresh: true });
  if (info === null) {
    deps.err("업데이트를 확인하지 못했습니다. 네트워크 연결을 확인하세요.");
    return 1;
  }
  const report = buildUpdateReport(current, info);
  if (report.status === "current") {
    deps.out(`이미 최신입니다 (${current}).`);
  } else {
    deps.out(`업데이트 있음: ${current} → ${report.latest}`);
    const { shown, omitted } = listedReleases(report);
    for (const release of shown) {
      deps.out(`  ${releaseTitle(release)}`);
      for (const highlight of release.highlights.slice(0, LISTED_HIGHLIGHTS)) {
        deps.out(`    - ${highlight}`);
      }
    }
    if (omitted > 0) deps.out(`  외 ${omitted}개 릴리스`);
    deps.out(UPDATE_HOW_TO);
  }
  if (app !== null && terminalIsBehind(deps.terminalVersion, app)) {
    deps.out(terminalBehindText(deps.terminalVersion, app));
  }
  return 0;
};
