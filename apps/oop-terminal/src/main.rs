//! OOP Terminal: 첫 pane 에서 oop 이 바로 실행되는 독립 터미널 프로그램.

mod app;
#[cfg(debug_assertions)]
mod autopilot;
mod boxdraw;
mod font;
mod gpu;
mod ime;
mod keys;
mod launch;
mod layout;
#[cfg(target_os = "macos")]
mod menu;
mod mouse;
mod pane;
mod scene;
mod shortcuts;
mod theme;

use std::time::Instant;

use winit::event_loop::EventLoop;

fn main() {
    let started = Instant::now();
    // Finder 가 붙이는 -psn_* 같은 인자와 옵션은 무시하고, 첫 번째 일반 인자를 시작 폴더로 쓴다.
    let start_dir_arg = std::env::args().skip(1).find(|a| !a.starts_with('-'));
    let event_loop = match EventLoop::<pane::UserEvent>::with_user_event().build() {
        Ok(l) => l,
        Err(e) => {
            eprintln!("oop-terminal: 이벤트 루프를 만들 수 없습니다: {e}");
            std::process::exit(1);
        }
    };
    let mut app = app::App::new(
        event_loop.create_proxy(),
        app::Options {
            start_dir_arg,
            started,
        },
    );
    if let Err(e) = event_loop.run_app(&mut app) {
        eprintln!("oop-terminal: {e}");
        std::process::exit(1);
    }
}
