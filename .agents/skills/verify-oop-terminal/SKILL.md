---
name: verify-oop-terminal
description: Drive and prove behavior of OOP's Rust terminal app (oop-rs, apps/oop-tui-rs) the way a user does - an isolated server plus the interactive TUI in a private tmux session, real Claude turns with a small model, colour-preserving pane captures. Use to verify a change to the TUI (Savvy progress bar, panels, composer, slash commands) or `oop-rs status`; not for the web, desktop or mobile clients (use test-t3-app / test-t3-mobile).
---

# Verify the OOP Rust terminal (oop-rs)

Surface: a full-screen TUI that talks to an OOP server. `oop-rs` finds a server through
`<home>/userdata/server-runtime.json` or starts one. This skill runs one isolated pair per run
(own home, own port from 3873, own tmux socket) so it never touches the developer's OOP.

Hard rules (from AGENTS.md): never kill by process name or pattern, only the PIDs this run
recorded; never use `~/.t3/userdata`, `~/.oop-desktop`, port 3773, `~/.local/bin/oop*` or
`OOP.app`; never read, copy or link credentials. The server inherits your normal `HOME`, so the
provider CLIs use their existing login; that is the only way auth is involved.

Scripts are in `scripts/` (executable). `S=.agents/skills/verify-oop-terminal/scripts`. All but
`launch.sh` need `RUN=<id>` in the environment.

## Launch

```bash
$S/launch.sh        # prints: export RUN=<id>   # evidence: /tmp/oop-verify-evidence/<id>
export RUN=<id>
```

It runs `cargo build` in `apps/oop-tui-rs` (reuses the existing `target/`; never set
`CARGO_TARGET_DIR`, disk is tight), creates `/tmp/oop-verify-run-<id>/{home,repo}` (repo is a
real git repo with one commit), and starts in tmux (`-L verify-oop-<id>`, 200x50) with
`OOP_HOME=<home> OOP_DAEMON_ENTRY=<this checkout>/apps/server/src/bin.ts OOP_RS_FIRST_PORT=3873
COLORTERM=truecolor LANG=en_US.UTF-8`. `OOP_DAEMON_ENTRY` is what lets an isolated home start a
server (node runs `bin.ts serve --daemon --base-dir <home> --port <3873+ free>`). Ready means: the
daemon wrote `server-runtime.json`, the TUI drew `Threads`, and `oop-rs status` reports
`claudeAgent … status=ready` (the provider probe takes several seconds after the port opens).
Launch records `TUI_PID`, `SERVER_PID`, `SERVER_PORT`, `GIT_HEAD` in `$EVID/run.env`.

## Doctor

```bash
$S/doctor.sh        # read-only; exit 0 = worth driving
```

Checks: tmux session on our socket; TUI pid runs our `oop-rs` with cwd = the throwaway repo;
daemon pid equals the one in our `server-runtime.json`, its args carry our `--base-dir` and this
checkout's `bin.ts`; port owned by that daemon and not 3773; the binary is newer than the last
commit touching `apps/oop-tui-rs/src`; Claude `ready` + `authenticated`. Any `FAIL`: run cleanup,
fix, launch again; do not drive it.

## Drive

`$S/drive.sh <cmd>` (full list in its header): `key`, `type`, `say` (type + Enter), `wait <regex>`,
`waitgone <regex>`, `cap <label>`, `sample`, `watch`, `model <filter>`, `open-project`.
Handles are on-screen strings, not coordinates: `Threads`, `Type a message and press Enter`,
`type to filter`, `Model: claudeAgent/…`, `Idle . nothing is running`, `plan steps`, `Working`.
First steps of any run: `open-project`, `model haiku-4-5` (cheapest sufficient), `say /savvy`.
A turn that shows a plan needs a prompt that makes the agent use TodoWrite, see the recipe in
[features/savvy-progress.md](features/savvy-progress.md). Pick the feature in
[features/README.md](features/README.md) and follow its recipe.

## Evidence

Everything goes to `/tmp/oop-verify-evidence/<id>/` and survives cleanup:
`captures/NN-<label>.ansi` (`tmux capture-pane -p -e`, truecolor escapes, needed to prove colour
and glow) and `.txt` (plain), `commands.log`, `run.env`, `bars.txt` (from `$S/summarize.sh`),
`status-after.txt` (save `OOP_HOME=$WORK/home $BIN status` there before cleanup),
`server-logs/` (copied by cleanup).

Proof standards: drive the real path (type in the composer, press Enter), never edit state or call
the server API to fake a turn; capture the action (just sent) and the result (running, done), not
only the last screen; check the side effect on the server (`oop-rs status` shows the project and
thread); read pane contents with `$S/pane.py bar|right|walker <cap>.ansi` and quote rows in the
report. A real model turn is the production boundary: no mocks. Verify what the check skips: an
absence check (`walker: none`) is only meaningful alongside a frame where the pane is drawn.

## Cleanup

```bash
$S/cleanup.sh
```

Kills the private tmux server (our socket only), the recorded `TUI_PID` if still alive, and the
daemon: its pid is re-read from OUR home's `server-runtime.json` and killed only if its live
command line contains `--base-dir <our home>`. Then removes `/tmp/oop-verify-run-<id>`. Never
touches the evidence. Re-run it after any failed attempt. Afterwards confirm
`ls /tmp/oop-verify-evidence/<id>` still lists captures and that the port is free.

## Helpers

| script                 | use                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `scripts/launch.sh`    | build + isolated home/repo + TUI in tmux; prints `export RUN=`                           |
| `scripts/doctor.sh`    | read-only health/identity check                                                          |
| `scripts/drive.sh`     | tmux driver, see header for subcommands                                                  |
| `scripts/pane.py`      | `bar <ansi>` bar row, fill, glow-lit cells; `right <f>` right pane text; `walker <ansi>` |
| `scripts/summarize.sh` | bar/walker summary of every capture into `bars.txt`                                      |
| `scripts/cleanup.sh`   | PID-exact teardown, keeps evidence                                                       |
| `scripts/common.sh`    | sourced by the above                                                                     |

## Isolation and gotchas

- Concurrent runs are fine (unique `RUN`, socket, home; ports scan upward from 3873). Do not drive
  a daemon this run did not start; the installed app's 3773 and `~/.oop-desktop` are off limits.
- The server is started by `oop-rs` itself, detached (own session); the TUI exiting does not stop it.
- Real turns cost subscription usage; keep prompts short, Haiku only, `sleep 4` steps.
- Needs tmux at `/opt/homebrew/bin/tmux` (override `TMUX_BIN`), node, python3, git, lsof.
- Stand-in notes for reports: model turns are real, but Claude is reached through the machine's own
  login, the repo is a toy repo, and the pane is a fixed 200x50 truecolor tmux, not the user's terminal.
