import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

/** A command the composer runs itself, instead of sending it to the agent. */
export interface SlashCommand {
  readonly name: string;
  /** What the menu says it does. */
  readonly note: string;
  /** Other spellings that run the same command. */
  readonly aliases: ReadonlyArray<string>;
  /** Tab leaves a space after it, since the command is usually given a word. */
  readonly takesArgument?: true;
  /** The argument is a sentence, not one word (`/goal <text>`). */
  readonly freeText?: true;
  /** How `/help` writes the argument, such as `[값]`. */
  readonly usage?: string;
}

/** In the order the menu lists them when nothing narrows them down. */
export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: "model", note: "모델 선택", aliases: ["models"] },
  {
    name: "mode",
    note: "권한 모드 보기·바꾸기",
    aliases: [],
    takesArgument: true,
    // The labels in the help have spaces in them (`/mode 전체 접근`).
    freeText: true,
    usage: "[승인 필요|편집 자동 승인|자동|전체 접근]",
  },
  {
    name: "effort",
    note: "리저닝 강도 보기·바꾸기",
    aliases: [],
    takesArgument: true,
    usage: "[값]",
  },
  { name: "plan", note: "계획 모드로 전환", aliases: [] },
  { name: "default", note: "기본 모드로 전환", aliases: [] },
  { name: "implement", note: "제안된 계획을 구현", aliases: [] },
  {
    name: "goal",
    note: "스레드 목표 설정·확인",
    aliases: [],
    takesArgument: true,
    freeText: true,
    usage: "[내용|clear|max 횟수]",
  },
  {
    name: "crew",
    note: "Crew 켜고 끄기·역할 모델·작업 보드",
    aliases: [],
    takesArgument: true,
    freeText: true,
    usage: "[on|off|preset|model|default|back]",
  },
  {
    name: "provider",
    note: "Provider 목록·추가·삭제",
    aliases: [],
    takesArgument: true,
    freeText: true,
    usage: "[list|add|remove]",
  },
  {
    name: "dag-workflow",
    note: "오른쪽에 workflow 창 열기·닫기",
    aliases: ["workflow"],
    takesArgument: true,
    usage: "[on|off|번호|next|prev|live]",
  },
  {
    name: "dag-agents",
    note: "오른쪽에 에이전트 창 열기·닫기",
    aliases: [],
    takesArgument: true,
    usage: "[on|off|live]",
  },
  { name: "new", note: "새 스레드", aliases: [] },
  { name: "threads", note: "스레드 목록", aliases: ["t"] },
  { name: "projects", note: "프로젝트 목록", aliases: ["p"] },
  { name: "stats", note: "이 스레드의 도구 사용 통계", aliases: [] },
  {
    name: "tasks",
    note: "왼쪽 아래에 작업 목록 열기·닫기",
    aliases: [],
    takesArgument: true,
    usage: "[on|off]",
  },
  { name: "history", note: "이전 대화 더 보기", aliases: [], takesArgument: true, usage: "[개수]" },
  {
    name: "diff",
    note: "턴이 바꾼 파일과 diff 보기",
    aliases: [],
    takesArgument: true,
    // A file name may have spaces in it.
    freeText: true,
    usage: "[턴번호] [파일]",
  },
  { name: "undo", note: "마지막 턴 되돌리기", aliases: [] },
  { name: "theme", note: "색 테마 보기·바꾸기", aliases: [], takesArgument: true, usage: "[이름]" },
  { name: "update", note: "새 릴리스와 업데이트 방법 보기", aliases: [] },
  { name: "help", note: "도움말", aliases: ["?"] },
  { name: "exit", note: "종료", aliases: ["quit", "q"] },
];

/**
 * The word after the slash while the text is still one word, which is when the menu is open;
 * null for anything else, since a space ends the command and what follows is its argument.
 */
export const slashQuery = (text: string): string | null =>
  text.startsWith("/") && !/\s/u.test(text) ? text.slice(1).toLowerCase() : null;

/** Rank bands, best first: the name, an alias, a word of the description. Equal bands keep the menu's order. */
const BAND = 1000;

const bandOf = (command: SlashCommand, query: string): number | null => {
  const match = (value: string, exact: number, prefix: number, includes?: number): number | null =>
    scoreQueryMatch({
      value: normalizeSearchQuery(value),
      query,
      exactBase: exact * BAND,
      prefixBase: prefix * BAND,
      ...(includes === undefined ? {} : { includesBase: includes * BAND }),
    });
  const bands = [
    match(command.name, 0, 1),
    ...command.aliases.map((alias) => match(alias, 2, 3)),
    match(command.note, 4, 4, 4),
  ]
    .filter((score): score is number => score !== null)
    .map((score) => Math.floor(score / BAND));
  return bands.length === 0 ? null : Math.min(...bands);
};

/**
 * The commands whose name or an alias begins with what has been typed, then those whose description
 * contains it. Equal matches keep the order of the menu.
 */
export const matchSlashCommands = (query: string): ReadonlyArray<SlashCommand> => {
  const wanted = normalizeSearchQuery(query);
  if (wanted === "") return SLASH_COMMANDS;
  return SLASH_COMMANDS.map((command, index) => ({ command, index, band: bandOf(command, wanted) }))
    .filter(
      (entry): entry is { command: SlashCommand; index: number; band: number } =>
        entry.band !== null,
    )
    .toSorted((left, right) => left.band - right.band || left.index - right.index)
    .map((entry) => entry.command);
};
