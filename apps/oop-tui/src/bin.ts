import { HELP_TEXT, parseArgs } from "./cli.ts";
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

const command = parseArgs(process.argv.slice(2));

const main = async (): Promise<number> => {
  switch (command.kind) {
    case "help":
      process.stdout.write(HELP_TEXT);
      return 0;
    case "version":
      process.stdout.write(`${TERMINAL_VERSION}\n`);
      return 0;
    case "error":
      process.stderr.write(`${command.message}\n\n${HELP_TEXT}`);
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
