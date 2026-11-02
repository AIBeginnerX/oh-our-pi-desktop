//! Keeps one WebSocket session alive: find or start the server, get a bearer token, open the
//! socket, read the config, and when the socket ends, try again after a backoff (500 ms doubling
//! to 10 s, spread by up to +-20 %, as apps/oop-tui/src/link/client.ts does).

use crate::app::{CONFIG_RPC, LinkStatus, Msg};
use crate::server::{self, Found};
use crate::wire::Rpc;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

pub struct Session {
    pub rpc: Rpc,
    pub config: Value,
    pub found: Found,
    /// The login the socket was opened with, for the few requests that go over plain HTTP.
    pub bearer: String,
}

/// A session shorter than this counts as a failed attempt, so a server that drops us at once is
/// not hammered.
const STABLE_SESSION: Duration = Duration::from_secs(10);

pub fn backoff(attempt: u32, jitter: f64) -> Duration {
    let base = (500u64 << attempt.saturating_sub(1).min(5)).min(10_000);
    Duration::from_millis((base as f64 * (0.8 + 0.4 * jitter)).round() as u64)
}

pub async fn connect_once(
    home: &std::path::Path,
    isolated: bool,
    server: Option<&str>,
    version: &str,
    progress: impl Fn(&str) + Copy,
) -> Result<Session, String> {
    let found = server::resolve(home, isolated, server, progress).await?;
    let bearer = server::bearer_for(&found, home, progress).await?;
    let url = server::websocket_url(&found, &bearer, version).await?;
    let rpc = Rpc::connect(&url).await?;
    let config = rpc.call(CONFIG_RPC, json!({})).await?;
    Ok(Session {
        rpc,
        config,
        found,
        bearer,
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

pub async fn supervise(
    home: PathBuf,
    isolated: bool,
    server: Option<String>,
    version: String,
    tx: UnboundedSender<Msg>,
) {
    let mut attempt = 0u32;
    let mut ever_online = false;
    loop {
        let _ = tx.send(Msg::Link(if attempt == 0 {
            LinkStatus::Connecting
        } else {
            LinkStatus::Reconnecting(String::new())
        }));
        let progress = |what: &str| {
            let _ = tx.send(Msg::Link(LinkStatus::Starting(what.to_string())));
        };
        let reason =
            match connect_once(&home, isolated, server.as_deref(), &version, progress).await {
                Ok(session) => {
                    ever_online = true;
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
                    });
                    let reason = session.rpc.closed().await;
                    attempt = if started.elapsed() >= STABLE_SESSION {
                        1
                    } else {
                        attempt + 1
                    };
                    reason
                }
                Err(error) => {
                    // Before the first connection an error means something to fix (no app to start a
                    // server from, a login that cannot be made); retrying would only repeat it.
                    if !ever_online {
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
}
