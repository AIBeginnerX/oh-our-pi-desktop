/** How many of a reaction's people the hover names before it counts the rest. */
export const REACTORS_PER_GROUP = 10;

/**
 * A reaction group as every reactable node reports it. `reactors` is bounded rather than paged:
 * a hover says who reacted, and a hundred and forty names is a count, not a sentence.
 */
export const REACTION_GROUPS_FIELDS = `reactionGroups {
  content
  viewerHasReacted
  reactors(first: ${REACTORS_PER_GROUP}) {
    totalCount
    nodes {
      ... on User { login }
      ... on Bot { login }
      ... on Organization { login }
      ... on Mannequin { login }
    }
  }
}`;

/** Resolves a listing's authors to avatars, which no `gh` JSON field carries. */
export const ACTOR_AVATARS_GRAPHQL_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on User { login avatarUrl }
    ... on Bot { login avatarUrl }
  }
}`;

export const PULL_REQUEST_LIST_JSON_FIELDS =
  "number,title,url,author,headRefName,baseRefName,state,isDraft,mergeable,reviewDecision,additions,deletions,createdAt,updatedAt,mergedAt,reviewRequests,latestReviews,labels,statusCheckRollup";

export const PULL_REQUEST_DETAIL_JSON_FIELDS = `${PULL_REQUEST_LIST_JSON_FIELDS},body,changedFiles,closedAt,isCrossRepository,headRepositoryOwner,headRefOid,autoMergeRequest`;

/** Pull refs let the comparison share the detail read without first resolving a fork branch. */
export const PULL_REQUEST_CORE_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $headRef: String!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerPermission
    pullRequest(number: $number) {
      number title url body state isDraft mergeable reviewDecision
      additions deletions changedFiles createdAt updatedAt mergedAt closedAt
      headRefName baseRefName headRefOid isCrossRepository
      headRepositoryOwner { login }
      author { login avatarUrl ... on User { id name } }
      autoMergeRequest { mergeMethod }
      viewerCanUpdate viewerDidAuthor viewerCanUpdateBranch
      baseRef { compare(headRef: $headRef) { behindBy } }
      reviewRequests(first: 100) {
        nodes { requestedReviewer { ... on User { login name } ... on Bot { login } ... on Team { slug name } } }
      }
      labels(first: 100) { nodes { name color } }
      commits(last: 1) {
        nodes { commit { statusCheckRollup { contexts(first: 100) {
          nodes {
            __typename
            ... on StatusContext { context state targetUrl createdAt description }
            ... on CheckRun {
              name status conclusion startedAt completedAt detailsUrl
              checkSuite { workflowRun { workflow { name } } }
            }
          }
          pageInfo { hasNextPage }
        } } } }
      }
    }
  }
}`;

export const PULL_REQUEST_PREVIEW_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url state isDraft createdAt
      author { login avatarUrl ... on User { name } }
    }
  }
}`;

export const PULL_REQUEST_ACTIVITY_JSON_FIELDS = "author,comments,reviews,commits";

/** GitHub's own ceiling on a connection page, which is what both thread reads ask for. */
export const GRAPHQL_PAGE_SIZE = 100;

/**
 * The ceiling on `search`, which refuses anything larger with EXCESSIVE_PAGINATION (measured:
 * `first: 101` is an error, `first: 100` is not).
 */
export const PULL_REQUEST_SEARCH_MAX_ROWS = GRAPHQL_PAGE_SIZE;

/**
 * Every repository of a host in one read, which is what makes a listing one request rather than
 * one process per repository.
 *
 * `additions` and `deletions` are deliberately absent: measured over twelve repositories at a
 * hundred rows, this query answers in ~4.0s with them left out and ~7.1s with them in, for two
 * numbers at the end of a row. They are read afterwards, by `buildPullRequestStatsGraphQlQuery`.
 *
 * The row count is written into the document rather than sent as a variable because every
 * variable here travels as a string — and it is this module's own number, clamped by the caller,
 * never a reader's.
 *
 * `first` on the two inner connections is a bound rather than a page: a pull request with more
 * than twenty labels shows twenty, and one that has asked more than twenty people for a review
 * is already past what a row can say.
 */
export function pullRequestSearchGraphQlQuery(rows: number, includeStacks = false): string {
  return `query($q: String!) {
  search(query: $q, type: ISSUE, first: ${Math.min(Math.max(Math.trunc(rows), 1), PULL_REQUEST_SEARCH_MAX_ROWS)}) {
    pageInfo { hasNextPage }
    nodes {
      ... on PullRequest {
        ${includeStacks ? "stack { number size baseRefName } stackEntry { position }" : ""}
        number
        title
        url
        author { __typename login avatarUrl ... on User { name } }
        headRefName
        baseRefName
        state
        isDraft
        mergeable
        reviewDecision
        latestReviews(first: 20) { nodes { state author { login } } }
        createdAt
        updatedAt
        mergedAt
        repository { nameWithOwner }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
        labels(first: 20) { nodes { name color } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;
}

/**
 * One page of review threads with their comments, and the people on the review. `$cursor` is
 * null for the first page and the last page's `endCursor` after that, so a pull request with
 * more threads than one page holds is walked rather than cut off at the first fifty.
 *
 * Only ten comments ride with each thread. A hundred threads times a hundred comments made
 * GitHub reserve 10,000 nested rows and charge 104 points; unfinished threads are paged from
 * their own cursor below.
 *
 * Reviewers come from here rather than from `gh pr view --json reviewRequests` for two reasons:
 * that field holds only requests still outstanding, so anyone who has already reviewed drops off
 * it, and neither it nor any other `gh` JSON field carries an avatar. A reviewer can be a person
 * or an app, and both are asked for by name because they are different GraphQL types.
 *
 * `viewerCanUpdate` and `viewerDidAuthor` ride along here for the same reason: they belong to the
 * pull request this query is already standing on, so what the reader may do with it arrives with
 * the conversation rather than costing a request of its own.
 *
 * Commits are asked for with `last` rather than `first`: `gh pr view --json commits` pages from
 * the start, so a pull request with more than a hundred commits loses the newest ones from its
 * view entirely. This query gives back the newest hundred, which is what a reader scoping a diff
 * wants, and stands in for the `gh` list wherever it came back non-empty.
 */
export const REVIEW_THREADS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${GRAPHQL_PAGE_SIZE}, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          diffSide
          comments(first: 10) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { id author { __typename login avatarUrl } body createdAt url ${REACTION_GROUPS_FIELDS} }
          }
        }
      }
      viewerCanUpdate
      viewerDidAuthor
      author { __typename login avatarUrl }
      ${REACTION_GROUPS_FIELDS}
      comments(first: ${GRAPHQL_PAGE_SIZE}) {
        nodes { id author { __typename login avatarUrl } ${REACTION_GROUPS_FIELDS} }
      }
      reviews(first: ${GRAPHQL_PAGE_SIZE}) { nodes { id author { __typename login avatarUrl } ${REACTION_GROUPS_FIELDS} } }
      reviewRequests(first: 50) {
        nodes {
          requestedReviewer {
            ... on User { login name avatarUrl }
            ... on Bot { __typename login avatarUrl }
          }
        }
      }
      latestReviews(first: 50) {
        nodes { state author { __typename login avatarUrl } }
      }
      reviewDismissals: timelineItems(itemTypes: [REVIEW_DISMISSED_EVENT], first: ${GRAPHQL_PAGE_SIZE}) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on ReviewDismissedEvent { dismissalMessage review { id } } }
      }
      commits(last: ${GRAPHQL_PAGE_SIZE}) {
        nodes {
          commit {
            oid
            messageHeadline
            committedDate
            additions
            deletions
            parents(first: 1) { totalCount }
            authors(first: 3) { nodes { name avatarUrl user { login } } }
          }
        }
      }
    }
  }
}`;

/**
 * The rest of one thread's conversation. GraphQL pages a connection nested inside another only
 * from the inner node itself, so a thread longer than a page is followed on its own — a request
 * GitHub makes necessary, and one no ordinary pull request ever provokes.
 */
export const REVIEW_THREAD_COMMENTS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $threadId: ID!, $cursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      pullRequest { id }
      comments(first: ${GRAPHQL_PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id author { __typename login avatarUrl } body createdAt url ${REACTION_GROUPS_FIELDS} }
      }
    }
  }
}`;

export const REVIEW_THREAD_REPLY_GRAPHQL_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`;

/**
 * The pull request's own node id, which is what a reaction on its description is addressed by.
 * Read only when one is being written: the conversation carries an id for every remark in it, and
 * the pull request is the one subject nothing in it names.
 */
export const PULL_REQUEST_NODE_ID_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;

/**
 * Where a client-given reaction subject actually hangs: the pull request itself, or the pull
 * request an issue comment, a review comment, or a review belongs to. Read before a mutation
 * reaches it, so a subject named for one pull request cannot react on another's behalf.
 */
export const REACTION_SUBJECT_PULL_REQUEST_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $subjectId: ID!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
  node(id: $subjectId) {
    id
    ... on IssueComment { pullRequest { id } }
    ... on PullRequestReviewComment { pullRequest { id } }
    ... on PullRequestReview { pullRequest { id } }
  }
}`;

export const ADD_REACTION_GRAPHQL_MUTATION = `mutation($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
}`;

export const REMOVE_REACTION_GRAPHQL_MUTATION = `mutation($subjectId: ID!, $content: ReactionContent!) {
  removeReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
}`;

export const RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`;

export const UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION = `mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`;

/**
 * Rewrites the pull request's own words. Both are nullable so that one document serves a change
 * to the title, to the description, or to the two together: a variable the request does not send
 * puts no entry in the input at all, which leaves that field as it was rather than clearing it.
 */
export const UPDATE_PULL_REQUEST_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!, $title: String, $body: String) {
  updatePullRequest(input: { pullRequestId: $pullRequestId, title: $title, body: $body }) {
    pullRequest { id }
  }
}`;

/** Creates a new pull request that reverses a merged pull request. */
export const REVERT_PULL_REQUEST_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!) {
  revertPullRequest(input: { pullRequestId: $pullRequestId }) {
    revertPullRequest { id }
  }
}`;

/**
 * The two comment mutations name their comment differently. The variable is spelled the same in
 * both, so a rewrite sends one set of variables whichever kind of remark it is.
 */
export const UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION = `mutation($commentId: ID!, $body: String!) {
  updateIssueComment(input: { id: $commentId, body: $body }) { issueComment { id } }
}`;

export const UPDATE_REVIEW_COMMENT_GRAPHQL_MUTATION = `mutation($commentId: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $commentId, body: $body }) {
    pullRequestReviewComment { id }
  }
}`;

/**
 * The dismissal events past the page the thread read carries. A pull request rarely has any:
 * this is followed only while the embedded page reports more.
 */
export const REVIEW_DISMISSALS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(itemTypes: [REVIEW_DISMISSED_EVENT], first: ${GRAPHQL_PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on ReviewDismissedEvent { dismissalMessage review { id } } }
      }
    }
  }
}`;

/** What a repository selector may hold before it is written into a GraphQL document unquoted. */
export const REPOSITORY_PART = /^[A-Za-z0-9._-]+$/;

/**
 * The line counts for rows a listing already handed over, as one aliased lookup each.
 *
 * Aliases rather than `nodes(ids:)` because the caller asks in the terms the page holds — a
 * repository and a number — and never sees a node id. Owner, name and number are written into
 * the document, so each is checked against what GitHub can actually name first: null for anything
 * else, which the caller reports rather than sends.
 *
 * Null too for an empty request, since a GraphQL document with no selection is not a document.
 */
export function buildPullRequestStatsGraphQlQuery(
  changeRequests: ReadonlyArray<{ readonly repository: string; readonly number: number }>,
): string | null {
  if (changeRequests.length === 0) return null;
  const selections: string[] = [];
  for (const [index, changeRequest] of changeRequests.entries()) {
    const [owner, name, ...rest] = changeRequest.repository.trim().split("/");
    if (rest.length > 0 || owner === undefined || name === undefined) return null;
    if (!REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(name)) return null;
    if (!Number.isSafeInteger(changeRequest.number) || changeRequest.number <= 0) return null;
    selections.push(
      `  s${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${changeRequest.number}) { additions deletions } }`,
    );
  }
  return `query {\n${selections.join("\n")}\n}`;
}

/** Stack membership for the visible rows of a per-repository listing. */
export function buildPullRequestStackMembershipsGraphQlQuery(
  repository: string,
  numbers: ReadonlyArray<number>,
): string | null {
  if (numbers.length === 0) return null;
  const [owner, name, ...rest] = repository.trim().split("/");
  if (rest.length > 0 || owner === undefined || name === undefined) return null;
  if (!REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(name)) return null;
  const selections: string[] = [];
  for (const [index, number] of numbers.entries()) {
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    selections.push(
      `  s${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) { stack { number size baseRefName } stackEntry { position } } }`,
    );
  }
  return `query PullRequestStackMemberships {\n${selections.join("\n")}\n}`;
}

/**
 * The fields a linked thread keeps current, for many pull requests in one aliased read. Same
 * shape as the search row where the two overlap: the checks arrive as GitHub's one-word rollup
 * rather than the whole check list `gh pr view` hands back, which is what keeps a batch cheap.
 */
export const PULL_REQUEST_SUMMARY_SELECTION =
  "number title url state isDraft mergeable reviewDecision additions deletions changedFiles " +
  "updatedAt mergedAt closedAt headRefName baseRefName " +
  "author { __typename login avatarUrl ... on User { name } } " +
  "latestReviews(first: 20) { nodes { state author { login } } } " +
  "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";

/**
 * Summaries for pull requests anywhere on one host, one aliased lookup each. Checked and written
 * into the document the way `buildPullRequestStatsGraphQlQuery` does, so null means "do not send".
 */
export function buildPullRequestSummariesGraphQlQuery(
  changeRequests: ReadonlyArray<{ readonly repository: string; readonly number: number }>,
): string | null {
  if (changeRequests.length === 0) return null;
  const selections: string[] = [];
  for (const [index, changeRequest] of changeRequests.entries()) {
    const [owner, name, ...rest] = changeRequest.repository.trim().split("/");
    if (rest.length > 0 || owner === undefined || name === undefined) return null;
    if (!REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(name)) return null;
    if (!Number.isSafeInteger(changeRequest.number) || changeRequest.number <= 0) return null;
    selections.push(
      `  s${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${changeRequest.number}) { ${PULL_REQUEST_SUMMARY_SELECTION} } }`,
    );
  }
  return `query PullRequestSummaries {\n${selections.join("\n")}\n}`;
}
