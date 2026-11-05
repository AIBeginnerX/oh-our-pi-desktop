# Right-hand panels

At 100+ columns the right side shows one of four views: Workflow, Agents, Savvy, Files. Tabs are
drawn as `Workflow │ Agents │ Savvy │ Files` with the active one marked by the rule below.

## Sub-features

- `savvy-on` `/savvy` shows the Savvy view (`Progress`, `Crew`). Exercised by savvy-progress.
- `workflow-on` `/dag-workflow` shows the Workflow view. Not yet run.
- `files-on` `/files` shows the Files view. Not yet run.

## How to get to it (user POV)

- Slash commands above (each with `on|off`), or Ctrl-G / `/panel` to open and close it. Tab / Shift-Tab or a click on a tab title switches views; the
  Agents view is reached only that way (it has no slash command).

## Driving it with verify-oop-terminal

Preconditions: open thread, pane at least 200 columns (the default of `launch.sh`).

- **Savvy.** `drive.sh say /savvy`, `drive.sh wait "Idle . nothing is running" 10`, `drive.sh cap savvy-open`;
  `pane.py right <cap>.ansi` starts with the tab row and `Progress`.
- **Other views.** Same with the command, then expect the view's own header text on the right.

## Gotchas

- With the pane under 100 columns no right pane is drawn and `pane.py` prints
  `no right pane / Savvy tab on screen`.
- An empty thread shows `No work to draw yet` in Workflow/Agents until an agent uses a tool.
