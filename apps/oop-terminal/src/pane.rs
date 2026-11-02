//! 한 pane = 자식 프로세스(PTY) 하나 + 그 화면 상태(alacritty `Term`).
//!
//! PTY 읽기/파싱은 alacritty_terminal 의 `EventLoop` 스레드가 맡고,
//! 여기서는 이벤트를 받아 메인 스레드(winit)로 전달만 한다.

use std::borrow::Cow;
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, EventLoopSender, Msg, State};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config, Osc52, Term};
use alacritty_terminal::tty::{self, Shell};
use alacritty_terminal::vte::ansi::{CursorShape, CursorStyle, Processor};
use winit::event_loop::EventLoopProxy;

use crate::launch::Program;
use crate::layout::PaneId;
use crate::shortcuts::Action;
use crate::theme;

/// 다른 스레드에서 메인 이벤트 루프로 보내는 이벤트.
#[derive(Debug)]
pub enum UserEvent {
    /// 화면 내용이 바뀌었다 (합쳐서 전달됨)
    Wakeup(PaneId),
    Title(PaneId, Option<String>),
    /// OSC 52 쓰기 (읽기 요청은 여기까지 오지 않고 거부된다)
    ClipboardStore(String),
    Bell,
    CursorBlinkChanged,
    /// 자식 프로세스 종료 (종료 코드 알면 Some)
    Exited(PaneId, Option<i32>),
    /// macOS 메뉴바 등 외부에서 온 동작
    Action(Action),
}

#[derive(Clone)]
pub struct Listener {
    id: PaneId,
    proxy: EventLoopProxy<UserEvent>,
    sender: Arc<OnceLock<EventLoopSender>>,
    pending: Arc<AtomicBool>,
    exit_code: Arc<Mutex<Option<i32>>>,
    size: Arc<Mutex<WindowSize>>,
}

impl Listener {
    fn write(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        if let Some(s) = self.sender.get() {
            let _ = s.send(Msg::Input(Cow::Owned(bytes)));
        }
    }
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        match event {
            Event::Wakeup => {
                // 이미 전달 대기 중이면 새로 보내지 않는다: 출력이 폭주해도 이벤트는 프레임당 하나.
                if !self.pending.swap(true, Ordering::AcqRel) {
                    let _ = self.proxy.send_event(UserEvent::Wakeup(self.id));
                }
            }
            Event::PtyWrite(text) => self.write(text.into_bytes()),
            Event::Title(t) => {
                let _ = self.proxy.send_event(UserEvent::Title(self.id, Some(t)));
            }
            Event::ResetTitle => {
                let _ = self.proxy.send_event(UserEvent::Title(self.id, None));
            }
            // OSC 52: 쓰기만 허용한다. 읽기(ClipboardLoad)는 응답하지 않고 버린다.
            Event::ClipboardStore(_, text) => {
                let _ = self.proxy.send_event(UserEvent::ClipboardStore(text));
            }
            Event::ClipboardLoad(..) => {}
            Event::ColorRequest(index, format) => {
                self.write(format(theme::default_for_index(index)).into_bytes());
            }
            Event::TextAreaSizeRequest(format) => {
                let size = *self.size.lock().unwrap();
                self.write(format(size).into_bytes());
            }
            Event::Bell => {
                let _ = self.proxy.send_event(UserEvent::Bell);
            }
            Event::CursorBlinkingChange => {
                let _ = self.proxy.send_event(UserEvent::CursorBlinkChanged);
            }
            Event::ChildExit(status) => {
                *self.exit_code.lock().unwrap() = status.code();
            }
            Event::Exit => {
                let code = self.exit_code.lock().unwrap().take();
                let _ = self.proxy.send_event(UserEvent::Exited(self.id, code));
            }
            Event::MouseCursorDirty => {}
        }
    }
}

pub struct TermDims {
    pub cols: usize,
    pub rows: usize,
}

impl Dimensions for TermDims {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GridSize {
    pub cols: u16,
    pub rows: u16,
    pub cell_w: u16,
    pub cell_h: u16,
}

impl GridSize {
    fn window_size(self) -> WindowSize {
        WindowSize {
            num_lines: self.rows,
            num_cols: self.cols,
            cell_width: self.cell_w,
            cell_height: self.cell_h,
        }
    }
}

#[derive(Default)]
pub struct PaneUi {
    /// 지금 눌려 있는 마우스 버튼 (좌, 가운데, 오른쪽)
    pub buttons: [bool; 3],
    pub selecting: bool,
    pub last_cell: Option<(usize, usize)>,
    pub last_click: Option<(Instant, u8, (usize, usize))>,
}

pub struct SpawnSpec {
    pub program: Program,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    /// pane 맨 위에 한 줄로 보여 줄 안내 (예: oop을 못 찾았을 때)
    pub banner: Option<String>,
}

pub struct Pane {
    pub id: PaneId,
    pub term: Arc<FairMutex<Term<Listener>>>,
    sender: EventLoopSender,
    pid: u32,
    pub title: Option<String>,
    pub size: GridSize,
    pub exited: Option<ExitState>,
    pub pending: Arc<AtomicBool>,
    pub ui: PaneUi,
    size_shared: Arc<Mutex<WindowSize>>,
    thread: Option<JoinHandle<(EventLoop<tty::Pty, Listener>, State)>>,
}

/// 자식 프로세스가 끝난 pane 의 표시 (종료 안내가 화면에 있다).
#[derive(Clone, Copy, Debug)]
pub struct ExitState;

fn term_config() -> Config {
    Config {
        scrolling_history: 10_000,
        default_cursor_style: CursorStyle {
            shape: CursorShape::Block,
            blinking: false,
        },
        kitty_keyboard: true,
        osc52: Osc52::OnlyCopy,
        ..Config::default()
    }
}

impl Pane {
    pub fn spawn(
        id: PaneId,
        spec: &SpawnSpec,
        size: GridSize,
        proxy: EventLoopProxy<UserEvent>,
    ) -> io::Result<Pane> {
        let pending = Arc::new(AtomicBool::new(false));
        let size_shared = Arc::new(Mutex::new(size.window_size()));
        let listener = Listener {
            id,
            proxy,
            sender: Arc::new(OnceLock::new()),
            pending: pending.clone(),
            exit_code: Arc::new(Mutex::new(None)),
            size: size_shared.clone(),
        };
        let options = tty::Options {
            shell: Some(Shell::new(
                spec.program.program.clone(),
                spec.program.args.clone(),
            )),
            working_directory: Some(spec.cwd.clone()),
            drain_on_exit: true,
            env: spec.env.clone(),
        };
        let pty = tty::new(&options, size.window_size(), id as u64)?;
        let pid = pty.child().id();
        let dims = TermDims {
            cols: size.cols as usize,
            rows: size.rows as usize,
        };
        let term = Arc::new(FairMutex::new(Term::new(
            term_config(),
            &dims,
            listener.clone(),
        )));
        if let Some(banner) = &spec.banner {
            let mut p: Processor = Processor::new();
            let text = format!("\x1b[2m{banner}\x1b[0m\r\n");
            p.advance(&mut *term.lock(), text.as_bytes());
        }
        let event_loop = EventLoop::new(term.clone(), listener.clone(), pty, true, false)?;
        let sender = event_loop.channel();
        let _ = listener.sender.set(sender.clone());
        let thread = event_loop.spawn();
        Ok(Pane {
            id,
            term,
            sender,
            pid,
            title: None,
            size,
            exited: None,
            pending,
            ui: PaneUi::default(),
            size_shared,
            thread: Some(thread),
        })
    }

    pub fn write(&self, bytes: impl Into<Cow<'static, [u8]>>) {
        let bytes = bytes.into();
        if bytes.is_empty() || self.exited.is_some() {
            return;
        }
        let _ = self.sender.send(Msg::Input(bytes));
    }

    pub fn resize(&mut self, size: GridSize) {
        if size == self.size || size.cols == 0 || size.rows == 0 {
            return;
        }
        self.size = size;
        *self.size_shared.lock().unwrap() = size.window_size();
        self.term.lock().resize(TermDims {
            cols: size.cols as usize,
            rows: size.rows as usize,
        });
        let _ = self.sender.send(Msg::Resize(size.window_size()));
    }

    /// 종료 안내를 화면에 직접 써 넣는다 (프로세스가 이미 끝난 뒤).
    pub fn show_exit_notice(&mut self, text: &str) {
        self.exited = Some(ExitState);
        let mut p: Processor = Processor::new();
        let msg = format!("\x1b[?25l\x1b[0m\r\n\x1b[2m{text}\x1b[0m");
        p.advance(&mut *self.term.lock(), msg.as_bytes());
    }

    /// 프로세스 그룹에 SIGHUP. 그룹이 사라질 때까지 기다리는 일은 `wait_gone_or_kill`.
    pub fn hangup(&self) {
        #[cfg(unix)]
        if self.exited.is_none() {
            // SAFETY: 자식은 setsid 로 만든 세션 리더이므로 pgid == pid 이다.
            unsafe {
                libc::killpg(self.pid as i32, libc::SIGHUP);
                libc::killpg(self.pid as i32, libc::SIGCONT);
            }
        }
    }

    pub fn group_alive(&self) -> bool {
        #[cfg(unix)]
        {
            // SAFETY: 신호 0 은 존재 확인만 한다.
            unsafe { libc::killpg(self.pid as i32, 0) == 0 }
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    pub fn kill_group(&self) {
        #[cfg(unix)]
        // SAFETY: 위와 같다.
        unsafe {
            libc::killpg(self.pid as i32, libc::SIGKILL);
        }
    }

    /// 이벤트 루프 스레드를 멈추게 한다 (Pty drop 이 자식을 정리).
    pub fn shutdown(&mut self) {
        let _ = self.sender.send(Msg::Shutdown);
        self.thread.take();
    }
}

/// 여러 pane 의 프로세스 그룹을 끝낸다: 모두 SIGHUP 후 `grace` 동안 기다리고, 남은 것은 SIGKILL.
pub fn terminate_all<'a>(panes: impl Iterator<Item = &'a mut Pane>, grace: Duration) {
    let mut panes: Vec<&mut Pane> = panes.collect();
    for p in &panes {
        p.hangup();
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline && panes.iter().any(|p| p.exited.is_none() && p.group_alive()) {
        std::thread::sleep(Duration::from_millis(15));
    }
    for p in &mut panes {
        if p.group_alive() {
            p.kill_group();
        }
        p.shutdown();
    }
}
