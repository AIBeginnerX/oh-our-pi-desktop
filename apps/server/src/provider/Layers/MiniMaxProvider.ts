import {
  MINIMAX_CODE_DEFAULT_MODEL,
  type MiniMaxCodeSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";

import type { AcpAgentLaunch } from "../acp/GrokAcpSupport.ts";
import {
  ACP_AGENT_EMPTY_CAPABILITIES,
  type AcpAgentDefinition,
  buildInitialAcpAgentSnapshot,
  checkAcpAgentProviderStatus,
} from "./AcpAgentProvider.ts";

export const MINIMAX_CODE_PRESENTATION = {
  displayName: "MiniMax Code",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

export const MINIMAX_CODE_SETUP_HINT =
  "Install MiniMax Code (npm i -g @minimax-ai/code), then run `mcode login --region global`.";

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: MINIMAX_CODE_DEFAULT_MODEL,
    name: "MiniMax Code",
    isCustom: false,
    capabilities: ACP_AGENT_EMPTY_CAPABILITIES,
  },
];

/**
 * `mcode acp` runs MiniMax Code as an ACP agent; it signs in on its own via `mcode login`. With no
 * region on the command line, in `MAVIS_REGION`, or from an earlier login, MiniMax Code picks the
 * China region (`cn`), so OoP pins the global one (`en`) and a first sign-in opens the global site.
 */
export function miniMaxCodeAcpLaunch(
  settings: Pick<MiniMaxCodeSettings, "binaryPath">,
): AcpAgentLaunch {
  return { command: settings.binaryPath || "mcode", args: ["acp"], env: { MAVIS_REGION: "en" } };
}

const miniMaxAgent = (settings: MiniMaxCodeSettings): AcpAgentDefinition => ({
  presentation: MINIMAX_CODE_PRESENTATION,
  builtInModels: BUILT_IN_MODELS,
  launch: miniMaxCodeAcpLaunch(settings),
  authLabel: "MiniMax account",
  missingMessage: `MiniMax Code (\`mcode\`) is not installed or not on PATH. ${MINIMAX_CODE_SETUP_HINT}`,
  noAnswerMessage:
    "MiniMax Code is installed but its ACP agent did not answer. If you are signed out, run `mcode login --region global`.",
});

export const buildInitialMiniMaxProviderSnapshot = (settings: MiniMaxCodeSettings) =>
  buildInitialAcpAgentSnapshot(miniMaxAgent(settings), settings);

export const checkMiniMaxProviderStatus = (
  settings: MiniMaxCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) => checkAcpAgentProviderStatus(miniMaxAgent(settings), settings, environment);
