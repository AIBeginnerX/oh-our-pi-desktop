# Model and mode

`/model` opens a filterable list of provider models, `/mode` the runtime mode, `/effort` the
reasoning effort. The chosen model shows in the header card (`Model  claudeAgent/claude-haiku-4-5`)
and in the status line.

## Sub-features

- `model-pick` `/model`, type a filter, Enter selects; status line reads `Model: claudeAgent/<id>`.
- `mode-pick` `/mode` (`approval-required | auto-accept-edits | auto | full-access`). Not yet run.
- `effort-pick` `/effort` for models that support it. Not yet run.

## How to get to it (user POV)

- Type `/model` in the `Message` composer and press Enter.

## Driving it with verify-oop-terminal

Preconditions: an open thread (`drive.sh open-project`).

- **Pick Haiku.** `drive.sh model haiku-4-5` (sends `/model`, waits for `type to filter`, types the
  filter, Enter). Then `drive.sh wait "Model: claudeAgent/claude-haiku-4-5" 10`; header card shows
  `Model     claudeAgent/claude-haiku-4-5`.
- **Proof.** `drive.sh cap model-picked`; the `.txt` contains the status line.

## Gotchas

- The filter matches the model id; `haiku-4-5` narrows to one row. A broad filter then Enter picks
  the first row (Opus 5.5 by default, the expensive one).
- `/mode` default in a fresh thread is `Full access`: tool calls run without approval prompts.
