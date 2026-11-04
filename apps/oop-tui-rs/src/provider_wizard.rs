//! The add screens of `oop provider add`, and the list `oop provider remove` picks from: ported
//! from the former TypeScript terminal's provider screen and wizard. The screens are a plain state
//! machine (`key_press`) that is drawn with `screen_of` and carried by `Session`, so they are tested
//! without a terminal; `run` and `pick_remove` put them on the alternate screen in raw mode with
//! bracketed paste, draw after a key or a resize and at no other time, and leave the terminal as
//! they found it. The draft is kept whole, secrets included, and never printed: frames show a
//! secret only as "set", and the field being typed is drawn masked.

use crate::provider_plan::Context;
use crate::provider_spec::{
    AddDraft, Control, Field, TARGET_COUNT, Target, Val, draft_problem, new_draft,
    sanitize_terminal, secret_set, summarize, target_driver, target_fields, target_label, targets,
    validate_instance_id, with_id, with_name, with_value,
};
use crate::provider_text::{t, tf};
use crate::text;

// ---- keys ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Name {
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    Enter,
    Escape,
    Backspace,
    Delete,
}

/// A key as the screens need it (`KeyEvent` of the TypeScript terminal).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    Text(String),
    Paste(String),
    Ctrl(char),
    Named {
        name: Name,
        ctrl: bool,
        alt: bool,
        shift: bool,
    },
}

impl Key {}

fn is_enter(key: &Key) -> bool {
    matches!(
        key,
        Key::Named {
            name: Name::Enter,
            alt: false,
            shift: false,
            ..
        }
    )
}

fn is_escape(key: &Key) -> bool {
    matches!(
        key,
        Key::Named {
            name: Name::Escape,
            ..
        }
    )
}

// ---- a one-line editor --------------------------------------------------------------------------

/// The text being typed and where the cursor is. Never printed whole: a field may hold a secret.
#[derive(Clone, Default, PartialEq)]
pub struct Editor {
    chars: Vec<char>,
    cursor: usize,
}

impl std::fmt::Debug for Editor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Editor({} chars)", self.chars.len())
    }
}

impl Editor {
    pub fn from_text(text: &str) -> Editor {
        let chars: Vec<char> = text.chars().collect();
        Editor {
            cursor: chars.len(),
            chars,
        }
    }

    pub fn text(&self) -> String {
        self.chars.iter().collect()
    }

    fn insert(&mut self, text: &str) {
        for c in text.chars() {
            self.chars.insert(self.cursor, c);
            self.cursor += 1;
        }
    }

    fn word_start(&self) -> usize {
        let mut at = self.cursor;
        while at > 0 && self.chars[at - 1].is_whitespace() {
            at -= 1;
        }
        while at > 0 && !self.chars[at - 1].is_whitespace() {
            at -= 1;
        }
        at
    }

    fn word_end(&self) -> usize {
        let mut at = self.cursor;
        while at < self.chars.len() && self.chars[at].is_whitespace() {
            at += 1;
        }
        while at < self.chars.len() && !self.chars[at].is_whitespace() {
            at += 1;
        }
        at
    }

    /// The editing keys of a one-question field: the ones that move or change the text. Enter,
    /// Esc and Ctrl-C belong to whoever shows the field. A secret is one line, whatever is pasted.
    fn edit(&mut self, key: &Key, secret: bool) {
        let line =
            |text: &str| -> String { text.chars().filter(|c| *c != '\n' && *c != '\r').collect() };
        match key {
            Key::Text(text) | Key::Paste(text) => {
                let one = if secret {
                    line(text)
                } else {
                    text.replace(['\r', '\n'], " ")
                };
                self.insert(&one);
            }
            Key::Ctrl(letter) => match letter {
                'a' => self.cursor = 0,
                'e' => self.cursor = self.chars.len(),
                'u' => {
                    self.chars.drain(..self.cursor);
                    self.cursor = 0;
                }
                'k' => self.chars.truncate(self.cursor),
                'w' => self.delete_word_back(),
                'b' => self.cursor = self.cursor.saturating_sub(1),
                'f' => self.cursor = (self.cursor + 1).min(self.chars.len()),
                _ => {}
            },
            Key::Named {
                name, ctrl, alt, ..
            } => {
                let word = *alt || *ctrl;
                match name {
                    Name::Backspace if word => self.delete_word_back(),
                    Name::Backspace => {
                        if self.cursor > 0 {
                            self.cursor -= 1;
                            self.chars.remove(self.cursor);
                        }
                    }
                    Name::Delete => {
                        if self.cursor < self.chars.len() {
                            self.chars.remove(self.cursor);
                        }
                    }
                    Name::Left if word => self.cursor = self.word_start(),
                    Name::Left => self.cursor = self.cursor.saturating_sub(1),
                    Name::Right if word => self.cursor = self.word_end(),
                    Name::Right => self.cursor = (self.cursor + 1).min(self.chars.len()),
                    Name::Home => self.cursor = 0,
                    Name::End => self.cursor = self.chars.len(),
                    _ => {}
                }
            }
        }
    }

    fn delete_word_back(&mut self) {
        let start = self.word_start();
        self.chars.drain(start..self.cursor);
        self.cursor = start;
    }
}

// ---- the views ----------------------------------------------------------------------------------

/// What a form row edits by typing.
#[derive(Debug, Clone, PartialEq)]
pub enum EditKey {
    Name,
    Id,
    Field(Field),
}

#[derive(Debug, Clone, PartialEq)]
pub enum View {
    Pick {
        selected: usize,
    },
    Form {
        draft: AddDraft,
        selected: usize,
        from_pick: bool,
    },
    Edit {
        draft: AddDraft,
        from_pick: bool,
        target: EditKey,
        editor: Editor,
        row: usize,
    },
    Choose {
        draft: AddDraft,
        from_pick: bool,
        field: Field,
        selected: usize,
        row: usize,
    },
    Review {
        draft: AddDraft,
        from_pick: bool,
        selected: usize,
    },
    PickRemove {
        selected: usize,
    },
}

/// What the caller must do for a key; the screen only moves between its views.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    None,
    Submit(AddDraft),
    /// The id chosen from the list of what can be removed.
    Pick(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct KeyResult {
    /// The view after the key; `None` closes the screen.
    pub view: Option<View>,
    pub effect: Effect,
    pub notice: Option<String>,
}

fn stay(view: Option<View>) -> KeyResult {
    KeyResult {
        view,
        effect: Effect::None,
        notice: None,
    }
}

fn warn(view: View, notice: String) -> KeyResult {
    KeyResult {
        view: Some(view),
        effect: Effect::None,
        notice: Some(notice),
    }
}

#[derive(Debug, Clone, PartialEq)]
enum FormRow {
    Name,
    Id,
    Field(Field),
    Next,
}

fn form_rows(draft: &AddDraft) -> Vec<FormRow> {
    let mut rows = vec![FormRow::Name, FormRow::Id];
    rows.extend(target_fields(draft.target).into_iter().map(FormRow::Field));
    rows.push(FormRow::Next);
    rows
}

/// The row to start on: the first one that still needs something, else the last.
fn first_open_row(draft: &AddDraft, ctx: &Context) -> usize {
    let rows = form_rows(draft);
    rows.iter()
        .position(|row| match row {
            FormRow::Id => validate_instance_id(&draft.id, &ctx.taken).is_some(),
            FormRow::Field(field) => {
                field.required && !matches!(draft.values.get(field.key), Some(Val::S(_)))
            }
            _ => false,
        })
        .unwrap_or(rows.len() - 1)
}

pub fn open_pick() -> View {
    View::Pick { selected: 0 }
}

pub fn open_remove_pick() -> View {
    View::PickRemove { selected: 0 }
}

/// The form for `draft`, or its review when nothing is missing (the draft came from command
/// arguments).
pub fn open_draft(draft: AddDraft, ctx: &Context, from_pick: bool) -> View {
    if draft_problem(&draft, &ctx.taken).is_none() {
        View::Review {
            draft,
            from_pick,
            selected: 0,
        }
    } else {
        let selected = first_open_row(&draft, ctx);
        View::Form {
            draft,
            selected,
            from_pick,
        }
    }
}

fn removable(ctx: &Context) -> Vec<&crate::provider_plan::ProviderRow> {
    ctx.rows.iter().filter(|row| !row.is_default).collect()
}

fn count_of(view: &View, ctx: &Context) -> usize {
    match view {
        View::Pick { .. } => TARGET_COUNT,
        View::Form { draft, .. } => form_rows(draft).len(),
        View::Choose { field, .. } => field.options.len(),
        View::Review { .. } => 2,
        View::PickRemove { .. } => removable(ctx).len(),
        View::Edit { .. } => 0,
    }
}

fn with_selected(view: &View, index: usize) -> View {
    let mut next = view.clone();
    match &mut next {
        View::Pick { selected }
        | View::Form { selected, .. }
        | View::Choose { selected, .. }
        | View::Review { selected, .. }
        | View::PickRemove { selected } => *selected = index,
        View::Edit { .. } => {}
    }
    next
}

fn selected_of(view: &View) -> usize {
    match view {
        View::Pick { selected }
        | View::Form { selected, .. }
        | View::Choose { selected, .. }
        | View::Review { selected, .. }
        | View::PickRemove { selected } => *selected,
        View::Edit { .. } => 0,
    }
}

/// One key on the screen. The arrows and the digits 1-9 move the pointer, Enter acts, Esc goes back
/// a step (or closes). Typing fields take every printable key, so there Esc and Enter are the only
/// ones that leave. Nothing is sent from here: the caller carries out the effect.
pub fn key_press(view: &View, ctx: &Context, key: &Key) -> KeyResult {
    if let View::Edit { .. } = view {
        return edit_key(view, ctx, key);
    }
    let count = count_of(view, ctx);
    let selected = selected_of(view);
    match key {
        Key::Text(text) => {
            if text == "q" {
                return back(view);
            }
            let index = match text.as_bytes() {
                [digit @ b'1'..=b'9'] => usize::from(digit - b'1'),
                _ => usize::MAX,
            };
            stay(Some(if index < count {
                with_selected(view, index)
            } else {
                view.clone()
            }))
        }
        Key::Named { name: Name::Up, .. } => {
            stay(Some(with_selected(view, selected.saturating_sub(1))))
        }
        Key::Named {
            name: Name::Down, ..
        } => stay(Some(with_selected(
            view,
            (selected + 1).min(count.saturating_sub(1)),
        ))),
        Key::Named {
            name: Name::Escape, ..
        } => back(view),
        Key::Named {
            name: Name::Enter, ..
        } => activate(view, ctx),
        _ => stay(Some(view.clone())),
    }
}

fn back(view: &View) -> KeyResult {
    match view {
        View::Form { from_pick, .. } => stay(if *from_pick { Some(open_pick()) } else { None }),
        View::Choose {
            draft,
            from_pick,
            row,
            ..
        } => stay(Some(View::Form {
            draft: draft.clone(),
            from_pick: *from_pick,
            selected: *row,
        })),
        View::Review {
            draft, from_pick, ..
        } => stay(Some(View::Form {
            draft: draft.clone(),
            from_pick: *from_pick,
            selected: form_rows(draft).len() - 1,
        })),
        _ => stay(None),
    }
}

fn field_text(draft: &AddDraft, field: &Field) -> String {
    match draft.values.get(field.key) {
        Some(Val::S(text)) => text.clone(),
        _ => String::new(),
    }
}

fn activate(view: &View, ctx: &Context) -> KeyResult {
    match view {
        View::Pick { selected } => match targets().get(*selected) {
            Some(target) => stay(Some(open_draft(new_draft(*target), ctx, true))),
            None => stay(Some(view.clone())),
        },
        View::PickRemove { selected } => match removable(ctx).get(*selected) {
            None => stay(Some(view.clone())),
            Some(row) => match ctx.check_remove(&row.id) {
                Ok(_) => KeyResult {
                    view: Some(view.clone()),
                    effect: Effect::Pick(row.id.clone()),
                    notice: None,
                },
                Err(reason) => warn(view.clone(), reason),
            },
        },
        View::Review {
            draft,
            from_pick,
            selected,
        } => {
            if *selected == 1 {
                return back(view);
            }
            if let Some(problem) = draft_problem(draft, &ctx.taken) {
                return warn(
                    View::Form {
                        draft: draft.clone(),
                        from_pick: *from_pick,
                        selected: 0,
                    },
                    problem,
                );
            }
            KeyResult {
                view: Some(view.clone()),
                effect: Effect::Submit(draft.clone()),
                notice: None,
            }
        }
        View::Choose {
            draft,
            from_pick,
            field,
            selected,
            row,
        } => {
            let Some((value, _)) = field.options.get(*selected) else {
                return stay(Some(view.clone()));
            };
            let mut draft = draft.clone();
            draft.values = with_value(
                draft.target,
                &draft.values,
                field.key,
                Some(Val::S(value.clone())),
            );
            stay(Some(View::Form {
                draft,
                from_pick: *from_pick,
                selected: *row,
            }))
        }
        View::Form {
            draft,
            selected,
            from_pick,
        } => {
            let Some(row) = form_rows(draft).get(*selected).cloned() else {
                return stay(Some(view.clone()));
            };
            let edit = |target: EditKey, text: &str| {
                stay(Some(View::Edit {
                    draft: draft.clone(),
                    from_pick: *from_pick,
                    target,
                    editor: Editor::from_text(text),
                    row: *selected,
                }))
            };
            match row {
                FormRow::Name => edit(EditKey::Name, &draft.name),
                FormRow::Id => edit(EditKey::Id, &draft.id),
                FormRow::Next => match draft_problem(draft, &ctx.taken) {
                    Some(problem) => warn(
                        View::Form {
                            draft: draft.clone(),
                            selected: first_open_row(draft, ctx),
                            from_pick: *from_pick,
                        },
                        problem,
                    ),
                    None => stay(Some(View::Review {
                        draft: draft.clone(),
                        from_pick: *from_pick,
                        selected: 0,
                    })),
                },
                FormRow::Field(field) => match field.control {
                    Control::Switch => {
                        let current = match draft.values.get(field.key) {
                            Some(Val::B(now)) => *now,
                            _ => field.default_bool,
                        };
                        let mut draft = draft.clone();
                        draft.values = with_value(
                            draft.target,
                            &draft.values,
                            field.key,
                            Some(Val::B(!current)),
                        );
                        stay(Some(View::Form {
                            draft,
                            selected: *selected,
                            from_pick: *from_pick,
                        }))
                    }
                    Control::Select => {
                        let at = field
                            .options
                            .iter()
                            .position(|(value, _)| {
                                draft.values.get(field.key) == Some(&Val::S(value.clone()))
                            })
                            .unwrap_or(0);
                        stay(Some(View::Choose {
                            draft: draft.clone(),
                            from_pick: *from_pick,
                            field,
                            selected: at,
                            row: *selected,
                        }))
                    }
                    // A secret already typed is not shown again, so the field starts empty.
                    Control::Password => edit(EditKey::Field(field), ""),
                    Control::Text => {
                        let text = field_text(draft, &field);
                        edit(EditKey::Field(field), &text)
                    }
                },
            }
        }
        View::Edit { .. } => stay(Some(view.clone())),
    }
}

fn edit_key(view: &View, ctx: &Context, key: &Key) -> KeyResult {
    let View::Edit {
        draft,
        from_pick,
        target,
        editor,
        row,
    } = view
    else {
        return stay(Some(view.clone()));
    };
    let leave = |draft: AddDraft| {
        stay(Some(View::Form {
            draft,
            from_pick: *from_pick,
            selected: *row,
        }))
    };
    if is_escape(key) {
        return leave(draft.clone());
    }
    let secret = matches!(target, EditKey::Field(field) if field.control == Control::Password);
    if !is_enter(key) {
        let mut editor = editor.clone();
        editor.edit(key, secret);
        return stay(Some(View::Edit {
            draft: draft.clone(),
            from_pick: *from_pick,
            target: target.clone(),
            editor,
            row: *row,
        }));
    }
    let collapsed = editor
        .text()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    match target {
        EditKey::Name => leave(with_name(draft.clone(), &sanitize_terminal(&collapsed))),
        EditKey::Id => {
            if collapsed.is_empty() {
                return leave(with_id(draft.clone(), ""));
            }
            match validate_instance_id(&collapsed, &ctx.taken) {
                None => leave(with_id(draft.clone(), &collapsed)),
                Some(problem) => warn(view.clone(), problem),
            }
        }
        EditKey::Field(field) if field.control == Control::Password => {
            // An empty answer keeps what was typed before.
            let typed = editor.text().trim().to_string();
            let mut draft = draft.clone();
            if !typed.is_empty() {
                draft.values =
                    with_value(draft.target, &draft.values, field.key, Some(Val::S(typed)));
            }
            leave(draft)
        }
        EditKey::Field(field) => {
            let mut draft = draft.clone();
            let value = (!collapsed.is_empty()).then(|| Val::S(sanitize_terminal(&collapsed)));
            draft.values = with_value(draft.target, &draft.values, field.key, value);
            leave(draft)
        }
    }
}

// ---- what is drawn ------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub label: String,
    pub note: String,
}

/// A line being typed: `text` is what is drawn (masked for a secret), `cursor` a character index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Input {
    pub text: String,
    pub cursor: usize,
    pub placeholder: String,
}

/// One frame of the screens, as data.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Screen {
    pub title: String,
    pub before: Vec<String>,
    pub items: Vec<Item>,
    pub selected: usize,
    pub empty: String,
    pub input: Option<Input>,
    pub hint: String,
    pub banner: Option<String>,
}

const MASK: &str = "•";

fn numbered(items: Vec<Item>) -> Vec<Item> {
    items
        .into_iter()
        .enumerate()
        .map(|(index, item)| Item {
            label: if index < 9 {
                format!("{}  {}", index + 1, item.label)
            } else {
                item.label
            },
            note: item.note,
        })
        .collect()
}

fn value_text(draft: &AddDraft, field: &Field) -> String {
    let value = draft.values.get(field.key);
    match field.control {
        Control::Password => match value {
            Some(Val::S(text)) if !text.trim().is_empty() => secret_set().to_string(),
            _ => t("providers.screen.none").to_string(),
        },
        Control::Switch => {
            let on = match value {
                Some(Val::B(now)) => *now,
                _ => field.default_bool,
            };
            t(if on {
                "providers.cmd.on"
            } else {
                "providers.cmd.off"
            })
            .to_string()
        }
        _ => match value {
            Some(Val::S(text)) if !text.trim().is_empty() => field
                .options
                .iter()
                .find(|(option, _)| option == text)
                .map_or_else(|| text.clone(), |(_, label)| label.clone()),
            _ => field.placeholder.map_or_else(
                || t("providers.screen.defaultValue").to_string(),
                |placeholder| format!("({placeholder})"),
            ),
        },
    }
}

fn target_note(target: Target) -> String {
    match target {
        Target::Preset(_) => t("providers.screen.runsOnOpenCode").to_string(),
        Target::Driver(index) => {
            if crate::provider_spec::DRIVERS[index].early_access {
                "Early Access".to_string()
            } else {
                String::new()
            }
        }
    }
}

/// What `view` shows. `columns` is the width the long lines of a review are wrapped to.
pub fn screen_of(view: &View, ctx: &Context, banner: Option<&str>, columns: usize) -> Screen {
    let room = columns.saturating_sub(3).max(8);
    let mut screen = Screen {
        banner: banner.map(str::to_string),
        ..Screen::default()
    };
    match view {
        View::Pick { selected } => {
            screen.title = t("providers.screen.pickAdd").into();
            screen.items = numbered(
                targets()
                    .into_iter()
                    .map(|target| Item {
                        label: crate::provider_spec::target_label(target).to_string(),
                        note: target_note(target),
                    })
                    .collect(),
            );
            screen.selected = *selected;
            screen.hint = t("providers.screen.hintPick").into();
        }
        View::Form {
            draft, selected, ..
        } => {
            let items = form_rows(draft)
                .iter()
                .map(|row| match row {
                    FormRow::Name => Item {
                        label: format!(
                            "{}  {}",
                            t("providers.cmd.colName"),
                            if draft.name.trim().is_empty() {
                                tf(
                                    "providers.spec.defaultName",
                                    &[("name", target_label(draft.target).to_string())],
                                )
                            } else {
                                draft.name.clone()
                            }
                        ),
                        note: t("providers.screen.optional").into(),
                    },
                    FormRow::Id => Item {
                        label: format!(
                            "ID  {}",
                            if draft.id.is_empty() {
                                t("providers.screen.needed").to_string()
                            } else {
                                draft.id.clone()
                            }
                        ),
                        note: t(if draft.id_touched || draft.id.is_empty() {
                            "providers.screen.required"
                        } else {
                            "providers.screen.autoFromName"
                        })
                        .into(),
                    },
                    FormRow::Field(field) => Item {
                        label: format!("{}  {}", field.label, value_text(draft, field)),
                        note: if field.required {
                            t("providers.screen.required").into()
                        } else {
                            String::new()
                        },
                    },
                    FormRow::Next => Item {
                        label: t("providers.screen.next").into(),
                        note: t("providers.screen.nextNote").into(),
                    },
                })
                .collect();
            screen.title = tf(
                "providers.screen.formTitle",
                &[("kind", target_label(draft.target).to_string())],
            );
            screen.items = numbered(items);
            screen.selected = *selected;
            screen.hint = t("providers.screen.hintForm").into();
            screen.before = vec![tf(
                "providers.screen.formNote",
                &[("driver", target_driver(draft.target).to_string())],
            )];
        }
        View::Choose {
            draft,
            field,
            selected,
            ..
        } => {
            screen.title = field.label.clone();
            screen.items = numbered(
                field
                    .options
                    .iter()
                    .map(|(value, label)| Item {
                        label: label.clone(),
                        note: if draft.values.get(field.key) == Some(&Val::S(value.clone())) {
                            t("providers.screen.current").into()
                        } else {
                            String::new()
                        },
                    })
                    .collect(),
            );
            screen.selected = *selected;
            screen.hint = t("providers.screen.hintChoose").into();
        }
        View::Review {
            draft, selected, ..
        } => {
            screen.title = tf(
                "providers.screen.reviewTitle",
                &[("kind", target_label(draft.target).to_string())],
            );
            screen.items = numbered(vec![
                Item {
                    label: t("providers.screen.add").into(),
                    note: String::new(),
                },
                Item {
                    label: t("providers.screen.back").into(),
                    note: String::new(),
                },
            ]);
            screen.selected = *selected;
            screen.hint = t("providers.screen.hintReview").into();
            screen.before = summarize(draft)
                .iter()
                .flat_map(|row| {
                    text::wrap(
                        &format!("{}  {}", row.label, sanitize_terminal(&row.value)),
                        room,
                    )
                })
                .collect();
        }
        View::PickRemove { selected } => {
            screen.title = t("providers.screen.pickRemove").into();
            screen.items = numbered(
                removable(ctx)
                    .iter()
                    .map(|row| Item {
                        label: format!("{}  {}", row.id, row.name),
                        note: row.status.clone(),
                    })
                    .collect(),
            );
            screen.selected = *selected;
            screen.empty = t("providers.flow.nothingRemovable").into();
            screen.hint = t("providers.screen.hintPick").into();
        }
        View::Edit { target, editor, .. } => {
            let secret =
                matches!(target, EditKey::Field(field) if field.control == Control::Password);
            let label = match target {
                EditKey::Name => t("providers.cmd.colName").to_string(),
                EditKey::Id => "ID".to_string(),
                EditKey::Field(field) => field.label.clone(),
            };
            let mut hints = Vec::new();
            if *target == EditKey::Id {
                hints.push(t("providers.screen.hintId"));
            }
            if *target == EditKey::Name {
                hints.push(t("providers.screen.hintName"));
            }
            if secret {
                hints.push(t("providers.screen.hintSecret"));
            }
            screen.title = tf("providers.screen.editTitle", &[("label", label)]);
            screen.before = hints
                .iter()
                .flat_map(|hint| text::wrap(hint, room))
                .collect();
            screen.hint = t("providers.screen.hintEdit").into();
            screen.input = Some(Input {
                text: if secret {
                    MASK.repeat(editor.chars.len())
                } else {
                    editor.text()
                },
                cursor: editor.cursor,
                placeholder: match target {
                    EditKey::Field(field) => field.placeholder.unwrap_or_default().to_string(),
                    EditKey::Id => t("providers.screen.idExample").to_string(),
                    EditKey::Name => String::new(),
                },
            });
        }
    }
    screen
}

// ---- a running screen ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// The user left.
    Cancel,
    Done(AddDraft),
    Picked(String),
}

/// The screens with the state a run needs: the view, the notice of the last refused step, and
/// what to check against.
pub struct Session {
    pub view: View,
    pub banner: Option<String>,
    ctx: Context,
}

impl Session {
    pub fn new(view: View, ctx: Context) -> Session {
        Session {
            view,
            banner: None,
            ctx,
        }
    }

    /// One key; `Some` ends the run.
    pub fn key(&mut self, key: &Key) -> Option<Outcome> {
        if *key == Key::Ctrl('c') {
            return Some(Outcome::Cancel);
        }
        self.banner = None;
        let result = key_press(&self.view, &self.ctx, key);
        match result.effect {
            Effect::Submit(draft) => return Some(Outcome::Done(draft)),
            Effect::Pick(id) => return Some(Outcome::Picked(id)),
            Effect::None => {}
        }
        match result.view {
            None => Some(Outcome::Cancel),
            Some(view) => {
                self.view = view;
                self.banner = result.notice;
                None
            }
        }
    }

    pub fn screen(&self, columns: usize) -> Screen {
        screen_of(&self.view, &self.ctx, self.banner.as_deref(), columns)
    }
}

// ---- the terminal -------------------------------------------------------------------------------

use ratatui::Frame;
use ratatui::crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers,
};
use ratatui::crossterm::execute;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

/// A terminal key as the screens read it; `None` for one they ignore (a key release, say).
pub fn key_of(event: &KeyEvent) -> Option<Key> {
    if event.kind != KeyEventKind::Press {
        return None;
    }
    let ctrl = event.modifiers.contains(KeyModifiers::CONTROL);
    let alt = event.modifiers.contains(KeyModifiers::ALT);
    let shift = event.modifiers.contains(KeyModifiers::SHIFT);
    let named = |name| {
        Some(Key::Named {
            name,
            ctrl,
            alt,
            shift,
        })
    };
    match event.code {
        KeyCode::Char(c) if ctrl => Some(Key::Ctrl(c.to_ascii_lowercase())),
        KeyCode::Char(_) if alt => None,
        KeyCode::Char(c) => Some(Key::Text(c.to_string())),
        KeyCode::Up => named(Name::Up),
        KeyCode::Down => named(Name::Down),
        KeyCode::Left => named(Name::Left),
        KeyCode::Right => named(Name::Right),
        KeyCode::Home => named(Name::Home),
        KeyCode::End => named(Name::End),
        KeyCode::Enter => named(Name::Enter),
        KeyCode::Esc => named(Name::Escape),
        KeyCode::Backspace => named(Name::Backspace),
        KeyCode::Delete => named(Name::Delete),
        _ => None,
    }
}

/// Draws `screen` over the whole frame, with the cursor on the line being typed.
pub fn draw(frame: &mut Frame, screen: &Screen) {
    let area = frame.area();
    let width = usize::from(area.width).saturating_sub(1).max(1);
    let dim = Style::default().add_modifier(Modifier::DIM);
    let cut = |line: &str| text::truncate(line, width);
    let mut lines: Vec<Line> = vec![Line::styled(
        cut(&screen.title),
        Style::default().add_modifier(Modifier::BOLD),
    )];
    lines.extend(
        screen
            .before
            .iter()
            .map(|line| Line::styled(cut(line), dim)),
    );
    let mut cursor: Option<(u16, u16)> = None;
    // The footer (a notice and the hint) keeps its rows; the list gives way to it.
    let footer = 1 + usize::from(screen.banner.is_some());
    let room = usize::from(area.height)
        .saturating_sub(lines.len() + footer)
        .max(1);
    if let Some(input) = &screen.input {
        let row = lines.len();
        let shown = if input.text.is_empty() {
            &input.placeholder
        } else {
            &input.text
        };
        let style = if input.text.is_empty() {
            dim
        } else {
            Style::default()
        };
        let prefix = "› ";
        lines.push(Line::from(vec![
            Span::raw(prefix),
            Span::styled(cut(shown), style),
        ]));
        let before: String = input.text.chars().take(input.cursor).collect();
        let column = text::width(prefix) + text::width(&before);
        cursor = Some((area.x + column.min(width) as u16, area.y + row as u16));
    } else if screen.items.is_empty() {
        lines.push(Line::styled(cut(&screen.empty), dim));
    } else {
        // Keep the pointer inside the window of rows there is room for.
        let top = screen.selected.saturating_sub(room.saturating_sub(1));
        for (index, item) in screen.items.iter().enumerate().skip(top).take(room) {
            let marker = if index == screen.selected {
                "› "
            } else {
                "  "
            };
            let label = format!("{marker}{}", item.label);
            let note = if item.note.is_empty() {
                String::new()
            } else {
                format!("  {}", item.note)
            };
            let label = text::truncate(&label, width);
            let note = text::truncate(&note, width.saturating_sub(text::width(&label)));
            let style = if index == screen.selected {
                Style::default().add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            lines.push(Line::from(vec![
                Span::styled(label, style),
                Span::styled(note, dim),
            ]));
        }
    }
    if let Some(banner) = &screen.banner {
        lines.push(Line::styled(
            cut(banner),
            Style::default().fg(Color::Yellow),
        ));
    }
    lines.push(Line::styled(cut(&screen.hint), dim));
    frame.render_widget(Paragraph::new(lines), area);
    if let Some((x, y)) = cursor
        && y < area.y + area.height
    {
        frame.set_cursor_position((x, y));
    }
}

/// Runs `view` on the terminal until the user decides. Needs a terminal on standard input and
/// output; blocks, so call it from a blocking task.
fn run_terminal(view: View, ctx: Context) -> Outcome {
    let Ok(mut terminal) = ratatui::try_init() else {
        return Outcome::Cancel;
    };
    let _ = execute!(std::io::stdout(), EnableBracketedPaste);
    let mut session = Session::new(view, ctx);
    let outcome = loop {
        let columns = terminal.size().map_or(80, |size| usize::from(size.width));
        let screen = session.screen(columns);
        if terminal.draw(|frame| draw(frame, &screen)).is_err() {
            break Outcome::Cancel;
        }
        // Drawn after a key or a resize and at no other time.
        let key = loop {
            match ratatui::crossterm::event::read() {
                Ok(Event::Key(event)) => {
                    if let Some(key) = key_of(&event) {
                        break Some(key);
                    }
                }
                Ok(Event::Paste(text)) => break Some(Key::Paste(text)),
                Ok(Event::Resize(..)) => break None,
                Ok(_) => {}
                Err(_) => return finish(Outcome::Cancel),
            }
        };
        if let Some(key) = key
            && let Some(outcome) = session.key(&key)
        {
            break outcome;
        }
    };
    finish(outcome)
}

fn finish(outcome: Outcome) -> Outcome {
    let _ = execute!(std::io::stdout(), DisableBracketedPaste);
    ratatui::restore();
    outcome
}

/// The add screens, started at the list of kinds or at `start`. The draft the user confirmed, or
/// `None` when they left.
pub async fn run(start: Option<AddDraft>, ctx: Context) -> Option<AddDraft> {
    let view = match start {
        None => open_pick(),
        Some(draft) => open_draft(draft, &ctx, false),
    };
    match tokio::task::spawn_blocking(move || run_terminal(view, ctx)).await {
        Ok(Outcome::Done(draft)) => Some(draft),
        _ => None,
    }
}

/// The list of what can be removed; the id the user chose, or `None` when they left.
pub async fn pick_remove(ctx: Context) -> Option<String> {
    match tokio::task::spawn_blocking(move || run_terminal(open_remove_pick(), ctx)).await {
        Ok(Outcome::Picked(id)) => Some(id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_spec::{Preset, parse_target};
    use serde_json::json;

    const SECRET: &str = "test-value-1234";

    fn english() {
        crate::i18n::init(Some("en"));
    }

    fn context() -> Context {
        english();
        let settings = json!({"providerInstances": {
            "codex": {"driver": "codex", "enabled": true},
            "opencode_zai": {"driver": "opencode", "displayName": "Z.AI", "environment": [
                {"name": "OOP_ZAI_API_KEY", "value": "", "sensitive": true, "valueRedacted": true}]},
            "codex_work": {"driver": "codex"}}});
        let providers: Vec<_> = ["codex", "opencode_zai", "codex_work"]
            .iter()
            .map(|id| {
                json!({"instanceId": id, "driver": "codex", "displayName": id, "enabled": true,
                "installed": true, "status": "ready", "models": []})
            })
            .collect();
        let shell = json!({"projects": [], "threads": [{"id": "a", "title": "t",
            "modelSelection": {"instanceId": "opencode_zai", "model": "m"}}]});
        Context::new(
            Some(&json!({"providers": providers})),
            settings,
            Some(shell),
        )
    }

    fn text_key(text: &str) -> Key {
        Key::Text(text.into())
    }

    fn key(name: Name) -> Key {
        Key::Named {
            name,
            ctrl: false,
            alt: false,
            shift: false,
        }
    }

    struct Run {
        view: Option<View>,
        effects: Vec<Effect>,
        notices: Vec<String>,
    }

    /// Presses keys one after another, keeping the last view and every effect and notice.
    fn press(start: View, keys: &[Key]) -> Run {
        let ctx = context();
        let mut run = Run {
            view: Some(start),
            effects: vec![],
            notices: vec![],
        };
        for key in keys {
            let Some(view) = &run.view else { break };
            let result = key_press(view, &ctx, key);
            run.view = result.view;
            if result.effect != Effect::None {
                run.effects.push(result.effect);
            }
            run.notices.extend(result.notice);
        }
        run
    }

    fn enter() -> Key {
        key(Name::Enter)
    }

    fn escape() -> Key {
        key(Name::Escape)
    }

    fn draft_of(word: &str) -> AddDraft {
        new_draft(parse_target(word).unwrap())
    }

    fn form(word: &str, selected: usize) -> View {
        View::Form {
            draft: draft_of(word),
            selected,
            from_pick: true,
        }
    }

    fn plain(screen: &Screen) -> String {
        let mut all = vec![screen.title.clone()];
        all.extend(screen.before.clone());
        all.extend(
            screen
                .items
                .iter()
                .map(|i| format!("{} {}", i.label, i.note)),
        );
        all.extend(screen.input.iter().map(|i| i.text.clone()));
        all.extend(screen.banner.clone());
        all.push(screen.hint.clone());
        all.join("\n")
    }

    fn frame_of(view: &View) -> String {
        plain(&screen_of(view, &context(), None, 61))
    }

    fn draft_in(view: &View) -> &AddDraft {
        match view {
            View::Form { draft, .. } | View::Edit { draft, .. } | View::Review { draft, .. } => {
                draft
            }
            other => panic!("no draft in {other:?}"),
        }
    }

    // ---- choosing what to add ----

    #[test]
    fn the_list_names_every_driver_and_both_presets_numbered() {
        let rows = frame_of(&open_pick());
        for label in [
            "Codex",
            "Claude",
            "OpenCode",
            "MiniMax Code",
            "Z.AI",
            "MiniMax",
        ] {
            assert!(rows.contains(label), "{label}");
        }
        assert!(
            rows.contains("1  Codex") && rows.contains("Early Access"),
            "{rows}"
        );
    }

    #[test]
    fn enter_or_a_number_opens_the_form_of_the_kind_and_esc_goes_back() {
        let run = press(open_pick(), &[key(Name::Down), enter()]);
        let Some(View::Form {
            draft,
            from_pick: true,
            ..
        }) = &run.view
        else {
            panic!("{:?}", run.view)
        };
        assert_eq!(draft.target, Target::Driver(1));
        let by_number = press(open_pick(), &[text_key("5"), enter()]);
        assert_eq!(
            draft_in(by_number.view.as_ref().unwrap()).target,
            Target::Driver(4)
        );
        assert_eq!(
            press(open_pick(), &[enter(), escape()]).view,
            Some(open_pick())
        );
        assert_eq!(press(open_pick(), &[escape()]).view, None);
        assert_eq!(press(open_pick(), &[text_key("q")]).view, None);
    }

    #[test]
    fn the_pointer_stays_in_range() {
        let downs = vec![key(Name::Down); 30];
        assert_eq!(
            press(open_pick(), &downs).view,
            Some(View::Pick { selected: 9 })
        );
        assert_eq!(press(open_pick(), &[key(Name::Up)]).view, Some(open_pick()));
    }

    // ---- the form ----

    #[test]
    fn a_form_starts_on_the_row_that_needs_something_and_the_name_makes_the_id() {
        let ctx = context();
        let start = open_draft(draft_of("codex"), &ctx, true);
        // Row 1 is the id, which a driver cannot do without.
        assert!(matches!(start, View::Form { selected: 1, .. }));
        let named = press(form("codex", 0), &[enter(), text_key("Work"), enter()]);
        let draft = draft_in(named.view.as_ref().unwrap());
        assert_eq!(
            (draft.name.as_str(), draft.id.as_str()),
            ("Work", "codex_work")
        );
    }

    #[test]
    fn an_id_is_checked_while_it_is_typed() {
        for (id, word) in [
            ("1x", "start with a letter"),
            ("codex", "built-in"),
            ("codex_work", "already taken"),
        ] {
            let run = press(form("codex", 1), &[enter(), text_key(id), enter()]);
            assert!(matches!(run.view, Some(View::Edit { .. })), "{id}");
            assert!(
                run.notices.join(" ").contains(word),
                "{id}: {:?}",
                run.notices
            );
        }
        let good = press(form("codex", 1), &[enter(), text_key("mine"), enter()]);
        let draft = draft_in(good.view.as_ref().unwrap());
        assert_eq!((draft.id.as_str(), draft.id_touched), ("mine", true));
    }

    #[test]
    fn it_will_not_go_on_while_something_is_missing_and_says_what() {
        let ctx = context();
        let start = open_draft(draft_of("codex"), &ctx, false);
        let mut keys = vec![key(Name::Down); 8];
        keys.push(enter());
        let run = press(start, &keys);
        assert!(matches!(run.view, Some(View::Form { .. })));
        assert!(run.notices.join(" ").contains("ID"), "{:?}", run.notices);
    }

    #[test]
    fn a_switch_toggles_with_enter_and_a_select_is_picked_from_a_list() {
        let codex = form("codex", 6);
        assert!(
            frame_of(&codex).contains("Send usage statistics"),
            "{}",
            frame_of(&codex)
        );
        let toggled = press(codex, &[enter()]);
        assert_eq!(
            draft_in(toggled.view.as_ref().unwrap())
                .values
                .get("telemetry"),
            Some(&Val::B(true))
        );
        let anti = form("antigravity", 2);
        let chosen = press(anti.clone(), &[enter(), key(Name::Down), enter()]);
        assert_eq!(
            draft_in(chosen.view.as_ref().unwrap())
                .values
                .get("authMethod"),
            Some(&Val::S("oauth-business".into()))
        );
        assert!(matches!(
            press(anti, &[enter(), escape()]).view,
            Some(View::Form { selected: 2, .. })
        ));
    }

    #[test]
    fn a_text_field_is_cleared_by_sending_it_empty() {
        let set = press(
            form("codex", 2),
            &[enter(), text_key("/opt/codex"), enter()],
        );
        assert_eq!(
            draft_in(set.view.as_ref().unwrap())
                .values
                .get("binaryPath"),
            Some(&Val::S("/opt/codex".into()))
        );
        let cleared = press(set.view.unwrap(), &[enter(), Key::Ctrl('u'), enter()]);
        assert!(
            !draft_in(cleared.view.as_ref().unwrap())
                .values
                .contains_key("binaryPath")
        );
    }

    // ---- a secret field ----

    fn preset() -> View {
        open_draft(with_id(draft_of("zai"), "opencode_zai2"), &context(), true)
    }

    #[test]
    fn a_secret_field_is_where_the_form_starts_for_a_preset() {
        assert!(matches!(preset(), View::Form { selected: 2, .. }));
    }

    #[test]
    fn a_secret_is_typed_and_pasted_without_showing_and_kept_whole() {
        let editing = press(
            preset(),
            &[
                enter(),
                text_key("test-"),
                Key::Paste("value-1234\nsecond line".into()),
            ],
        );
        let screen = frame_of(editing.view.as_ref().unwrap());
        assert!(
            !screen.contains("test-") && !screen.contains("value"),
            "{screen}"
        );
        assert!(screen.contains('•'), "{screen}");
        let done = press(editing.view.unwrap(), &[enter()]);
        // A pasted line break is dropped, not kept as part of the secret.
        assert_eq!(
            draft_in(done.view.as_ref().unwrap()).values.get("apiKey"),
            Some(&Val::S("test-value-1234second line".into()))
        );
    }

    #[test]
    fn a_secret_shows_only_that_it_is_set_in_the_form_and_in_the_review() {
        let filled = press(preset(), &[enter(), text_key(SECRET), enter()]);
        let form_screen = frame_of(filled.view.as_ref().unwrap());
        let mut downs = vec![key(Name::Down); 5];
        downs.push(enter());
        let review = press(filled.view.unwrap(), &downs);
        assert!(matches!(review.view, Some(View::Review { .. })));
        for screen in [form_screen, frame_of(review.view.as_ref().unwrap())] {
            assert!(!screen.contains(SECRET), "{screen}");
            assert!(screen.contains("set (masked)"), "{screen}");
        }
    }

    #[test]
    fn an_empty_answer_keeps_the_old_secret_and_esc_leaves_it_as_it_was() {
        let filled = press(preset(), &[enter(), text_key(SECRET), enter()]);
        let again = press(filled.view.clone().unwrap(), &[enter(), enter()]);
        assert_eq!(
            draft_in(again.view.as_ref().unwrap()).values.get("apiKey"),
            Some(&Val::S(SECRET.into()))
        );
        let escaped = press(
            filled.view.unwrap(),
            &[enter(), text_key("other"), escape()],
        );
        assert_eq!(
            draft_in(escaped.view.as_ref().unwrap())
                .values
                .get("apiKey"),
            Some(&Val::S(SECRET.into()))
        );
    }

    #[test]
    fn the_editor_debug_output_never_holds_the_text() {
        let editor = Editor::from_text(SECRET);
        assert!(!format!("{editor:?}").contains(SECRET));
        let view = press(preset(), &[enter(), text_key(SECRET)]).view.unwrap();
        assert!(!format!("{view:?}").contains(SECRET));
    }

    // ---- the review ----

    fn complete() -> View {
        let mut draft = with_id(draft_of("zai"), "opencode_zai2");
        draft.values.insert("apiKey".into(), Val::S(SECRET.into()));
        open_draft(draft, &context(), false)
    }

    #[test]
    fn a_complete_draft_opens_on_its_review_and_enter_adds() {
        assert!(matches!(complete(), View::Review { .. }));
        let submitted = press(complete(), &[enter()]);
        assert!(matches!(submitted.effects.as_slice(), [Effect::Submit(_)]));
        assert!(matches!(
            press(complete(), &[key(Name::Down), enter()]).view,
            Some(View::Form { .. })
        ));
        assert!(matches!(
            press(complete(), &[escape()]).view,
            Some(View::Form { .. })
        ));
        assert_eq!(press(complete(), &[escape(), escape()]).view, None);
    }

    #[test]
    fn it_checks_again_before_it_submits_because_an_id_can_be_taken_meanwhile() {
        let View::Review {
            mut draft,
            from_pick,
            selected,
        } = complete()
        else {
            panic!()
        };
        draft.id = "codex_work".into();
        let run = press(
            View::Review {
                draft,
                from_pick,
                selected,
            },
            &[enter()],
        );
        assert!(run.effects.is_empty());
        assert!(matches!(run.view, Some(View::Form { .. })));
        assert!(run.notices.join(" ").contains("already taken"));
    }

    // ---- removing ----

    #[test]
    fn the_remove_list_has_only_what_can_be_removed_and_enter_picks_one() {
        let screen = frame_of(&open_remove_pick());
        assert!(
            screen.contains("opencode_zai") && screen.contains("codex_work"),
            "{screen}"
        );
        assert!(!screen.contains("codex  codex"), "{screen}");
        let run = press(open_remove_pick(), &[enter()]);
        assert_eq!(run.effects, [Effect::Pick("opencode_zai".into())]);
    }

    #[test]
    fn a_refusal_is_told_at_the_list_and_an_empty_list_says_so() {
        let only_defaults = Context::new(
            None,
            json!({"providerInstances": {"codex": {"driver": "codex", "enabled": true}}}),
            None,
        );
        let screen = screen_of(&open_remove_pick(), &only_defaults, None, 61);
        assert!(
            screen.items.is_empty() && screen.empty.contains("No provider can be removed"),
            "{screen:?}"
        );
    }

    // ---- the editor and the keys ----

    #[test]
    fn the_editor_moves_and_deletes_by_character_and_word() {
        let mut editor = Editor::from_text("one two");
        editor.edit(&Key::Ctrl('w'), false);
        assert_eq!(editor.text(), "one ");
        editor.edit(&Key::Ctrl('a'), false);
        editor.edit(&Key::Text("x".into()), false);
        assert_eq!(editor.text(), "xone ");
        editor.edit(&Key::Ctrl('k'), false);
        assert_eq!(editor.text(), "x");
        editor.edit(&key(Name::Backspace), false);
        editor.edit(&key(Name::Backspace), false);
        assert_eq!(editor.text(), "");
    }

    #[test]
    fn a_terminal_key_press_becomes_a_screen_key_and_a_release_is_ignored() {
        let press = |code, modifiers| KeyEvent::new(code, modifiers);
        assert_eq!(
            key_of(&press(KeyCode::Char('a'), KeyModifiers::NONE)),
            Some(text_key("a"))
        );
        assert_eq!(
            key_of(&press(KeyCode::Char('C'), KeyModifiers::CONTROL)),
            Some(Key::Ctrl('c'))
        );
        assert_eq!(
            key_of(&press(KeyCode::Enter, KeyModifiers::NONE)),
            Some(enter())
        );
        let mut release = press(KeyCode::Enter, KeyModifiers::NONE);
        release.kind = KeyEventKind::Release;
        assert_eq!(key_of(&release), None);
    }

    // ---- a whole run ----

    #[test]
    fn a_run_walks_from_the_list_of_kinds_to_a_confirmed_draft_with_the_secret_never_on_screen() {
        let few = Context::new(
            None,
            json!({"providerInstances": {"codex_work": {"driver": "codex"}}}),
            None,
        );
        let mut session = Session::new(open_pick(), few);
        let mut screens = vec![plain(&session.screen(60))];
        fn feed(
            session: &mut Session,
            screens: &mut Vec<String>,
            keys: Vec<Key>,
        ) -> Option<Outcome> {
            let mut outcome = None;
            for key in keys {
                outcome = session.key(&key);
                screens.push(plain(&session.screen(60)));
            }
            outcome
        }
        // Z.AI is the ninth kind; the form starts on the key.
        assert_eq!(
            feed(&mut session, &mut screens, vec![text_key("9"), enter()]),
            None
        );
        assert!(screens.last().unwrap().contains("API key"));
        feed(
            &mut session,
            &mut screens,
            vec![enter(), text_key(SECRET), enter()],
        );
        let mut downs = vec![key(Name::Down); 4];
        downs.push(enter());
        feed(&mut session, &mut screens, downs);
        assert!(
            screens.last().unwrap().contains("Add Z.AI?"),
            "{}",
            screens.last().unwrap()
        );
        let Some(Outcome::Done(draft)) = feed(&mut session, &mut screens, vec![enter()]) else {
            panic!()
        };
        assert_eq!(draft.id, "opencode_zai");
        assert_eq!(draft.values.get("apiKey"), Some(&Val::S(SECRET.into())));
        assert!(!screens.join("\n").contains(SECRET));
        assert_eq!(draft.target, Target::Preset(Preset::Zai));
    }

    #[test]
    fn a_run_given_a_draft_starts_at_its_review_and_ctrl_c_leaves() {
        let draft = with_id(draft_of("codex"), "codex_x");
        let mut session = Session::new(open_draft(draft, &context(), false), context());
        assert!(plain(&session.screen(60)).contains("Add Codex?"));
        assert_eq!(session.key(&Key::Ctrl('c')), Some(Outcome::Cancel));
    }

    #[test]
    fn a_refusal_is_shown_and_cleared_on_the_next_key() {
        let start = open_draft(draft_of("codex"), &context(), false);
        let mut session = Session::new(start, context());
        for key in [enter(), text_key("codex_work"), enter()] {
            session.key(&key);
        }
        assert!(plain(&session.screen(60)).contains("already taken"));
        session.key(&escape());
        assert!(!plain(&session.screen(60)).contains("already taken"));
    }

    // ---- what is drawn ----

    fn rendered(screen: &Screen, width: u16, height: u16) -> Vec<String> {
        use ratatui::Terminal;
        use ratatui::backend::TestBackend;
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| draw(frame, screen)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol().to_string())
                    .collect::<String>()
            })
            .collect()
    }

    #[test]
    fn the_frames_fit_a_forty_column_terminal_and_show_the_pointer() {
        let views = [
            open_pick(),
            preset(),
            complete(),
            open_remove_pick(),
            form("codex", 0),
        ];
        for view in &views {
            let screen = screen_of(view, &context(), Some("a notice"), 40);
            for line in rendered(&screen, 40, 24) {
                assert!(text::width(line.trim_end()) <= 39, "{line:?}");
            }
        }
        let rows = rendered(&screen_of(&open_pick(), &context(), None, 40), 40, 24).join("\n");
        assert!(rows.contains("› 1  Codex"), "{rows}");
    }

    #[test]
    fn a_secret_being_typed_is_drawn_as_marks_and_never_in_the_clear() {
        let editing = press(preset(), &[enter(), text_key(SECRET)]).view.unwrap();
        let screen = screen_of(&editing, &context(), None, 61);
        let rows = rendered(&screen, 61, 24).join("\n");
        assert!(
            rows.contains(&"•".repeat(SECRET.len())) && !rows.contains(SECRET),
            "{rows}"
        );
        assert_eq!(screen.input.as_ref().unwrap().cursor, SECRET.len());
    }

    #[test]
    fn a_long_list_scrolls_to_keep_the_pointer_in_view() {
        let screen = screen_of(&View::Pick { selected: 9 }, &context(), None, 40);
        let rows = rendered(&screen, 40, 8).join("\n");
        assert!(rows.contains("MiniMax") && rows.contains("› "), "{rows}");
    }
}
