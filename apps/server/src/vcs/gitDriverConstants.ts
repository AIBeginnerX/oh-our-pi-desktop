import * as Duration from "effect/Duration";
import * as Semaphore from "effect/Semaphore";
import * as GitVcsDriver from "./GitVcsDriver.ts";

export const DEFAULT_TIMEOUT_MS = 30_000;

export const gitProcesses = Semaphore.makeUnsafe(8);

// `git worktree add` checks out the full tree, so on large repositories it can
// take well beyond the default 30s (e.g. a 375k-file repo takes ~40s on an idle
// machine). Give it generous headroom while still bounding a genuinely hung git.
export const WORKTREE_ADD_TIMEOUT_MS = 300_000;

export const WORKTREE_REMOVE_TIMEOUT_MS = Duration.toMillis(Duration.minutes(5));

export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

export const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

export const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;

export const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;

export const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;

export const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;

export const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;

export const REVIEW_METADATA_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;

// Patches the clients render are parsed against git's default a/ and b/ path
// prefixes. A repository or global diff.noprefix or diff.mnemonicPrefix would
// otherwise leak into the patch and leave every parsed file unnamed.
export const PATCH_RENDER_PREFIX_ARGS = ["--src-prefix=a/", "--dst-prefix=b/"] as const;

export const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);

export const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);

export const STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN = Duration.seconds(30);

export const STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN = Duration.minutes(15);

export const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;

export const REPOSITORY_PATHS_CACHE_CAPACITY = 2_048;

export const REPOSITORY_PATHS_CACHE_TTL = Duration.minutes(10);

export const REPOSITORY_PATHS_REFRESH_COALESCE_TTL = Duration.seconds(5);

export const NON_REPOSITORY_PATHS_CACHE_TTL = Duration.seconds(1);

export const LIST_REFS_SNAPSHOT_CACHE_CAPACITY = 64;

export const LIST_REFS_SNAPSHOT_CACHE_TTL = Duration.minutes(2);

export const LIST_REFS_REFRESH_COALESCE_TTL = Duration.seconds(5);

export const LIST_REFS_REFRESH_FAILURE_COOLDOWN = Duration.seconds(30);

export const STATUS_DEFAULT_BRANCH_CACHE_TTL = Duration.minutes(5);

export const STATUS_ORIGIN_EXISTS_CACHE_TTL = Duration.minutes(5);

export const STATUS_UPSTREAM_REFRESH_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);

export const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;

export const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100;

export const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitStatusDetails>({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});

export const NON_REPOSITORY_REMOTE_STATUS_DETAILS =
  Object.freeze<GitVcsDriver.GitRemoteStatusDetails>({
    isRepo: false,
    defaultBranch: null,
    isDefaultBranch: false,
    branch: null,
    upstreamRef: null,
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
  });
