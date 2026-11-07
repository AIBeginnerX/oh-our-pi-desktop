//! The slash commands `app.rs` does not run itself. `run` is asked for every name `run_slash`
//! does not know; each family lives in its own module.

use crate::app::{App, Pick};

/// Runs `/name argument`; false when the name is none of ours.
pub fn run(app: &mut App, name: &str, argument: &str) -> bool {
    match name {
        "implement" => crate::cmd_implement::run(app),
        "continue" => crate::cmd_continue::run(app),
        "copy" => crate::cmd_copy::run(app, argument),
        "theme" => crate::cmd_misc::theme(app, argument),
        "update" => crate::cmd_misc::update(app),
        "threads" | "t" => crate::cmd_misc::threads(app),
        "projects" | "p" => crate::cmd_misc::projects(app),
        "goal" => crate::cmd_goal::run(app, argument),
        "crew" => crate::cmd_crew::run(app, argument),
        "provider" => crate::cmd_provider::run(app, argument),
        "mobile" => crate::mobile::command(app),
        "stats" => crate::cmd_stats::stats(app),
        "tasks" => crate::cmd_stats::tasks(app, argument),
        "history" => crate::cmd_history::history(app, argument),
        "diff" => crate::cmd_history::diff(app, argument),
        "undo" => crate::cmd_history::undo(app),
        "skills" => crate::cmd_skills::run(app, argument),
        "replay" => crate::replay::command(app),
        _ => return false,
    }
    true
}

/// A list from `Modal::Pick` was answered with row `index`.
pub fn picked(app: &mut App, pick: &Pick, index: usize) {
    match pick.id {
        "theme" => crate::cmd_misc::theme_picked(app, pick, index),
        "undo" => crate::cmd_history::undo_picked(app, pick, index),
        "crew" => crate::cmd_crew::picked(app, pick, index),
        "skills" => crate::cmd_skills::picked(app, pick, index),
        crate::folder::ID => crate::folder::picked(app, pick, index),
        _ => {}
    }
}
