# ZCode (GLM)

ZCode is Z.ai's coding agent for GLM models. OOP runs it through its own harness, so GLM chats
use ZCode's tools and your ZCode sign-in instead of OpenCode.

## Set up

1. Install ZCode and sign in with `zcode login zai`.
2. Install the ACP bridge on the same machine: `npm i -g zcode-acp-server`.
3. Enable **ZCode** in **Settings > Providers**. Set **Binary path** or **ACP bridge path** only
   when they are not on `PATH`.

## Models

ZCode offers one model, **GLM (ZCode)**, which is whichever GLM model ZCode itself has selected.
To use another GLM model, change it in ZCode. ZCode runs its own tools without asking for
approval, regardless of the T3 permission mode.
