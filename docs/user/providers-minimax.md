# MiniMax Code

MiniMax Code is MiniMax's own coding agent. T3 Code runs it over the Agent Client Protocol, so
MiniMax chats use MiniMax Code's tools and account instead of OpenCode.

## Set up

1. Install the CLI: `npm i -g @minimax-ai/code`.
2. Sign in once with `mcode login --region global`. The MiniMax desktop app's sign-in is separate.
3. Enable **MiniMax Code** in **Settings > Providers**.

If a chat fails with "Authentication required", run `mcode login` again on the server machine.
The **MiniMax Code** model uses the model MiniMax Code has selected.
