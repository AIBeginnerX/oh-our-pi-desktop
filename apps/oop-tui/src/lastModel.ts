import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ModelSelection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { configDirectory, type PathEnv } from "./link/paths.ts";

/**
 * The model chosen last in this terminal, with its options (reasoning effort and the like). The
 * server keeps no "last used" value (the desktop app keeps its own in the browser), so this lives
 * next to settings.json. Only a pick made here changes it: a turn run from another device does not.
 */
export const lastModelFilePath = (paths: PathEnv): string =>
  (paths.platform === "win32" ? NodePath.win32.join : NodePath.join)(
    configDirectory(paths),
    "last-model.json",
  );

const decode = Schema.decodeUnknownSync(ModelSelection);

/** The remembered selection, or null when there is none or the file is unreadable. Never throws. */
export const readLastModel = (file: string): ModelSelection | null => {
  try {
    return decode(JSON.parse(NodeFS.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
};

/** Replaces the file whole. A failed save is ignored: the pick still works for this session. */
export const writeLastModel = (file: string, selection: ModelSelection): void => {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(temporary, `${JSON.stringify(selection, null, 2)}\n`);
    NodeFS.renameSync(temporary, file);
  } catch {
    NodeFS.rmSync(temporary, { force: true });
  }
};
