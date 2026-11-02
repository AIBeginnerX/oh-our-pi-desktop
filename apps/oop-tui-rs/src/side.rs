//! The right-hand panel: the Workflow or the Agents view of the thread on screen, drawn by
//! `workflow_panel` / `agents_panel` (each starts with its own tab bar). This builds their input
//! from the app and says whether the view is moving, so the clock redraws it only then.

use crate::agents_panel;
use crate::app::{Active, App, LinkStatus, Side};
use crate::flow::{CrewRoleModel, FlowInput, Waiting, model_label};
use crate::panels_common::{fill, s};
use crate::text::{iso_now, parse_iso_ms};
use crate::workflow_panel;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::{Block, Borders, Paragraph};

/// Runs `f` on the panel input of the thread on screen.
fn with_input<R>(app: &App, f: impl FnOnce(&FlowInput) -> R) -> R {
    let current = app.current_model();
    let brain = current
        .as_ref()
        .and_then(|m| Some((m["instanceId"].as_str()?, m["model"].as_str()?)));
    let crew: Option<Vec<CrewRoleModel>> = crate::crew::roles_of(
        &app.config,
        app.thread_id().as_deref(),
        brain,
        app.active != Active::None,
    );
    let lead_model = current
        .as_ref()
        .and_then(|m| m["model"].as_str())
        .map(|model| model_label(model, app.effort_display().as_deref()));
    let lead_waiting = if app.approval().is_some() {
        Some(Waiting::Approval)
    } else if app.pending_input().is_some() {
        Some(Waiting::Input)
    } else {
        None
    };
    let input = FlowInput {
        thread: &app.conv.thread,
        children: &app.shell.threads,
        lead_model,
        crew: crew.as_deref(),
        lead_waiting,
        loading: matches!(app.active, Active::Thread(_)) && !app.conv.loaded,
        now_ms: parse_iso_ms(&iso_now()).unwrap_or(0),
        tick: app.tick,
        animations: app.settings.animations,
        pinned: app.pinned_flow.clone(),
        online: app.link == LinkStatus::Online,
        scroll: Some(&app.panel_scroll),
    };
    f(&input)
}

// ---- `/dag-workflow` and `/dag-agents` ----------------------------------------------------------

/// What the words after `/dag-workflow` ask for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FlowAction {
    Toggle,
    On,
    Off,
    Live,
    Next,
    Prev,
    Pick(usize),
}

/// Reads the words after the command; `None` when they are not something it takes.
pub fn parse_flow_action(word: &str) -> Option<FlowAction> {
    let word = word.trim().to_lowercase();
    Some(match word.as_str() {
        "" => FlowAction::Toggle,
        "on" => FlowAction::On,
        "off" => FlowAction::Off,
        "live" => FlowAction::Live,
        "next" => FlowAction::Next,
        "prev" => FlowAction::Prev,
        digits if digits.len() <= 4 && digits.chars().all(|c| c.is_ascii_digit()) => {
            FlowAction::Pick(digits.parse().ok()?)
        }
        _ => return None,
    })
}

/// What happens to the layout when a view's command is run.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PanelMove {
    Open,
    Switch,
    Close,
    Nothing,
}

/// Each command shows its own view. Closed, the panel opens; with the other view up it switches
/// without closing; the same command again closes it, and so does `off`. `off` for the view that
/// is not shown has nothing to turn off.
pub fn plan_panel_move(view: Side, action: FlowAction, shown: Option<Side>) -> PanelMove {
    if action == FlowAction::Off {
        return if shown == Some(view) {
            PanelMove::Close
        } else {
            PanelMove::Nothing
        };
    }
    if shown == Some(view) {
        return if action == FlowAction::Toggle {
            PanelMove::Close
        } else {
            PanelMove::Nothing
        };
    }
    if shown.is_none() {
        PanelMove::Open
    } else {
        PanelMove::Switch
    }
}

/// Applies a pick, `next`, `prev` or `live` to the pinned flow; `Err` says why it cannot.
/// `ids` are the thread's flows, newest first.
pub fn choose_flow(
    ids: &[String],
    live: Option<usize>,
    pinned: &mut Option<String>,
    action: FlowAction,
) -> Result<(), String> {
    if action == FlowAction::Live {
        *pinned = None;
        return Ok(());
    }
    if !matches!(
        action,
        FlowAction::Pick(_) | FlowAction::Next | FlowAction::Prev
    ) {
        return Ok(());
    }
    if ids.is_empty() {
        return Err(s("There is no flow to pick.", "고를 흐름이 없습니다.").into());
    }
    let index = match action {
        FlowAction::Pick(number) => {
            if number < 1 || number > ids.len() {
                return Err(fill(
                    s(
                        "The flow number is 1 to {max}.",
                        "흐름 번호는 1~{max} 입니다.",
                    ),
                    &[("max", ids.len().to_string())],
                ));
            }
            number - 1
        }
        _ => {
            let now = pinned
                .as_deref()
                .and_then(|id| ids.iter().position(|i| i == id))
                .or(live)
                .unwrap_or(0);
            let count = ids.len();
            if action == FlowAction::Next {
                (now + 1) % count
            } else {
                (now + count - 1) % count
            }
        }
    };
    // Picking the flow that is being followed anyway keeps following it.
    *pinned = if Some(index) == live {
        None
    } else {
        Some(ids[index].clone())
    };
    Ok(())
}

/// The ids of the thread's flows (newest first) and which one the live focus is.
pub fn flow_ids(app: &App) -> (Vec<String>, Option<usize>) {
    with_input(app, |input| {
        let graphs = crate::flow::flows(input.thread, input.lead_model.as_deref());
        let live = crate::flow::focus_graph(&graphs);
        (graphs.into_iter().map(|g| g.id).collect(), live)
    })
}

/// Something in the view moves with the clock (a running agent), so it is redrawn on the tick.
pub fn is_live(app: &App) -> bool {
    if !app.side_shown() {
        return false;
    }
    with_input(app, |input| match app.side_view {
        Side::Workflow => workflow_panel::is_live(input),
        Side::Agents => agents_panel::is_live(input),
    })
}

pub fn draw(frame: &mut Frame, area: Rect, app: &App) {
    let block = Block::default()
        .borders(Borders::LEFT)
        .border_style(Style::new().fg(app.theme.border));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width < 8 || inner.height < 2 {
        return;
    }
    let lines = with_input(app, |input| {
        let (w, h) = (usize::from(inner.width), usize::from(inner.height));
        match app.side_view {
            Side::Workflow => workflow_panel::lines(input, w, h, &app.theme, &app.sym),
            Side::Agents => agents_panel::lines(input, w, h, &app.theme, &app.sym),
        }
    });
    frame.render_widget(Paragraph::new(lines), inner);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("f{i}")).collect()
    }

    #[test]
    fn the_words_after_the_command_are_read() {
        assert_eq!(parse_flow_action(""), Some(FlowAction::Toggle));
        assert_eq!(parse_flow_action(" OFF "), Some(FlowAction::Off));
        assert_eq!(parse_flow_action("12"), Some(FlowAction::Pick(12)));
        assert_eq!(parse_flow_action("next"), Some(FlowAction::Next));
        assert_eq!(parse_flow_action("live"), Some(FlowAction::Live));
        assert_eq!(parse_flow_action("12345"), None);
        assert_eq!(parse_flow_action("next 2"), None);
        assert_eq!(parse_flow_action("-1"), None);
    }

    #[test]
    fn each_command_opens_switches_or_closes() {
        use FlowAction::*;
        use PanelMove::*;
        let (w, a) = (Side::Workflow, Side::Agents);
        assert_eq!(plan_panel_move(w, Toggle, None), Open);
        assert_eq!(plan_panel_move(w, Toggle, Some(w)), Close);
        assert_eq!(plan_panel_move(w, Toggle, Some(a)), Switch);
        assert_eq!(plan_panel_move(w, Off, Some(w)), Close);
        assert_eq!(plan_panel_move(w, Off, Some(a)), Nothing);
        assert_eq!(plan_panel_move(w, Pick(2), Some(w)), Nothing);
    }

    #[test]
    fn picking_walks_the_flows_and_following_the_live_one_unpins() {
        let list = ids(3);
        let mut pinned = None;
        assert!(choose_flow(&list, Some(0), &mut pinned, FlowAction::Pick(2)).is_ok());
        assert_eq!(pinned.as_deref(), Some("f2"));
        assert!(choose_flow(&list, Some(0), &mut pinned, FlowAction::Next).is_ok());
        assert_eq!(pinned.as_deref(), Some("f3"));
        // past the last it wraps to the first, which is the live one: following again
        assert!(choose_flow(&list, Some(0), &mut pinned, FlowAction::Next).is_ok());
        assert_eq!(pinned, None);
        assert!(choose_flow(&list, Some(0), &mut pinned, FlowAction::Prev).is_ok());
        assert_eq!(pinned.as_deref(), Some("f3"));
        assert!(choose_flow(&list, Some(0), &mut pinned, FlowAction::Live).is_ok());
        assert_eq!(pinned, None);
    }

    #[test]
    fn a_pick_out_of_range_or_with_no_flows_says_why() {
        crate::i18n::init(Some("en"));
        let mut pinned = Some("f1".to_string());
        let error = choose_flow(&ids(2), None, &mut pinned, FlowAction::Pick(3)).unwrap_err();
        assert_eq!(error, "The flow number is 1 to 2.");
        let error = choose_flow(&[], None, &mut pinned, FlowAction::Next).unwrap_err();
        assert_eq!(error, "There is no flow to pick.");
        assert_eq!(
            pinned.as_deref(),
            Some("f1"),
            "a refused pick changes nothing"
        );
    }
}
