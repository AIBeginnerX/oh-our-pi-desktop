import { t } from "../i18n/index.ts";
import type { ClipboardOutcome } from "./clipboard.ts";

/** What the status line says about a copy: that it worked, how, and what went wrong if anything did. */
export const copyNotice = (outcome: ClipboardOutcome): string => {
  const count = outcome.chars;
  const { tool } = outcome;
  const toolWhy = tool !== null && !tool.ok ? t(`session.c.copyWhy.${tool.reason}`) : "";
  if (tool?.ok === true) return t("session.c.copied", { count });
  if (outcome.osc52 === "sent") {
    return tool === null
      ? t("session.c.copiedTerminal", { count })
      : t("session.c.copiedTerminalToolFailed", { count, tool: tool.name, why: toolWhy });
  }
  const why =
    tool !== null
      ? `${tool.name}: ${toolWhy}`
      : outcome.osc52 === "tooLarge"
        ? t("session.c.copyWhy.tooLarge")
        : t("session.c.copyWhy.noWay");
  return t("session.c.copyFailed", { why });
};
