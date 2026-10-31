import type { RuntimeMode } from "@t3tools/contracts";

/** What the desktop app calls each runtime mode, in Korean, and what it does. */
export const RUNTIME_MODES: ReadonlyArray<{
  readonly value: RuntimeMode;
  readonly label: string;
  readonly description: string;
  /** Short words `/mode <word>` accepts besides the value itself. */
  readonly aliases: ReadonlyArray<string>;
}> = [
  {
    value: "approval-required",
    label: "승인 필요",
    description: "명령과 파일 변경 전에 묻습니다.",
    aliases: ["approval"],
  },
  {
    value: "auto-accept-edits",
    label: "편집 자동 승인",
    description: "편집은 자동 승인하고, 다른 작업은 묻습니다.",
    aliases: ["edits"],
  },
  {
    value: "auto",
    label: "자동",
    description: "지원하는 제공자는 일상적인 작업을 승인하고, 나머지는 묻습니다.",
    aliases: [],
  },
  {
    value: "full-access",
    label: "전체 접근",
    description: "명령과 편집을 묻지 않고 허용합니다.",
    aliases: ["full"],
  },
];

export const runtimeModeLabel = (mode: RuntimeMode): string =>
  RUNTIME_MODES.find((entry) => entry.value === mode)?.label ?? mode;

/** The mode a `/mode` argument names: a value, an alias or the Korean label; null when none. */
export const parseRuntimeMode = (word: string): RuntimeMode | null => {
  // The Korean labels have a space in them ("전체 접근"), which may or may not be typed.
  const wanted = word.replace(/\s+/gu, "").toLowerCase();
  if (wanted === "") return null;
  const found = RUNTIME_MODES.find(
    (entry) =>
      entry.value === wanted ||
      entry.aliases.includes(wanted) ||
      entry.label.replace(/\s/gu, "") === wanted,
  );
  return found?.value ?? null;
};

/** The short words `/mode` accepts, for the message that says what was wrong. */
export const runtimeModeWords = (): string =>
  RUNTIME_MODES.map((entry) => entry.aliases[0] ?? entry.value).join(", ");
