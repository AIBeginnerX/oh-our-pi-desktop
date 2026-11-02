//! IME(한글 조합) 상태기계.
//!
//! winit `Ime` 이벤트만으로 PTY에 보낼 바이트를 정한다.
//! - 조합 중(preedit)에는 아무것도 PTY로 보내지 않고 커서 위치에 표시만 한다.
//! - 확정(commit)된 문자열만 정확히 한 번 보낸다.
//! - 조합 중이거나 방금 확정된 글자가 `KeyboardInput` 텍스트로 한 번 더 도착하면 버린다
//!   (자모 중복/유실 방지).

use winit::event::Ime;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImeEvent {
    Enabled,
    Preedit(String, Option<(usize, usize)>),
    Commit(String),
    Disabled,
}

impl From<Ime> for ImeEvent {
    fn from(ime: Ime) -> Self {
        match ime {
            Ime::Enabled => ImeEvent::Enabled,
            Ime::Preedit(s, c) => ImeEvent::Preedit(s, c),
            Ime::Commit(s) => ImeEvent::Commit(s),
            Ime::Disabled => ImeEvent::Disabled,
        }
    }
}

#[derive(Debug, Default)]
pub struct ImeState {
    enabled: bool,
    preedit: String,
    /// preedit 안의 커서 범위 (바이트 오프셋, winit 규약)
    cursor: Option<(usize, usize)>,
    /// 직전 commit 문자열: 같은 글자가 키 이벤트로 중복 도착하면 한 번 버린다.
    last_commit: Option<String>,
}

impl ImeState {
    #[cfg(test)]
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn composing(&self) -> bool {
        !self.preedit.is_empty()
    }

    pub fn preedit(&self) -> Option<&str> {
        self.composing().then_some(self.preedit.as_str())
    }

    /// preedit 안에서 커서가 놓인 글자 위치(문자 단위). 없으면 끝.
    pub fn preedit_cursor_chars(&self) -> usize {
        let total = self.preedit.chars().count();
        match self.cursor {
            Some((start, _)) => self
                .preedit
                .char_indices()
                .take_while(|(i, _)| *i < start)
                .count()
                .min(total),
            None => total,
        }
    }

    pub fn reset(&mut self) {
        self.preedit.clear();
        self.cursor = None;
        self.last_commit = None;
    }

    /// IME 이벤트를 처리하고, PTY로 보낼 바이트가 있으면 돌려준다.
    pub fn handle(&mut self, ev: ImeEvent) -> Option<Vec<u8>> {
        match ev {
            ImeEvent::Enabled => {
                self.enabled = true;
                None
            }
            ImeEvent::Disabled => {
                self.enabled = false;
                self.reset();
                None
            }
            ImeEvent::Preedit(text, cursor) => {
                self.preedit = text;
                self.cursor = if self.preedit.is_empty() {
                    None
                } else {
                    cursor
                };
                None
            }
            ImeEvent::Commit(text) => {
                self.preedit.clear();
                self.cursor = None;
                if text.is_empty() {
                    return None;
                }
                self.last_commit = Some(text.clone());
                Some(text.into_bytes())
            }
        }
    }

    /// `KeyboardInput` 이 IME와 중복이라 버려야 하는지. `text`는 그 키가 만든 문자열.
    /// 내부 상태(직전 commit 기억)를 갱신한다.
    pub fn should_drop_key_text(&mut self, text: Option<&str>) -> bool {
        let committed = self.last_commit.take();
        let Some(text) = text.filter(|t| !t.is_empty()) else {
            return false;
        };
        if self.composing() {
            return true;
        }
        committed.as_deref() == Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pre(s: &str) -> ImeEvent {
        ImeEvent::Preedit(s.into(), Some((s.len(), s.len())))
    }

    #[test]
    fn preedit_is_shown_but_not_sent() {
        let mut ime = ImeState::default();
        assert_eq!(ime.handle(ImeEvent::Enabled), None);
        assert_eq!(ime.handle(pre("ㅎ")), None);
        assert_eq!(ime.preedit(), Some("ㅎ"));
        assert_eq!(ime.handle(pre("하")), None);
        assert_eq!(ime.preedit(), Some("하"));
        assert!(ime.composing());
    }

    #[test]
    fn commit_sends_once_and_clears_preedit() {
        let mut ime = ImeState::default();
        ime.handle(pre("하"));
        // macOS는 확정 전에 빈 preedit 을 먼저 보낸다
        ime.handle(ImeEvent::Preedit(String::new(), None));
        assert_eq!(
            ime.handle(ImeEvent::Commit("하".into())),
            Some("하".as_bytes().to_vec())
        );
        assert_eq!(ime.preedit(), None);
        assert!(!ime.composing());
    }

    #[test]
    fn full_syllable_sequence_has_no_doubles_or_losses() {
        // "한글" 입력: ㅎ ㅏ ㄴ ㄱ ㅡ ㄹ
        let mut ime = ImeState::default();
        let mut sent = Vec::new();
        let steps = [
            pre("ㅎ"),
            pre("하"),
            pre("한"),
            // ㄱ: 한 확정, ㄱ 조합 시작
            ImeEvent::Commit("한".into()),
            pre("ㄱ"),
            pre("그"),
            pre("글"),
            // Enter 로 확정
            ImeEvent::Preedit(String::new(), None),
            ImeEvent::Commit("글".into()),
        ];
        for s in steps {
            if let Some(b) = ime.handle(s) {
                sent.extend(b);
            }
        }
        assert_eq!(String::from_utf8(sent).unwrap(), "한글");
    }

    #[test]
    fn key_text_is_dropped_while_composing() {
        let mut ime = ImeState::default();
        ime.handle(pre("ㅎ"));
        assert!(
            ime.should_drop_key_text(Some("g")),
            "조합 중 같은 키의 텍스트는 중복"
        );
        assert!(
            !ime.should_drop_key_text(None),
            "텍스트가 없는 키(Enter/방향키)는 통과"
        );
    }

    #[test]
    fn duplicate_key_text_right_after_commit_is_dropped_once() {
        let mut ime = ImeState::default();
        ime.handle(ImeEvent::Commit("가".into()));
        assert!(ime.should_drop_key_text(Some("가")));
        assert!(!ime.should_drop_key_text(Some("가")), "한 번만 버린다");
    }

    #[test]
    fn unrelated_key_after_commit_passes_and_clears_memory() {
        let mut ime = ImeState::default();
        ime.handle(ImeEvent::Commit("하".into()));
        assert!(!ime.should_drop_key_text(Some(" ")), "스페이스는 통과");
        assert!(
            !ime.should_drop_key_text(Some("하")),
            "기억은 이미 지워졌다"
        );
    }

    #[test]
    fn plain_ascii_without_ime_is_never_dropped() {
        let mut ime = ImeState::default();
        for c in ["a", "b", "a", "a"] {
            assert!(!ime.should_drop_key_text(Some(c)));
        }
    }

    #[test]
    fn disabled_resets_everything() {
        let mut ime = ImeState::default();
        ime.handle(ImeEvent::Enabled);
        ime.handle(pre("ㅎ"));
        ime.handle(ImeEvent::Disabled);
        assert!(!ime.enabled());
        assert!(!ime.composing());
    }

    #[test]
    fn preedit_cursor_is_converted_to_char_index() {
        let mut ime = ImeState::default();
        ime.handle(ImeEvent::Preedit("한글".into(), Some((3, 6))));
        assert_eq!(ime.preedit_cursor_chars(), 1);
        ime.handle(ImeEvent::Preedit("한글".into(), None));
        assert_eq!(ime.preedit_cursor_chars(), 2);
    }

    #[test]
    fn empty_commit_sends_nothing() {
        let mut ime = ImeState::default();
        assert_eq!(ime.handle(ImeEvent::Commit(String::new())), None);
    }

    #[test]
    fn converts_from_winit_events() {
        assert_eq!(
            ImeEvent::from(Ime::Commit("x".into())),
            ImeEvent::Commit("x".into())
        );
        assert_eq!(ImeEvent::from(Ime::Enabled), ImeEvent::Enabled);
    }
}
