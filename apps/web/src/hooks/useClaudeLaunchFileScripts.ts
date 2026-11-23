import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { claudeLaunchConfigurationToAction, parseClaudeLaunchFile } from "~/lib/claudeLaunchFile";

export function useClaudeLaunchFileScripts(environmentId: EnvironmentId, cwd: string | null) {
  const query = useProjectFileQuery(environmentId, cwd ?? "", ".claude/launch.json", cwd !== null);
  return useMemo(() => {
    if (!query.data) {
      return { status: query.isPending ? "loading" : "missing", scripts: [] } as const;
    }
    const file = query.data.truncated ? null : parseClaudeLaunchFile(query.data.contents);
    if (!file) return { status: "invalid", scripts: [] } as const;
    return {
      status: "valid",
      scripts: file.configurations.flatMap((configuration) => {
        const converted = claudeLaunchConfigurationToAction(configuration);
        return converted ? [converted] : [];
      }),
    } as const;
  }, [query.data, query.isPending]);
}
