import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type { NewProjectScriptInput } from "../components/projectScriptEditor";

const Configuration = Schema.Struct({
  name: Schema.String,
  runtimeExecutable: Schema.optional(Schema.String),
  runtimeArgs: Schema.optional(Schema.Array(Schema.String)),
  program: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  port: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  autoPort: Schema.optional(Schema.Boolean),
});
const decodeLaunchFile = Schema.decodeExit(
  fromLenientJson(Schema.Struct({ configurations: Schema.Array(Configuration) })),
);
export type ClaudeLaunchConfiguration = typeof Configuration.Type;

export function parseClaudeLaunchFile(text: string) {
  const decoded = decodeLaunchFile(text);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

function quoteArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : `"${value.replace(/[\\"$`]/g, "\\$&")}"`;
}

/** Convert argv to an action without executing it or importing environment values. */
export function claudeLaunchConfigurationToAction(configuration: ClaudeLaunchConfiguration): {
  action: NewProjectScriptInput;
  skippedEnvironmentVariables: boolean;
} | null {
  const argv = configuration.runtimeExecutable
    ? [configuration.runtimeExecutable, ...(configuration.runtimeArgs ?? [])]
    : configuration.program
      ? ["node", configuration.program, ...(configuration.args ?? [])]
      : null;
  if (!argv) return null;
  const cwd = configuration.cwd?.replace(/^\$\{workspaceFolder\}(?:\/|$)/, "");
  const command = argv.map(quoteArgument).join(" ");
  return {
    action: {
      name: configuration.name,
      command:
        cwd && cwd !== "." && cwd !== "./" ? `cd ${quoteArgument(cwd)} && ${command}` : command,
      icon: "play",
      runOnWorktreeCreate: false,
      waitForSetup: false,
      keybinding: null,
      previewUrl: configuration.url ?? `http://localhost:${configuration.port ?? 3000}`,
      autoOpenPreview: false,
    },
    skippedEnvironmentVariables: Object.keys(configuration.env ?? {}).length > 0,
  };
}
