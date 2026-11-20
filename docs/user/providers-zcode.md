# ZCode (GLM)

ZCode is Z.ai's coding agent for GLM models. OOP runs it through its own harness, so GLM chats
use ZCode's tools and your ZCode sign-in instead of OpenCode.

## Set up

1. Install ZCode and sign in with `zcode login zai`.
2. Install the ACP bridge on the same machine: `npm i -g zcode-acp-server`.
3. Enable **ZCode** in **Settings > Providers**. Set **Binary path** or **ACP bridge path** only
   when they are not on `PATH`.

## Models

**GLM (ZCode)** is whichever GLM model ZCode itself has selected. The picker also lists the
models ZCode can route to, and those offer ZCode's **Thought Level** (low, high, max). ZCode runs
its own tools without asking for approval, regardless of the OOP permission mode.

## Usage limits

GLM plan limits come from a Z.ai API key. If OOP cannot read ZCode's own key, add
`OOP_ZAI_API_KEY` with your Z.ai API key under the ZCode instance's **Variables** in
**Settings > Providers** to see limits in **Usage**.
