# MiniMax Code

MiniMax Code is MiniMax's own coding agent. T3 Code runs it over the Agent Client Protocol, so
MiniMax chats use MiniMax Code's tools and account instead of OpenCode.

## Set up

1. Install the CLI: `npm i -g @minimax-ai/code`.
2. Sign in once with `mcode login --region global`. The MiniMax desktop app's sign-in is separate.
3. Enable **MiniMax Code** in **Settings > Providers**.

If a chat fails with "Authentication required", run `mcode login` again on the server machine.
The **MiniMax Code** model uses the model MiniMax Code has selected.

## Use a MiniMax API key (Coding Plan)

To run MiniMax Code on a MiniMax API key, such as a Coding Plan (`sk-cp-...`) key, add the
variable `OOP_MINIMAX_API_KEY` with the key under the instance's **Variables**. No `mcode login`
is needed. T3 Code then keeps that instance's MiniMax Code state in its own data directory
(`providers/minimax/<instance>/<key id>` under the server's state directory), selects the key
there, and reads the plan's limits for **Usage** with the key. Your own `~/.minimax` sign-in is not
changed. If MiniMax Code rejects a key, the provider shows an error and chats on that instance stop
with a sign-in error instead of running on another account. Remove the variable to go back to the
signed-in account.

MiniMax Code names `MiniMax-M3.1-Flash` "M3.1-Flash (Free)" for signed-in accounts; with a key,
T3 Code lists it as "M3.1-Flash" and runs it on the key. A thread or crew role still set to the
retired `MiniMax-M3.1-Flash-Preview` switches to `MiniMax-M3.1-Flash` when MiniMax Code lists it.
