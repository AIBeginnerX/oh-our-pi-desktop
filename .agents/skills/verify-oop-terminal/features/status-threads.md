# Status and threads

`oop-rs status` connects once, prints server, providers, projects and threads, and exits. The
TUI lists the same projects and threads in the left "Threads" list and adds the current folder
as a project.

## Sub-features

- `status-oneshot` `oop-rs status` starts (or finds) the isolated daemon and prints providers.
- `add-folder` `+ Add this folder` registers the working folder as a project and opens a thread.
- `thread-list` the thread created by a first message appears under the project, `[ready]`.

## How to get to it (user POV)

- `oop-rs status` in a shell.
- In the TUI, Enter on `+ Add this folder`, or `n` for a new thread.

## Driving it with verify-oop-terminal

Preconditions: `launch.sh` done (the TUI is already running; `status` reuses its daemon).

- **Status.** `OOP_HOME=$WORK/home $BIN status` (both from `$EVID/run.env`). Expect
  `server … v0.0.141`, `provider claudeAgent … status=ready auth=authenticated`, and
  `1 project(s), 0 thread(s)` before a first message.
- **Add folder.** `drive.sh open-project`. The screen shows `Provider  Claude` and
  `New thread. Type a message and press Enter to start it.`
- **Thread appears.** After a first `drive.sh say '<message>'` and `waitgone Working`, run status
  again: `project  repo  /private/tmp/oop-verify-run-<id>/repo` and a `thread <uuid> [ready]  <title>`
  line. Proof run saved this as `status-after.txt`.

## Gotchas

- Directly after launch every provider reads `installed=false auth=unknown`; wait until the
  probe finishes (`launch.sh` does) or a turn will not start.
- macOS resolves `/tmp` to `/private/tmp`; compare against `$REPO` from `run.env` (already `pwd -P`).
- `status` without `OOP_HOME` would read `~/.oop-desktop`. Always pass the isolated home.
