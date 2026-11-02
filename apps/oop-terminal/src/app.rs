//! winit 앱: 창, 입력, pane 관리, 렌더 요청.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use alacritty_terminal::grid::Scroll;
use alacritty_terminal::index::{Column, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::{TermMode, viewport_to_point};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoopProxy};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::platform::modifier_supplement::KeyEventExtModifierSupplement;
use winit::window::{CursorIcon, Window, WindowId};

use crate::font::Fonts;
use crate::gpu::{Frame, Gpu, WindowSurface};
use crate::ime::ImeState;
use crate::keys::{self, KeyInput};
use crate::launch::{self, Probe, Resolved};
use crate::layout::{CloseOutcome, Dir, Divider, Layout, PaneId, Rect, drag_ratio};
use crate::mouse::{self, Button, Kind, Report};
use crate::pane::{GridSize, Pane, SpawnSpec, UserEvent, terminate_all};
use crate::scene::{self, GAP, ViewState};
use crate::shortcuts::{self, Action, PaneKind, Platform};

const BASE_FONT_PT: f32 = 14.0;
const BLINK: Duration = Duration::from_millis(530);
const MIN_COLS: f32 = 8.0;
const MIN_ROWS: f32 = 3.0;

pub struct Options {
    pub start_dir_arg: Option<String>,
    pub started: Instant,
}

struct DragState {
    divider: Divider,
}

struct Running {
    window: Arc<Window>,
    gpu: Gpu,
    surf: WindowSurface,
    fonts: Fonts,
    frame: Frame,
    scale: f64,
    zoom_steps: i32,
    layout: Layout,
    panes: HashMap<PaneId, Pane>,
    mods: ModifiersState,
    mouse: PhysicalPosition<f64>,
    window_focused: bool,
    ime: ImeState,
    last_ime_area: Option<(f32, f32, f32, f32)>,
    drag: Option<DragState>,
    hover: Option<Vec<bool>>,
    blink_on: bool,
    blink_enabled: bool,
    last_blink: Instant,
    clipboard: Option<arboard::Clipboard>,
    close_at: Vec<(PaneId, Instant)>,
    scroll_accum: f32,
    shutting_down: bool,
    first_frame_logged: bool,
    started: Instant,
    #[cfg(target_os = "macos")]
    _menu: muda::Menu,
    #[cfg(debug_assertions)]
    autopilot: crate::autopilot::Autopilot,
}

pub struct App {
    proxy: EventLoopProxy<UserEvent>,
    opts: Options,
    run: Option<Running>,
    program: Resolved,
    shell_program: launch::Program,
    env: HashMap<String, String>,
    start_dir: PathBuf,
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

impl App {
    pub fn new(proxy: EventLoopProxy<UserEvent>, opts: Options) -> Self {
        let home = home_dir();
        let path = launch::sane_path(std::env::var("PATH").ok().as_deref(), Some(&home));
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(PathBuf::from));
        let shell = std::env::var("SHELL").ok();
        let probe = Probe {
            exe_dir,
            command_override: std::env::var("OOP_TERMINAL_COMMAND").ok(),
            search_path: path.clone(),
            shell: shell.clone(),
            is_executable: &launch::is_executable_file,
        };
        let program = launch::resolve(&probe);
        let env = launch::child_env(&home, &path, std::env::var("LANG").ok().as_deref());
        let start_dir = launch::start_dir(opts.start_dir_arg.as_deref(), &home, &|p| p.is_dir());
        Self {
            proxy,
            opts,
            run: None,
            program,
            shell_program: launch::shell_program(shell.as_deref()),
            env,
            start_dir,
        }
    }

    fn spec(&self, kind: PaneKind) -> SpawnSpec {
        let (program, banner) = match (kind, &self.program) {
            (PaneKind::Shell, _) => (self.shell_program.clone(), None),
            (PaneKind::Oop, Resolved::Oop(p)) => (p.clone(), None),
            (PaneKind::Oop, Resolved::Shell { program, notice }) => {
                (program.clone(), Some(notice.clone()))
            }
        };
        SpawnSpec {
            program,
            cwd: self.start_dir.clone(),
            env: self.env.clone(),
            banner,
        }
    }
}

impl ApplicationHandler<UserEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.run.is_some() {
            return;
        }
        event_loop.set_control_flow(ControlFlow::Wait);
        let t0 = Instant::now();
        let attrs = Window::default_attributes()
            .with_title("OOP Terminal")
            .with_inner_size(LogicalSize::new(1100.0, 720.0))
            .with_min_inner_size(LogicalSize::new(360.0, 220.0));
        let window = match event_loop.create_window(attrs) {
            Ok(w) => Arc::new(w),
            Err(e) => {
                eprintln!("oop-terminal: 창을 만들 수 없습니다: {e}");
                event_loop.exit();
                return;
            }
        };
        window.set_ime_allowed(true);
        let t_window = t0.elapsed();
        let (gpu, surf) = match Gpu::for_window(window.clone()) {
            Ok(g) => g,
            Err(e) => {
                eprintln!("oop-terminal: GPU 초기화 실패: {e}");
                event_loop.exit();
                return;
            }
        };
        let t_gpu = t0.elapsed();
        let scale = window.scale_factor();
        let fonts = Fonts::new((BASE_FONT_PT as f64 * scale) as f32);
        let t_fonts = t0.elapsed();
        if std::env::var_os("OOP_TERMINAL_TIMING").is_some() {
            eprintln!(
                "[oop-terminal] startup: window {} ms, gpu {} ms, fonts {} ms (since process start {} ms)",
                t_window.as_millis(),
                (t_gpu - t_window).as_millis(),
                (t_fonts - t_gpu).as_millis(),
                self.opts.started.elapsed().as_millis()
            );
        }
        #[cfg(target_os = "macos")]
        let menu = crate::menu::install(self.proxy.clone());
        let mut run = Running {
            window,
            gpu,
            surf,
            fonts,
            frame: Frame::default(),
            scale,
            zoom_steps: 0,
            layout: Layout::new(),
            panes: HashMap::new(),
            mods: ModifiersState::empty(),
            mouse: PhysicalPosition::new(-1.0, -1.0),
            window_focused: true,
            ime: ImeState::default(),
            last_ime_area: None,
            drag: None,
            hover: None,
            blink_on: true,
            blink_enabled: false,
            last_blink: Instant::now(),
            clipboard: None,
            close_at: Vec::new(),
            scroll_accum: 0.0,
            shutting_down: false,
            first_frame_logged: false,
            started: self.opts.started,
            #[cfg(target_os = "macos")]
            _menu: menu,
            #[cfg(debug_assertions)]
            autopilot: crate::autopilot::Autopilot::from_env(),
        };
        let area = run.area();
        let m = run.fonts.metrics();
        let rects = run.layout.rects(area, run.gap());
        let geom = scene::geometry(rects[0].1, run.scale as f32, &m);
        let size = GridSize {
            cols: geom.cols,
            rows: geom.rows,
            cell_w: m.cell_w as u16,
            cell_h: m.cell_h as u16,
        };
        match Pane::spawn(
            run.layout.first_id(),
            &self.spec(PaneKind::Oop),
            size,
            self.proxy.clone(),
        ) {
            Ok(p) => {
                run.panes.insert(p.id, p);
            }
            Err(e) => {
                eprintln!("oop-terminal: 첫 pane을 시작할 수 없습니다: {e}");
                event_loop.exit();
                return;
            }
        }
        run.window.request_redraw();
        self.run = Some(run);
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Action(a) => self.perform(event_loop, a),
            other => {
                let Some(run) = self.run.as_mut() else { return };
                run.on_user_event(other);
                if run.panes.is_empty() && !run.shutting_down {
                    run.shutdown();
                    event_loop.exit();
                }
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        if self.run.is_none() {
            return;
        }
        match event {
            WindowEvent::CloseRequested => {
                let run = self.run.as_mut().unwrap();
                run.shutdown();
                event_loop.exit();
            }
            WindowEvent::Resized(size) => self.run.as_mut().unwrap().on_resize(size),
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                self.run.as_mut().unwrap().on_scale(scale_factor)
            }
            WindowEvent::RedrawRequested => self.run.as_mut().unwrap().redraw(),
            // 가려져 있던 동안 건너뛴 프레임을 창이 다시 보일 때 그린다.
            WindowEvent::Occluded(false) => self.run.as_mut().unwrap().window.request_redraw(),
            WindowEvent::Focused(f) => self.run.as_mut().unwrap().on_focus(f),
            WindowEvent::ModifiersChanged(m) => self.run.as_mut().unwrap().mods = m.state(),
            WindowEvent::Ime(ime) => self.run.as_mut().unwrap().on_ime(ime.into()),
            WindowEvent::KeyboardInput {
                event,
                is_synthetic: false,
                ..
            } if event.state == ElementState::Pressed => {
                let mods = self.run.as_ref().unwrap().mods;
                let base = event.key_without_modifiers();
                if let Some(action) =
                    shortcuts::map(Platform::current(), &event.logical_key, Some(&base), mods)
                {
                    self.perform(event_loop, action);
                    return;
                }
                self.run.as_mut().unwrap().on_key(
                    &event.logical_key,
                    &base,
                    event.text.as_deref(),
                    mods,
                );
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.run.as_mut().unwrap().on_cursor_moved(position)
            }
            WindowEvent::MouseInput { state, button, .. } => {
                self.run.as_mut().unwrap().on_mouse_button(state, button)
            }
            WindowEvent::MouseWheel { delta, .. } => self.run.as_mut().unwrap().on_wheel(delta),
            WindowEvent::CursorLeft { .. } => self.run.as_mut().unwrap().set_hover(None),
            WindowEvent::DroppedFile(path) => {
                let text = format!("'{}' ", path.to_string_lossy().replace('\'', "'\\''"));
                self.run.as_mut().unwrap().paste_text(&text);
            }
            _ => {}
        }
        if let Some(run) = self.run.as_mut()
            && run.panes.is_empty()
            && !run.shutting_down
        {
            run.shutdown();
            event_loop.exit();
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        // 주의: 여기서 `EventLoopProxy` 를 clone 하면 안 된다. macOS 의 winit 은 clone 마다
        // 런루프 소스를 새로 추가하고 루프를 깨워서, about_to_wait 가 끝없이 반복된다(CPU 100%).
        #[cfg(debug_assertions)]
        self.drive_autopilot(event_loop);
        let Some(run) = self.run.as_mut() else { return };
        let now = Instant::now();
        let mut next: Option<Instant> = None;
        let mut want = |t: Instant| next = Some(next.map_or(t, |n| n.min(t)));
        if run.blink_enabled && run.window_focused {
            let due = run.last_blink + BLINK;
            if due <= now {
                run.blink_on = !run.blink_on;
                run.last_blink = now;
                run.window.request_redraw();
                want(now + BLINK);
            } else {
                want(due);
            }
        }
        let due_close: Vec<PaneId> = run
            .close_at
            .iter()
            .filter(|(_, t)| *t <= now)
            .map(|(id, _)| *id)
            .collect();
        run.close_at.retain(|(_, t)| *t > now);
        for id in due_close {
            run.close_pane(id);
        }
        if let Some(t) = run.close_at.iter().map(|(_, t)| *t).min() {
            want(t);
        }
        #[cfg(debug_assertions)]
        if let Some(t) = run.autopilot.next_deadline() {
            want(t);
        }
        if run.panes.is_empty() && !run.shutting_down {
            run.shutdown();
            event_loop.exit();
            return;
        }
        event_loop.set_control_flow(next.map_or(ControlFlow::Wait, ControlFlow::WaitUntil));
    }

    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(run) = self.run.as_mut() {
            run.shutdown();
        }
    }
}

impl App {
    /// 디버그 빌드 전용: 시간이 된 자동 조종 단계를 실행한다. 단계가 있을 때만 proxy 를 복제한다.
    #[cfg(debug_assertions)]
    fn drive_autopilot(&mut self, event_loop: &ActiveEventLoop) {
        let mut steps = Vec::new();
        match self.run.as_mut() {
            Some(run) => run.autopilot.due(&mut steps),
            None => return,
        }
        if steps.is_empty() {
            return;
        }
        let (oop, shell, proxy) = (
            self.spec(PaneKind::Oop),
            self.spec(PaneKind::Shell),
            self.proxy.clone(),
        );
        if let Some(run) = self.run.as_mut() {
            for step in steps {
                run.run_autopilot_step(event_loop, step, &oop, &shell, &proxy);
            }
        }
    }

    fn perform(&mut self, event_loop: &ActiveEventLoop, action: Action) {
        let spec_oop = self.spec(PaneKind::Oop);
        let spec_shell = self.spec(PaneKind::Shell);
        let proxy = self.proxy.clone();
        let Some(run) = self.run.as_mut() else { return };
        match action {
            Action::Split(dir, kind) => {
                let spec = if kind == PaneKind::Oop {
                    &spec_oop
                } else {
                    &spec_shell
                };
                run.split(dir, spec, &proxy);
            }
            Action::Quit => {
                run.shutdown();
                event_loop.exit();
            }
            Action::NewWindow => {
                if let Ok(exe) = std::env::current_exe() {
                    let mut cmd = std::process::Command::new(exe);
                    cmd.current_dir(home_dir())
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null());
                    #[cfg(unix)]
                    {
                        use std::os::unix::process::CommandExt;
                        cmd.process_group(0);
                    }
                    let _ = cmd.spawn();
                }
            }
            other => run.perform_local(other),
        }
        if run.panes.is_empty() && !run.shutting_down {
            run.shutdown();
            event_loop.exit();
        }
    }
}

impl Running {
    fn area(&self) -> Rect {
        Rect::new(
            0.0,
            0.0,
            self.surf.config.width as f32,
            self.surf.config.height as f32,
        )
    }

    fn gap(&self) -> f32 {
        (GAP * self.scale as f32).round()
    }

    fn grid_for(&self, rect: Rect) -> GridSize {
        let m = self.fonts.metrics();
        let g = scene::geometry(rect, self.scale as f32, &m);
        GridSize {
            cols: g.cols,
            rows: g.rows,
            cell_w: m.cell_w as u16,
            cell_h: m.cell_h as u16,
        }
    }

    /// 레이아웃이 바뀐 뒤 모든 pane 의 격자 크기를 맞춘다.
    fn relayout(&mut self) {
        let rects = self.layout.rects(self.area(), self.gap());
        for (id, rect) in rects {
            let size = self.grid_for(rect);
            if let Some(p) = self.panes.get_mut(&id) {
                p.resize(size);
            }
        }
        self.window.request_redraw();
    }

    fn pane_rect(&self, id: PaneId) -> Option<Rect> {
        self.layout
            .rects(self.area(), self.gap())
            .into_iter()
            .find(|(i, _)| *i == id)
            .map(|(_, r)| r)
    }

    fn pane_at(&self, pos: PhysicalPosition<f64>) -> Option<(PaneId, Rect)> {
        let (x, y) = (pos.x as f32, pos.y as f32);
        self.layout
            .rects(self.area(), self.gap())
            .into_iter()
            .find(|(_, r)| r.contains(x, y))
    }

    fn divider_at(&self, pos: PhysicalPosition<f64>) -> Option<Divider> {
        let slop = 3.0 * self.scale as f32;
        let (x, y) = (pos.x as f32, pos.y as f32);
        self.layout
            .dividers(self.area(), self.gap())
            .into_iter()
            .find(|d| {
                Rect::new(
                    d.rect.x - slop,
                    d.rect.y - slop,
                    d.rect.w + 2.0 * slop,
                    d.rect.h + 2.0 * slop,
                )
                .contains(x, y)
            })
    }

    fn on_resize(&mut self, size: PhysicalSize<u32>) {
        if size.width == 0 || size.height == 0 {
            return;
        }
        self.surf.config.width = size.width;
        self.surf.config.height = size.height;
        self.surf
            .surface
            .configure(&self.gpu.device, &self.surf.config);
        self.relayout();
    }

    fn font_px(&self) -> f32 {
        let pt = (BASE_FONT_PT + self.zoom_steps as f32).clamp(8.0, 40.0);
        (pt as f64 * self.scale) as f32
    }

    fn on_scale(&mut self, scale: f64) {
        self.scale = scale;
        self.fonts.set_size_px(self.font_px());
        self.relayout();
    }

    fn on_focus(&mut self, focused: bool) {
        self.window_focused = focused;
        self.blink_on = true;
        self.last_blink = Instant::now();
        if let Some(p) = self.panes.get(&self.layout.focus())
            && p.term.lock().mode().contains(TermMode::FOCUS_IN_OUT)
        {
            p.write(if focused {
                b"\x1b[I".as_slice()
            } else {
                b"\x1b[O".as_slice()
            });
        }
        self.window.request_redraw();
    }

    fn set_focus(&mut self, id: PaneId) {
        let old = self.layout.focus();
        if old == id && self.layout.zoomed().is_none() {
            return;
        }
        if !self.layout.set_focus(id) {
            return;
        }
        self.after_focus_change(old);
    }

    fn after_focus_change(&mut self, old: PaneId) {
        let new = self.layout.focus();
        if old != new {
            self.ime.reset();
            for (id, up) in [(old, false), (new, true)] {
                if let Some(p) = self.panes.get(&id)
                    && self.window_focused
                    && p.term.lock().mode().contains(TermMode::FOCUS_IN_OUT)
                {
                    p.write(if up {
                        b"\x1b[I".as_slice()
                    } else {
                        b"\x1b[O".as_slice()
                    });
                }
            }
        }
        self.update_title();
        self.relayout();
    }

    fn update_title(&self) {
        let title = self
            .panes
            .get(&self.layout.focus())
            .and_then(|p| p.title.clone())
            .filter(|t| !t.is_empty());
        match title {
            Some(t) => self.window.set_title(&format!("{t} — OOP Terminal")),
            None => self.window.set_title("OOP Terminal"),
        }
    }

    fn on_user_event(&mut self, event: UserEvent) {
        match event {
            UserEvent::Wakeup(id) => {
                if let Some(p) = self.panes.get(&id) {
                    p.pending.store(false, std::sync::atomic::Ordering::Release);
                    self.window.request_redraw();
                }
            }
            UserEvent::Title(id, t) => {
                if let Some(p) = self.panes.get_mut(&id) {
                    p.title = t;
                }
                if id == self.layout.focus() {
                    self.update_title();
                }
            }
            UserEvent::ClipboardStore(text) => {
                if text.len() <= 1 << 20 {
                    self.set_clipboard(&text);
                }
            }
            UserEvent::Bell => {
                if !self.window_focused {
                    self.window.request_user_attention(Some(
                        winit::window::UserAttentionType::Informational,
                    ));
                }
            }
            UserEvent::CursorBlinkChanged => self.window.request_redraw(),
            UserEvent::Exited(id, code) => {
                if let Some(p) = self.panes.get_mut(&id) {
                    if p.exited.is_some() {
                        return;
                    }
                    let clean = code == Some(0);
                    let text = match code {
                        Some(0) => "[프로세스가 종료되었습니다 — 곧 닫힙니다]".to_string(),
                        Some(c) => format!(
                            "[프로세스가 종료되었습니다 (코드 {c}) — 아무 키나 누르면 닫힙니다]"
                        ),
                        None => {
                            "[프로세스가 종료되었습니다 — 아무 키나 누르면 닫힙니다]".to_string()
                        }
                    };
                    p.show_exit_notice(&text);
                    if clean {
                        self.close_at
                            .push((id, Instant::now() + Duration::from_millis(900)));
                    }
                    self.window.request_redraw();
                }
            }
            UserEvent::Action(_) => {}
        }
    }

    fn set_clipboard(&mut self, text: &str) {
        if self.clipboard.is_none() {
            self.clipboard = arboard::Clipboard::new().ok();
        }
        if let Some(c) = self.clipboard.as_mut() {
            let _ = c.set_text(text.to_string());
        }
    }

    fn get_clipboard(&mut self) -> Option<String> {
        if self.clipboard.is_none() {
            self.clipboard = arboard::Clipboard::new().ok();
        }
        self.clipboard.as_mut().and_then(|c| c.get_text().ok())
    }

    fn split(&mut self, dir: Dir, spec: &SpawnSpec, proxy: &EventLoopProxy<UserEvent>) {
        let target = self.layout.focus();
        let Some(rect) = self.pane_rect(target).or_else(|| Some(self.area())) else {
            return;
        };
        let m = self.fonts.metrics();
        let pad = 2.0 * (scene::PAD * self.scale as f32).round();
        let (min_w, min_h) = (
            MIN_COLS * m.cell_w as f32 + pad,
            MIN_ROWS * m.cell_h as f32 + pad,
        );
        let ok = match dir {
            Dir::Left | Dir::Right => rect.w >= 2.0 * min_w + self.gap(),
            Dir::Up | Dir::Down => rect.h >= 2.0 * min_h + self.gap(),
        };
        if !ok && self.layout.zoomed().is_none() {
            return;
        }
        let old = self.layout.focus();
        let Some(new_id) = self.layout.split(target, dir) else {
            return;
        };
        let rect = self.pane_rect(new_id).unwrap_or(rect);
        let size = self.grid_for(rect);
        match Pane::spawn(new_id, spec, size, proxy.clone()) {
            Ok(p) => {
                self.panes.insert(new_id, p);
                self.after_focus_change(old);
            }
            Err(e) => {
                eprintln!("oop-terminal: 새 pane을 시작할 수 없습니다: {e}");
                self.layout.close(new_id);
                self.layout.set_focus(old);
                self.relayout();
            }
        }
    }

    fn close_pane(&mut self, id: PaneId) {
        let old = self.layout.focus();
        match self.layout.close(id) {
            CloseOutcome::Last => {
                self.shutdown();
            }
            CloseOutcome::Closed(_) => {
                if let Some(mut p) = self.panes.remove(&id) {
                    // 살아 있는 프로세스는 백그라운드에서 정리해 UI 를 막지 않는다.
                    p.hangup();
                    std::thread::spawn(move || {
                        let deadline = Instant::now() + Duration::from_millis(400);
                        while Instant::now() < deadline && p.group_alive() {
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        if p.group_alive() {
                            p.kill_group();
                        }
                        p.shutdown();
                    });
                }
                self.close_at.retain(|(i, _)| *i != id);
                if old == id {
                    self.ime.reset();
                }
                let new = self.layout.focus();
                self.after_focus_change(if old == id { new } else { old });
                if old == id {
                    // 새 포커스 pane 에 포커스 인 알림
                    if let Some(p) = self.panes.get(&new)
                        && self.window_focused
                        && p.term.lock().mode().contains(TermMode::FOCUS_IN_OUT)
                    {
                        p.write(b"\x1b[I".as_slice());
                    }
                }
            }
            CloseOutcome::Unknown => {}
        }
    }

    fn perform_local(&mut self, action: Action) {
        match action {
            Action::ClosePane => {
                let id = self.layout.focus();
                if self.layout.len() == 1 {
                    self.shutdown();
                } else {
                    self.close_pane(id);
                }
            }
            Action::ToggleZoom => {
                if self.layout.toggle_zoom() {
                    self.relayout();
                }
            }
            Action::FocusNext | Action::FocusPrev => {
                let old = self.layout.focus();
                if self.layout.focus_cycle(action == Action::FocusNext) {
                    self.after_focus_change(old);
                }
            }
            Action::FocusDir(dir) => {
                let old = self.layout.focus();
                let (area, gap) = (self.area(), self.gap());
                if self.layout.focus_dir(dir, area, gap) {
                    self.after_focus_change(old);
                }
            }
            Action::Copy => {
                let text = self
                    .panes
                    .get(&self.layout.focus())
                    .and_then(|p| p.term.lock().selection_to_string());
                if let Some(t) = text.filter(|t| !t.is_empty()) {
                    self.set_clipboard(&t);
                }
            }
            Action::Paste => {
                if let Some(t) = self.get_clipboard() {
                    self.paste_text(&t);
                }
            }
            Action::FontBigger | Action::FontSmaller | Action::FontReset => {
                self.zoom_steps = match action {
                    Action::FontBigger => (self.zoom_steps + 1).min(20),
                    Action::FontSmaller => (self.zoom_steps - 1).max(-6),
                    _ => 0,
                };
                self.fonts.set_size_px(self.font_px());
                self.relayout();
            }
            Action::Split(..) | Action::Quit | Action::NewWindow => {}
        }
    }

    fn paste_text(&mut self, text: &str) {
        let id = self.layout.focus();
        if let Some(p) = self.panes.get(&id) {
            let bracketed = p.term.lock().mode().contains(TermMode::BRACKETED_PASTE);
            p.write(keys::encode_paste(text, bracketed));
            p.term.lock().scroll_display(Scroll::Bottom);
        }
        self.window.request_redraw();
    }

    fn on_ime(&mut self, ev: crate::ime::ImeEvent) {
        if let Some(bytes) = self.ime.handle(ev) {
            let id = self.layout.focus();
            if let Some(p) = self.panes.get(&id) {
                if p.exited.is_some() {
                    self.close_pane(id);
                    return;
                }
                p.term.lock().scroll_display(Scroll::Bottom);
                p.write(bytes);
            }
        }
        self.window.request_redraw();
    }

    fn on_key(&mut self, logical: &Key, base: &Key, text: Option<&str>, mods: ModifiersState) {
        let id = self.layout.focus();
        let Some(pane) = self.panes.get(&id) else {
            return;
        };
        if pane.exited.is_some() {
            if !matches!(
                logical,
                Key::Named(
                    NamedKey::Shift
                        | NamedKey::Control
                        | NamedKey::Alt
                        | NamedKey::Super
                        | NamedKey::Meta
                        | NamedKey::CapsLock
                )
            ) {
                self.close_pane(id);
            }
            return;
        }
        // IME 와 겹치는 글자 입력은 버린다 (문자 키만; Enter/Backspace 등은 그대로)
        let text_for_dedupe = match logical {
            Key::Character(_) | Key::Named(NamedKey::Space) => text,
            _ => None,
        };
        let composing_before = self.ime.composing();
        if self.ime.should_drop_key_text(text_for_dedupe) {
            return;
        }
        if composing_before && matches!(logical, Key::Named(NamedKey::Backspace)) {
            return;
        }
        let mode = *pane.term.lock().mode();
        // Shift+PageUp/Down/Home/End: 스크롤백 (대체 화면이 아닐 때)
        if mods.shift_key() && !mode.contains(TermMode::ALT_SCREEN) {
            let scroll = match logical {
                Key::Named(NamedKey::PageUp) => Some(Scroll::PageUp),
                Key::Named(NamedKey::PageDown) => Some(Scroll::PageDown),
                Key::Named(NamedKey::Home) => Some(Scroll::Top),
                Key::Named(NamedKey::End) => Some(Scroll::Bottom),
                _ => None,
            };
            if let Some(s) = scroll {
                pane.term.lock().scroll_display(s);
                self.window.request_redraw();
                return;
            }
        }
        let input = KeyInput {
            logical,
            base: Some(base),
            text,
            mods,
        };
        if let Some(bytes) = keys::encode_key(&input, mode) {
            let mut term = pane.term.lock();
            if term.grid().display_offset() > 0 {
                term.scroll_display(Scroll::Bottom);
            }
            term.selection = None;
            drop(term);
            pane.write(bytes);
            self.blink_on = true;
            self.last_blink = Instant::now();
            self.window.request_redraw();
        }
    }

    // ---- 마우스 ---------------------------------------------------------------------------

    fn set_hover(&mut self, hover: Option<Divider>) {
        let path = hover.as_ref().map(|d| d.path.clone());
        if path != self.hover {
            self.hover = path;
            let icon = match hover.as_ref().map(|d| d.axis) {
                Some(crate::layout::Axis::Horizontal) => CursorIcon::ColResize,
                Some(crate::layout::Axis::Vertical) => CursorIcon::RowResize,
                None => CursorIcon::Default,
            };
            self.window.set_cursor(icon);
            self.window.request_redraw();
        }
    }

    /// 화면 좌표 -> (열, 행, 셀 왼쪽 절반 여부) (pane 내부 격자 기준)
    fn cell_at(&self, rect: Rect, pos: PhysicalPosition<f64>) -> (usize, usize, Side) {
        let m = self.fonts.metrics();
        let g = scene::geometry(rect, self.scale as f32, &m);
        let fx = ((pos.x as f32 - g.x) / m.cell_w as f32).max(0.0);
        let fy = ((pos.y as f32 - g.y) / m.cell_h as f32).max(0.0);
        let col = (fx.floor() as usize).min(g.cols as usize - 1);
        let row = (fy.floor() as usize).min(g.rows as usize - 1);
        let side = if fx.fract() < 0.5 {
            Side::Left
        } else {
            Side::Right
        };
        (col, row, side)
    }

    fn on_cursor_moved(&mut self, position: PhysicalPosition<f64>) {
        self.mouse = position;
        if let Some(drag) = &self.drag {
            let d = &drag.divider;
            let along = match d.axis {
                crate::layout::Axis::Horizontal => position.x as f32,
                crate::layout::Axis::Vertical => position.y as f32,
            };
            let m = self.fonts.metrics();
            let pad = 2.0 * (scene::PAD * self.scale as f32).round();
            let min_px = match d.axis {
                crate::layout::Axis::Horizontal => MIN_COLS * m.cell_w as f32 + pad,
                crate::layout::Axis::Vertical => MIN_ROWS * m.cell_h as f32 + pad,
            };
            let ratio = drag_ratio(d, along, self.gap(), min_px);
            let path = d.path.clone();
            if self.layout.set_ratio(&path, ratio) {
                self.relayout();
            }
            return;
        }
        let div = self.divider_at(position);
        let on_div = div.is_some();
        self.set_hover(div);
        if on_div {
            return;
        }
        let Some((id, rect)) = self.pane_at(position) else {
            return;
        };
        let (col, row, side) = self.cell_at(rect, position);
        let mods = self.mods;
        let Some(pane) = self.panes.get_mut(&id) else {
            return;
        };
        let mode = *pane.term.lock().mode();
        if mouse::reporting(mode) && !mods.shift_key() {
            if pane.ui.last_cell == Some((col, row)) {
                return;
            }
            pane.ui.last_cell = Some((col, row));
            let button = if pane.ui.buttons[0] {
                Button::Left
            } else if pane.ui.buttons[1] {
                Button::Middle
            } else if pane.ui.buttons[2] {
                Button::Right
            } else {
                Button::None
            };
            if let Some(bytes) = mouse::encode(
                &Report {
                    button,
                    kind: Kind::Motion,
                    col,
                    row,
                    mods,
                },
                mode,
            ) {
                pane.write(bytes);
            }
        } else if pane.ui.selecting {
            let mut term = pane.term.lock();
            let point =
                viewport_to_point(term.grid().display_offset(), Point::new(row, Column(col)));
            if let Some(sel) = term.selection.as_mut() {
                sel.update(point, side);
            }
            drop(term);
            self.window.request_redraw();
        }
    }

    fn on_mouse_button(&mut self, state: ElementState, button: MouseButton) {
        let pressed = state == ElementState::Pressed;
        let idx = match button {
            MouseButton::Left => 0,
            MouseButton::Middle => 1,
            MouseButton::Right => 2,
            _ => return,
        };
        if pressed
            && button == MouseButton::Left
            && let Some(d) = self.divider_at(self.mouse)
        {
            self.drag = Some(DragState { divider: d });
            return;
        }
        if !pressed && self.drag.is_some() && button == MouseButton::Left {
            self.drag = None;
            let d = self.divider_at(self.mouse);
            self.set_hover(d);
            return;
        }
        let Some((id, rect)) = self.pane_at(self.mouse) else {
            if !pressed {
                for p in self.panes.values_mut() {
                    p.ui.buttons[idx] = false;
                    p.ui.selecting = false;
                }
            }
            return;
        };
        if pressed && id != self.layout.focus() {
            self.set_focus(id);
        }
        let (col, row, side) = self.cell_at(rect, self.mouse);
        let mods = self.mods;
        let exited = self.panes.get(&id).is_some_and(|p| p.exited.is_some());
        if exited {
            if pressed {
                self.close_pane(id);
            }
            return;
        }
        let Some(pane) = self.panes.get_mut(&id) else {
            return;
        };
        pane.ui.buttons[idx] = pressed;
        let mode = *pane.term.lock().mode();
        let rep_button = [Button::Left, Button::Middle, Button::Right][idx];
        if mouse::reporting(mode) && !mods.shift_key() {
            let kind = if pressed { Kind::Press } else { Kind::Release };
            pane.ui.last_cell = Some((col, row));
            if let Some(bytes) = mouse::encode(
                &Report {
                    button: rep_button,
                    kind,
                    col,
                    row,
                    mods,
                },
                mode,
            ) {
                pane.write(bytes);
            }
            return;
        }
        match (button, pressed) {
            (MouseButton::Left, true) => {
                let now = Instant::now();
                let count = match pane.ui.last_click {
                    Some((t, n, c))
                        if now.duration_since(t) < Duration::from_millis(400)
                            && c == (col, row) =>
                    {
                        (n % 3) + 1
                    }
                    _ => 1,
                };
                pane.ui.last_click = Some((now, count, (col, row)));
                let ty = match count {
                    2 => SelectionType::Semantic,
                    3 => SelectionType::Lines,
                    _ => SelectionType::Simple,
                };
                let mut term = pane.term.lock();
                let point =
                    viewport_to_point(term.grid().display_offset(), Point::new(row, Column(col)));
                term.selection = Some(Selection::new(ty, point, side));
                drop(term);
                pane.ui.selecting = true;
            }
            (MouseButton::Left, false) => {
                pane.ui.selecting = false;
                let mut term = pane.term.lock();
                if term.selection.as_ref().is_some_and(|s| s.is_empty())
                    && pane.ui.last_click.is_some_and(|(_, n, _)| n == 1)
                {
                    term.selection = None;
                }
            }
            (MouseButton::Middle, true) => {
                if let Some(t) = self.get_clipboard() {
                    self.paste_text(&t);
                }
            }
            _ => {}
        }
        self.window.request_redraw();
    }

    fn on_wheel(&mut self, delta: MouseScrollDelta) {
        let lines = match delta {
            MouseScrollDelta::LineDelta(_, y) => y,
            MouseScrollDelta::PixelDelta(p) => p.y as f32 / self.fonts.metrics().cell_h as f32,
        };
        self.scroll_accum += lines;
        let whole = self.scroll_accum.trunc();
        if whole == 0.0 {
            return;
        }
        self.scroll_accum -= whole;
        let n = whole.abs() as usize;
        let up = whole > 0.0;
        let Some((id, rect)) = self.pane_at(self.mouse) else {
            return;
        };
        let (col, row, _) = self.cell_at(rect, self.mouse);
        let mods = self.mods;
        let Some(pane) = self.panes.get(&id) else {
            return;
        };
        let mode = *pane.term.lock().mode();
        if mouse::reporting(mode) && !mods.shift_key() {
            let button = if up {
                Button::WheelUp
            } else {
                Button::WheelDown
            };
            for _ in 0..n {
                if let Some(b) = mouse::encode(
                    &Report {
                        button,
                        kind: Kind::Press,
                        col,
                        row,
                        mods,
                    },
                    mode,
                ) {
                    pane.write(b);
                }
            }
        } else if mode.contains(TermMode::ALT_SCREEN) {
            if mode.contains(TermMode::ALTERNATE_SCROLL) {
                let key = match (up, mode.contains(TermMode::APP_CURSOR)) {
                    (true, true) => b"\x1bOA".as_slice(),
                    (true, false) => b"\x1b[A".as_slice(),
                    (false, true) => b"\x1bOB".as_slice(),
                    (false, false) => b"\x1b[B".as_slice(),
                };
                for _ in 0..n {
                    pane.write(key);
                }
            }
        } else {
            pane.term
                .lock()
                .scroll_display(Scroll::Delta(if up { n as i32 } else { -(n as i32) } * 3));
            self.window.request_redraw();
        }
    }

    // ---- 그리기 ---------------------------------------------------------------------------

    fn redraw(&mut self) {
        let rects = self.layout.rects(self.area(), self.gap());
        let dividers = self.layout.dividers(self.area(), self.gap());
        let hover = self.hover.clone();
        let active = self.drag.as_ref().map(|d| d.divider.path.clone()).or(hover);
        let focus = self.layout.focus();
        let mut view = ViewState {
            fonts: &mut self.fonts,
            scale: self.scale as f32,
            window_focused: self.window_focused,
            blink_on: self.blink_on,
            ime: &self.ime,
            focus,
            active_divider: active.as_deref(),
        };
        let out = scene::build(&mut self.frame, &mut view, &self.panes, &rects, &dividers);
        self.gpu.upload_atlas(&mut self.fonts.atlas.uploads);
        if let Some(area) = out.ime_area
            && self.last_ime_area != Some(area)
        {
            self.last_ime_area = Some(area);
            self.window.set_ime_cursor_area(
                PhysicalPosition::new(area.0 as f64, area.1 as f64),
                PhysicalSize::new(area.2 as f64, area.3 as f64),
            );
        }
        // 커서 깜박임이 필요한지 기억 (타이머는 about_to_wait 에서)
        self.blink_enabled = self.panes.get(&focus).is_some_and(|p| {
            let t = p.term.lock();
            t.cursor_style().blinking && t.mode().contains(TermMode::SHOW_CURSOR)
        });
        if !self.blink_enabled {
            self.blink_on = true;
        }
        #[cfg(debug_assertions)]
        if let Some(path) = self.autopilot.take_screenshot() {
            self.save_ppm(&path);
        }
        let size = (self.surf.config.width, self.surf.config.height);
        match self.surf.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(tex)
            | wgpu::CurrentSurfaceTexture::Suboptimal(tex) => {
                let view = tex
                    .texture
                    .create_view(&wgpu::TextureViewDescriptor::default());
                self.gpu.draw(&view, size, &self.frame);
                self.window.pre_present_notify();
                self.gpu.queue.present(tex);
                if !self.first_frame_logged {
                    self.first_frame_logged = true;
                    if std::env::var_os("OOP_TERMINAL_TIMING").is_some() {
                        eprintln!(
                            "[oop-terminal] first frame presented {} ms after process start",
                            self.started.elapsed().as_millis()
                        );
                    }
                }
            }
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surf
                    .surface
                    .configure(&self.gpu.device, &self.surf.config);
                self.window.request_redraw();
            }
            other => {
                if matches!(other, wgpu::CurrentSurfaceTexture::Timeout) {
                    self.window.request_redraw();
                }
                if std::env::var_os("OOP_TERMINAL_TIMING").is_some() {
                    eprintln!(
                        "[oop-terminal] frame skipped ({:?}) at {} ms",
                        std::mem::discriminant(&other),
                        self.started.elapsed().as_millis()
                    );
                }
            }
        }
    }

    #[cfg(debug_assertions)]
    fn save_ppm(&mut self, path: &str) {
        let size = (self.surf.config.width, self.surf.config.height);
        let bgra = matches!(
            self.gpu.format,
            wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb
        );
        let px = self.gpu.render_to_rgba(size, &self.frame);
        let mut data = format!("P6\n{} {}\n255\n", size.0, size.1).into_bytes();
        for c in px.chunks_exact(4) {
            if bgra {
                data.extend_from_slice(&[c[2], c[1], c[0]]);
            } else {
                data.extend_from_slice(&[c[0], c[1], c[2]]);
            }
        }
        let _ = std::fs::write(path, data);
    }

    // ---- 종료 -----------------------------------------------------------------------------

    /// 모든 pane 의 프로세스 그룹을 정리한다. 여러 번 불러도 안전하다.
    fn shutdown(&mut self) {
        if self.shutting_down {
            return;
        }
        self.shutting_down = true;
        terminate_all(self.panes.values_mut(), Duration::from_millis(400));
        self.panes.clear();
    }

    #[cfg(debug_assertions)]
    fn run_autopilot_step(
        &mut self,
        event_loop: &ActiveEventLoop,
        step: crate::autopilot::Step,
        oop: &SpawnSpec,
        shell: &SpawnSpec,
        proxy: &EventLoopProxy<UserEvent>,
    ) {
        use crate::autopilot::Step;
        match step {
            Step::Action(Action::Split(dir, kind)) => {
                let spec = if kind == PaneKind::Oop { oop } else { shell };
                self.split(dir, spec, proxy);
            }
            Step::Action(Action::Quit) | Step::Quit => {
                self.shutdown();
                event_loop.exit();
            }
            Step::Action(a) => self.perform_local(a),
            Step::Type(text) => {
                let id = self.layout.focus();
                if let Some(p) = self.panes.get(&id) {
                    p.write(text.into_bytes());
                }
            }
            Step::Screenshot(path) => {
                self.autopilot.set_screenshot(path);
                self.window.request_redraw();
            }
            Step::Click(x, y) => {
                self.mouse = PhysicalPosition::new(x as f64, y as f64);
                self.on_mouse_button(ElementState::Pressed, MouseButton::Left);
                self.on_mouse_button(ElementState::Released, MouseButton::Left);
            }
            Step::DragDivider(path_idx, to) => {
                let divs = self.layout.dividers(self.area(), self.gap());
                if let Some(d) = divs.get(path_idx).cloned() {
                    let c = Rect::new(d.rect.x, d.rect.y, d.rect.w, d.rect.h);
                    self.mouse =
                        PhysicalPosition::new((c.x + c.w / 2.0) as f64, (c.y + c.h / 2.0) as f64);
                    self.on_mouse_button(ElementState::Pressed, MouseButton::Left);
                    let (px, py) = match d.axis {
                        crate::layout::Axis::Horizontal => (to, self.mouse.y as f32),
                        crate::layout::Axis::Vertical => (self.mouse.x as f32, to),
                    };
                    self.on_cursor_moved(PhysicalPosition::new(px as f64, py as f64));
                    self.on_mouse_button(ElementState::Released, MouseButton::Left);
                }
            }
            Step::Report => {
                let rects = self.layout.rects(self.area(), self.gap());
                let mut line = format!(
                    "[autopilot] panes={} focus={} zoom={:?}",
                    self.layout.len(),
                    self.layout.focus(),
                    self.layout.zoomed()
                );
                for (id, r) in rects {
                    let g = self
                        .panes
                        .get(&id)
                        .map(|p| (p.size.cols, p.size.rows))
                        .unwrap_or((0, 0));
                    line.push_str(&format!(
                        " | #{id} {}x{} @({:.0},{:.0}) {:.0}x{:.0}px",
                        g.0, g.1, r.x, r.y, r.w, r.h
                    ));
                }
                eprintln!("{line}");
            }
            Step::Wait(_) => {}
        }
    }
}
