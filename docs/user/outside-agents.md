# Outside agents

Agents that OOP did not start can work with an environment through its MCP
server. They can list projects and threads, read messages, start or message
threads, answer a thread's approval requests and questions, and stop a turn.
This covers Claude Code or Codex in your own terminal, ChatGPT, and other
agents or bots that support remote MCP over HTTP with OAuth. Each agent signs
in once, and you choose what it may do.

## Get the MCP URL

In **Settings → Connections**, open an environment's menu and choose **Copy MCP
URL**. The URL is the environment's address followed by `/mcp`, for example:

```text
https://<environment-address>/mcp
```

Which addresses work depends on where the agent runs:

- **An agent on your own computers** can use `localhost` on the host, or any
  `https` address such as OOP Connect or
  [Tailscale HTTPS](./remote-access.md#tailscale-https). Signing in sends the
  agent's credentials to the environment, and agents only finish signing in over
  `https` or to `localhost`. A plain-`http` LAN or Tailscale address, such as
  `http://100.x.y.z:3773`, lets an agent find the environment but not finish
  signing in.
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet. Use an internet-reachable `https` address
  such as OOP Connect. A Tailscale address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. Enter a one-time pairing code from
**Settings → Connections** or from `oop server auth pairing create` on the
host. A browser already signed in to the environment with permission to manage
access can approve in one click without a pairing code, for any access level
that browser session already holds.

Choose what the agent may do. **Read only** is selected by default:

- **Read only** lets the agent list projects and threads and read messages. It
  cannot start, message, or change anything.
- **Supervised**, **Auto-accept edits**, **Auto**, and **Full access** also let
  the agent start and message threads in every project. No thread it starts or
  messages can run with more permissions than the level you pick. See
  [Permission modes](./permission-modes.md) for what each mode allows.

  The same levels also let the agent answer approval requests and questions
  and stop turns in those threads. So an agent approved above **Read only**
  can approve what its own threads ask for: the level you pick is the most a
  thread can do, not a promise that a person sees each approval. Each answer
  is recorded in the thread, so you can look later at what the agent decided.

## What outside agents can call

Outside agents can call these tools:

- `oop_project_list` — list active projects in the environment.
- `oop_thread_list` — list active threads in one project (pass `projectId`) or
  across every project (pass `allProjects: true`).
- `oop_thread_read` — read recent user and assistant messages from a thread.
  It also shows what the thread is waiting for: pending approval requests and
  pending questions, each with a request id.
- `oop_thread_start` — create a new thread in a project and start a turn
  (requires more than **Read only**).
- `oop_thread_send` — send a message to an idle thread (requires more than
  **Read only**).
- `oop_thread_approve` — answer one pending approval request by its request
  id: accept, decline, or cancel. It cannot allow something for the rest of the
  session or permanently, and it cannot accept a request to widen the agent's
  permissions (requires more than **Read only**).
- `oop_thread_answer` — answer a pending question from the agent (requires
  more than **Read only**).
- `oop_thread_interrupt` — stop the running turn of a thread (requires more
  than **Read only**).

Every other tool needs an agent running inside OOP. Calling one from an outside
agent returns an error explaining that it requires an agent running inside OOP.

## Claude Code

```sh
claude mcp add --transport http oop https://<environment-address>/mcp
claude mcp login oop
```

`claude mcp login` opens the sign-in page in your browser. On a machine without
a browser, add `--no-browser`, open the printed URL elsewhere, and paste the
final URL back when asked. `claude mcp list` shows `oop` as connected once you
approve.

## Codex

```sh
codex mcp add oop --url https://<environment-address>/mcp
codex mcp login oop
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `oop` with OAuth once you approve.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect,
including hosted apps like ChatGPT. Give it the MCP URL and choose **OAuth** for
authentication; the agent discovers the sign-in settings on its own without a
client ID or secret. Agents without OAuth support, or apps that require their
own static client ID, cannot connect.

## Remove an agent

Approved agents appear under **Settings → Connections** alongside other signed-in
clients. Revoke an agent there to cut off its access immediately. A sign-in
lasts 30 days; after that, the agent asks you to approve it again.
