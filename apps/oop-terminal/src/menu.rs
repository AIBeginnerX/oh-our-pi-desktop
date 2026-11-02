//! macOS 메뉴바 (Shell / Split / Edit / View). 단축키는 메뉴가 먼저 가로채므로
//! 메뉴 항목과 `shortcuts::map` 은 같은 `Action` 으로 이어진다.

use muda::accelerator::{Accelerator, Code, Modifiers};
use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use winit::event_loop::EventLoopProxy;

use crate::layout::Dir;
use crate::pane::UserEvent;
use crate::shortcuts::{Action, PaneKind};

struct Entry {
    id: &'static str,
    title: &'static str,
    action: Action,
    accel: Option<(Modifiers, Code)>,
}

const CMD: Modifiers = Modifiers::META;
const CMD_SHIFT: Modifiers = Modifiers::META.union(Modifiers::SHIFT);
const CMD_ALT: Modifiers = Modifiers::META.union(Modifiers::ALT);
const CMD_ALT_SHIFT: Modifiers = Modifiers::META
    .union(Modifiers::ALT)
    .union(Modifiers::SHIFT);

fn split(
    id: &'static str,
    title: &'static str,
    dir: Dir,
    kind: PaneKind,
    accel: Option<(Modifiers, Code)>,
) -> Entry {
    Entry {
        id,
        title,
        action: Action::Split(dir, kind),
        accel,
    }
}

fn entries() -> Vec<(&'static str, Vec<Option<Entry>>)> {
    use Dir::*;
    use PaneKind::*;
    let e = |id, title, action, accel| {
        Some(Entry {
            id,
            title,
            action,
            accel,
        })
    };
    vec![
        (
            "Shell",
            vec![
                e(
                    "new-window",
                    "New Window",
                    Action::NewWindow,
                    Some((CMD, Code::KeyN)),
                ),
                None,
                Some(split(
                    "split-right",
                    "Split Right",
                    Right,
                    Oop,
                    Some((CMD, Code::KeyD)),
                )),
                Some(split(
                    "split-down",
                    "Split Down",
                    Down,
                    Oop,
                    Some((CMD_SHIFT, Code::KeyD)),
                )),
                None,
                Some(split(
                    "split-left-oop",
                    "Split Left",
                    Left,
                    Oop,
                    Some((CMD_ALT, Code::ArrowLeft)),
                )),
                Some(split(
                    "split-right-oop",
                    "Split Right (Arrow)",
                    Right,
                    Oop,
                    Some((CMD_ALT, Code::ArrowRight)),
                )),
                Some(split(
                    "split-up-oop",
                    "Split Up",
                    Up,
                    Oop,
                    Some((CMD_ALT, Code::ArrowUp)),
                )),
                Some(split(
                    "split-down-oop",
                    "Split Down (Arrow)",
                    Down,
                    Oop,
                    Some((CMD_ALT, Code::ArrowDown)),
                )),
                None,
                Some(split(
                    "split-left-shell",
                    "Split Left with Shell",
                    Left,
                    Shell,
                    Some((CMD_ALT_SHIFT, Code::ArrowLeft)),
                )),
                Some(split(
                    "split-right-shell",
                    "Split Right with Shell",
                    Right,
                    Shell,
                    Some((CMD_ALT_SHIFT, Code::ArrowRight)),
                )),
                Some(split(
                    "split-up-shell",
                    "Split Up with Shell",
                    Up,
                    Shell,
                    Some((CMD_ALT_SHIFT, Code::ArrowUp)),
                )),
                Some(split(
                    "split-down-shell",
                    "Split Down with Shell",
                    Down,
                    Shell,
                    Some((CMD_ALT_SHIFT, Code::ArrowDown)),
                )),
                None,
                e(
                    "zoom",
                    "Toggle Pane Zoom",
                    Action::ToggleZoom,
                    Some((CMD_SHIFT, Code::Enter)),
                ),
                e(
                    "prev-pane",
                    "Previous Pane",
                    Action::FocusPrev,
                    Some((CMD_ALT, Code::BracketLeft)),
                ),
                e(
                    "next-pane",
                    "Next Pane",
                    Action::FocusNext,
                    Some((CMD_ALT, Code::BracketRight)),
                ),
                None,
                e(
                    "close-pane",
                    "Close Pane",
                    Action::ClosePane,
                    Some((CMD, Code::KeyW)),
                ),
            ],
        ),
        (
            "Edit",
            vec![
                e("copy", "Copy", Action::Copy, Some((CMD, Code::KeyC))),
                e("paste", "Paste", Action::Paste, Some((CMD, Code::KeyV))),
            ],
        ),
        (
            "View",
            vec![
                e(
                    "font-bigger",
                    "Bigger",
                    Action::FontBigger,
                    Some((CMD, Code::Equal)),
                ),
                e(
                    "font-smaller",
                    "Smaller",
                    Action::FontSmaller,
                    Some((CMD, Code::Minus)),
                ),
                e(
                    "font-reset",
                    "Actual Size",
                    Action::FontReset,
                    Some((CMD, Code::Digit0)),
                ),
            ],
        ),
    ]
}

/// 메뉴바를 만들어 NSApp 에 붙이고, 선택을 `UserEvent::Action` 으로 전달한다.
/// 반환값(메뉴)은 앱이 살아 있는 동안 들고 있어야 한다.
pub fn install(proxy: EventLoopProxy<UserEvent>) -> Menu {
    let menu = Menu::new();
    let app = Submenu::new("OOP Terminal", true);
    let quit = MenuItem::with_id(
        "quit",
        "Quit OOP Terminal",
        true,
        Some(Accelerator::new(CMD, Code::KeyQ)),
    );
    let _ = app.append_items(&[
        &PredefinedMenuItem::about(Some("About OOP Terminal"), None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::hide(None),
        &PredefinedMenuItem::hide_others(None),
        &PredefinedMenuItem::show_all(None),
        &PredefinedMenuItem::separator(),
        &quit,
    ]);
    let _ = menu.append(&app);

    let mut table: Vec<(&'static str, Action)> = vec![("quit", Action::Quit)];
    for (name, items) in entries() {
        let sub = Submenu::new(name, true);
        for item in items {
            match item {
                None => {
                    let _ = sub.append(&PredefinedMenuItem::separator());
                }
                Some(en) => {
                    let accel = en.accel.map(|(m, c)| Accelerator::new(m, c));
                    let mi = MenuItem::with_id(en.id, en.title, true, accel);
                    let _ = sub.append(&mi);
                    table.push((en.id, en.action));
                }
            }
        }
        let _ = menu.append(&sub);
    }
    let window = Submenu::new("Window", true);
    let _ = window.append_items(&[
        &PredefinedMenuItem::minimize(None),
        &PredefinedMenuItem::maximize(None),
        &PredefinedMenuItem::fullscreen(None),
    ]);
    let _ = menu.append(&window);
    menu.init_for_nsapp();
    window.set_as_windows_menu_for_nsapp();

    MenuEvent::set_event_handler(Some(move |ev: MenuEvent| {
        if let Some((_, action)) = table.iter().find(|(id, _)| ev.id.as_ref() == *id) {
            let _ = proxy.send_event(UserEvent::Action(*action));
        }
    }));
    menu
}
