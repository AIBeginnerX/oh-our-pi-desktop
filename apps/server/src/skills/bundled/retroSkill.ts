/**
 * The retro skill OOP ships. Adapted from mattpocock/skills by Matt Pocock (MIT),
 * https://github.com/mattpocock/skills; the license text is in `mattpocock-LICENSE` beside this
 * file. Installing writes exactly these bytes.
 */
export const RETRO_SKILL_MARKDOWN = `---
name: retro
description: Review a finished coding session and propose changes to the environment and instructions that would have prevented its mistakes. Invoke it explicitly ($retro or /retro) at the end of a session.
disable-model-invocation: true
---

# Retro

The user asked for a retrospective. You are improving the agent's **environment**, not this session's code. Report only; change nothing until the user picks.

Read the session the user names, or this one. Look for:

- **Navigation**: did finding a file take too long? Would a pointer in AGENTS.md, or a short doc naming the entry points, have shortened it?
- **Automated checks**: which mistake would a check have caught? Read the repo's existing check commands in \`package.json\`, \`t3.json\`, and CI first — an existing check that is unwired or silently broken is the finding, not a reason to add another. A repo with no guardrail running its lint, typecheck, or tests on every change is itself a finding.
- **Coding standards**: was the mistake mechanical (a banned API, an import shape, a file location) or a judgement call? Build the deterministic check for mechanical ones; keep rules for judgement calls only.
- **AGENTS.md**: is it long? Move anything enforceable into a check, and anything conditional into a doc or skill it points to.
- **Tool economy**: which calls were expensive for little information? Name the cheaper call.
- **No-ops**: which instructions did not change what you did? Those earn deletion.
- **Information access**: which fact did you need and not have? Dev server logs, read-only service access, one more file in context.

Present the candidates in order of severity, each with the evidence that prompted it and the smallest fix.

## Reference

Implementation carries the context pressure: exploration, code, debugging. Review has little, because it starts from a diff. So standards belong to the reviewer, and checks — which cost the implementer nothing — belong to whichever stage runs them.

Skills are for on-demand procedure and user-invoked commands, not always-on context: a skill's description enters every prompt, so add one only when the trigger earns that cost.

---

Adapted from mattpocock/skills by Matt Pocock (MIT).
`;
