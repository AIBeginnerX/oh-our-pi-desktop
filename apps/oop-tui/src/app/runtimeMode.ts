import type { RuntimeMode } from "@t3tools/contracts";
import { t } from "../i18n/index.ts";

/** What the desktop app calls each runtime mode, in the current language, and what it does. */
export const RUNTIME_MODES: ReadonlyArray<{
  readonly value: RuntimeMode;
  readonly label: string;
  readonly description: string;
  /** Short words `/mode <word>` accepts besides the value itself. */
  readonly aliases: ReadonlyArray<string>;
}> = [
  {
    value: "approval-required",
    get label() {
      return t("session.mode.approval.label");
    },
    get description() {
      return t("session.mode.approval.desc");
    },
    aliases: ["approval"],
  },
  {
    value: "auto-accept-edits",
    get label() {
      return t("session.mode.edits.label");
    },
    get description() {
      return t("session.mode.edits.desc");
    },
    aliases: ["edits"],
  },
  {
    value: "auto",
    get label() {
      return t("session.mode.auto.label");
    },
    get description() {
      return t("session.mode.auto.desc");
    },
    aliases: [],
  },
  {
    value: "full-access",
    get label() {
      return t("session.mode.full.label");
    },
    get description() {
      return t("session.mode.full.desc");
    },
    aliases: ["full"],
  },
];

export const runtimeModeLabel = (mode: RuntimeMode): string =>
  RUNTIME_MODES.find((entry) => entry.value === mode)?.label ?? mode;

/** The mode a `/mode` argument names: a value, an alias or the label; null when none. */
export const parseRuntimeMode = (word: string): RuntimeMode | null => {
  // The labels have a space in them ("Full access"), which may or may not be typed.
  const wanted = word.replace(/\s+/gu, "").toLowerCase();
  if (wanted === "") return null;
  const found = RUNTIME_MODES.find(
    (entry) =>
      entry.value === wanted ||
      entry.aliases.includes(wanted) ||
      entry.label.replace(/\s/gu, "").toLowerCase() === wanted,
  );
  return found?.value ?? null;
};

/** The short words `/mode` accepts, for the message that says what was wrong. */
export const runtimeModeWords = (): string =>
  RUNTIME_MODES.map((entry) => entry.aliases[0] ?? entry.value).join(", ");
