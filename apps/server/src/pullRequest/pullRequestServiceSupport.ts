import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  pullRequestProviderRequirement,
  type OrchestrationProjectShell,
  type PullRequestAction,
  type PullRequestDiffResult,
  type PullRequestListEntry,
  type PullRequestListProjectError,
  type PullRequestReviewVerdict,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { AllowGitHubReserve } from "../sourceControl/GitHubCli.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import {
  type ProviderChangeRequest,
  type ProviderListCursor,
  type PullRequestProviderApi,
  PullRequestProviderError,
} from "./PullRequestProvider.ts";

/**
 * Rows per repository when the client does not ask for a page size, and rows per slice when a
 * listing is carried on from a cursor.
 *
 * 99 and not 100, because every provider asks its host for one row over this to probe for a next
 * page: 99 requests 100, which is exactly what a page of GitHub's API serves — GraphQL refuses
 * `first` over 100 with EXCESSIVE_PAGINATION and REST clamps `per_page` to it — and what GitLab
 * caps `per_page` at. Asking for 100 here would request 101 and buy a whole second round trip for
 * one row (measured: `gh pr list --limit 100` makes 1 HTTP request, `--limit 101` makes 2).
 */
export const DEFAULT_REPOSITORY_LIST_LIMIT = 99;

/**
 * Repositories read at once. Each one is a CLI process that spends nearly all its wall clock
 * waiting on the host, so the useful ceiling is far above the core count; measured over 12
 * repositories on this listing's own command, 4 took ~12.7s, 8 ~8.9s and 12 ~4.9s, with 16 and 24
 * no faster because 12 already reads every repository in one wave.
 */
export const REPOSITORY_CONCURRENCY = 12;

/**
 * Repositories named in one read across a host. Measured against GitHub's search: six hundred
 * `repo:` qualifiers in one query — 14.7KB of it — were all still honoured, and the answer took
 * the same three to six seconds at twelve repositories as at four hundred. A hundred is well
 * inside that and past the size of a workspace anyone opens, so a larger one reads in a handful
 * of searches rather than in a request per repository.
 */
export const REPOSITORY_SEARCH_CHUNK = 100;

/**
 * Every read leaves the process — a CLI per repository, against hosts whose limits are low
 * (GitHub's search API allows ~30 requests a minute) — so answers are shared for a short
 * while and concurrent identical reads share one request. The windows sit near the clients'
 * own stale times: long enough that two people opening the same page cost one round trip,
 * short enough that "cached" and "fresh" never need telling apart on screen. Reads that
 * must not share — the refresh button, a client reloading after its own action — go through
 * `invalidate` rather than a flag on the read, so an ordinary read can never opt out.
 */
export const LIST_CACHE_TTL = Duration.seconds(30);

export const DETAIL_CACHE_TTL = Duration.seconds(15);

export const DIFF_CACHE_TTL = Duration.seconds(60);

/** A commit is content-addressed, so its own diff cannot change under its key. */
export const COMMIT_DIFF_CACHE_TTL = Duration.minutes(10);

/** Sized like the client's own stale time; a row's counts move only when somebody pushes. */
export const LIST_STATS_CACHE_TTL = Duration.seconds(60);

/**
 * Short, and with no stale window behind it: this is the reader's own bookkeeping, and the
 * press that changes it is the same press the page is already showing optimistically. Held at
 * all only so opening a change request on two devices costs one read.
 */
export const FILES_VIEWED_CACHE_TTL = Duration.seconds(15);

/** A diff can stay interactive while its next cached value is fetched off the critical path. */
export const DIFF_STALE_WINDOW = Duration.minutes(10);

/** How long one host's signed-in login is believed without asking its CLI again. */
export const VIEWER_CACHE_TTL = Duration.minutes(10);

export const SEARCH_VISIBILITY_TTL = Duration.minutes(10);

export const STALE_DETAIL_WINDOW = Duration.minutes(10);

export const isPullRequestProviderError = Schema.is(PullRequestProviderError);

export const LIST_CACHE_CAPACITY = 64;

export const LIST_STATS_CACHE_CAPACITY = 32;

export const DETAIL_CACHE_CAPACITY = 128;

export const DIFF_CACHE_CAPACITY = 128;

// Each diff cache can retain at most 64 MiB of patch text, counting UTF-16 storage.
export const MAX_CACHED_DIFF_PATCH_BYTES = 512 * 1024;

export const canCacheDiff = (value: PullRequestDiffResult) =>
  value.patch.length * 2 <= MAX_CACHED_DIFF_PATCH_BYTES;

export const FILES_VIEWED_CACHE_CAPACITY = 128;

export const VIEWER_CACHE_CAPACITY = 32;

export type PullRequestError = PullRequestUnavailableError | PullRequestOperationError;

/** What a verdict is called when refusing it, so the sentence reads as an action. */
export const VERDICT_LABELS: Record<PullRequestReviewVerdict, string> = {
  comment: "review",
  approve: "approve",
  "request-changes": "request changes on",
};

/**
 * Why an action is refused to this viewer, said as the access it would take rather than as the
 * refusal the host would have answered with. Merging is the one that needs write and nothing
 * else; the other four are also the author's to take, whatever access they have.
 */
export const ACTION_ACCESS_REFUSALS: Record<PullRequestAction, string> = {
  merge: "You need write access on this repository to merge.",
  ready:
    "You need write access on this repository, or to have opened this change request, to mark it ready for review.",
  draft:
    "You need write access on this repository, or to have opened this change request, to return it to a draft.",
  close:
    "You need write access on this repository, or to have opened this change request, to close it.",
  "update-branch":
    "You need write access on this repository, or to have opened this change request, to update its branch.",
  reopen:
    "You need write access on this repository, or to have opened this change request, to reopen it.",
  "enable-auto-merge":
    "You need write access on this repository to have it merged for you once it is ready.",
  "disable-auto-merge":
    "You need write access on this repository to stop it being merged for you once it is ready.",
  revert: "You need write access on this repository to open a revert pull request.",
  "approve-workflows":
    "You need write access on this repository to approve workflows from a fork pull request.",
};

/**
 * Why asking for a review is refused, and why the menu behind it is too. Write access is what the
 * hosts that state anything about this want; the ones that state nothing grant it, so this
 * sentence is only ever the answer where a host said no.
 */
export const REVIEWER_REQUEST_REFUSAL =
  "You need write access on this repository to ask for a review.";

export const LABEL_CHANGE_REFUSAL =
  "You need triage access on this repository to change its labels.";

/** A project this page can read: its remote is on a host with an implementation. */
export interface SupportedProject {
  readonly cursorKey: string;
  readonly project: OrchestrationProjectShell;
  readonly api: PullRequestProviderApi;
  readonly repository: string;
  /** The host the repository lives on, which is the account boundary rather than the kind. */
  readonly host: string;
  /**
   * The identity's canonical key, which is what this environment's own records are keyed by.
   * Unique where `repository` is not: Azure's is a bare name that repeats across an organisation.
   */
  readonly remote: string;
}

/**
 * What the workspace has, split by whether this build can read it. Hosts with no
 * implementation are counted rather than dropped, so their projects are explained in the
 * provider list instead of quietly missing from the page.
 */
export interface WorkspaceProjects {
  readonly supported: ReadonlyArray<SupportedProject>;
  /** Keyed by host, as the readable ones are: an unimplemented host is its own switcher entry. */
  readonly unimplemented: ReadonlyMap<
    string,
    { readonly kind: SourceControlProviderKind; readonly projectCount: number }
  >;
  /**
   * Every checkout on a host, including the ones the listing de-duplicated away. Asking who is
   * signed in is a question about the host rather than about a repository, and any checkout can
   * answer it — so a broken worktree is not allowed to take the host down with it just because
   * it happened to be the one the listing kept.
   */
  readonly viewerRoots: ReadonlyMap<string, ReadonlyArray<string>>;
}

export interface RepositoryBatch {
  /** Which repository this slice came from, which is what a cursor for it is filed under. */
  readonly key: string;
  readonly entries: ReadonlyArray<PullRequestListEntry>;
  readonly errors: ReadonlyArray<PullRequestListProjectError>;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

/** What the providers are told, plus the part only the service acts on. */
export interface ListCursor extends ProviderListCursor {
  /**
   * The rows already handed over at exactly `updatedBefore`. The next read asks for that instant
   * inclusively, so these are what keeps it from sending them a second time.
   */
  readonly seenAt: ReadonlyArray<number>;
}

/**
 * A continuation as it travels through the page and back. Written out rather than encoded because
 * it comes back from a client and has to be believed or refused on sight: everything a host is
 * given is either a timestamp of this shape or a number of this length, which is what lets a
 * provider drop it into a filter without checking it again.
 */
export const LIST_CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))\|(\d{1,9})\|(\d{1,9}(?:,\d{1,9})*)?$/;

export function parseListCursor(raw: string): ListCursor | null {
  const match = LIST_CURSOR_PATTERN.exec(raw);
  if (match === null) return null;
  const seenAt = match[3];
  return {
    updatedBefore: match[1]!,
    delivered: Number(match[2]),
    seenAt: seenAt === undefined ? [] : seenAt.split(",").map(Number),
  };
}

/**
 * How a listing tells two repositories apart. The host is part of it because the same
 * `owner/repo` exists on github.com and on an Enterprise install, and they are two repositories.
 */
export function listCursorKey(host: string, repository: string): string {
  return `${host} ${repository.toLowerCase()}`;
}

/**
 * Where a repository carries on, worked out from the slice just handed over. The boundary is the
 * instant of the oldest row in it: the next read asks for that instant and everything before it,
 * and names the rows already sent at it so none of them arrives twice.
 *
 * The names carry over when the boundary has not moved. A slice that ends on the same instant it
 * began on has to keep the earlier rows excluded as well as its own, or the read after it would
 * hand them over again.
 */
export function nextListCursor(
  previous: ListCursor | undefined,
  /** What the host handed over, before the rows already sent were dropped from it. */
  fetched: ReadonlyArray<ProviderChangeRequest>,
  /** What is being sent on, which is what the count of delivered rows is about. */
  delivered: ReadonlyArray<ProviderChangeRequest>,
  /** A provider may consume malformed offset-paged rows that never appear in `delivered`. */
  cursorAdvance = delivered.length,
): string | null {
  // The host had nothing at all, so there is no row to carry on from — and repeating the cursor
  // that produced the empty slice would ask the same question forever.
  if (fetched.length === 0) return null;
  // Taken from what the host answered rather than from what survived de-duplication: a slice can
  // be entirely rows already sent — a hundred change requests touched in the same second is one
  // repository's boring afternoon — and reading "nothing new" as "nothing left" would end the
  // walk on the instant it was stuck on, with everything older unreachable for good.
  const oldest = fetched.reduce((left, right) => (right.updatedAt < left.updatedAt ? right : left));
  return listCursorAt(previous, oldest.updatedAt, fetched, cursorAdvance);
}

/**
 * The same cursor against a boundary chosen elsewhere, which is what a slice read across several
 * repositories at once needs: every repository in it is read up to the oldest row of the whole
 * slice, including the ones that contributed nothing to it — their rows are simply all older, and
 * a repository that carried on from its own oldest row would be right about where it stopped and
 * silent about the ones that never appeared.
 */
export function listCursorAt(
  previous: ListCursor | undefined,
  boundary: string,
  /** This repository's own rows in the slice, before the ones already sent were dropped. */
  fetched: ReadonlyArray<ProviderChangeRequest>,
  deliveredCount: number,
): string {
  const seenAt = [
    ...(previous?.updatedBefore === boundary ? previous.seenAt : []),
    ...fetched.filter((item) => item.updatedAt === boundary).map((item) => item.number),
  ];
  return `${boundary}|${(previous?.delivered ?? 0) + deliveredCount}|${seenAt.join(",")}`;
}

/** A host that cannot be read at all, as opposed to one request that failed. */
export function isProviderUnusable(error: PullRequestProviderError): boolean {
  return error.reason === "missing-tool" || error.reason === "unauthenticated";
}

/**
 * Why a host is not readable, told as the thing to do about it. A host that is simply not set up
 * says so in the same words the whole-page state uses, rather than repeating whatever its tool
 * printed — "HTTP 401" names the symptom, not the fix.
 */
export function providerDetail(error: PullRequestProviderError): string {
  if (!isProviderUnusable(error)) return error.detail;
  return (
    pullRequestProviderRequirement(
      error.provider,
      error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
    ) ?? error.detail
  );
}

export function toUnavailableError(error: PullRequestProviderError): PullRequestUnavailableError {
  return new PullRequestUnavailableError({
    reason: error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
    provider: error.provider,
    cause: error,
  });
}

export function toPullRequestError(
  operation: string,
): (error: PullRequestProviderError) => PullRequestError {
  return (error) =>
    isProviderUnusable(error)
      ? toUnavailableError(error)
      : new PullRequestOperationError({ operation, detail: error.detail, cause: error });
}

export function withRateLimitBackoff(
  api: PullRequestProviderApi,
  host: string,
  limits: SourceControlRateLimit.SourceControlRateLimit["Service"],
  options?: { readonly viewerAllowsPause: boolean },
): PullRequestProviderApi {
  const key = { provider: api.kind, host };
  const protect = <A>(
    operation: string,
    effect: Effect.Effect<A, PullRequestProviderError>,
    allowPaused: boolean,
  ) =>
    limits.check(key, allowPaused ? { allowPaused: true } : undefined).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            provider: api.kind,
            operation,
            reason: "rate-limited",
            detail: error.detail,
            retryAt: error.retryAt,
            cause: error,
          }),
      ),
      Effect.flatMap((lease) =>
        effect.pipe(
          Effect.provideService(AllowGitHubReserve, allowPaused),
          Effect.tap(() => limits.recordSuccess({ ...key, lease })),
          Effect.tapError((error) =>
            error.reason === "rate-limited"
              ? limits.recordRateLimit({
                  ...key,
                  lease,
                  ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
                })
              : Effect.void,
          ),
        ),
      ),
    );
  const wrap =
    <Args extends ReadonlyArray<unknown>, A>(
      operation: string,
      call: (...args: Args) => Effect.Effect<A, PullRequestProviderError>,
      allowPaused = false,
    ) =>
    (...args: Args) =>
      protect(operation, call(...args), allowPaused);
  const interactive = <Args extends ReadonlyArray<unknown>, A>(
    operation: string,
    call: (...args: Args) => Effect.Effect<A, PullRequestProviderError>,
  ) => wrap(operation, call, true);

  const wrapped = {
    kind: api.kind,
    capabilities: api.capabilities,
    // Refused during a pause like any other read, except for the caller that asks for the
    // bypass: a lookup that failed is not held, so letting every background read through would
    // spawn this host's CLI on each of them and re-extend the pause it was already in.
    getViewer:
      options?.viewerAllowsPause === true
        ? interactive("getViewer", api.getViewer)
        : wrap("getViewer", api.getViewer),
    ...(api.getRoutingIdentity === undefined ? {} : { getRoutingIdentity: api.getRoutingIdentity }),
    ...(api.withVerifiedCredential === undefined
      ? {}
      : { withVerifiedCredential: api.withVerifiedCredential }),
    listChangeRequests: wrap("listChangeRequests", api.listChangeRequests),
    ...(api.listChangeRequestsAcross === undefined
      ? {}
      : {
          listChangeRequestsAcross: wrap("listChangeRequestsAcross", api.listChangeRequestsAcross),
        }),
    ...(api.listChangeRequestStats === undefined
      ? {}
      : {
          listChangeRequestStats: wrap("listChangeRequestStats", api.listChangeRequestStats),
        }),
    getChangeRequest: wrap("getChangeRequest", api.getChangeRequest),
    ...(api.getChangeRequestPreview === undefined
      ? {}
      : { getChangeRequestPreview: wrap("getChangeRequestPreview", api.getChangeRequestPreview) }),
    ...(api.getChangeRequestSummary === undefined
      ? {}
      : {
          getChangeRequestSummary: wrap("getChangeRequestSummary", api.getChangeRequestSummary),
        }),
    ...(api.getChangeRequestStack === undefined
      ? {}
      : { getChangeRequestStack: wrap("getChangeRequestStack", api.getChangeRequestStack) }),
    getChangeRequestActivity: wrap("getChangeRequestActivity", api.getChangeRequestActivity),
    ...(api.getReviewThreadComments === undefined
      ? {}
      : {
          getReviewThreadComments: wrap("getReviewThreadComments", api.getReviewThreadComments),
        }),
    getViewerPermissions: interactive("getViewerPermissions", api.getViewerPermissions),
    getDiff: wrap("getDiff", api.getDiff),
    ...(api.getDiffFileContents === undefined
      ? {}
      : { getDiffFileContents: wrap("getDiffFileContents", api.getDiffFileContents) }),
    ...(api.getFilesViewed === undefined
      ? {}
      : { getFilesViewed: wrap("getFilesViewed", api.getFilesViewed) }),
    ...(api.setFilesViewed === undefined
      ? {}
      : { setFilesViewed: interactive("setFilesViewed", api.setFilesViewed) }),
    ...(api.getFileRevisions === undefined
      ? {}
      : { getFileRevisions: wrap("getFileRevisions", api.getFileRevisions) }),
    runAction: interactive("runAction", api.runAction),
    ...(api.updateChangeRequest === undefined
      ? {}
      : {
          updateChangeRequest: interactive("updateChangeRequest", api.updateChangeRequest),
        }),
    comment: interactive("comment", api.comment),
    ...(api.updateComment === undefined
      ? {}
      : { updateComment: interactive("updateComment", api.updateComment) }),
    submitReview: interactive("submitReview", api.submitReview),
    listReviewerCandidates: interactive("listReviewerCandidates", api.listReviewerCandidates),
    setReviewerRequest: interactive("setReviewerRequest", api.setReviewerRequest),
    ...(api.listLabelCandidates === undefined
      ? {}
      : { listLabelCandidates: interactive("listLabelCandidates", api.listLabelCandidates) }),
    ...(api.setLabels === undefined ? {} : { setLabels: interactive("setLabels", api.setLabels) }),
    replyToThread: interactive("replyToThread", api.replyToThread),
    setReaction: interactive("setReaction", api.setReaction),
    setThreadResolution: interactive("setThreadResolution", api.setThreadResolution),
  };
  // Optional provider methods must be forwarded too; returning the interface alone permits omissions.
  return wrapped satisfies PullRequestProviderApi &
    Record<Exclude<keyof PullRequestProviderApi, keyof typeof wrapped>, never>;
}

// Capture before the provider read so a slow response keeps its original freshness through caches.
export const observeRead = Effect.fnUntraced(function* <A, E, R>(read: Effect.Effect<A, E, R>) {
  const observedAt = yield* Clock.currentTimeMillis;
  return { value: yield* read, observedAt };
});
