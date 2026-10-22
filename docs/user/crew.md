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

Changes apply to the current chat. Use **Use this crew for new chats** to make them the default;
in a new, unsent chat the changes set the default directly.

If a crew model fails, for example because its account is out of credit, OoP hands the same task to another signed-in model of the same level and shows the switch on the board. A provider that just failed sits out new tasks for ten minutes; one that is out of credit or signed out sits out until OoP checks its status again. Only when every model in that chain fails does the chat's own model do the task itself.

When the auditor asks for changes, or a crew task finishes after the brain has already answered, OoP sends the brain a follow-up turn with that report so it can fix the work or update its answer. Audit fixes stop after two rounds per message you send. A crew member that finished only part of its task, or was blocked, says so instead of reporting it done, and the board shows that task as unfinished.

Each piece of crew work runs as its own chat named `Crew Worker · …`, `Crew Expert · …`, or
`Crew Auditor · …` in the same workspace, and is settled when it finishes. In the sidebar these
chats fold into a **Crew · N** line under the chat that delegated them; open it to see or jump to
each task. Crew chats from before this grouping, or whose lead chat is archived, collect in one
**Earlier crew tasks** line. A crew chat waiting on your approval or answer stays in the main list.
The brain and its crew show up live in the right panel under **Workflows** and **Agents**.

When the brain is a Claude chat, crew roles that use a Claude model from the same account run as
the brain's own subagents instead of separate chats. They start faster and share the brain's
session, and they appear in the brain chat's work log. Roles on other providers still run as crew
chats.

The crew tools reach the brain through T3 Code's agent tools, which Claude, Codex, and Antigravity
chats use. Any signed-in model can serve as a worker, expert, or auditor, including GLM through
[ZCode](./providers-zcode.md) and [MiniMax Code](./providers-minimax.md).
