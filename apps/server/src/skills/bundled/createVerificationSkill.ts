/**
 * The create-verification-skill skill OOP ships.
 * Adapted from pstack by Lauren Tan (MIT), https://github.com/cursor/plugins/tree/main/pstack; the
 * license text is in `pstack-LICENSE` beside this file. Installing writes exactly these bytes.
 */
export const CREATE_VERIFICATION_SKILL_MARKDOWN = `---
name: create-verification-skill
description: Generate a project-local verification skill that drives your app the way a user does, for any language, framework, or platform. Invoke it explicitly ($create-verification-skill or /create-verification-skill, or ask to make a control skill for this repo) when a project has no scripted way to prove UI, CLI, or service behavior.
disable-model-invocation: true
---

# Create a verification skill

Every serious project needs a scripted way to drive the real app and prove behavior: launch it, exercise a feature the way a user would, and capture evidence. This skill generates that as a project-local skill (\`verify-<app>/\`) tailored to the repo. You write the generator's output for the next agent, not for a human: it will be read cold, mid-task, by an agent that has never seen the app.

Where the generated skill goes: the project's skill folder that the current provider reads, e.g. \`.claude/skills/\` for Claude, \`.agents/skills/\` for Codex and others. If the project uses several providers, write it to each folder they read (same content). Below, \`<skills-dir>\` means that folder.

## 1. Interview the repo, not the user

Answer these from the codebase and only ask the user what you cannot observe:

- **Surface:** what does a user actually touch? A web UI, a CLI/TUI, a desktop app, an API, a mobile app, a library? A repo can have several; pick the primary one and note the rest.
- **Run:** how does the app start locally? Prefer the repo's own documented dev command (package scripts, Makefile, README quickstart). Note ports, env vars, seed data, auth.
- **Drive:** how can an agent interact with it programmatically? Existing harnesses first — Playwright/Cypress specs, expect scripts, PTY helpers, curl-able endpoints, a debug port. Only then pick a generic recipe: browser/CDP for web and Electron, a tmux/PTY harness for CLI/TUI, plain HTTP for services.
- **Observe:** what evidence can be captured? Screenshots, terminal transcripts, response bodies, logs, exit codes, DB state.
- **Isolate:** can two instances run side by side (ports, data dirs, profiles)? If not, say so in the generated skill: refusing to double-drive a shared instance beats corrupting the user's session.

If the checkout doesn't build or start as-is, fix that first (or report it precisely) before generating; a skill written against a broken base teaches wrong steps. When an irrelevant missing asset blocks startup (a static dir the API never serves, a sample config), the generated skill may create it, clearly marked as verification scaffolding, and remove it in cleanup.

## 2. Generate the skill

Write \`<skills-dir>/verify-<app>/SKILL.md\` with YAML frontmatter (\`name: verify-<app>\` and a \`description\` that names the app, the surface, and when to reach for it — without frontmatter the skill never registers) and these sections, each grounded in what the interview actually found (no placeholders left):

- **Launch:** the exact command that starts the app for verification, and how to tell it's ready (a log line, a prompt). Launch must reach a usable state from an empty data dir, including any migrations and seed data. Ready means usable, not just that a process answers. A database health check can pass while its init scripts are still running. Include teardown. For a short-lived CLI or TUI there is no server to keep alive: launch means build the binary (or install deps) once, then start each drive in its own isolated PTY or tmux session.
- **Doctor:** one read-only check that answers "is this instance worth driving?" — process up, right version/build, port owned by us, auth valid. An agent runs this first whenever anything looks off.
- **Drive:** the harness recipe with real selectors/commands from this repo, not examples. Prefer stable handles (ARIA labels, data attributes, prompt strings, route paths) over coordinates and tab order.
- **Evidence:** what to capture for a proof and where it goes. State the proof standards: exercise the real user path, not internal setters or test-only endpoints; capture the action and the resulting state, not just the final screen; verify side effects (files written, rows inserted, messages sent) alongside what's visible; mocks only where a production boundary already isolates the external system. When the safe path is a dry-run or test mode, verify what it actually skips by observing (files, network, git refs) rather than trusting its name: some dry-runs still touch the network or open a browser.
- **Cleanup:** how to tear down instances the run created. Never kill by process name; kill what you started. Cleanup removes instances and scratch state, never the evidence: proof artifacts survive the teardown, in a location the skill names.
- **Helpers:** any script the skill ships is executable and its invocation is shown in the skill body. A helper the reader has to reverse-engineer is not a helper.

## 3. Seed the feature map

Create \`<skills-dir>/verify-<app>/features/README.md\` plus one file per user-facing feature you can identify (aim for the top 3-5 to start, from routes, commands, menus, or docs). Follow the shape in the example at the end of this skill, with a README index and one file per feature. Each file answers, from the user's point of view: what the feature is, how to reach it, how to drive it with the harness, and what observable end state proves it works. The four H2s are \`Sub-features\`, \`How to get to it (user POV)\`, \`Driving it with <harness>\`, and \`Gotchas\`. If the seed data lacks a precondition that a journey needs, the journey reports a failure and the reason goes in that feature's \`Gotchas\`. Never weaken the journey to make it pass. The map is the repo's maintained verification source; a proof that drives one convenient entry point is incomplete when the map lists others.

## 4. Prove the generated skill before handing it over

Run its own instructions end to end once: launch, doctor, drive ONE mapped feature (one is enough; the map exists so later runs can cover the rest), capture evidence, clean up. After cleanup, confirm the evidence still exists at the named location — a cleanup that eats the proof fails this step. Fix what fails, and run the generated cleanup after every failed iteration too, so broken attempts don't strand processes and ports. A generated skill that was never executed is a draft, not a deliverable. If you proved it in a stand-in for the real target (a container in place of a fresh VM, a local stack in place of a remote one), list every setup step the stand-in did that the target will not. Those steps stay unverified until a run on the real target covers them.

## 5. Offer the maintenance loop

Point the user at the \`maintain-verification-skill\` skill (invoke it explicitly) for keeping the map honest as the app changes. Suggest a cadence only if they ask.

## Example feature map

An illustrative map for a fictional "Notes" app whose harness is a helper called \`control-notes\`. Copy the shape, not the content: your files use this repo's real handles and commands.

### \`features/README.md\`

\`\`\`\`markdown
# Notes verification map

This directory is the maintained source for verifying the user-facing behavior of Notes. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch Notes at \`http://127.0.0.1:4173\` with a disposable data directory.
- Set \`NOTES_DATA_DIR=/tmp/notes-verify-$RUN_ID\` so concurrent runs do not share state.
- Seed notes titled \`Quarterly plan\` and \`Grocery list\`.
- Put \`control-notes\` and the \`notes\` CLI on \`PATH\`.
- Run \`control-notes doctor\` and require the expected URL, data directory, and build revision.
- Never drive an instance that was not started by this verification run.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS selectors or DOM position.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run browser actions through \`control-notes browser\`.
- Run terminal actions through \`control-notes cli -- <command>\`.
- Restore seeded data after a mutation. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with the app identity visible.
- CLI proof includes the command, stdout, stderr, and exit code.
- Mutation proof includes a read-only second view of the stored value.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. \`Sub-features\` lists short IDs with one line for each behavior.
2. \`How to get to it (user POV)\` lists every user entry point.
3. \`Driving it with <harness>\` starts with \`Preconditions:\` and uses labeled bullets that pair each user action with an exact command and observable result.
4. \`Gotchas\` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Create a note](./create-note.md) covers browser and CLI creation, cancellation, persistence, and cleanup.
- [Search notes](./search.md) covers toolbar, keyboard, and CLI search with matching, empty, and clear states.
\`\`\`\`

### \`features/create-note.md\`

\`\`\`\`markdown
# Create a note

Create note lets a user save a titled note from the browser or CLI, cancel an unfinished draft, and confirm the saved note from a second user-facing view.

## Sub-features

- \`create-open\` opens a blank editor from each browser entry point.
- \`create-save\` persists a title and body.
- \`create-cancel\` discards an unfinished browser draft.
- \`create-cli\` creates the same note shape from the terminal.

## How to get to it (user POV)

- Choose the \`New note\` button in the browser toolbar.
- Press \`n\` in the browser while focus is outside an editable field.
- Run \`notes create --title <title> --body <body>\` in a terminal.

## Driving it with control-notes

Preconditions:

- Notes is healthy at \`http://127.0.0.1:4173\`.
- No note is titled \`Release checklist\`.
- \`control-notes doctor\` reports the expected URL and disposable data directory.

- **Open editor.** Choose \`New note\`. Run \`control-notes browser click --role button --name "New note"\`. A form named \`Note editor\` appears with focus in the \`Title\` textbox.
- **Enter content.** Type the title and body. Run \`control-notes browser fill --role textbox --name "Title" --value "Release checklist"\` and \`control-notes browser fill --role textbox --name "Body" --value "Tag and publish"\`. The \`Save note\` button becomes enabled.
- **Save note.** Choose \`Save note\`. Run \`control-notes browser click --role button --name "Save note"\`. A status named \`Note saved\` appears and the heading reads \`Release checklist\`.
- **Confirm persistence.** Return to the note list and reopen the note. Run \`control-notes browser click --role link --name "All notes"\` and \`control-notes browser click --role link --name "Release checklist"\`. The editor shows both saved values.
- **Cancel draft.** Open a new note, enter \`Discard me\`, and choose \`Cancel\`. Run \`control-notes browser click --role button --name "New note"\`, \`control-notes browser fill --role textbox --name "Title" --value "Discard me"\`, and \`control-notes browser click --role button --name "Cancel"\`. The note list returns and has no \`Discard me\` link.
- **CLI entry.** Create a second note. Run \`control-notes cli -- notes create --title "CLI note" --body "Created from terminal" --format json\`. Exit code \`0\` and stdout contain the new note ID and title.
- **Proof.** Reopen both saved notes from \`All notes\`. Run \`control-notes browser snapshot --aria --path artifacts/create-note/list.aria.txt\` and \`control-notes browser screenshot --path artifacts/create-note/list.png\`. The artifacts show \`Release checklist\` and \`CLI note\`.

## Gotchas

- Pressing \`n\` while a textbox has focus types the character instead of opening a new editor.
- Titles are trimmed on save. Assert the rendered title, not the draft input value.
- A save status alone is insufficient proof. Reopen the note from the list.
- Remove \`Release checklist\` and \`CLI note\` during fixture cleanup, but retain their proof artifacts.
\`\`\`\`

The README above also lists a search feature file, omitted here; it follows the same four-H2 shape. Add one such file per feature.

---

Adapted from pstack by Lauren Tan (MIT), https://github.com/cursor/plugins/tree/main/pstack
`;
