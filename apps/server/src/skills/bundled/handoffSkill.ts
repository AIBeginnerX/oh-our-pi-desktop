/**
 * The handoff skill OOP ships. Adapted from mattpocock/skills by Matt Pocock (MIT),
 * https://github.com/mattpocock/skills; the license text is in `mattpocock-LICENSE` beside this
 * file. Installing writes exactly these bytes.
 */
export const HANDOFF_SKILL_MARKDOWN = `---
name: handoff
description: Compact the current conversation into a short handoff note in a temp directory so a fresh agent can continue the work. Invoke it explicitly ($handoff or /handoff) when the user asks to hand off to a new session.
disable-model-invocation: true
---

# Handoff

Write one note so a fresh agent can continue this work without re-reading the conversation. Say where you put it.

## Where it goes

To the OS temp directory, never the repo: \`$TMPDIR\`, else \`/tmp\` (\`%TEMP%\` on Windows), as \`handoff-<topic>-<date>.md\`. AGENTS.md forbids committing plans, research notes, and agent scratch files, so the workspace is the wrong place and \`.plans/\` is not a loophole.

## What it says

- **Goal**: what the user wants, in their words where the wording matters.
- **State**: what is finished, what is half-finished, and the exact branch, worktree, and paths involved.
- **Next steps**: an ordered list of what remains, each with how to tell it is done.
- **Skills to use next**: name the OOP skill for each step — \`create-verification-skill\` before writing a new test, \`maintain-verification-skill\` when an existing one breaks, \`arena\` for a choice that is hard to undo, \`retro\` when the session ends.
- **Open questions**: what you were unsure about, and what you would check first.

## What it leaves out

Do not restate what other artifacts already say. Reference specs, plans, issues, commits, and diffs by path, branch, commit hash, or URL; the next agent can read them. Keep the note to about a page.

Redact secrets: no API keys, tokens, passwords, or personal data.

If the user passed arguments, treat them as the focus of the next session and weight the note accordingly.

---

Adapted from mattpocock/skills by Matt Pocock (MIT).
`;
