# Savvy progress bar

The right-hand "Savvy" panel shows how far the running turn is as a bar (`▕███░░░▏ 62% │ 5/8`
then `plan steps`), above a `Crew` block with one text row per member. It restarts for every
request, a glow slides along it while work runs, and it ends full. Code: `savvy_panel.rs`,
`side.rs`, `app.rs` (`request_pending`), `work_scope.rs` (`fresh_work`). Commits 639b28f, 789ca11.

## Sub-features

- `fresh-bar` sending a request clears the old progress at once and shows a new bar (the
  bouncing `no total` marker, `working . the provider reported no total`, `cost —`) until the
  turn reports a plan.
- `glow` on an unfinished counted bar (`done < total`) a light patch (cells whose colour is
  lighter than the rest of the same glyph) moves between frames; it stops when the bar is full
  or nothing runs.
- `no-walker` member blocks under `Crew` are text only (`Lead  haiku-4-5` and a `ctx . cost .`
  row); the half-block walking figure is gone.
- `full-bar` a completed bar fills all cells to the last one (`100% │ N/N`) in the success
  colour (green, 74,222,128) with no glow. Same for crew/workflow basis once every task or agent
  is in (not driven here, see Gotchas).

## How to get to it (user POV)

- Open `oop-rs` in a project folder, type `/savvy` + Enter (or Ctrl-G / `/panel` to cycle the
  right pane to the Savvy tab).
- Send any message that makes the agent keep a plan (`TodoWrite`): the bar counts plan steps.
- The composer border also carries the same bar (`━━━━ 8/8` on the `Message` box).

## Driving it with verify-oop-terminal

Preconditions: `launch.sh` done, `doctor.sh` all `ok`, thread open on the repo.

```bash
S=.agents/skills/verify-oop-terminal/scripts; export RUN=<id>; D=$S/drive.sh
$D open-project                      # "+ Add this folder" -> empty thread
$D model haiku-4-5                   # /model filter + Enter; wait for "Model: claudeAgent/claude-haiku-4-5"
$D say /savvy; $D wait "Idle . nothing is running" 10
$D say 'Make a todo list with TodoWrite of exactly 4 steps (A, B, C, D). Do them one at a time: for each step run `sleep 5` with Bash, then mark that step completed with TodoWrite before starting the next. Finish with one short sentence.'
$D wait "plan steps" 60; $D sample req1-running 8 0.4     # glow: compare "glow-lit" between frames
$D waitgone Working 150; $D cap req1-done                  # plan bar is gone when the turn ended
$D cap req2-before-send                                    # Idle, cost $0.xx
$D say '<second request, same shape, steps E-H, sleep 4>'
$D cap req2-just-sent-a; $D cap req2-just-sent-b           # fresh bar, cost —, no old plan
$D watch req2-run 150 0.5                                  # catches the 100% frames while Working
$D waitgone Working 120; $D cap req2-done
$S/summarize.sh                                            # bars.txt: bar/fill/glow-lit/walker per capture
```

- **fresh-bar.** Compare `req2-before-send` (right pane `Idle . nothing is running`, `cost $0.10`)
  with `req2-just-sent-*`: `▕…░███░░░▏ no total`, `cost —`, no earlier plan rows.
- **glow.** In `req1-running-*` / `req2-run-*` frames `glow-lit` lists different cells per frame
  (`[8..12]`, `[16..20]`, `[24..28]`, `[32..36]`); in frames with `100%` it is `none`.
- **no-walker.** `python3 -I $S/pane.py walker <cap>.ansi` prints `walker: none` (exit 0) on running
  frames; `summarize.sh` reports `walker rows: 0`.
- **full-bar.** A `100% │ N/N` frame shows `cells 40 filled 40`, fill colour `74,222,128`, `glow-lit none`.

## Gotchas

- The plan-basis bar disappears when the turn ends (`Idle . nothing is running`): only crew and
  workflow bars stay full afterwards. Catch the full plan bar with `watch` while `Working` is
  still on screen; a single capture after the turn will show no bar and is not a failure.
- Claude keeps one task list per thread: request 2 started at 4/8 (steps A-D carried over), so
  its plan reads `N/8`. That is the provider's list, not a stale Savvy bar; judge freshness by
  the `no total` bar and `cost —` right after sending, not by the count.
- The "just sent" window is short (about 0.3 s). Capture immediately after `say`; the very
  first request of a new thread shows `Loading the thread…` instead.
- The glow is not drawn on the `no total` marker (it has its own bounce) or with animations off.
  Glow proof needs a counted bar (`plan steps`) with `done < total`.
- Crew (`/crew`) and workflow basis (item 4 of 789ca11) need worker/auditor models and a workflow
  run; this map has no recipe for them yet. Report them as not driven, not as passing.
- Plan steps need the agent to use TodoWrite; haiku sometimes first shows `0/1` or `0/3` while it
  builds the list, then settles on the real count.
- `waitgone Working` also passes before the first reply if the pane has not yet drawn
  `Working`; `wait "plan steps"` first.
