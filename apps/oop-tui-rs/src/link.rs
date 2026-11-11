//! Keeps one WebSocket session alive: find or start the server, get a bearer token, open the
//! socket, read the config, and when the socket ends, try again after a backoff (500 ms doubling
//! to 10 s, spread by up to +-20 %, as the former TypeScript terminal's link client did). The
//! session talks to one computer at a time: this one, or — through the host's gateway — another
//! the running desktop app shares (`Target`).

use crate::app::{App, CONFIG_RPC, LinkStatus, Msg};
use crate::server::{self, Found};
use crate::wire::Rpc;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

/// Another computer the host's gateway can reach, as the picker names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub environment_id: String,
    pub label: String,
}

/// Which computer the one session talks to. This one is the default at every start and the choice
/// is never saved; a host that was gone brings the terminal back here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    This,
    Gateway(Remote),
}

pub struct Session {
    pub rpc: Rpc,
    pub config: Value,
    pub found: Found,
    /// The login the socket was opened with, for the few requests that go over plain HTTP.
    pub bearer: String,
    /// The gateway computer this session talks to; `None` for this computer.
    pub remote: Option<Remote>,
    /// Said when a gateway computer was asked for but had to be left: the session that came back
    /// is this computer's, and the reason goes to the user once.
    pub fallback: Option<String>,
}

/// What one session will be opened on: the socket address, the computer it belongs to, and the
/// fallback a gateway computer that refused it left behind.
#[derive(Debug)]
pub struct SessionPlan {
    pub url: String,
    pub remote: Option<Remote>,
    pub fallback: Option<String>,
}

/// The socket address for `target`: this computer's, or the gateway path of the chosen computer.
/// A gateway computer that says it cannot be used (the host stopped sharing it, cannot reach it,
/// or refused the login) is not retried: the plan falls back to this computer and carries the
/// reason.
pub async fn session_plan(
    found: &Found,
    bearer: &str,
    version: &str,
    target: &Target,
) -> Result<SessionPlan, String> {
    match target {
        Target::This => Ok(SessionPlan {
            url: server::websocket_url(found, bearer, version).await?,
            remote: None,
            fallback: None,
        }),
        Target::Gateway(remote) => {
            match server::gateway_websocket_url(found, bearer, remote, version).await {
                Ok(url) => Ok(SessionPlan {
                    url,
                    remote: Some(remote.clone()),
                    fallback: None,
                }),
                Err(server::GatewayFail::Final(why)) => Ok(SessionPlan {
                    url: server::websocket_url(found, bearer, version).await?,
                    remote: None,
                    fallback: Some(why),
                }),
                Err(server::GatewayFail::Retry(why)) => Err(why),
            }
        }
    }
}

/// A session shorter than this counts as a failed attempt, so a server that drops us at once is
/// not hammered.
const STABLE_SESSION: Duration = Duration::from_secs(10);

/// How long a server may stay gone before this terminal starts its own; the app may be restarting
/// and would kill it at once (`OWN_SERVER_GRACE_MS` of the former TypeScript terminal).
const OWN_SERVER_GRACE: Duration = Duration::from_secs(5);

pub fn backoff(attempt: u32, jitter: f64) -> Duration {
    let base = (500u64 << attempt.saturating_sub(1).min(5)).min(10_000);
    Duration::from_millis((base as f64 * (0.8 + 0.4 * jitter)).round() as u64)
}

/// Whether a server of this terminal's own may be started, given when a server was first missed
/// (`None` while one is there) and the time now. Only after the grace, so a restarting app is not
/// raced; `gone_since` is reset whenever a server is found.
pub fn own_server_may_start(gone_since: Option<Instant>, now: Instant, grace: Duration) -> bool {
    gone_since.is_some_and(|since| now.saturating_duration_since(since) >= grace)
}

/// The grace as one attempt leaves it: a server that was found clears the miss even when the
/// bearer token or the socket then failed, as `reverifiedOrigin` clears `goneSince` for any
/// discovery that is not down, as the former TypeScript terminal did; an absence that goes on
/// keeps the time it started.
pub fn grace_after(found: bool, gone_since: Option<Instant>, now: Instant) -> Option<Instant> {
    if found {
        None
    } else {
        Some(gone_since.unwrap_or(now))
    }
}

/// Why a connection failed, and whether a server was found before the step that failed: a server
/// that is there but cannot be used is still not an absence, so the grace starts over.
pub struct ConnectFailure {
    pub reason: String,
    pub found: bool,
}

pub async fn connect_once(
    home: &std::path::Path,
    isolated: bool,
    server: Option<&str>,
    version: &str,
    progress: impl Fn(&str) + Copy,
) -> Result<Session, String> {
    connect_once_with(home, isolated, server, version, true, progress)
        .await
        .map_err(|failure| one_shot_reason(failure.reason))
}

/// What a command that connects once says when a failure the reconnect loop would wait out is
/// final here: this process exits, so "waiting for it" would be untrue. Only the update marker
/// differs; it is `link.err.appUpdating` of the former TypeScript terminal.
pub fn one_shot_reason(reason: String) -> String {
    if reason == server::WAITING_FOR_UPDATE {
        crate::i18n::tr("link.appUpdating").to_string()
    } else {
        reason
    }
}

/// `connect_once` with the start of a server of this terminal's own allowed or held back
/// (`may_start_own`); `false` while the app may be restarting or installing an update.
pub async fn connect_once_with(
    home: &std::path::Path,
    isolated: bool,
    server: Option<&str>,
    version: &str,
    may_start_own: bool,
    progress: impl Fn(&str) + Copy,
) -> Result<Session, ConnectFailure> {
    connect_once_expecting(
        home,
        isolated,
        server,
        version,
        may_start_own,
        None,
        &Target::This,
        progress,
    )
    .await
}

/// `connect_once_with` for a reconnection to a server that was found by discovery (`expect`): the
/// app may have restarted on another port, so it is looked up again, and the saved token goes only
/// to the same environment at an address that token is valid for (`reverifiedOrigin` in
/// resolveServer.ts). A different server is a transient failure with nothing sent, and no token is
/// minted for it. Without `expect`, or with an address given by `--server`, it is `resolve`.
#[allow(clippy::too_many_arguments)]
pub async fn connect_once_expecting(
    home: &std::path::Path,
    isolated: bool,
    server: Option<&str>,
    version: &str,
    may_start_own: bool,
    expect: Option<&Found>,
    target: &Target,
    progress: impl Fn(&str) + Copy,
) -> Result<Session, ConnectFailure> {
    let known = expect.filter(|known| {
        server.is_none() && known.pid != 0 && server::is_loopback_origin(&known.origin)
    });
    let located = match known {
        Some(known) => server::relocate(home, isolated, may_start_own, known, progress)
            .await
            .map_err(|unlocated| ConnectFailure {
                reason: unlocated.reason,
                found: unlocated.found,
            }),
        None => server::resolve(home, isolated, server, may_start_own, progress)
            .await
            .map_err(|reason| ConnectFailure {
                reason,
                found: false,
            }),
    };
    let found = located?;
    let failed = |reason: String| ConnectFailure {
        reason,
        found: true,
    };
    let bearer = server::bearer_for(&found, home, progress)
        .await
        .map_err(failed)?;
    let plan = session_plan(&found, &bearer, version, target)
        .await
        .map_err(failed)?;
    let rpc = Rpc::connect(&plan.url).await.map_err(failed)?;
    let config = rpc.call(CONFIG_RPC, json!({})).await.map_err(failed)?;
    Ok(Session {
        rpc,
        config,
        found,
        bearer,
        remote: plan.remote,
        fallback: plan.fallback,
    })
}

fn jitter() -> f64 {
    // Only spreads reconnects; the clock's sub-second part is random enough.
    f64::from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos())
            % 1000,
    ) / 1000.0
}

/// Runs the reconnect loop for the whole session. The computer it talks to is `target`, changed
/// by the picker; a change (`switch`) drops the live session and reconnects at once. One socket is
/// open at a time. When the host itself is gone, the target returns to this computer, so the
/// host's own reconnect behaviour carries on here; a gateway computer that says it cannot be used
/// is left with a note and not retried either.
pub async fn supervise(
    home: PathBuf,
    isolated: bool,
    server: Option<String>,
    version: String,
    tx: UnboundedSender<Msg>,
    target: tokio::sync::watch::Sender<Target>,
    switch: std::sync::Arc<tokio::sync::Notify>,
) {
    let watched = target.subscribe();
    let mut attempt = 0u32;
    let mut ever_online = false;
    // When a server was first missed since one was last found; cleared whenever one is found, so
    // the grace measures one absence, not the whole session.
    let mut gone_since: Option<Instant> = None;
    // The server the last session ran on: a reconnection is verified against it.
    let mut last_found: Option<Found> = None;
    loop {
        let now = watched.borrow().clone();
        let _ = tx.send(Msg::Link(if attempt == 0 {
            LinkStatus::Connecting
        } else {
            LinkStatus::Reconnecting(String::new())
        }));
        let progress = |what: &str| {
            let _ = tx.send(Msg::Link(LinkStatus::Starting(what.to_string())));
        };
        // The first connection may start a server at once; after one was online, the app gets its
        // grace first: it may only be restarting, and it would kill a server started now.
        let may_start_own =
            !ever_online || own_server_may_start(gone_since, Instant::now(), OWN_SERVER_GRACE);
        let reason = match connect_once_expecting(
            &home,
            isolated,
            server.as_deref(),
            &version,
            may_start_own,
            last_found.as_ref(),
            &now,
            progress,
        )
        .await
        {
            Ok(session) => {
                ever_online = true;
                last_found = Some(session.found.clone());
                gone_since = grace_after(true, gone_since, Instant::now());
                let started = Instant::now();
                let server = session
                    .found
                    .origin
                    .trim_start_matches("https://")
                    .trim_start_matches("http://")
                    .to_string();
                let _ = tx.send(Msg::Connected {
                    rpc: session.rpc.clone(),
                    config: session.config,
                    server,
                    origin: session.found.origin.clone(),
                    bearer: session.bearer.clone(),
                    label: session.found.label.clone(),
                    remote: session.remote.clone(),
                });
                // A gateway computer that had to be left has already said why; the picker's
                // choice is undone, so the next reconnection opens this computer again.
                if let Some(why) = session.fallback.clone() {
                    let _ = target.send(Target::This);
                    let _ = tx.send(Msg::Ext(Box::new(move |app: &mut App| {
                        app.notice = Some(why);
                    })));
                }
                {
                    // The wait borrows the session, so it ends before the loop dials again: the
                    // socket closes when the session drops at the end of the round.
                    let closed = session.rpc.closed();
                    tokio::pin!(closed);
                    tokio::select! {
                        reason = closed.as_mut() => {
                            attempt = if started.elapsed() >= STABLE_SESSION {
                                1
                            } else {
                                attempt + 1
                            };
                            reason
                        }
                        // The picker chose another computer: the session goes, and the loop
                        // dials the new one from the start.
                        _ = switch.notified() => {
                            attempt = 0;
                            String::new()
                        }
                    }
                }
            }
            Err(failure) => {
                // A server that was found clears the miss even though the connection failed: the
                // app is there, so the next absence starts its grace from the start.
                gone_since = grace_after(failure.found, gone_since, Instant::now());
                let error = failure.reason;
                // The host itself is gone: today's reconnect behaviour takes over, on this
                // computer. What the gateway listed comes back only when it is picked again.
                if !failure.found && watched.borrow().clone() != Target::This {
                    let _ = target.send(Target::This);
                }
                // Before the first connection an error means something to fix (no app to start a
                // server from, a login that cannot be made); retrying would only repeat it. An
                // app installing an update is the exception: waiting is the fix, and the app's
                // server is found when it comes back.
                if !ever_online && error != server::WAITING_FOR_UPDATE {
                    let _ = tx.send(Msg::Link(LinkStatus::Failed(error)));
                    return;
                }
                attempt += 1;
                error
            }
        };
        let wait = backoff(attempt, jitter());
        let _ = tx.send(Msg::Link(LinkStatus::Reconnecting(format!(
            "{reason}; retrying in {}s",
            wait.as_secs().max(1)
        ))));
        tokio::time::sleep(wait).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_a_cap_and_is_spread() {
        assert_eq!(backoff(1, 0.5), Duration::from_millis(500));
        assert_eq!(backoff(2, 0.5), Duration::from_millis(1000));
        assert_eq!(backoff(9, 0.5), Duration::from_millis(10_000));
        assert_eq!(backoff(1, 0.0), Duration::from_millis(400));
        assert_eq!(backoff(1, 1.0), Duration::from_millis(600));
    }

    #[test]
    fn the_grace_is_five_seconds_from_the_first_missed_server() {
        assert_eq!(OWN_SERVER_GRACE, Duration::from_secs(5));
    }

    #[test]
    fn a_server_of_our_own_is_started_only_after_the_grace() {
        let gone = Instant::now();
        let at = |ms: u64| gone + Duration::from_millis(ms);
        // While one is there (`None`) nothing of ours is started.
        assert!(!own_server_may_start(None, gone, OWN_SERVER_GRACE));
        assert!(!own_server_may_start(Some(gone), gone, OWN_SERVER_GRACE));
        assert!(!own_server_may_start(
            Some(gone),
            at(4_900),
            OWN_SERVER_GRACE
        ));
        assert!(own_server_may_start(
            Some(gone),
            at(5_000),
            OWN_SERVER_GRACE
        ));
        assert!(own_server_may_start(
            Some(gone),
            at(30_000),
            OWN_SERVER_GRACE
        ));
    }

    #[test]
    fn finding_a_server_again_resets_the_grace() {
        // The loop clears `gone_since` whenever a server is found; the next absence starts over.
        let first = Instant::now();
        assert!(own_server_may_start(
            Some(first),
            first + OWN_SERVER_GRACE,
            OWN_SERVER_GRACE
        ));
        let found_again = first + Duration::from_secs(4);
        let second = found_again + Duration::from_millis(100);
        assert!(!own_server_may_start(
            Some(second),
            found_again + Duration::from_secs(4),
            OWN_SERVER_GRACE
        ));
        assert!(own_server_may_start(
            Some(second),
            second + OWN_SERVER_GRACE,
            OWN_SERVER_GRACE
        ));
    }

    #[test]
    fn a_server_found_but_not_connectable_still_resets_the_grace() {
        // The app answered discovery and only the bearer or socket step failed: `goneSince` is
        // cleared there too (resolveServer.ts), so the next absence gets its whole grace again.
        let missed = Instant::now();
        let failed_at = missed + Duration::from_secs(1);
        let after_failure = grace_after(true, Some(missed), failed_at);
        assert_eq!(after_failure, None);
        // The absence that follows starts now, not at the first miss.
        let next_miss = failed_at + Duration::from_millis(50);
        let gone = grace_after(false, after_failure, next_miss);
        assert_eq!(gone, Some(next_miss));
        assert!(!own_server_may_start(
            gone,
            missed + OWN_SERVER_GRACE,
            OWN_SERVER_GRACE
        ));
        // An absence that goes on keeps its first time rather than starting over.
        assert_eq!(
            grace_after(false, Some(missed), failed_at),
            Some(missed),
            "a miss is not moved forward by later misses"
        );
        // Before any server was found, a failure is the first miss, and no server was found.
        assert_eq!(grace_after(false, None, missed), Some(missed));
    }

    #[tokio::test]
    async fn a_resolve_that_finds_nothing_reports_no_server_found() {
        // The flag is what tells the loop which side of the grace bookkeeping a failure is on.
        let home = std::env::temp_dir().join(format!("oop-rs-link-{}", crate::text::new_id()));
        std::fs::create_dir_all(&home).unwrap();
        let failure = connect_once_with(&home, false, None, "0.0.0", false, |_| {})
            .await
            .err()
            .expect("nothing answers in an empty home");
        assert!(!failure.found, "{}", failure.reason);
        assert_eq!(
            failure.reason,
            server::discover(&home).await.detail(),
            "nothing is announced, so the reason is what discovery says"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_command_that_connects_once_does_not_say_it_is_waiting() {
        // `oop-rs status` exits on this failure, so it says what to do instead of "waiting for it";
        // the reconnect loop keeps its own wording (`link.appUpdating`'s text is checked in i18n).
        crate::i18n::init(Some("en"));
        let one_shot = one_shot_reason(server::WAITING_FOR_UPDATE.to_string());
        assert_eq!(one_shot, crate::i18n::tr("link.appUpdating"));
        assert_ne!(one_shot, server::WAITING_FOR_UPDATE);
        // Any other failure is passed on as it is.
        assert_eq!(
            one_shot_reason("nothing answers at http://127.0.0.1:1".into()),
            "nothing answers at http://127.0.0.1:1"
        );
    }

    // ---- the plan of a session on another computer -----------------------------------------

    use std::sync::{Arc, Mutex};

    /// An HTTP server that answers by request path and keeps the request heads it saw.
    async fn path_server(
        answer: impl Fn(&str) -> (u16, String) + Send + 'static,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let keep = seen.clone();
        tokio::spawn(async move {
            // One connection per request (`Connection: close`); a session plan that falls back
            // asks twice.
            loop {
                let Ok((mut tcp, _)) = listener.accept().await else {
                    return;
                };
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut raw = Vec::new();
                let mut buf = [0u8; 2048];
                while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    let read = match tcp.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => read,
                    };
                    raw.extend_from_slice(&buf[..read]);
                }
                if raw.is_empty() {
                    return;
                }
                let head = String::from_utf8_lossy(&raw).to_string();
                let path = head
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or_default()
                    .to_string();
                keep.lock().unwrap().push(head);
                let (status, body) = answer(&path);
                let words = match status {
                    200 => "OK",
                    401 => "Unauthorized",
                    404 => "Not Found",
                    500 => "Server Error",
                    _ => "Bad Gateway",
                };
                let _ = tcp
                    .write_all(
                        format!(
                            "HTTP/1.1 {status} {words}\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await;
            }
        });
        (format!("http://127.0.0.1:{port}"), seen)
    }

    fn found_at(origin: &str) -> Found {
        Found {
            pid: 1,
            origin: origin.into(),
            environment_id: "host".into(),
            label: "Mac".into(),
            daemon: false,
        }
    }

    fn remote(id: &str) -> Target {
        Target::Gateway(Remote {
            environment_id: id.into(),
            label: "ai-server".into(),
        })
    }

    /// The path the gateway forwards to the computer: the descriptor that says which computer
    /// answers, asked before the ticket because the host answers a ticket by itself.
    const DESCRIPTOR_TAIL: &str = "/.well-known/t3/environment";
    const TICKET_TAIL: &str = "/api/auth/websocket-ticket";

    #[tokio::test]
    async fn the_gateway_session_goes_through_the_gateway_path_with_the_hosts_login() {
        crate::i18n::init(Some("en"));
        let (origin, seen) = path_server(|path| {
            if path.ends_with(DESCRIPTOR_TAIL) {
                (200, r#"{"environmentId":"env id/1"}"#.into())
            } else {
                assert!(path.ends_with(TICKET_TAIL), "{path}");
                (200, r#"{"ticket":"t k/1"}"#.into())
            }
        })
        .await;
        let found = found_at(&origin);
        let plan = session_plan(&found, "b", "9.9", &remote("env id/1"))
            .await
            .expect("the gateway answered");
        assert!(plan.fallback.is_none());
        assert_eq!(plan.remote.as_ref().unwrap().label, "ai-server");
        let authority = crate::http::authority(&origin).unwrap();
        assert_eq!(
            plan.url,
            format!(
                "ws://{authority}/_gw/env%20id%2F1/ws?wsTicket=t+k%2F1&clientSurface=cli&clientAppVersion=9.9&clientDeviceType=desktop&clientOs={}&connectionMethod=direct&orchestrationProtocol=1",
                server::client_os()
            )
        );
        let heads = seen.lock().unwrap().clone();
        assert_eq!(heads.len(), 2, "{heads:?}");
        assert!(
            heads[0].starts_with("GET /_gw/env%20id%2F1/.well-known/t3/environment "),
            "the descriptor is asked first: {}",
            heads[0]
        );
        assert!(
            heads[1].starts_with("POST /_gw/env%20id%2F1/api/auth/websocket-ticket "),
            "{}",
            heads[1]
        );
        for head in &heads {
            assert!(head.contains("Authorization: Bearer b"), "{head}");
        }
    }

    #[tokio::test]
    async fn a_gateway_computer_that_cannot_be_used_falls_back_to_this_one_and_says_why() {
        crate::i18n::init(Some("en"));
        for (status, word) in [
            (404u16, "not shared"),
            (502, "cannot be reached"),
            (401, "sign-in"),
        ] {
            let (origin, seen) = path_server(move |path| {
                if path.ends_with(DESCRIPTOR_TAIL) {
                    (status, String::new())
                } else {
                    (200, r#"{"ticket":"ok"}"#.into())
                }
            })
            .await;
            let found = found_at(&origin);
            let plan = session_plan(&found, "b", "1", &remote("e"))
                .await
                .expect("the host session stands in");
            assert!(plan.remote.is_none(), "{status}");
            assert!(
                plan.url.contains("/ws?wsTicket=ok"),
                "this computer's socket"
            );
            let why = plan.fallback.expect("{status} says why");
            assert!(why.contains("ai-server") && why.contains(word), "{why}");
            // The descriptor answered for the computer, so no ticket was asked through the
            // gateway: the fallback went straight to this computer's own ticket.
            let heads = seen.lock().unwrap().clone();
            assert!(
                !heads
                    .iter()
                    .any(|head| head.contains(&format!("/_gw/e{TICKET_TAIL} "))),
                "{status}: {heads:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_descriptor_the_gateway_cannot_reach_falls_back_without_asking_for_a_ticket() {
        // A computer that is still listed but unreachable passes the ticket step, because the host
        // answers that itself; only the forwarded descriptor is refused.
        crate::i18n::init(Some("en"));
        let (origin, seen) = path_server(|path| {
            if path.ends_with(DESCRIPTOR_TAIL) {
                (502, String::new())
            } else {
                (200, r#"{"ticket":"ok"}"#.into())
            }
        })
        .await;
        let found = found_at(&origin);
        let plan = session_plan(&found, "b", "1", &remote("e"))
            .await
            .expect("the host session stands in");
        assert!(plan.remote.is_none());
        assert!(plan.url.contains("/ws?wsTicket=ok"), "{}", plan.url);
        let why = plan.fallback.expect("the unreachable computer says why");
        assert!(
            why.contains("ai-server") && why.contains("cannot be reached"),
            "{why}"
        );
        let heads = seen.lock().unwrap().clone();
        assert_eq!(
            heads.len(),
            2,
            "the descriptor and this computer's ticket only: {heads:?}"
        );
        assert!(heads[0].starts_with("GET /_gw/e/.well-known/t3/environment "));
        assert!(heads[1].starts_with("POST /api/auth/websocket-ticket "));
    }

    #[tokio::test]
    async fn a_route_that_leads_to_another_computer_falls_back_and_says_so() {
        crate::i18n::init(Some("en"));
        let (origin, seen) = path_server(|path| {
            if path.ends_with(DESCRIPTOR_TAIL) {
                (200, r#"{"environmentId":"someone-else"}"#.into())
            } else {
                (200, r#"{"ticket":"ok"}"#.into())
            }
        })
        .await;
        let found = found_at(&origin);
        let plan = session_plan(&found, "b", "1", &remote("e"))
            .await
            .expect("the host session stands in");
        assert!(plan.remote.is_none());
        assert!(plan.url.contains("/ws?wsTicket=ok"), "{}", plan.url);
        let why = plan.fallback.expect("the other computer says why");
        assert!(
            why.contains("ai-server") && why.contains("different computer"),
            "{why}"
        );
        let heads = seen.lock().unwrap().clone();
        assert_eq!(heads.len(), 2, "{heads:?}");
        assert!(
            !heads
                .iter()
                .any(|head| head.contains(&format!("/_gw/e{TICKET_TAIL} "))),
            "{heads:?}"
        );
    }

    #[tokio::test]
    async fn an_undecided_gateway_answer_keeps_the_target_for_another_try() {
        crate::i18n::init(Some("en"));
        let (origin, _seen) = path_server(|_| (500, String::new())).await;
        let found = found_at(&origin);
        let error = session_plan(&found, "b", "1", &remote("e"))
            .await
            .expect_err("nothing was decided");
        assert!(error.contains("500"), "{error}");
    }
}
