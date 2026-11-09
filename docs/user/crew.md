# OOP Crew

OOP Crew lets one chat use several models at once. The chat's own model is the **brain**: it
plans, talks with you, and hands self-contained work to the crew. The **worker** takes routine
work such as searches, edits, and tests, and the **expert** takes hard implementation. When a
turn changes files, the **auditor** reviews it and reports problems and a verdict. A change of 20
lines or fewer that the turn ended by passing its own tests is not reviewed, and other small changes
go to a fast model unless you picked the auditor's model yourself. A turn after the auditor asked
for changes is always reviewed in full.

Open **Crew** next to the model picker in the composer and turn it on. While it is on, every turn tells the chat's model who is on the crew and to hand work to them, so the crew starts working on the next message. Pick a preset with one
click: **OOP pick** (balanced), **Speed**, **Quality**, or **Budget**. To choose a model for one role yourself, open that role's list and type to search by model, provider, or speed; **Auto** hands the role back to the preset and shows which model it recommends. **Auto all** returns every role to the preset in one click.
Presets choose from the models you have signed in to, so the crew follows new models without
changes.

Every chat has its own crew. A change you make applies to that chat only: it never changes another chat or the default, and it is kept when you restart OOP or open the chat on another device. A chat you have not changed uses the default crew, so a later change to the default moves those chats and never one that has its own crew. Where you pick the crew, OOP says which one applies: "This chat has its own crew" or "Using the default crew". A new, unsent chat keeps the crew you pick until you send the first message, and then starts with it.

**Use the default crew** (in the terminal, `/crew reset`) drops the chat's own crew. **Use this crew for new chats** (`/crew default`) makes the chat's crew the default. You can also edit the default directly — on or off, the preset, each role's model, and its fallbacks — in **Settings → General → Crew**. Every new chat starts with the default; no existing chat's own crew changes with it. Chats created before per-chat crews use the default.

Next to each role, the **Fallback** button adds a model to that role's fallbacks (up to three, tried in the order you added them; remove one with its minus button; in the terminal, on the `/crew` screen). A fallback whose provider is not available right now stays on the list, dimmed, and is skipped until it is back. If a crew model fails, OOP hands the same task to that role's fallbacks first, then to another signed-in model of the same level, and shows each switch and its reason on the board; the next model is told which checklist items are already done. Only when every model in that chain fails does the chat's own model do the task itself.

How long a provider sits out depends on why it failed:

- **Usage limit.** When the provider reports its usage windows and one is full, the provider sits out until that window resets, for example the end of a 5-hour or weekly window. A window for one model only, such as a weekly Opus limit, benches only that model. When OOP can only tell that a limit was hit, it waits 15 minutes and then tries the provider again on the next task.
- **Model refused.** When a provider refuses one model (for example, it cannot switch to it), only that model sits out until OOP checks the provider's status again; if the same model is refused again, it sits out for a day. The provider's other models keep working.
- **Out of credit or signed out.** The provider sits out until OOP checks its status again.
- **Anything else**, such as a crash or a timeout: the provider sits out new tasks for ten minutes.

A role's own model is still tried once at the start of every new task, even while it is sitting out, so a limit you reset yourself is picked up right away. A provider stops sitting out as soon as one of its models finishes a turn, or when its next usage check shows the full window is no longer full. `crew_roster` lists what is sitting out right now and until when.

When the auditor asks for changes, or a crew task finishes after the brain has already answered, OOP sends the brain a follow-up turn with that report so it can fix the work or update its answer. Tasks handed out together come back in one follow-up, once the last of them finishes. The auditor checks whether a failing test or build already failed before the turn, and does not ask for fixes to failures that predate it. Audit fixes stop after two rounds per message you send. When you turn the crew off for a chat, tasks already running keep going and their results still reach the brain, as plain information it may use; the brain starts no new crew tasks, and an auditor's request for changes is dropped. A crew member that finished only part of its task, or was blocked, says so instead of reporting it done, and the board shows that task as unfinished.

## Task checklists

The brain gives each crew task a short checklist of steps. A step that can be proved also carries
a check, such as a test or build command, or the files the step must change. You do not write the
checklist yourself; it is part of how the brain splits the work.

Each step ends up **verified** or **claimed**. **Verified** means OOP ran the check itself and it
passed. **Claimed** means the crew member said it finished the step and nothing could prove it.
The percent on the board and in the terminal counts verified steps only, and claimed steps are
shown beside it as unproven, so five claimed steps read 0%, not 100%. A finished task also says
whether OOP could verify it: verified, not verified, or unproven. A task with steps that are still
open, or that failed their check, comes back unfinished, so a report of done always means the whole
checklist cleared.

If extra work turns up while a crew member is still busy, the brain can add steps to its checklist. They reach the member as a follow-up once its current turn ends, never in the middle of it.

Each piece of crew work runs as its own chat named `Crew Worker · …`, `Crew Expert · …`, or
`Crew Auditor · …` in the same workspace, and is settled when it finishes. In the sidebar these
chats fold into a **Crew · N** line under the chat that delegated them; open it to see or jump to
each task. Crew chats from before this grouping, or whose lead chat is archived, collect in one
**Earlier crew tasks** line. A crew chat waiting on your approval or answer stays in the main list.
The brain and its crew show up live in the right panel under **Workflows** and **Agents**.

On the **Workflows** board a finished task is labeled **reported**, **tested** (its run passed tests), or **audited** (an approving audit came after it), and never called done. Cards show tokens and, when the provider reports one, a cost; the brain's card totals the turn and says "+ unpriced" when part of it had no reported cost. Select a card to **Stop** a running task, **Open** its chat, or **Retry** one that failed, stopped, was blocked, or finished only part of its work. **Stop all** on the board, or `/crew stop [id|all]` in the terminal, stops every running task. Stopping the chat's own turn, or deleting the chat, also stops the crew tasks it started; a stopped task is never retried on another model.

When the brain splits code edits across crew tasks that run at the same time, it can start each in its own git worktree. The member starts from your tracked files, uncommitted changes included, and its changes are applied back to the chat's workspace when it finishes. Untracked and ignored files such as installed dependencies are not copied. If the changes conflict with yours, nothing is applied, the worktree is kept, and the task is reported as unfinished with the worktree's path. A worktree needs a git repository with at least one commit; without one, the task is not started rather than run in your workspace.

When the brain is a Claude chat, crew roles that use a Claude model from the same account run as
the brain's own subagents instead of separate chats. They start faster and share the brain's
session, and they appear in the brain chat's work log. Roles on other providers still run as crew
chats.

When you attach project memories to the message that makes the brain delegate, a worker, expert,
or auditor on Claude or Codex receives the same memories, each in its own chat, and is held like any
chat if one of them changes. A member on another provider receives none, and the brain is told so.

The brain must be a Claude or Codex model: the crew tools reach it through OOP's agent tools, which
only those chats use. On a chat that runs on another provider, such as Cursor, Grok, OpenCode, or
Antigravity, the **Crew** control is disabled and explains why, no crew work or audit is started, and
the terminal hides the crew. Any signed-in model can serve as a worker, expert, or auditor, including GLM through
[ZCode](./providers-zcode.md) and [MiniMax Code](./providers-minimax.md).

## Decision log

After a long run, **Decision log** at the top of the Workflows panel (`/crew log` in the terminal)
shows the crew's decisions as one table: when, which role was handed what and why, what evidence
backs it, and how it ended. Copy it as TSV or download a `.tsv` file to keep it. In the terminal the
newest rows are printed and the whole table goes to your clipboard. The table is built when you open
it and does not update while the crew works, so open it again to see newer rows. The "why" comes
from the brain's own note when it gave one, and is empty for a stop you asked for yourself.

## Arena

To compare approaches, ask the brain to run an arena: it gives the same task to several crew
members, each working in its own isolated copy, and nothing they write is applied to your
workspace automatically. The brain reads the candidates, picks a base, and grafts in the best parts
of the others. An arena of N approaches costs N+1 tasks, one per candidate and one for the
comparison, so use it for decisions worth that cost.
