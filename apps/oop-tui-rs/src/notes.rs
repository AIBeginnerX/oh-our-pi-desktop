//! Local notes under the conversation: what a slash command says that is not part of the thread
//! (`/diff`'s report, `/goal`'s status, `/update`'s releases). They are the Rust app's counterpart
//! of the TypeScript terminal's rail notes written into the scrollback: they belong to the screen,
//! not to the server, and are dropped when another thread opens.

use crate::app::App;
use crate::text::{sanitize, wrap};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tone {
    Info,
    Done,
    Warning,
    Error,
}

#[derive(Clone, Debug)]
pub enum Note {
    /// A titled block of plain text, wrapped to the width when drawn.
    Text {
        tone: Tone,
        title: String,
        body: Vec<String>,
    },
    /// Rows that are already styled (a diff); drawn as they are, clipped at the edge.
    Rows { lines: Vec<Line<'static>> },
}

/// How many notes are kept; older ones fall off the top.
const KEEP: usize = 40;

impl App {
    /// Adds a note under the conversation and follows the end, so it is seen.
    pub fn add_note(&mut self, note: Note) {
        self.notes.push(note);
        if self.notes.len() > KEEP {
            self.notes.remove(0);
        }
        self.scroll.set(0);
    }

    /// A one-block note with a title.
    pub fn note(&mut self, tone: Tone, title: &str, body: Vec<String>) {
        self.add_note(Note::Text {
            tone,
            title: title.to_string(),
            body,
        });
    }

    /// A refusal or a failure worth keeping: it stays in the conversation, unlike the notice.
    pub fn say(&mut self, tone: Tone, text: &str) {
        self.note(tone, "", vec![text.to_string()]);
    }
}

/// The lines of every note at this width, each led by a blank line.
pub fn lines(app: &App, w: usize) -> Vec<Line<'static>> {
    let t = &app.theme;
    let mut out = Vec::new();
    for note in &app.notes {
        out.push(Line::default());
        match note {
            Note::Rows { lines } => out.extend(lines.iter().cloned()),
            Note::Text { tone, title, body } => {
                let color = match tone {
                    Tone::Info => t.brand,
                    Tone::Done => t.success,
                    Tone::Warning => t.warning,
                    Tone::Error => t.error,
                };
                let rail = Span::styled(format!("{} ", app.sym.bar), Style::new().fg(color));
                if !title.is_empty() {
                    out.push(Line::from(vec![
                        rail.clone(),
                        Span::styled(
                            sanitize(title),
                            Style::new().fg(color).add_modifier(Modifier::BOLD),
                        ),
                    ]));
                }
                for paragraph in body {
                    if paragraph.is_empty() {
                        out.push(Line::from(rail.clone()));
                        continue;
                    }
                    for row in wrap(&sanitize(paragraph), w.saturating_sub(3).max(8)) {
                        out.push(Line::from(vec![rail.clone(), Span::raw(row)]));
                    }
                }
            }
        }
    }
    out
}
