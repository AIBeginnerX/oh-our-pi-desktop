# Terminal app

`oop` is OOP in a terminal. Pick a project and a thread, chat with an agent, approve what it
wants to do, and set up providers without opening the desktop window. Your threads, providers,
and settings are the same ones the desktop app shows.

## Get started

On macOS the app adds the `oop` command the first time it runs, and the one-line install adds it
too; on Windows the OOP installer adds it along with the app. Open a new terminal window and run:

```sh
oop
```

If the shell says `command not found`, the folder holding `oop` is not on your `PATH`: add
`~/.local/bin` on macOS or `%LOCALAPPDATA%\oop-terminal` on Windows. The installer does not edit
`PATH`, and it leaves alone an `oop` it did not create.

`oop --help` lists everything. The ones you will use most:

| Task                                    | Command                      |
| --------------------------------------- | ---------------------------- |
| Resume the latest thread of this folder | `oop --continue`             |
| Start a thread with a first message     | `oop "fix the login bug"`    |
| Manage providers                        | `oop provider`               |
| Connect to OOP on another computer      | `oop pair <link>`            |
| Work on another computer over SSH       | `oop ssh <host>`             |
| Connect a phone with a QR code          | `oop mobile` or `/mobile`    |
| Check your setup                        | `oop doctor`                 |
| See what is new in the latest release   | `oop update`                 |
| Stop the server the terminal started    | `oop stop`                   |
| Change a setting, such as the language  | `oop config set language ko` |

If you used an earlier terminal app, nothing changes for you: the commands, `settings.json`,
saved logins and threads are the same, and `OOP_TUI=ts` is no longer read.

## Work on another computer over SSH

`oop ssh devbox` opens OOP on a host you can reach with `ssh`, so you work on that machine's
projects and threads. `devbox` can be `user@host` or an alias from `~/.ssh/config`. Password and
passphrase prompts appear in the terminal before the screen opens, and so does the question about
an unknown host key. If you refuse it, or the key changed, `oop` shows ssh's own message and says
to check `~/.ssh/known_hosts`.

It uses the same server folder on the host (`~/.oop-desktop`) as the desktop app's SSH
connections: a server that is already running is reused, and otherwise the terminal starts one
from the newest runtime installed there. If the host has none, connect to it once from the desktop
app (**Settings -> Connections -> Add environment -> SSH**). The terminal does not copy a runtime
over. The server keeps running on the host when you close `oop`; the SSH tunnel closes. Run
`oop ssh devbox` again to reconnect; the saved login is reused.

## Other computers

`/computers` lists the computers the desktop app can reach: the first row is this computer, then
one row per other computer with whether it is online. Enter switches this terminal to that
computer's projects and threads — the same ones the desktop sidebar shows — and its name stays in
the title of the lists while you work there. Enter on this computer switches back. On the project
list, **Ctrl+O** opens the same picker.

A computer only appears in the list while the OOP desktop app is running and its connection is
switched on for the phone (Settings → Connections, **Available on phone**). Enter on a computer
that is offline, or whose saved sign-in was refused, says so instead of switching. Without the
desktop app, `oop ssh <host>` still connects to a computer on its own.

While you are on another computer, `oop mobile`, pairing and `oop stop` keep concerning the
computer the terminal itself runs on.

## Over Tailscale

On a tailnet, either of these works from a Mac or Windows terminal to a host that runs OOP:

- `oop pair https://<machine>.<tailnet>.ts.net/pair#token=...` with a link from `t3 pair --tailscale`
  on the host. A bare token works with `--server <machine>.<tailnet>.ts.net`. The connection is
  HTTPS, and `oop` trusts Tailscale's certificates without any setup.
- `oop ssh <machine>.<tailnet>.ts.net` (or the `100.x` address), with the same prompts as any ssh.

A plain `http://100.x.x.x:<port>` link also pairs, but `oop` warns that it is not HTTPS.

## OOP Terminal and splits

On macOS the desktop app also installs **OOP Terminal**, a window of its own that runs `oop` and
ordinary shells side by side. Open it from `~/Applications` (or `/Applications`, if you used the
`.pkg` update), like any app. Use it to keep several threads, or a thread and a shell, on one screen:

| Task                                    | Shortcut                          |
| --------------------------------------- | --------------------------------- |
| Split right, with `oop` in the new pane | `Cmd+D`                           |
| Split down, with `oop` in the new pane  | `Cmd+Shift+D`                     |
| Split toward an arrow, with `oop`       | `Cmd+Option+Arrow`                |
| Split toward an arrow, with a shell     | `Cmd+Option+Shift+Arrow`          |
| Move to the previous or next pane       | `Cmd+Option+[` and `Cmd+Option+]` |
| Zoom the pane, or return                | `Cmd+Shift+Enter`                 |
| Close the pane, open a new window       | `Cmd+W`, `Cmd+N`                  |

OOP Terminal is not required: `oop` works in Terminal, iTerm, or any other terminal, and the
splits in this window are separate from the side panels `oop` opens inside a thread
(`/dag-workflow`, `/tasks`).

## Start with a message

`oop "fix the login bug"` opens a new thread in the project of the current folder, sends the
message, and carries on in the usual conversation. With `--continue` the message goes to the
latest thread instead. The model and permission mode are the ones a conversation starts with;
`--mode` sets the mode.

If the folder belongs to no project, `oop` asks you to pick one and then sends the message. A
message that starts with `/` is read as a command, as it would be in the conversation. A single
word that is not a command name, or a message that starts with `-`, goes after `--`:
`oop -- explain`. The terminal does not read piped input, so `echo ... | oop` does not work.

## Messages while the agent works

Press Enter while a turn runs and the message waits above the composer; it is sent after the turn
ends, one message per turn, in the order you typed them. On an empty composer, Up takes the newest
waiting message back so you can edit it (Enter queues it again) or clear it. Esc and Ctrl-C stop the
turn and put every waiting message back in the composer.

Waiting messages stay with their thread and are kept only while `oop` is open. A thread that ends
in an error, or one you left and came back to, stops its queue: press Enter on an empty composer to
let it go on.

## Provider commands and skills

Typing `/` lists the commands built into `oop` and, after them, the slash commands and skills the
current provider offers for the project folder, marked `[provider]` and `[스킬]`. Picking one puts
its name in the composer (`/name ` for a command, `$name ` for a skill) so you can add what it
needs, then press Enter to send. When a provider command has the same name as one of `oop`'s, the
`oop` command is the one that runs. The list comes from the same place as in the desktop app; a
project's own commands can take a moment to appear after you open a thread.

### Skills OOP ships

`/skills` lists the skills that come with OOP (`paper-analysis`, `deep-research`, and others) and
whether each is installed for Claude Code and for Codex and Cursor. Pick a row, or run
`/skills install <name>`, to install one into both. Nothing already there is replaced; a different
skill with the same name is reported and left alone. Once a skill is installed, `/name` (or
`$name`) followed by your request runs it, for example `/paper-analysis arxiv:1706.03762`.

## Pasting long text

A long paste is kept whole but drawn in a window of at most ten rows; the rows above or below it
are counted ("↑ N줄 더", "↓ N줄 더") and the window follows the cursor. A message can be at most
120,000 characters, the limit of the server; a longer one is not sent, and `oop` says how many
characters to cut.

## Copying a command

`/copy` puts the last code block of the agent's latest answer on the clipboard exactly as written,
with no fences, indentation or line wrapping and no trailing newline, so a pasted command does not
run until you press Enter. `/copy 2` copies block 2 and `/copy all` every block, one after another.
When an answer has several blocks, each shows its number in its header; with one block the header
says `/copy`. An answer with no block but exactly one `inline` code span copies that span. Over SSH
and in most terminals the copy goes through the terminal (OSC 52); a terminal that ignores OSC 52
does not receive it.

## Knowing when the agent needs you

`oop` rings the terminal bell when a turn finishes and when the agent asks for an approval or an
answer, so a terminal in another window or tab can flag itself. A request is rung for once, and one
that was already waiting when you opened the thread is not. Turn it off with
`oop config set notify false`. The bell is the only signal; it does not check whether the terminal
is the window you are looking at.

## Mocha

The header of a tall terminal has a small coffee mug, Mocha, who reacts to what the agent is doing:
she steams while idle, bubbles while it thinks, stirs while it uses a tool, perks up while text
arrives, waits for you when an approval or an answer is needed, cheers when a turn ends well, looks
upset on an error or a lost connection, and dozes after a quiet while until a key press wakes her.
On a terminal too short for the full header she shrinks to a small cup at the end of the first
line, and she is left out when there is no room.

Her coffee takes the colour of the provider you are talking to: orange for Claude, green for Codex,
purple for a local model (Ollama, or a local model in OpenCode), and brown for the others. Switching
the model with `/model` gives her a small hop and a colour wave. With few colours, no colour
(`NO_COLOR`), or ASCII symbols she is drawn with plainer shapes.

Turn her off and on with `/pet off` and `/pet on`, or `oop config set pet false`. She holds still
when animations are off (`oop config set animations false`) and while the terminal window is not
focused.

## Provider usage

The bottom of the left pane shows each provider's usage limit as a compact gauge: the filled part
of the bar is what is used, with the percentage and, when there is room, the time until it resets.
Claude and Codex update while you work; other providers
refresh about every five minutes. Turn the panel off and on with `/usage off` and `/usage on`, or
`oop config set usage false`. It is left out when the pane is short.

## Find and pin threads

On the project and thread lists, start typing to narrow the list: threads match on their title,
projects on their title or folder, Korean included. Because letters go to the search, the lists
have no one-letter shortcuts. Use the arrows to move, Enter to open, and Esc to clear the search or
step back (thread list, then project list, then the conversation you came from). Ctrl+C quits.

On the thread list, **Ctrl+P** pins the thread under the pointer, or unpins it. Pinned threads sit
at the top of the list and are the same pins the desktop app shows.

## Read earlier messages

Opening a thread prints its last 30 messages, and a line under the header says when there are
more. `/history` prints the 30 messages before those, and `/history 100` prints up to 100 (at most
200). Run it again to keep going back; it says when it reaches the start. The messages are printed
again at the bottom, under the conversation, because a terminal cannot add lines above what it
already shows. In the side-by-side layout they are added to the bottom of the conversation pane.

While a reply is being written it says so and prints nothing, so it does not land in the middle
of the reply; run it again once the reply ends. Older messages are fetched from the server a page
at a time, so a long thread opens as fast as a short one.

## Review and undo a turn

Each turn ends with a checkpoint when the project is a git repository. In a conversation:

- `/diff` shows what the last turn changed. `/diff 2` shows turn 2, and `/diff 2 src/app.ts`
  shows one file in full. A long diff stops after a few hundred lines and says so. Like
  `/history`, it is refused while a reply is being written.
- `/undo` removes the last turn from the conversation and puts your question back in the
  input. It asks for confirmation first and cannot run while the agent is working. Messages
  waiting in the queue go back to the input too, after the question, since they may have
  assumed the turn that is gone.

Files are restored only for a thread that has its own worktree. In a folder shared with other
threads, `/undo` rewinds the conversation and leaves your files alone, as the desktop app does.
There is no way to undo an undo, in the terminal or in the desktop app.

## With and without the desktop app

With the app open, `oop` connects to its server on its own.

With the app closed, `oop` starts the installed app's server in the background, and no window
opens. That server keeps running after you close the terminal, so your threads stay available;
`oop stop` stops it. `oop stop` never stops the server the app is using.

Only one server uses your OOP data at a time. When you open the app, it takes over from the
terminal's server and `oop` reconnects on its own. When you quit the app while a terminal is open,
that terminal starts its server again after a few seconds. A turn that is running when the server
changes hands is interrupted, unless **Settings → General → Continue threads after restarts** is
on.

Without the desktop app, install the terminal app on its own (INSTALL.md, "Terminal app only"). It carries its own server and
needs no OOP Desktop. The Linux AppImage does not include the terminal app.

## Connect a phone

`/mobile` (or `oop mobile`) shows the QR code from the app's **Connect mobile** dialog: scan it with
the phone camera to open OOP in the phone's browser. It uses the relay address saved in the app, so
it works away from home. Without one, the phone must be on the same network. Press Esc to close.

If this computer publishes the server with Tailscale Serve (`t3 serve --tailscale-serve`), a
**Tailscale HTTPS** route is offered too, for a phone with the Tailscale app on the same tailnet.
The relay stays the first choice; press Tab to switch between routes. `oop mobile` prints the
other routes' links under the code.

The code works for one phone and expires after a few minutes; run the command again for a new one.
It needs the OOP server on the same computer, and in the app, mobile connections allowed (and the
relay address saved) under **Connect mobile**.

## Task list

`/tasks` opens the thread's task list under the conversation, on the left of the terminal, and
`/tasks` again closes it. It shows the steps the agent is keeping (waiting, in progress, done) and
how many are done, and it keeps the last list after the turn ends. An agent that keeps no list
leaves it empty. The terminal switches to a full-screen view while the list is open, and it needs
a terminal at least 16 rows tall. It works with or without the side panels of `/dag-workflow`.

## Plans

When a turn in plan mode (`/plan`) ends with a proposed plan, it is printed in the conversation once,
with a line saying how to build it. `/implement` sends the latest plan back to the agent in the
default mode, the same as the desktop app's implement button. Send a message instead to keep
refining the plan.

## Updates

The terminal app is part of the desktop app, so updating the app updates `oop` and OOP Terminal
too. On macOS, both the in-app update and the `.pkg` update replace `OOP Terminal.app`; the `.pkg`
leaves alone an app of that name that is not OOP's. A terminal-only install is updated by running
its install command again. `oop update` shows what changed since your version; it does not
install anything.
