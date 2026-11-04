/**
 * The arena skill OOP ships.
 * Adapted from pstack by Lauren Tan (MIT), https://github.com/cursor/plugins/tree/main/pstack; the
 * license text is in `pstack-LICENSE` beside this file. Installing writes exactly these bytes.
 */
export const ARENA_SKILL_MARKDOWN = `---
name: arena
description: Compare several independent approaches to one hard-to-undo design or implementation, judge them with a model from another family, and merge the best parts into one verified result. Invoke it explicitly ($arena or /arena) when the user asks to compare approaches or try a few directions.
disable-model-invocation: true
---

# Arena

Use this only when the user asks to compare approaches, or the choice is hard to undo. It costs one crew task per candidate plus one for the judge. A small, reversible change does not need it.

You need the OOP crew tools (\`crew_delegate\`, \`crew_wait\`, \`crew_stop\` of the t3-code MCP server). Without them, say so and stop. Do not use the fast-path Agent tool here: only \`crew_delegate\` can keep a candidate out of the workspace and pick different model families.

## 1. Criteria

Write 3-6 criteria, each gradeable by running something or reading specific code (for example "the migration is reversible", "no new dependency", "the existing tests still pass"). Show them to the user in one short list. Vague criteria ("clean", "elegant") are not gradeable: replace them.

## 2. Candidates

Start 2-3 tasks with the SAME brief, one \`crew_delegate\` call each:

- \`role\`: worker or expert; \`isolation: "candidate"\`; \`title\`: "Candidate A: <approach>", "Candidate B: ...".
- Give each later candidate \`differentFrom: [taskIds of the earlier ones]\` so the models differ.
- Put the criteria and a \`verify\` command in the brief. Tell each candidate to say in its report if it needs an install it cannot do in its own checkout.
- Never show a candidate another candidate's work: independence is the point.

A candidate is never applied. Its report ends with a CANDIDATE note naming a patch file and a worktree. Call \`crew_wait\` until all are done. A candidate that changed nothing, or failed, drops out; say so.

## 3. Judge

Start ONE judge: \`crew_delegate\` with role expert, \`isolation: "candidate"\`, \`differentFrom: [all candidate ids]\`. Give it the criteria and every patch and worktree path, and tell it: READ-ONLY, do not change candidate code; run each candidate's tests in its own worktree; score every criterion with evidence you ran; recommend a base.

If crew_delegate warns that no model from another family is available, the judge would not be independent. Skip it, judge yourself, and tell the user the judge was not independent.

## 4. Decide

Read every candidate's patch yourself. A judge's score is a lead, not a verdict. Pick a base, apply its patch (\`git apply --check <patch>\`, then \`git apply\`), and graft the one or two best parts of the others by hand. Do not blend everything.

## 5. Verify and clean up

Run the real checks on the merged result. Then remove each candidate worktree with the command in its CANDIDATE note.

## 6. Report

Tell the user: the criteria, the base and why, what you grafted, the judge's verdict (or that there was none and why), what you rejected, and what you verified by running it.

---

Adapted from pstack by Lauren Tan (MIT), https://github.com/cursor/plugins/tree/main/pstack
`;
