import {
  ZCODE_DEFAULT_MODEL,
  type ServerProviderModel,
  type ZCodeSettings,
} from "@t3tools/contracts";

import type { AcpAgentLaunch } from "../acp/GrokAcpSupport.ts";
import {
  ACP_AGENT_EMPTY_CAPABILITIES,
  type AcpAgentDefinition,
  buildInitialAcpAgentSnapshot,
  checkAcpAgentProviderStatus,
} from "./AcpAgentProvider.ts";

export const ZCODE_PRESENTATION = {
  displayName: "ZCode",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

export const ZCODE_SETUP_HINT =
  "Install ZCode and the ACP bridge (npm i -g zcode-acp-server), then run `zcode login zai`.";

// ZCode switches models only inside its own app; the bridge cannot change them per session, so OOP
// offers the one GLM model ZCode has selected.
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: ZCODE_DEFAULT_MODEL,
    name: "GLM (ZCode)",
    isCustom: false,
    capabilities: ACP_AGENT_EMPTY_CAPABILITIES,
  },
];

/** The bridge runs `zcode app-server`; a custom ZCode binary reaches it through `ZCODE_BIN`. */
export function zcodeAcpLaunch(
  settings: Pick<ZCodeSettings, "binaryPath" | "bridgePath">,
): AcpAgentLaunch {
  const zcodeBinary = settings.binaryPath.trim();
  return {
    command: settings.bridgePath || "zcode-acp-server",
    args: [],
    ...(zcodeBinary && zcodeBinary !== "zcode" ? { env: { ZCODE_BIN: zcodeBinary } } : {}),
  };
}

const zcodeAgent = (settings: ZCodeSettings): AcpAgentDefinition => ({
  presentation: ZCODE_PRESENTATION,
  builtInModels: BUILT_IN_MODELS,
  launch: zcodeAcpLaunch(settings),
  authLabel: "Z.ai account (ZCode)",
  missingMessage: `The ZCode ACP bridge (\`zcode-acp-server\`) is not installed or not on PATH. ${ZCODE_SETUP_HINT}`,
  noAnswerMessage:
    "The ZCode ACP bridge is installed but did not answer. Check that ZCode is installed and signed in (`zcode login zai`).",
});

export const buildInitialZCodeProviderSnapshot = (settings: ZCodeSettings) =>
  buildInitialAcpAgentSnapshot(zcodeAgent(settings), settings);

export const checkZCodeProviderStatus = (
  settings: ZCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) => checkAcpAgentProviderStatus(zcodeAgent(settings), settings, environment);
