import type { EnvironmentId } from "@t3tools/contracts";
import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts/settings";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Textarea } from "../ui/textarea";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

/** Environment-wide text appended to every agent session on this machine. */
export function AgentInstructionsSettingsSection({
  environmentId,
  agentInstructions,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly agentInstructions: string;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const defaultInstructions = DEFAULT_SERVER_SETTINGS.agentInstructions;
  const isDirty = agentInstructions !== defaultInstructions;

  return (
    <SettingsSection {...searchableSetting("agent-instructions")}>
      <SettingsRow
        title={<span className="sr-only">{searchableSetting("agent-instructions").title}</span>}
        settingKeys={["agentInstructions"]}
        description="Added to every agent session on this environment, whichever provider runs it. Claude picks up a change in new chats; other providers on your next message."
        resetAction={
          !readOnly && isDirty ? (
            <SettingResetButton
              label="agent instructions"
              onClick={() => updateSettings({ agentInstructions: defaultInstructions })}
            />
          ) : null
        }
      >
        <div className="w-full min-w-0 pb-3.5">
          <Textarea
            key={agentInstructions}
            defaultValue={agentInstructions}
            maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
            disabled={readOnly}
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next !== agentInstructions) {
                updateSettings({ agentInstructions: next });
              }
            }}
            rows={4}
            placeholder="Reply in Korean. Keep final answers concise."
            aria-label="Instructions for all agents"
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
