import { helpText, parseArgs } from "./cli.ts";
import { resolveLanguage, setLanguage } from "./i18n/index.ts";
import { currentPathEnv } from "./link/paths.ts";
import { readSettings, settingsFilePath } from "./settings.ts";
import {
  runConfig,
  runDoctorCommand,
  runInteractive,
  runPair,
  runProvider,
  runStop,
  runUpdate,
} from "./run.ts";
import { TERMINAL_VERSION } from "./version.ts";

// The launcher runs the app's Electron as Node. Anything started from here must not inherit that,
// or the app itself would come up as a bare Node process; what needs it sets it explicitly.
delete process.env.ELECTRON_RUN_AS_NODE;

// The language comes first: even a usage error is printed in it.
setLanguage(
  resolveLanguage(
    readSettings(settingsFilePath(currentPathEnv())).values.language ?? null,
    process.env,
  ),
);

const command = parseArgs(process.argv.slice(2));

const main = async (): Promise<number> => {
  switch (command.kind) {
    case "help":
      process.stdout.write(helpText());
      return 0;
    case "version":
      process.stdout.write(`${TERMINAL_VERSION}\n`);
      return 0;
    case "error":
      process.stderr.write(`${command.message}\n\n${helpText()}`);
      return 2;
    case "pair":
      return runPair({ ...command, version: TERMINAL_VERSION });
    case "config":
      return runConfig(command.config);
    case "doctor":
      return runDoctorCommand(command.home);
    case "stop":
      return runStop(command.home);
    case "update":
      return runUpdate({ ...command, version: TERMINAL_VERSION });
    case "provider":
      return runProvider({ ...command, version: TERMINAL_VERSION });
    case "run":
      return runInteractive({ ...command, version: TERMINAL_VERSION });
  }
};

main().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  },
);
