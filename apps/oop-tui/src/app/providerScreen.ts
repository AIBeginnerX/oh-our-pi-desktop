import { emptyEditor, editorFromText, editorText, type EditorState } from "../input/editor.ts";
import type { KeyEvent } from "../input/keys.ts";
import type { RegionFrame } from "../render/liveRegion.ts";
import { RAIL_COLUMNS, type RailTone } from "../render/rail.ts";
import type { Style } from "../render/style.ts";
import type { Symbols } from "../render/symbols.ts";
import { sanitizeForTerminal } from "../text/width.ts";
import { wrapStyled } from "../text/wrap.ts";
import { planLines, type ProviderRow, type RemoveCheck, type RemovePlan } from "./providerPlan.ts";
import {
  draftProblem,
  newDraft,
  SECRET_SET,
  summarize,
  TARGETS,
  targetFields,
  targetLabel,
  targetDriver,
  validateInstanceId,
  withId,
  withName,
  withValue,
  type AddDraft,
  type FieldModel,
  type Target,
} from "./providerSpec.ts";
import { editSecretText, editPromptText } from "./textPrompt.ts";
import { renderPicker, renderTextPrompt, type PickerItem } from "./view.ts";

/** What a form row edits by typing. */
type EditKey =
  | { readonly kind: "name" }
  | { readonly kind: "id" }
  | { readonly kind: "field"; readonly field: FieldModel };

/**
 * The screens `/provider add` and `/provider remove` open. The draft is kept whole, secrets
 * included, and never printed: frames show a secret only as `SECRET_SET`, and the field being
 * typed is drawn masked.
 */
export type ProviderView =
  | { readonly kind: "pick"; readonly selected: number }
  | {
      readonly kind: "form";
      readonly draft: AddDraft;
      readonly selected: number;
      /** Esc returns to the list of kinds rather than closing. */
      readonly fromPick: boolean;
    }
  | {
      readonly kind: "edit";
      readonly draft: AddDraft;
      readonly fromPick: boolean;
      readonly target: EditKey;
      readonly editor: EditorState;
      readonly row: number;
    }
  | {
      readonly kind: "choose";
      readonly draft: AddDraft;
      readonly fromPick: boolean;
      readonly field: FieldModel;
      readonly selected: number;
      readonly row: number;
    }
  | {
      readonly kind: "review";
      readonly draft: AddDraft;
      readonly fromPick: boolean;
      readonly selected: number;
    }
  | { readonly kind: "pickRemove"; readonly selected: number }
  | {
      readonly kind: "remove";
      readonly plan: RemovePlan;
      readonly editor: EditorState;
      readonly fromPick: boolean;
    };

/** What the screen draws and checks against, read fresh for each key and frame. */
export interface ProviderContext {
  /** Ids an instance already has. */
  readonly taken: ReadonlySet<string>;
  readonly rows: ReadonlyArray<ProviderRow>;
  readonly checkRemove: (id: string) => RemoveCheck;
}

/** What the flow must do for a key; the screen only moves between its views. */
export type ProviderEffect =
  | { readonly kind: "none" }
  | { readonly kind: "submit"; readonly draft: AddDraft }
  | { readonly kind: "remove"; readonly id: string };

export interface ProviderKeyResult {
  /** The view after the key; null closes the screen. */
  readonly view: ProviderView | null;
  readonly effect: ProviderEffect;
  readonly notice?: string;
}

const stay = (
  view: ProviderView | null,
  effect: ProviderEffect = { kind: "none" },
): ProviderKeyResult => ({ view, effect });

const warn = (view: ProviderView, notice: string): ProviderKeyResult => ({
  view,
  effect: { kind: "none" },
  notice,
});

// ---- entering the screens ---------------------------------------------------------------------

type FormRow =
  | { readonly kind: "name" }
  | { readonly kind: "id" }
  | { readonly kind: "field"; readonly field: FieldModel }
  | { readonly kind: "next" };

const formRows = (draft: AddDraft): ReadonlyArray<FormRow> => [
  { kind: "name" },
  { kind: "id" },
  ...targetFields(draft.target).map((field): FormRow => ({ kind: "field", field })),
  { kind: "next" },
];

/** The row to start on: the first one that still needs something, else the last. */
const firstOpenRow = (draft: AddDraft, taken: ReadonlySet<string>): number => {
  const rows = formRows(draft);
  const open = rows.findIndex((row) => {
    if (row.kind === "id") return validateInstanceId(draft.id, taken) !== null;
    return (
      row.kind === "field" &&
      row.field.required === true &&
      typeof draft.values[row.field.key] !== "string"
    );
  });
  return open === -1 ? rows.length - 1 : open;
};

export const openPickView = (): ProviderView => ({ kind: "pick", selected: 0 });

export const openRemovePick = (): ProviderView => ({ kind: "pickRemove", selected: 0 });

/** The form for `draft`, or its review when nothing is missing (the draft came from command arguments). */
export const openDraftView = (
  draft: AddDraft,
  context: ProviderContext,
  fromPick = false,
): ProviderView =>
  draftProblem(draft, context.taken) === null
    ? { kind: "review", draft, fromPick, selected: 0 }
    : { kind: "form", draft, fromPick, selected: firstOpenRow(draft, context.taken) };

export const openRemoveView = (plan: RemovePlan, fromPick = false): ProviderView => ({
  kind: "remove",
  plan,
  editor: emptyEditor,
  fromPick,
});

// ---- keys -------------------------------------------------------------------------------------

const countOf = (view: ProviderView, context: ProviderContext): number => {
  switch (view.kind) {
    case "pick":
      return TARGETS.length;
    case "form":
      return formRows(view.draft).length;
    case "choose":
      return view.field.options?.length ?? 0;
    case "review":
      return 2;
    case "pickRemove":
      return removable(context).length;
    default:
      return 0;
  }
};

const removable = (context: ProviderContext): ProviderRow[] =>
  context.rows.filter((row) => !row.isDefault);

const isEnter = (event: KeyEvent): boolean =>
  event.type === "key" && event.name === "enter" && !event.shift && !event.alt;

/** The `yes` a deletion waits for, in any case, with spaces around ignored. */
export const isYes = (text: string): boolean => text.trim().toLowerCase() === "yes";

const fieldText = (draft: AddDraft, field: FieldModel): string => {
  const value = draft.values[field.key];
  return typeof value === "string" ? value : "";
};

/**
 * One key on the screen. The arrows and the digits 1-9 move the pointer, Enter acts, Esc goes back
 * a step (or closes). Typing fields take every printable key, so there Esc and Enter are the only
 * ones that leave. Nothing is sent from here: the flow carries out the effect.
 */
export const providerKey = (
  view: ProviderView,
  context: ProviderContext,
  event: KeyEvent,
): ProviderKeyResult => {
  if (view.kind === "edit") return editKey(view, context, event);
  if (view.kind === "remove") return removeKey(view, event);
  const count = countOf(view, context);
  const selected = "selected" in view ? view.selected : 0;
  const withSelected = (index: number): ProviderView =>
    ({ ...view, selected: index }) as ProviderView;
  if (event.type === "text") {
    if (event.text === "q") return back(view, context);
    const index = /^[1-9]$/u.test(event.text) ? Number(event.text) - 1 : -1;
    return stay(index >= 0 && index < count ? withSelected(index) : view);
  }
  if (event.type !== "key") return stay(view);
  switch (event.name) {
    case "up":
      return stay(withSelected(Math.max(0, selected - 1)));
    case "down":
      return stay(withSelected(Math.max(0, Math.min(count - 1, selected + 1))));
    case "escape":
      return back(view, context);
    case "enter":
      return activate(view, context);
    default:
      return stay(view);
  }
};

const back = (view: ProviderView, context: ProviderContext): ProviderKeyResult => {
  switch (view.kind) {
    case "form":
      return stay(view.fromPick ? openPickView() : null);
    case "choose":
      return stay({ kind: "form", draft: view.draft, fromPick: view.fromPick, selected: view.row });
    case "review":
      return stay({
        kind: "form",
        draft: view.draft,
        fromPick: view.fromPick,
        selected: formRows(view.draft).length - 1,
      });
    case "remove":
      return stay(view.fromPick ? openRemovePick() : null);
    default:
      void context;
      return stay(null);
  }
};

const activate = (view: ProviderView, context: ProviderContext): ProviderKeyResult => {
  if (view.kind === "pick") {
    const target = TARGETS[view.selected];
    if (target === undefined) return stay(view);
    return stay(openDraftView(newDraft(target), context, true));
  }
  if (view.kind === "pickRemove") {
    const row = removable(context)[view.selected];
    if (row === undefined) return stay(view);
    const check = context.checkRemove(row.id);
    return check.ok ? stay(openRemoveView(check.plan, true)) : warn(view, check.reason);
  }
  if (view.kind === "review") {
    if (view.selected === 1) return back(view, context);
    const problem = draftProblem(view.draft, context.taken);
    if (problem !== null) {
      return warn(
        { kind: "form", draft: view.draft, fromPick: view.fromPick, selected: 0 },
        problem,
      );
    }
    return stay(view, { kind: "submit", draft: view.draft });
  }
  if (view.kind === "choose") {
    const option = view.field.options?.[view.selected];
    if (option === undefined) return stay(view);
    return stay({
      kind: "form",
      draft: {
        ...view.draft,
        values: withValue(view.draft.target, view.draft.values, view.field.key, option.value),
      },
      fromPick: view.fromPick,
      selected: view.row,
    });
  }
  if (view.kind !== "form") return stay(view);
  const row = formRows(view.draft)[view.selected];
  if (row === undefined) return stay(view);
  const edit = (target: EditKey, text: string): ProviderView => ({
    kind: "edit",
    draft: view.draft,
    fromPick: view.fromPick,
    target,
    editor: editorFromText(text),
    row: view.selected,
  });
  switch (row.kind) {
    case "name":
      return stay(edit(row, view.draft.name));
    case "id":
      return stay(edit(row, view.draft.id));
    case "next": {
      const problem = draftProblem(view.draft, context.taken);
      if (problem !== null) {
        return warn({ ...view, selected: firstOpenRow(view.draft, context.taken) }, problem);
      }
      return stay({ kind: "review", draft: view.draft, fromPick: view.fromPick, selected: 0 });
    }
    case "field": {
      const { field } = row;
      if (field.control === "switch") {
        const now = view.draft.values[field.key];
        const current = typeof now === "boolean" ? now : (field.defaultBoolean ?? false);
        return stay({
          ...view,
          draft: {
            ...view.draft,
            values: withValue(view.draft.target, view.draft.values, field.key, !current),
          },
        });
      }
      if (field.control === "select") {
        const options = field.options ?? [];
        const at = options.findIndex((option) => option.value === view.draft.values[field.key]);
        return stay({
          kind: "choose",
          draft: view.draft,
          fromPick: view.fromPick,
          field,
          selected: Math.max(0, at),
          row: view.selected,
        });
      }
      // A secret already typed is not shown again, so the field starts empty.
      return stay(edit(row, field.control === "password" ? "" : fieldText(view.draft, field)));
    }
  }
};

const leaveEdit = (
  view: Extract<ProviderView, { kind: "edit" }>,
  draft: AddDraft,
): ProviderKeyResult => stay({ kind: "form", draft, fromPick: view.fromPick, selected: view.row });

const editKey = (
  view: Extract<ProviderView, { kind: "edit" }>,
  context: ProviderContext,
  event: KeyEvent,
): ProviderKeyResult => {
  if (event.type === "key" && event.name === "escape") return leaveEdit(view, view.draft);
  const secret = view.target.kind === "field" && view.target.field.control === "password";
  if (!isEnter(event)) {
    const editor = secret ? editSecretText(view.editor, event) : editPromptText(view.editor, event);
    return stay({ ...view, editor: editor === view.editor ? view.editor : editor });
  }
  const text = editorText(view.editor).replace(/\s+/gu, " ").trim();
  const { target, draft } = view;
  if (target.kind === "name") return leaveEdit(view, withName(draft, sanitizeForTerminal(text)));
  if (target.kind === "id") {
    if (text === "") return leaveEdit(view, withId(draft, ""));
    const problem = validateInstanceId(text, context.taken);
    return problem === null ? leaveEdit(view, withId(draft, text)) : warn(view, problem);
  }
  const { field } = target;
  if (field.control === "password") {
    // An empty answer keeps what was typed before.
    const typed = editorText(view.editor).trim();
    return leaveEdit(
      view,
      typed === ""
        ? draft
        : { ...draft, values: withValue(draft.target, draft.values, field.key, typed) },
    );
  }
  return leaveEdit(view, {
    ...draft,
    values: withValue(
      draft.target,
      draft.values,
      field.key,
      text === "" ? null : sanitizeForTerminal(text),
    ),
  });
};

const removeKey = (
  view: Extract<ProviderView, { kind: "remove" }>,
  event: KeyEvent,
): ProviderKeyResult => {
  if (event.type === "key" && event.name === "escape") {
    return stay(view.fromPick ? openRemovePick() : null);
  }
  if (isEnter(event)) {
    if (isYes(editorText(view.editor))) return stay(view, { kind: "remove", id: view.plan.id });
    return warn(view, "삭제하려면 yes 를 입력하세요. 취소는 Esc 입니다.");
  }
  return stay({ ...view, editor: editPromptText(view.editor, event) });
};

// ---- the frame --------------------------------------------------------------------------------

const numbered = (items: ReadonlyArray<PickerItem>): PickerItem[] =>
  items.map((item, index) => ({
    ...item,
    label: index < 9 ? `${index + 1}  ${item.label}` : item.label,
  }));

export interface ProviderFrameEnv {
  readonly columns: number;
  readonly rows: number;
  readonly style: Style;
  readonly symbols: Symbols;
  readonly banner: string | null;
  readonly tone: RailTone;
}

const REMOVE_ROWS = 12;

const valueText = (draft: AddDraft, field: FieldModel): string => {
  const value = draft.values[field.key];
  if (field.control === "password") {
    return typeof value === "string" && value.trim() !== "" ? SECRET_SET : "(없음)";
  }
  if (field.control === "switch") {
    return (typeof value === "boolean" ? value : (field.defaultBoolean ?? false)) ? "켜짐" : "꺼짐";
  }
  if (typeof value !== "string" || value.trim() === "") {
    return field.placeholder === undefined ? "(기본값)" : `(${field.placeholder})`;
  }
  return field.options?.find((option) => option.value === value)?.label ?? value;
};

const targetNote = (target: Target): string => {
  if (target.kind === "preset") return "OpenCode 로 실행";
  return target.driver.earlyAccess ? "Early Access" : "";
};

export const providerFrame = (
  view: ProviderView,
  context: ProviderContext,
  env: ProviderFrameEnv,
): RegionFrame => {
  const { theme } = env.style;
  const room = Math.max(8, env.columns - 1 - RAIL_COLUMNS);
  const dim = (text: string) => theme.dim(sanitizeForTerminal(text));
  const picker = (value: Parameters<typeof renderPicker>[0]) =>
    renderPicker(value, env.columns, env.rows, env.style, env.symbols, env.banner, env.tone);
  const prompt = (value: Parameters<typeof renderTextPrompt>[0]) =>
    renderTextPrompt(value, env.columns, env.style, env.symbols, env.banner, env.tone, env.rows);

  switch (view.kind) {
    case "pick":
      return picker({
        title: "추가할 Provider 를 고르세요",
        items: numbered(
          TARGETS.map((target) => ({ label: targetLabel(target), note: targetNote(target) })),
        ),
        selected: view.selected,
        hint: "↑/↓ 이동 • 1-9 선택 • Enter 다음 • Esc 닫기",
        empty: "",
      });
    case "form": {
      const rows = formRows(view.draft);
      const items = rows.map((row): PickerItem => {
        switch (row.kind) {
          case "name":
            return {
              label: `이름  ${view.draft.name.trim() === "" ? `(기본: ${targetLabel(view.draft.target)})` : view.draft.name}`,
              note: "선택",
            };
          case "id":
            return {
              label: `ID  ${view.draft.id === "" ? "(필요)" : view.draft.id}`,
              note: view.draft.idTouched || view.draft.id === "" ? "필수" : "이름에서 자동",
            };
          case "field":
            return {
              label: `${row.field.label}  ${valueText(view.draft, row.field)}`,
              note: row.field.required === true ? "필수" : "",
            };
          case "next":
            return { label: "다음: 확인", note: "요약을 보고 추가합니다" };
        }
      });
      return picker({
        title: `${targetLabel(view.draft.target)} 추가`,
        items: numbered(items),
        selected: view.selected,
        hint: "↑/↓ 이동 • Enter 편집 • Esc 뒤로",
        empty: "",
        before: [
          dim(`종류 ${targetDriver(view.draft.target)} · 비밀값은 입력해도 화면에 나오지 않습니다`),
        ],
      });
    }
    case "choose":
      return picker({
        title: view.field.label,
        items: numbered(
          (view.field.options ?? []).map((option) => ({
            label: option.label,
            note: option.value === view.draft.values[view.field.key] ? "현재" : "",
          })),
        ),
        selected: view.selected,
        hint: "↑/↓ 이동 • Enter 선택 • Esc 뒤로",
        empty: "",
      });
    case "review":
      return picker({
        title: `${targetLabel(view.draft.target)} 추가할까요?`,
        items: numbered([{ label: "추가" }, { label: "돌아가기" }]),
        selected: view.selected,
        hint: "↑/↓ 이동 • Enter 실행 • Esc 뒤로",
        empty: "",
        before: summarize(view.draft).flatMap((row) =>
          wrapStyled(
            `${theme.dim(row.label)}  ${theme.text(sanitizeForTerminal(row.value))}`,
            room,
          ),
        ),
      });
    case "pickRemove":
      return picker({
        title: "삭제할 Provider 를 고르세요",
        items: numbered(
          removable(context).map((row) => ({ label: `${row.id}  ${row.name}`, note: row.status })),
        ),
        selected: view.selected,
        hint: "↑/↓ 이동 • 1-9 선택 • Enter 다음 • Esc 닫기",
        empty: "지울 수 있는 Provider 가 없습니다. 기본 인스턴스는 지울 수 없습니다.",
      });
    case "remove": {
      const lines = planLines(view.plan).flatMap((line) =>
        wrapStyled(sanitizeForTerminal(line), room),
      );
      const shown =
        lines.length > REMOVE_ROWS ? [...lines.slice(0, REMOVE_ROWS - 1), dim("…")] : lines;
      return prompt({
        title: "삭제하려면 yes 를 입력하세요",
        editor: view.editor,
        placeholder: "yes",
        hint: "Enter 삭제 • Esc 취소",
        before: shown,
      });
    }
    case "edit": {
      const { target } = view;
      const secret = target.kind === "field" && target.field.control === "password";
      const label =
        target.kind === "name" ? "이름" : target.kind === "id" ? "ID" : target.field.label;
      const hints: string[] = [];
      if (target.kind === "id")
        hints.push("영문자로 시작, 영문자·숫자·-·_ 만, 64자까지. 비우면 이름에서 만듭니다");
      if (target.kind === "name") hints.push("비우면 종류 이름을 씁니다");
      if (secret) hints.push("입력한 값은 화면에 나오지 않습니다. 비우고 Enter 면 그대로 둡니다");
      return prompt({
        title: `${label} 입력`,
        editor: view.editor,
        placeholder:
          target.kind === "field"
            ? (target.field.placeholder ?? "")
            : target.kind === "id"
              ? "예: codex_work"
              : "",
        hint: "Enter 확인 • Esc 취소",
        before: hints.flatMap((hint) => wrapStyled(dim(hint), room)),
        ...(secret ? { mask: env.symbols.mask } : {}),
      });
    }
  }
};
