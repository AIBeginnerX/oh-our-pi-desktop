import type { BundledSkillTarget, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const TARGET_LABEL: Record<BundledSkillTarget, string> = {
  claude: "Claude Code",
  agents: "Codex · Cursor",
};

/**
 * Skills OOP ships. Installing copies one into the provider's own user skill folder on this
 * environment's host, after which the provider loads it and the `$` picker lists it. A skill of
 * the same name with other content is reported and never replaced.
 */
export function BundledSkillsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const target = { environmentId: props.environmentId, input: {} };
  const { data, error, refresh } = useEnvironmentQuery(serverEnvironment.bundledSkills(target));
  const install = useAtomCommand(serverEnvironment.installBundledSkill, {
    label: "install the bundled skill",
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<string | null>(null);

  const installSkill = async (name: string, skillTarget: BundledSkillTarget) => {
    setPending(`${name}:${skillTarget}`);
    try {
      const result = await install({
        environmentId: props.environmentId,
        input: { name, target: skillTarget },
      });
      refresh();
      // The provider snapshot rescans its skill folders, so the picker shows the new skill now.
      if (result._tag === "Success") {
        await refreshProviders({ environmentId: props.environmentId, input: {} });
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <SettingsSection title="Bundled skills">
      {error ? (
        <SettingsRow
          title="Bundled skills unavailable"
          description="This environment could not list the skills OOP ships."
          control={
            <Button size="sm" variant="outline" onClick={refresh}>
              Retry
            </Button>
          }
        />
      ) : (
        (data?.skills ?? []).map((skill) => (
          <SettingsRow
            key={skill.name}
            title={skill.name}
            description={skill.description}
            control={
              <span className="flex flex-wrap gap-2">
                {skill.targets.map(({ target: skillTarget, status }) => (
                  <Button
                    key={skillTarget}
                    size="sm"
                    variant="outline"
                    disabled={props.readOnly || status !== "not-installed" || pending !== null}
                    onClick={() => void installSkill(skill.name, skillTarget)}
                  >
                    {status === "installed"
                      ? `${TARGET_LABEL[skillTarget]}: installed`
                      : status === "different"
                        ? `${TARGET_LABEL[skillTarget]}: name in use`
                        : `Install for ${TARGET_LABEL[skillTarget]}`}
                  </Button>
                ))}
              </span>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
