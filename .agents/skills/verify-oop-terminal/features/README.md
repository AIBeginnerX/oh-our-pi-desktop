# oop-rs terminal verification map

The maintained source for what to verify in the OOP Rust terminal app (`apps/oop-tui-rs`, binary
`oop-rs`). Read this index, then the matching feature file, then drive it with
[`../SKILL.md`](../SKILL.md) (`launch.sh`, `doctor.sh`, `drive.sh`, `summarize.sh`, `cleanup.sh`).

## Baseline preconditions

- `RUN=<id>` from `scripts/launch.sh`: isolated `OOP_HOME`, throwaway git repo, private tmux
  socket `verify-oop-<id>`, a daemon started from this checkout (`OOP_DAEMON_ENTRY`), 200x50 pane,
  `COLORTERM=truecolor` (colour proof needs `capture-pane -e`).
- `scripts/doctor.sh` is all `ok` (Claude `status=ready auth=authenticated`; right after launch
  the provider probe has not finished, `launch.sh` waits for it).
- Turns use Claude `haiku-4-5` (`drive.sh model haiku-4-5`): the cheapest sufficient model, run by
  the CLI's existing login. No credential is read, copied or linked.
- Never drive an instance this run did not start. Never touch port 3773, `~/.oop-desktop`,
  `~/.t3/userdata`, the installed `OOP.app`.

## Driving conventions

- Prefer on-screen strings (`Threads`, `Idle . nothing is running`, `plan steps`, `Working`) over
  coordinates. `drive.sh wait` polls the plain screen; never `sleep` for a state.
- Every capture is `.ansi` (`capture-pane -p -e`, truecolor kept) plus `.txt`; `pane.py` reads
  the `.ansi`.
- A mutating step (send, `/model`) is followed by a capture of the action and one of the result.

## Proof and skip reporting

- Report each sub-feature with the capture names that show it; an unreachable path is reported
  with the command tried and the unmet precondition, not as verified through another path.
- Server-side proof: `oop-rs status` (project/thread counts) saved as `status-after.txt`.

## Features

- [Savvy progress bar](./savvy-progress.md): fresh bar per request, running glow, no walking
  figure, full completed bar. Proved end to end.
- [Status and threads](./status-threads.md): `oop-rs status`, add folder, thread listing.
  Partly exercised by the proof (status after the run).
- [Model and mode](./model-mode.md): `/model` picker, `/mode`, `/effort`. `/model` exercised.
- [Right-hand panels](./side-panels.md): `/dag-workflow`, `/savvy`, `/files`
  toggles. `/savvy` exercised; the others seeded, not yet run.
- Shell commands: `oop-rs config [get|set|path]`, `doctor`, `stop`, `update` and `provider` run
  without the full-screen UI. Run them with an isolated `OOP_CONFIG_DIR` and `OOP_HOME` (never the
  real ones), save stdout, stderr and the exit code, and check that `doctor` prints no credential
  contents or server address and that `stop` leaves a server the app owns running.
