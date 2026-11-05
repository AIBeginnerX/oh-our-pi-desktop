//! `/mobile` and `oop mobile`: a QR code a phone scans to open OOP's mobile web, the same thing
//! the desktop app's "Connect mobile" dialog shows (`MobileConnectDialog.tsx`).
//!
//! The terminal's own login lacks `access:write`, which minting a pairing credential over HTTP
//! needs, so the credential comes from the running server's own `pair` command (the way
//! `server::bearer_for` already pairs this terminal): it carries `AuthStandardClientScopes`, the
//! dialog's scopes, and the server's default five-minute, single-use expiry. That is possible only
//! on the computer that runs the server. The relay address lives in the desktop app's
//! `remote-relay.json`; the link is `<relay>/pair#token=<credential>` (`resolveDesktopPairingUrl`).
//! With no relay it falls back to the link `pair` printed, which names the server's own address.
//! Nothing refreshes: a code is made when asked for and a new one needs the command again.

use crate::app::{App, Msg};
use crate::notes::Tone;
use crate::panels_common::{fill, s};
use crate::screen::Screen;
use crate::server;
use crate::text::wrap;
use qrcode::{Color as Module, EcLevel, QrCode};
use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph};
use serde_json::Value;
use std::path::Path;

/// Light modules around the code, enough for a phone camera to find its edges.
const QUIET_ZONE: usize = 2;

/// How a phone reaches the server, in the desktop dialog's order: public routes first, then
/// private networks, then the same Wi-Fi (`mobileConnectEndpoints`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Via {
    Relay,
    TailscaleHttps,
    TailscaleIp,
    Lan,
}

impl Via {
    /// The dialog's names for these routes.
    fn label(self) -> &'static str {
        match self {
            Via::Relay => "Cloudflare relay",
            Via::TailscaleHttps => "Tailscale HTTPS",
            Via::TailscaleIp => "Tailscale IP",
            Via::Lan => "Local network",
        }
    }

    /// The route an address the server printed is; `None` for one only this computer can open.
    fn of_address(url: &str) -> Option<Via> {
        let origin = crate::http::Origin::parse(url).ok()?;
        if server::is_loopback_origin(url) {
            None
        } else if origin.tls && origin.host.ends_with(".ts.net") {
            Some(Via::TailscaleHttps)
        } else if is_tailscale_ipv4(&origin.host) {
            Some(Via::TailscaleIp)
        } else {
            Some(Via::Lan)
        }
    }
}

/// 100.64.0.0/10, the range Tailscale gives its addresses (`isTailscaleIpv4Address`).
fn is_tailscale_ipv4(host: &str) -> bool {
    let parts: Vec<u8> = host.split('.').filter_map(|p| p.parse().ok()).collect();
    parts.len() == 4
        && host.split('.').count() == 4
        && parts[0] == 100
        && (64..=127).contains(&parts[1])
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Pairing {
    /// What the code encodes and what is shown as the link.
    pub url: String,
    pub expires_at: String,
    pub via: Via,
}

/// What the server's `pair` command printed.
#[derive(Debug, PartialEq, Eq)]
pub struct Issued {
    pub token: String,
    pub url: String,
    pub expires_at: String,
}

pub fn parse_pair_output(output: &str) -> Option<Issued> {
    let field = |name: &str| {
        output
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    Some(Issued {
        token: server::parse_pairing_token(output)?,
        url: field("Pairing URL: ")?,
        expires_at: field("Expires: ")?,
    })
}

/// The relay's origin from the app's `remote-relay.json`; none when no address is saved. The app
/// accepts only `https://`, or `http://` for a relay on this computer.
pub fn relay_origin(document: &str) -> Option<String> {
    let url = serde_json::from_str::<Value>(document).ok()?["url"]
        .as_str()?
        .trim()
        .to_string();
    let origin = crate::http::Origin::parse(&url).ok()?;
    let local = origin.host == "localhost" || origin.host == "127.0.0.1";
    if !origin.tls && !local {
        return None;
    }
    let host = if origin.host.contains(':') {
        format!("[{}]", origin.host)
    } else {
        origin.host.clone()
    };
    let (scheme, default) = if origin.tls {
        ("https", 443)
    } else {
        ("http", 80)
    };
    Some(if origin.port == default {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}:{}", origin.port)
    })
}

/// Whether the app lets phones reach the server (`serverExposureMode` of `desktop-settings.json`);
/// none when the file says nothing, as for a server the terminal started itself.
pub fn network_accessible(document: &str) -> Option<bool> {
    let value: Value = serde_json::from_str(document).ok()?;
    Some(value["serverExposureMode"].as_str()? == "network-accessible")
}

/// `<base>/pair#token=<credential>`, the fragment form-encoded like `URLSearchParams` does.
pub fn pairing_url(base: &str, token: &str) -> String {
    let mut encoded = String::new();
    for byte in token.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                encoded.push(byte as char)
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    format!("{}/pair#token={encoded}", base.trim_end_matches('/'))
}

fn setup_hint() -> &'static str {
    s(
        "In the OOP app open Connect mobile, allow mobile connections, and under \"Use away from home\" save your relay address. Or publish the server on your tailnet with Tailscale Serve (t3 serve --tailscale-serve).",
        "OOP 앱에서 모바일 연결을 열어 모바일 연결을 허용하고, \"외부에서 사용\"에 릴레이 주소를 저장하세요. 또는 Tailscale Serve 로 서버를 테일넷에 게시하세요 (t3 serve --tailscale-serve).",
    )
}

/// The routes a phone can use, best first; the first is shown at first. One credential serves all
/// of them, so switching needs no new one. `tailscale` is the HTTPS address this computer
/// publishes the server at, when it does. The relay is left out when the app says mobile
/// connections are off; with no route left the error says what to set up.
pub fn choose(
    issued: &Issued,
    relay: Option<&str>,
    accessible: Option<bool>,
    tailscale: Option<&str>,
) -> Result<Vec<Pairing>, String> {
    let mut routes: Vec<(Via, String)> = Vec::new();
    if let Some(relay) = relay
        && accessible != Some(false)
    {
        routes.push((Via::Relay, pairing_url(relay, &issued.token)));
    }
    if let Some(origin) = tailscale {
        routes.push((Via::TailscaleHttps, pairing_url(origin, &issued.token)));
    }
    // The address the server itself printed, unless it is one of the above or only this computer's.
    if let Some(via) = Via::of_address(&issued.url)
        && !routes
            .iter()
            .any(|(known, _)| *known == via && via == Via::TailscaleHttps)
    {
        routes.push((via, issued.url.clone()));
    }
    routes.sort_by_key(|(via, _)| *via as u8);
    if routes.is_empty() {
        return Err(if relay.is_some() {
            s(
                "Mobile connections are off, so a phone could not use the relay. In the OOP app open Connect mobile and choose Allow mobile connections.",
                "모바일 연결이 꺼져 있어 휴대폰이 릴레이를 쓸 수 없습니다. OOP 앱의 모바일 연결에서 모바일 연결 허용을 누르세요.",
            )
            .to_string()
        } else {
            format!(
                "{} {}",
                s(
                    "No relay address is saved and the server only answers on this computer, so a phone cannot reach it.",
                    "저장된 릴레이 주소가 없고 서버가 이 컴퓨터에서만 응답해 휴대폰이 연결할 수 없습니다.",
                ),
                setup_hint()
            )
        });
    }
    Ok(routes
        .into_iter()
        .map(|(via, url)| Pairing {
            url,
            expires_at: issued.expires_at.clone(),
            via,
        })
        .collect())
}

/// The code as text rows of half blocks, two module rows per line. The caller draws every cell
/// dark on light, so it reads the same on a dark or a light theme.
pub fn qr_rows(payload: &str) -> Result<Vec<String>, String> {
    let code =
        QrCode::with_error_correction_level(payload.as_bytes(), EcLevel::M).map_err(|_| {
            s(
                "The link is too long for a QR code.",
                "링크가 QR 코드로 만들기에는 너무 깁니다.",
            )
            .to_string()
        })?;
    let size = code.width();
    let colors = code.to_colors();
    let total = size + 2 * QUIET_ZONE;
    let dark = |x: usize, y: usize| {
        x >= QUIET_ZONE
            && y >= QUIET_ZONE
            && x < QUIET_ZONE + size
            && y < QUIET_ZONE + size
            && colors[(y - QUIET_ZONE) * size + (x - QUIET_ZONE)] == Module::Dark
    };
    Ok((0..total)
        .step_by(2)
        .map(|y| {
            (0..total)
                .map(|x| match (dark(x, y), dark(x, y + 1)) {
                    (true, true) => '█',
                    (true, false) => '▀',
                    (false, true) => '▄',
                    (false, false) => ' ',
                })
                .collect()
        })
        .collect())
}

fn read_state(home: &Path, name: &str) -> Option<String> {
    std::fs::read_to_string(home.join("userdata").join(name)).ok()
}

/// Mints a credential on the server this computer runs and decides what the phone scans.
/// `expect` is the server the caller is connected to, which must be that one.
pub async fn create(home: &Path, expect: Option<&str>) -> Result<Vec<Pairing>, String> {
    let found = match server::discover_announced(home).await {
        server::Discovery::Found(found) => found,
        _ => {
            return Err(s(
                "No OOP server is running on this computer. A phone can only be connected from the computer that runs the server; use Connect mobile in the OOP app instead.",
                "이 컴퓨터에서 실행 중인 OOP 서버가 없습니다. 휴대폰은 서버가 실행 중인 컴퓨터에서만 연결할 수 있습니다. OOP 앱의 모바일 연결을 이용하세요.",
            )
            .to_string());
        }
    };
    if let Some(expect) = expect
        && !server::origins_match(expect, &found.origin)
    {
        return Err(fill(
            s(
                "This terminal is connected to {expect}, not to the server on this computer ({found}). Use Connect mobile in the OOP app of that server.",
                "이 터미널은 이 컴퓨터의 서버({found})가 아니라 {expect} 에 연결되어 있습니다. 해당 서버의 OOP 앱에서 모바일 연결을 이용하세요.",
            ),
            &[("expect", expect.to_string()), ("found", found.origin)],
        ));
    }
    let relay = read_state(home, "remote-relay.json").and_then(|d| relay_origin(&d));
    let accessible = read_state(home, "desktop-settings.json").and_then(|d| network_accessible(&d));
    let output = server::pair_output(&found, home, "Mobile", None).await;
    let issued = output
        .as_deref()
        .and_then(parse_pair_output)
        .ok_or_else(|| {
            s(
                "The running OOP server did not give out a pairing code.",
                "실행 중인 OOP 서버에서 페어링 코드를 받지 못했습니다.",
            )
            .to_string()
        })?;
    let tailscale = crate::tailscale::https_origin(&found.origin, &found.environment_id).await;
    choose(&issued, relay.as_deref(), accessible, tailscale.as_deref())
}

fn notes_for(pairing: &Pairing) -> Vec<String> {
    let route = match pairing.via {
        Via::Relay => s(
            "Through your relay, from anywhere. If the phone cannot connect, check that the app's Connect mobile shows the relay as connected.",
            "릴레이를 통해 어디서나 연결됩니다. 연결되지 않으면 앱의 모바일 연결에서 릴레이가 연결됨인지 확인하세요.",
        ),
        Via::TailscaleHttps | Via::TailscaleIp => s(
            "Works anywhere while Tailscale is on for both devices: the phone needs the Tailscale app signed in to the same tailnet.",
            "두 기기 모두 Tailscale 이 켜져 있으면 어디서나 연결됩니다. 휴대폰에 같은 테일넷으로 로그인한 Tailscale 앱이 필요합니다.",
        ),
        Via::Lan => s(
            "The phone must be on the same network as this computer.",
            "휴대폰이 이 컴퓨터와 같은 네트워크에 있어야 합니다.",
        ),
    };
    vec![
        fill(
            s(
                "Expires {at} (UTC). One phone per code.",
                "{at} (UTC) 에 만료됩니다. 코드 하나에 휴대폰 한 대.",
            ),
            &[("at", pairing.expires_at.clone())],
        ),
        route.to_string(),
    ]
}

/// The routes on one line with the shown one in brackets; empty when there is only one.
fn routes_line(routes: &[Via], at: usize) -> String {
    if routes.len() < 2 {
        return String::new();
    }
    routes
        .iter()
        .enumerate()
        .map(|(i, via)| {
            if i == at {
                format!("[{}]", via.label())
            } else {
                via.label().to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("  ")
}

/// The route Tab moves to: forward, or back with Shift+Tab, around the list.
fn step(at: usize, len: usize, back: bool) -> usize {
    if back {
        (at + len - 1) % len
    } else {
        (at + 1) % len
    }
}

struct MobileScreen {
    routes: Vec<(Pairing, Vec<String>)>,
    at: usize,
}

impl Screen for MobileScreen {
    fn draw(&self, frame: &mut Frame, area: Rect, _app: &App) {
        let width = usize::from(area.width);
        let (pairing, rows) = (&self.routes[self.at].0, &self.routes[self.at].1);
        let vias: Vec<Via> = self.routes.iter().map(|(p, _)| p.via).collect();
        let choice = routes_line(&vias, self.at);
        let link = wrap(&pairing.url, width.max(8));
        let notes: Vec<String> = notes_for(pairing)
            .iter()
            .flat_map(|n| wrap(n, width.max(8)))
            .collect();
        let mut text = vec![
            Line::from(
                s(
                    "Connect a phone: scan with its camera",
                    "휴대폰 연결: 카메라로 스캔하세요",
                )
                .to_string(),
            ),
            Line::default(),
        ];
        let choice: Vec<String> = if choice.is_empty() {
            Vec::new()
        } else {
            wrap(&choice, width.max(8))
        };
        let qr_width = rows.first().map_or(0, |r| r.chars().count());
        let needed = 2 + choice.len() + rows.len() + 1 + link.len() + 1 + notes.len();
        if qr_width <= width && needed <= usize::from(area.height) {
            // Dark on light for every theme, so the code scans on a dark terminal too.
            let style = Style::default().fg(Color::Black).bg(Color::White);
            let pad = " ".repeat((width - qr_width) / 2);
            for row in rows {
                text.push(Line::from(vec![
                    Span::raw(pad.clone()),
                    Span::styled(row.clone(), style),
                ]));
            }
        } else {
            text.push(Line::from(fill(
                s(
                    "Make the window at least {w} columns by {h} rows to see the QR code.",
                    "QR 코드를 보려면 창을 {w}열 x {h}행 이상으로 키우세요.",
                ),
                &[("w", qr_width.to_string()), ("h", (needed + 2).to_string())],
            )));
        }
        text.push(Line::default());
        text.extend(link.into_iter().map(Line::from));
        text.push(Line::default());
        text.extend(choice.into_iter().map(Line::from));
        text.extend(notes.into_iter().map(Line::from));
        frame.render_widget(Clear, area);
        frame.render_widget(Paragraph::new(text), area);
    }

    fn key(&mut self, key: KeyEvent, _app: &mut App) -> bool {
        match key.code {
            KeyCode::Tab | KeyCode::BackTab | KeyCode::Right | KeyCode::Left => {
                let back = matches!(key.code, KeyCode::BackTab | KeyCode::Left);
                self.at = step(self.at, self.routes.len(), back);
                false
            }
            KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => true,
            _ => false,
        }
    }

    fn hint(&self) -> String {
        if self.routes.len() > 1 {
            s("Tab switch route · Esc close", "Tab 경로 전환 · Esc 닫기").to_string()
        } else {
            s("Esc close", "Esc 닫기").to_string()
        }
    }
}

/// A QR code for every route, or the first failure.
fn with_rows(routes: Vec<Pairing>) -> Result<Vec<(Pairing, Vec<String>)>, String> {
    routes
        .into_iter()
        .map(|pairing| qr_rows(&pairing.url).map(|rows| (pairing, rows)))
        .collect()
}

/// `/mobile`: makes a code on the server's computer and opens it as a screen.
pub fn command(app: &mut App) {
    app.notice = Some(s("Creating a pairing code…", "페어링 코드를 만드는 중…").to_string());
    let (home, _) = server::server_home(app.provider_home.as_deref());
    let expect = app.provider_server.clone();
    let tx = app.sender();
    tokio::spawn(async move {
        let result = create(&home, expect.as_deref()).await.and_then(with_rows);
        let _ = tx.send(Msg::Ext(Box::new(move |app: &mut App| {
            app.notice = None;
            match result {
                Ok(routes) => app.screen = Some(Box::new(MobileScreen { routes, at: 0 })),
                Err(message) => app.say(Tone::Error, &message),
            }
        })));
    });
}

/// `oop mobile`: prints the best route's code, link and expiry, and the other routes' links; 0 on
/// success.
pub async fn run_cli(home: Option<String>) -> i32 {
    let (home, _) = server::server_home(home.as_deref());
    let result = create(&home, None).await.and_then(with_rows);
    match result {
        Ok(routes) => {
            let (pairing, rows) = &routes[0];
            for row in rows {
                println!("\x1b[30;47m{row}\x1b[0m");
            }
            println!("\n{}", pairing.url);
            for line in notes_for(pairing) {
                println!("{line}");
            }
            for (other, _) in &routes[1..] {
                println!("{}: {}", other.via.label(), other.url);
            }
            0
        }
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUTPUT: &str = "Pairing with OOP (http://192.168.1.5:3773).\n\n▄▄▄\n\nPairing URL: http://192.168.1.5:3773/pair#token=FIXTURETOKEN\nToken: FIXTURETOKEN\nExpires: 2026-01-01T00:05:00.000Z\n";

    fn issued(url: &str) -> Issued {
        Issued {
            token: "FIXTURE TOKEN/1".into(),
            url: url.into(),
            expires_at: "2026-01-01T00:05:00.000Z".into(),
        }
    }

    #[test]
    fn the_servers_pair_output_gives_token_link_and_expiry() {
        let got = parse_pair_output(OUTPUT).unwrap();
        assert_eq!(got.token, "FIXTURETOKEN");
        assert_eq!(got.url, "http://192.168.1.5:3773/pair#token=FIXTURETOKEN");
        assert_eq!(got.expires_at, "2026-01-01T00:05:00.000Z");
        assert!(parse_pair_output("Token: x\n").is_none());
    }

    #[test]
    fn the_relay_origin_is_read_from_the_apps_file() {
        let doc = |u: &str| format!(r#"{{"url":"{u}","secret":"s"}}"#);
        assert_eq!(
            relay_origin(&doc("https://oop-relay.you.workers.dev/")).as_deref(),
            Some("https://oop-relay.you.workers.dev")
        );
        assert_eq!(
            relay_origin(&doc("http://localhost:8787")).as_deref(),
            Some("http://localhost:8787")
        );
        assert_eq!(relay_origin(&doc("http://example.com")), None);
        assert_eq!(relay_origin(r#"{"url":null,"secret":"s"}"#), None);
        assert_eq!(relay_origin("nonsense"), None);
    }

    #[test]
    fn the_link_puts_the_encoded_token_in_the_fragment_of_pair() {
        assert_eq!(
            pairing_url("https://r.example/", "FIXTURE TOKEN/1"),
            "https://r.example/pair#token=FIXTURE+TOKEN%2F1"
        );
    }

    #[test]
    fn a_relay_wins_and_is_refused_only_when_the_app_says_mobile_is_off() {
        let i = issued("http://127.0.0.1:3773/pair#token=x");
        let got = choose(&i, Some("https://r.example"), None, None).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].via, Via::Relay);
        assert!(got[0].url.starts_with("https://r.example/pair#token="));
        assert!(choose(&i, Some("https://r.example"), Some(true), None).is_ok());
        assert!(choose(&i, Some("https://r.example"), Some(false), None).is_err());
    }

    #[test]
    fn without_a_relay_only_a_reachable_address_is_offered() {
        let lan = issued("http://192.168.1.5:3773/pair#token=x");
        let got = choose(&lan, None, Some(true), None).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(
            (got[0].via, got[0].url.as_str()),
            (Via::Lan, lan.url.as_str())
        );
        let err = choose(
            &issued("http://127.0.0.1:3773/pair#token=x"),
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("relay"));
    }

    const TS: &str = "https://devbox.tail0000ab.ts.net";

    fn routes(got: &[Pairing]) -> Vec<(Via, &str)> {
        got.iter().map(|p| (p.via, p.url.as_str())).collect()
    }

    #[test]
    fn the_relay_stays_the_default_and_tailscale_then_the_local_network_follow() {
        let i = issued("http://192.168.1.5:3773/pair#token=x");
        let got = choose(&i, Some("https://r.example"), None, Some(TS)).unwrap();
        assert_eq!(
            routes(&got),
            vec![
                (Via::Relay, "https://r.example/pair#token=FIXTURE+TOKEN%2F1"),
                (
                    Via::TailscaleHttps,
                    "https://devbox.tail0000ab.ts.net/pair#token=FIXTURE+TOKEN%2F1"
                ),
                (Via::Lan, i.url.as_str()),
            ]
        );
    }

    #[test]
    fn tailscale_alone_serves_a_server_that_only_answers_on_this_computer() {
        let i = issued("http://127.0.0.1:3773/pair#token=x");
        let got = choose(&i, None, None, Some(TS)).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].via, Via::TailscaleHttps);
        // A relay the app switched off does not hide it.
        let got = choose(&i, Some("https://r.example"), Some(false), Some(TS)).unwrap();
        assert_eq!(got[0].via, Via::TailscaleHttps);
    }

    #[test]
    fn an_address_the_server_printed_is_named_by_what_it_is_and_never_listed_twice() {
        let ip = issued("http://100.101.102.103:3773/pair#token=x");
        assert_eq!(
            choose(&ip, None, None, None).unwrap()[0].via,
            Via::TailscaleIp
        );
        let https = issued("https://devbox.tail0000ab.ts.net/pair#token=x");
        assert_eq!(
            choose(&https, None, None, None).unwrap()[0].via,
            Via::TailscaleHttps
        );
        assert_eq!(choose(&https, None, None, Some(TS)).unwrap().len(), 1);
        assert!(!is_tailscale_ipv4("100.128.0.1"));
        assert!(!is_tailscale_ipv4("100.63.0.1"));
        assert!(!is_tailscale_ipv4("192.168.1.5"));
    }

    #[test]
    fn the_routes_are_listed_with_the_shown_one_in_brackets_and_tab_wraps_around() {
        let all = [Via::Relay, Via::TailscaleHttps, Via::Lan];
        assert_eq!(
            routes_line(&all, 1),
            "Cloudflare relay  [Tailscale HTTPS]  Local network"
        );
        assert_eq!(routes_line(&all[..1], 0), "");
        assert_eq!(step(2, 3, false), 0);
        assert_eq!(step(0, 3, true), 2);
        assert_eq!(step(0, 3, false), 1);
    }

    #[test]
    fn the_exposure_mode_is_read_from_the_desktop_settings() {
        assert_eq!(
            network_accessible(r#"{"serverExposureMode":"network-accessible"}"#),
            Some(true)
        );
        assert_eq!(
            network_accessible(r#"{"serverExposureMode":"local-only"}"#),
            Some(false)
        );
        assert_eq!(network_accessible("{}"), None);
    }

    #[test]
    fn the_code_is_a_square_of_half_blocks_inside_a_quiet_zone() {
        let rows = qr_rows("https://r.example/pair#token=FIXTURE").unwrap();
        let width = rows[0].chars().count();
        assert!(rows.iter().all(|r| r.chars().count() == width));
        assert!(width >= 21 + 2 * QUIET_ZONE);
        assert_eq!(rows.len(), width.div_ceil(2));
        // The quiet zone is light on every side.
        assert!(rows[0].chars().all(|c| c == ' '));
        assert!(
            rows.iter()
                .all(|r| r.starts_with("  ") && r.ends_with("  "))
        );
        // The first module row inside the zone holds the finder patterns.
        assert!(rows[QUIET_ZONE / 2].contains('▄') || rows[QUIET_ZONE / 2].contains('█'));
    }

    #[test]
    fn the_same_text_gives_the_same_code_and_other_text_another() {
        let a = qr_rows("https://r.example/pair#token=A").unwrap();
        assert_eq!(a, qr_rows("https://r.example/pair#token=A").unwrap());
        assert_ne!(a, qr_rows("https://r.example/pair#token=B").unwrap());
    }

    #[test]
    fn a_link_beyond_any_code_is_refused() {
        assert!(qr_rows(&"x".repeat(5000)).is_err());
    }
}
