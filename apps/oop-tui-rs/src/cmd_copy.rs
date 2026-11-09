//! `/copy`: the code of the latest answer on the clipboard in one step, exactly as written, so a
//! command can be pasted into a shell without selecting across wrapped, indented rows. `/copy` takes
//! the last fenced block, `/copy N` block N and `/copy all` every block joined by a newline. An answer
//! with no block falls back to its inline `code` span, when there is exactly one. The text is queued
//! like any copy (`App::copy_named`); the main loop alone touches the clipboard.

use crate::app::App;
use crate::i18n::{Lang, lang, tr};
use crate::markdown::{code_blocks, inline_code};
use crate::transcript::answer;

pub fn run(app: &mut App, argument: &str) {
    let messages = answer(&app.conv.thread);
    let blocks: Vec<String> = messages.iter().flat_map(|m| code_blocks(&m.text)).collect();
    let arg = argument.trim();
    let chosen: Result<Vec<String>, String> = if arg.is_empty() {
        match blocks.last() {
            Some(last) => Ok(vec![last.clone()]),
            None => {
                let spans: Vec<String> =
                    messages.iter().flat_map(|m| inline_code(&m.text)).collect();
                match spans.as_slice() {
                    [only] => Ok(vec![only.clone()]),
                    _ => Err(tr("copy.nothing").into()),
                }
            }
        }
    } else if arg.eq_ignore_ascii_case("all") {
        if blocks.is_empty() {
            Err(tr("copy.nothing").into())
        } else {
            Ok(blocks.clone())
        }
    } else if let Ok(n) = arg.parse::<usize>() {
        match n.checked_sub(1).and_then(|i| blocks.get(i)) {
            Some(block) => Ok(vec![block.clone()]),
            None if blocks.is_empty() => Err(tr("copy.nothing").into()),
            None => Err(tr("copy.noBlock")
                .replace("{n}", arg)
                .replace("{total}", &blocks.len().to_string())),
        }
    } else {
        Err(tr("copy.usage").into())
    };
    match chosen {
        Ok(parts) if parts.iter().all(|p| p.trim().is_empty()) => {
            app.notice = Some(tr("copy.nothing").into());
        }
        Ok(parts) => {
            let text = parts.join("\n");
            let what = describe(parts.len(), text.lines().count());
            app.copy_named(text, Some(what));
        }
        Err(notice) => app.notice = Some(notice),
    }
}

/// "1 command (2 lines)": what the notice says was copied.
fn describe(commands: usize, lines: usize) -> String {
    match lang() {
        Lang::Ko => format!("명령 {commands}개 ({lines}줄)"),
        Lang::En => format!(
            "{commands} {} ({lines} {})",
            if commands == 1 { "command" } else { "commands" },
            if lines == 1 { "line" } else { "lines" }
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Msg;
    use crate::clipboard::Outcome;
    use serde_json::json;
    use tokio::sync::mpsc::unbounded_channel;

    fn app_answering(texts: &[&str]) -> App {
        let (tx, _rx) = unbounded_channel();
        let mut app = App::new("9.9.9", "/Users/x/demo", "/Users/x", tx);
        app.last_model_path = std::env::temp_dir().join("oop-rs-copy-none/last-model.json");
        app.handle(Msg::Shell(json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1,
            "projects": [{"id": "p", "title": "demo", "workspaceRoot": "/Users/x/demo"}],
            "threads": [{"id": "t", "projectId": "p", "title": "t", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}]}})));
        app.active = crate::app::Active::Thread("t".into());
        app.conv = crate::state::Conversation::new("t");
        let mut messages = vec![
            json!({"id": "u", "role": "user", "text": "how?", "streaming": false, "createdAt": "2026-01-01T00:00:01.000Z"}),
        ];
        for (i, text) in texts.iter().enumerate() {
            messages.push(
                json!({"id": format!("a{i}"), "role": "assistant", "text": text, "streaming": false,
                "createdAt": format!("2026-01-01T00:00:0{}.000Z", i + 2)}),
            );
        }
        app.conv.apply(
            &json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 2, "thread": {"title": "t",
            "modelSelection": {"instanceId": "codex", "model": "gpt"}, "messages": messages}}}),
        );
        app
    }

    const NONE: &str = "Just words, nothing to run.";
    const ONE: &str = "Run it:\n\n```sh\nnpm install\nnpm test\n```\nDone.";
    const THREE: &str = "A:\n```sh\none\n```\nB:\n  ```rust\n  fn main() {\n      two();\n  }\n  ```\nC:\n```\nthree\n```";

    fn copied(app: &mut App, arg: &str) -> Option<(String, Option<String>)> {
        run(app, arg);
        app.take_copy().map(|j| (j.text, j.what))
    }

    #[test]
    fn a_bare_copy_takes_the_last_block_as_written() {
        let mut app = app_answering(&[THREE]);
        assert_eq!(copied(&mut app, "").unwrap().0, "three");
        let mut app = app_answering(&[ONE]);
        let (text, what) = copied(&mut app, "").unwrap();
        assert_eq!(
            text, "npm install\nnpm test",
            "no fences, no trailing newline"
        );
        assert_eq!(what.as_deref(), Some("1 command (2 lines)"));
    }

    #[test]
    fn a_number_picks_a_block_and_the_fence_indent_is_removed() {
        let mut app = app_answering(&[THREE]);
        assert_eq!(copied(&mut app, "1").unwrap().0, "one");
        assert_eq!(
            copied(&mut app, "2").unwrap().0,
            "fn main() {\n    two();\n}"
        );
    }

    #[test]
    fn all_joins_every_block_with_a_newline() {
        let mut app = app_answering(&[THREE]);
        let (text, what) = copied(&mut app, "all").unwrap();
        assert_eq!(text, "one\nfn main() {\n    two();\n}\nthree");
        assert_eq!(what.as_deref(), Some("3 commands (5 lines)"));
    }

    #[test]
    fn a_number_out_of_range_or_a_bad_word_copies_nothing_and_says_why() {
        let mut app = app_answering(&[THREE]);
        for arg in ["9", "0", "x"] {
            assert!(copied(&mut app, arg).is_none(), "/copy {arg}");
        }
        run(&mut app, "9");
        assert_eq!(
            app.notice.as_deref(),
            Some("No code block 9: the answer has 3.")
        );
        run(&mut app, "x");
        assert_eq!(app.notice.as_deref(), Some(tr("copy.usage")));
    }

    #[test]
    fn without_a_block_one_inline_span_is_the_command_and_otherwise_nothing() {
        let mut app = app_answering(&["Try `cargo test --lib` now."]);
        let (text, what) = copied(&mut app, "").unwrap();
        assert_eq!(text, "cargo test --lib");
        assert_eq!(what.as_deref(), Some("1 command (1 line)"));
        for answer in ["Use `a` or `b`.", NONE] {
            let mut app = app_answering(&[answer]);
            assert!(copied(&mut app, "").is_none(), "{answer}");
            assert_eq!(app.notice.as_deref(), Some(tr("copy.nothing")));
        }
        // a block wins over inline spans, and inline spans inside a fence are not spans
        let mut app = app_answering(&["Use `a`.\n```\nx `y` z\n```"]);
        assert_eq!(copied(&mut app, "").unwrap().0, "x `y` z");
        let mut app = app_answering(&[NONE]);
        assert!(copied(&mut app, "2").is_none() && copied(&mut app, "all").is_none());
    }

    #[test]
    fn the_answer_spans_the_agents_messages_since_the_user_spoke() {
        let mut app = app_answering(&[ONE, "```\nlater\n```", "All done."]);
        assert_eq!(copied(&mut app, "").unwrap().0, "later");
        assert_eq!(copied(&mut app, "1").unwrap().0, "npm install\nnpm test");
        assert_eq!(
            copied(&mut app, "all").unwrap().1.as_deref(),
            Some("2 commands (3 lines)")
        );
    }

    #[test]
    fn no_open_thread_has_nothing_to_copy() {
        let (tx, _rx) = unbounded_channel();
        let mut app = App::new("9.9.9", "/Users/x/demo", "/Users/x", tx);
        assert!(copied(&mut app, "").is_none());
    }

    #[test]
    fn the_queued_job_carries_the_osc52_sequence_and_wraps_it_for_tmux() {
        let mut app = app_answering(&["```\nnpm\n```"]);
        run(&mut app, "");
        let job = app.take_copy().unwrap();
        assert_eq!(job.osc52.as_deref(), Some("\u{1b}]52;c;bnBt\u{7}"));
        app.clip_plan.tmux = true;
        run(&mut app, "");
        let wrapped = app.take_copy().unwrap().osc52.unwrap();
        assert!(
            wrapped.starts_with("\u{1b}Ptmux;\u{1b}\u{1b}]52;c;bnBt"),
            "{wrapped:?}"
        );
    }

    #[test]
    fn the_transcript_numbers_blocks_of_the_latest_answer_only_with_two_or_more() {
        let th = &crate::theme::LAVENDER;
        let sym = &crate::theme::UNICODE;
        let shown = |app: &App| -> String {
            crate::transcript::build(&app.conv.thread, 60, th, sym)
                .iter()
                .map(|l| {
                    l.spans
                        .iter()
                        .map(|s| s.content.as_ref())
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let three = shown(&app_answering(&[THREE]));
        assert!(
            three.contains("[1]") && three.contains("[2]") && three.contains("[3]"),
            "{three}"
        );
        let one = shown(&app_answering(&[ONE]));
        assert!(one.contains("/copy") && !one.contains("[1]"), "{one}");
        let none = shown(&app_answering(&[NONE, "Use `x`."]));
        assert!(!none.contains("/copy") && !none.contains('['), "{none}");
        // numbers run across the messages of one answer
        let split = shown(&app_answering(&[ONE, "```\nlater\n```"]));
        assert!(split.contains("[1]") && split.contains("[2]"), "{split}");
    }

    fn notice_for(what: Option<&str>, tool_ok: bool, osc52: bool) -> String {
        crate::app::copy_notice(&Outcome {
            chars: 20,
            osc52_sent: osc52,
            tool: tool_ok.then(|| ("pbcopy".to_string(), Ok(()))),
            too_large: false,
            what: what.map(str::to_string),
        })
    }

    #[test]
    fn the_notice_names_what_was_copied_and_still_counts_characters_for_other_copies() {
        assert_eq!(
            notice_for(Some("1 command (2 lines)"), true, true),
            "Copied 1 command (2 lines)."
        );
        assert!(
            notice_for(Some("1 command (2 lines)"), false, true).contains("1 command (2 lines)")
        );
        assert_eq!(notice_for(None, true, true), "Copied 20 characters.");
    }
}
