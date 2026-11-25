# Environment authentication

The environment issues its own sessions and enforces their capabilities. Cloud
identity and relay credentials belong to a separate trust boundary, described in
[OOP Connect](./t3-connect.md). A relay token is never an environment login.

## Authority survives transport changes

Pairing delegates a set of scopes. Exchanging a bootstrap credential can narrow
that grant but cannot widen it. Ordinary pairing does not grant access-management
or relay-management authority. Creating another pairing link requires both
`access:write` and every scope being delegated. The
[auth handlers](../../apps/server/src/auth/http.ts) enforce this at issuance;
client labels and device metadata have no authorization role.

The access read model contains pairing metadata, never recoverable pairing
secrets. Only the creation response returns the raw credential. Otherwise read
access to the connections list would become a way to acquire another client's
authority.

Browser cookies, bearer tokens, and DPoP tokens adapt the same scoped session
model. DPoP binds a token to a client's proof key; an invalid proof must fail
rather than fall back to bearer authentication. The OAuth token-exchange
vocabulary gives these grants a familiar meaning.

### MCP clients are a separate audience

Agents OOP did not launch sign in to `/mcp` through a narrow OAuth
authorization-code server ([McpOAuth](../../apps/server/src/auth/McpOAuth.ts)).
It accepts loopback redirect URIs for agents on the user's machine and any
HTTPS redirect for hosted agents (ChatGPT, bots). An HTTPS redirect means a
link someone else sends the owner can deliver access to that someone, so the
approval page names the host access goes to and approving stays the owner's
call. Every client is public and proves itself with PKCE; a client that asks
for a secret is registered without one. Client registration is stateless, so an
unauthenticated caller cannot grow server state. Approval spends a one-time
pairing code, or uses a browser session with `access:write`; proof-bound OOP
Connect codes are refused without being spent.

The user grants either read-only access or a runtime-mode ceiling, not a
scope list: MCP tools are all orchestration, and `orchestration:operate`
alone would let an agent start a thread in full access and act through it.
The result is an ordinary session with subject `mcp-client`. A read-only
grant holds `orchestration:read` alone; any other grant adds
`orchestration:operate` and a signed ceiling (`rtc`). Only `/mcp` accepts these
sessions. Every other HTTP and WebSocket path rejects that subject, because the
RPC surface would let the agent act above its ceiling. Inside `/mcp`,
[McpInvocationContext](../../apps/server/src/mcp/McpInvocationContext.ts) keeps
outside clients distinct from thread-bound provider sessions and refuses
thread-only tools before their handlers run.

Issuer and resource URLs come from the request's Host and
`X-Forwarded-Proto`, so one server answers over loopback, Tailscale Serve and an
OOP Connect tunnel. A proxy that rewrites Host or drops the protocol header
breaks sign-in.

Bearer and DPoP clients obtain short-lived WebSocket tickets through authenticated
HTTP so long-lived tokens stay out of socket URLs. Browser sessions can
authenticate the upgrade with their cookie. Cookies are not port-scoped, so a
cookie-authenticated upgrade that carries an `Origin` header must come from a
host the server is reached at: the request's `Host`, the host a reverse proxy
reports in `X-Forwarded-Host` (first entry) or `Forwarded: host=`, the dev URL,
a configured dev origin, or the desktop renderer. An upgrade whose
`Sec-Fetch-Site` is `same-origin` also passes: browsers set it and page JS
cannot forge it, which covers a proxy that rewrites `Host` without forwarding
the original. A browser cannot set the forwarding headers on a WebSocket
handshake, so a foreign page still fails.
The desktop relay tunnel re-opens the phone's socket on loopback, so it
replaces any forwarding headers from the phone with `X-Forwarded-Host` set to
the relay's own host; the Vite dev proxy keeps the browser's `Host` on `/ws`
for the same reason. Requests without `Origin` are not browsers and are
unaffected, as are ticket, bearer, and DPoP upgrades. A successful handshake grants no
extra authority: [every RPC declares a required
scope](../../apps/server/src/auth/RpcAuthorization.ts).

Desktop restarts forget the previous local bearer token, so its reusable
bootstrap grant replaces earlier sessions for the same subject and method.
Revocation and insertion share a [database
transaction](../../apps/server/src/persistence/AuthSessions.ts); a failed
replacement must leave the old credential usable. Pairing and browser sessions
do not follow this replacement rule.

### Reusable dev credential

Web development environments can accept one `T3CODE_DEV_AUTH_TOKEN` across
worktrees and ports on one hostname. The token and startup URLs that contain it
grant administrative access. Desktop and non-development servers ignore it. See
the [development runbook](../operations/development.md#reusable-dev-credential)
for setup.

Each environment hashes the value and seeds its own database record at startup.
Environments do not share SQLite data, signing keys, environment IDs, session
records, pairing grants, or revocation state. Local revocation persists after
restart and does not affect another worktree. Removing or rotating the value
and restarting invalidates the old credential and its WebSocket tickets.

Normal credentials keep precedence. A rejected normal credential never falls
back to the reusable credential. OAuth exchanges create ordinary local bearer
or DPoP children with normal expiry and revocation. The reusable cookie expires
after 30 days.

## Filesystem access follows session scope

Without `orchestration:operate`, filesystem reads are confined to registered
roots of active projects and live thread worktrees. An explicit working
directory must name one of those roots, and file targets must remain inside
the authorized workspace after symlink resolution. Absolute media paths can
resolve inside any registered root or live worktree.

A session with `review:write` can read VCS status and refs in directories
accepted by the review service. Repository lookup without a working directory
uses the server default. Server-managed attachments, native app icons, and
recorded workflow scripts are addressed by their server-managed references.

`orchestration:operate` permits host filesystem browsing, provider session
discovery, and opening supported files by absolute path, including artifacts
an agent writes to a temporary directory. Relative paths and writes follow the
[workspace path rules](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

Signed asset URLs are bearer credentials. A URL for media on the host grants
access to one canonical file and its device/inode identity, not its containing directory.
[Asset access](../../apps/server/src/assets/AssetAccess.ts) rechecks the opened
file's identity when serving it, so atomic replacement requires a new URL while
editing the same file in place does not. An HTML file authorized this way cannot
load sibling assets; directory-scoped workspace previews are a separate grant.
Clients should share the authored file reference so they do not disclose the
temporary URL's credential.

Host videos can change in place. Their [HTTP
responses](../../apps/server/src/http.ts) omit cache validators because file
metadata cannot prove byte-for-byte identity for `If-Range`. Adding weak
validators would turn native-player seeks into full downloads.
