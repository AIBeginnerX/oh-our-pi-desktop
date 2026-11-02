//! 디버그 빌드 전용 테스트 훅. 사용자 세션에 키를 주입하지 않고도 분할/닫기/캡처를
//! 재현하기 위한 것이다. 릴리스 빌드에는 컴파일되지 않는다 (`main.rs` 의 cfg).
//!
//! `OOP_TERMINAL_AUTOPILOT=split-right,split-down,report,ppm=/tmp/a.ppm,quit`
//!
//! 단계 이름: split-{right,left,up,down} (oop pane), shell-{right,left,up,down} (셸 pane),
//! zoom, close, next, prev, type=<글자>, ppm=<경로>, click=<x>:<y>, drag=<구분선 번호>:<목표 px>,
//! report, wait=<ms>, quit

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::layout::Dir;
use crate::shortcuts::{Action, PaneKind};

const FIRST_DELAY: Duration = Duration::from_millis(2500);
const STEP_GAP: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Action(Action),
    Type(String),
    Screenshot(String),
    Click(f32, f32),
    DragDivider(usize, f32),
    Report,
    Wait(Duration),
    Quit,
}

pub struct Autopilot {
    steps: VecDeque<Step>,
    next_at: Instant,
    screenshot: Option<String>,
}

fn parse_step(word: &str) -> Option<Step> {
    let (name, arg) = match word.split_once('=') {
        Some((n, a)) => (n, Some(a)),
        None => (word, None),
    };
    let split = |dir, kind| Some(Step::Action(Action::Split(dir, kind)));
    match (name, arg) {
        ("split-right", _) => split(Dir::Right, PaneKind::Oop),
        ("split-left", _) => split(Dir::Left, PaneKind::Oop),
        ("split-up", _) => split(Dir::Up, PaneKind::Oop),
        ("split-down", _) => split(Dir::Down, PaneKind::Oop),
        ("shell-right", _) => split(Dir::Right, PaneKind::Shell),
        ("shell-left", _) => split(Dir::Left, PaneKind::Shell),
        ("shell-up", _) => split(Dir::Up, PaneKind::Shell),
        ("shell-down", _) => split(Dir::Down, PaneKind::Shell),
        ("zoom", _) => Some(Step::Action(Action::ToggleZoom)),
        ("close", _) => Some(Step::Action(Action::ClosePane)),
        ("next", _) => Some(Step::Action(Action::FocusNext)),
        ("prev", _) => Some(Step::Action(Action::FocusPrev)),
        ("report", _) => Some(Step::Report),
        ("quit", _) => Some(Step::Quit),
        ("type", Some(t)) => Some(Step::Type(t.replace("\\n", "\r"))),
        ("ppm", Some(p)) => Some(Step::Screenshot(p.to_string())),
        ("wait", Some(ms)) => ms
            .parse()
            .ok()
            .map(|ms| Step::Wait(Duration::from_millis(ms))),
        ("click", Some(xy)) => {
            let (x, y) = xy.split_once(':')?;
            Some(Step::Click(x.parse().ok()?, y.parse().ok()?))
        }
        ("drag", Some(a)) => {
            let (i, to) = a.split_once(':')?;
            Some(Step::DragDivider(i.parse().ok()?, to.parse().ok()?))
        }
        _ => None,
    }
}

pub fn parse(spec: &str) -> Vec<Step> {
    spec.split(',')
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .filter_map(parse_step)
        .collect()
}

impl Autopilot {
    pub fn from_env() -> Self {
        let steps = std::env::var("OOP_TERMINAL_AUTOPILOT")
            .map(|s| parse(&s))
            .unwrap_or_default();
        Self {
            steps: steps.into(),
            next_at: Instant::now() + FIRST_DELAY,
            screenshot: None,
        }
    }

    /// 지금 실행할 단계를 `out` 에 추가한다 (한 번에 하나, 단계 사이는 `STEP_GAP`).
    pub fn due(&mut self, out: &mut Vec<Step>) {
        let now = Instant::now();
        while now >= self.next_at {
            match self.steps.pop_front() {
                None => break,
                Some(Step::Wait(d)) => self.next_at = now + d,
                Some(step) => {
                    out.push(step);
                    self.next_at = now + STEP_GAP;
                    break;
                }
            }
        }
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        (!self.steps.is_empty()).then_some(self.next_at)
    }

    pub fn set_screenshot(&mut self, path: String) {
        self.screenshot = Some(path);
    }

    pub fn take_screenshot(&mut self) -> Option<String> {
        self.screenshot.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_steps_and_skips_unknown() {
        let v = parse(
            "split-right, shell-down,bogus,type=ls\\n,ppm=/tmp/x.ppm,click=10:20,drag=0:300,wait=50,quit",
        );
        assert_eq!(v.len(), 8);
        assert_eq!(v[0], Step::Action(Action::Split(Dir::Right, PaneKind::Oop)));
        assert_eq!(
            v[1],
            Step::Action(Action::Split(Dir::Down, PaneKind::Shell))
        );
        assert_eq!(v[2], Step::Type("ls\r".into()));
        assert_eq!(v[4], Step::Click(10.0, 20.0));
        assert_eq!(v[5], Step::DragDivider(0, 300.0));
        assert_eq!(v[6], Step::Wait(Duration::from_millis(50)));
        assert_eq!(v[7], Step::Quit);
    }

    #[test]
    fn due_releases_one_step_at_a_time() {
        let mut ap = Autopilot {
            steps: parse("zoom,report").into(),
            next_at: Instant::now(),
            screenshot: None,
        };
        let mut out = Vec::new();
        ap.due(&mut out);
        assert_eq!(out, vec![Step::Action(Action::ToggleZoom)]);
        out.clear();
        ap.due(&mut out); // 아직 STEP_GAP 이 지나지 않았다
        assert!(out.is_empty());
        assert!(ap.next_deadline().is_some());
    }
}
