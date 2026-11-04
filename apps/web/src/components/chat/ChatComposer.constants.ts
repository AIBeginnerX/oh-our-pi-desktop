import type { PullRequestListInput } from "@t3tools/contracts";
import type { EnvironmentQueryTarget } from "~/state/pullRequests";

export const COMPOSER_PULL_REQUEST_LIST_LIMIT = 99;
export const COMPOSER_PULL_REQUEST_RESULT_LIMIT = 12;
export const EMPTY_PULL_REQUEST_LIST_TARGETS: ReadonlyArray<
  EnvironmentQueryTarget<PullRequestListInput>
> = [];

export const WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS = 10_000;

export const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};
