# Thread workflow

**Workflow** draws the work an agent is doing in a thread as a live diagram, next to the chat.
Open it from the right panel (`W` in its launcher), the command palette, or `mod+alt+w` on web and
desktop. Customize `workflows.open` in **Settings → Keybindings**.

The row at the top lists the thread's flows, newest first, and follows the one that is running:

- **Workflows** a provider runs, such as a Claude Code dynamic workflow. Each phase is a column
  and each agent in it is a card.
- **Turns** that called tools. Each tool call, subagent, or workflow launch is a card named for
  what it does, such as `Run · npm test`. Calls that ran at the same time share a column, so
  parallel work reads as a fan-out. While the turn runs between calls, a **Thinking** card at the
  end shows the agent working out its next step.

Edges feeding a running step carry moving light. Select a card for its model, timing, tokens,
and current step; the activity list below jumps to the card you pick. Turn on your system's
reduced-motion setting to stop the animation.
