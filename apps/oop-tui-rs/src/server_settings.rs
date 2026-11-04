//! Reads and changes the server's settings (`server.getSettings`, `server.updateSettings`), the
//! way the former TypeScript terminal's settings patch did. A patch that replaces a whole record
//! (`threadGoals`, `crew`) must be built from the newest value, or it undoes a change made a moment
//! ago elsewhere: each patch reads the settings first and is built from what was read, and patches
//! run one at a time, so two quick ones from this app cannot overwrite each other either.

use crate::app::{App, Msg};
use crate::text::sanitize;
use crate::wire::Rpc;
use serde_json::{Value, json};

pub const GET_SETTINGS: &str = "server.getSettings";
pub const UPDATE_SETTINGS: &str = "server.updateSettings";

/// A patch that went through.
#[derive(Debug, Clone)]
pub struct Patched {
    /// The settings as they were just before the patch; what a message about the change may quote.
    pub before: Value,
    pub after: Value,
    /// False when the builder had nothing to change and nothing was sent.
    pub changed: bool,
}

/// One line, safe to print.
fn one_line(message: &str) -> String {
    sanitize(message)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string()
}

fn lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Reads the newest settings, builds a patch from them (`None`: nothing to change), sends it, and
/// hands the outcome to `done` on the app. The answer is folded into `app.config` first, so the
/// screen (the crew line, the goal bar) shows the change at once, before the server announces it.
pub fn patch<B, D>(app: &mut App, build: B, done: D)
where
    B: FnOnce(&Value) -> Option<Value> + Send + 'static,
    D: FnOnce(&mut App, Result<Patched, String>) + Send + 'static,
{
    let Some(rpc) = app.rpc.clone() else {
        done(app, Err(crate::i18n::tr("notice.offline").to_string()));
        return;
    };
    let tx = app.sender();
    tokio::spawn(async move {
        let outcome = run(&rpc, build).await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| {
            if let Ok(patched) = &outcome
                && patched.changed
            {
                let event =
                    json!({"type": "settingsUpdated", "payload": {"settings": patched.after}});
                app.apply_config_event(&event);
            }
            done(app, outcome);
        })));
    });
}

async fn run(rpc: &Rpc, build: impl FnOnce(&Value) -> Option<Value>) -> Result<Patched, String> {
    let _turn = lock().lock().await;
    let before = rpc
        .call(GET_SETTINGS, json!({}))
        .await
        .map_err(|e| one_line(&e))?;
    let Some(patch) = build(&before) else {
        return Ok(Patched {
            after: before.clone(),
            before,
            changed: false,
        });
    };
    let after = rpc
        .call(UPDATE_SETTINGS, json!({"patch": patch}))
        .await
        .map_err(|e| one_line(&e))?;
    Ok(Patched {
        before,
        after,
        changed: true,
    })
}

/// A fake server for tests: it keeps settings, answers `server.getSettings` and
/// `server.updateSettings` (a patch replaces whole top-level keys, as the real one does for the
/// records patched here), tells every `subscribeServerConfig` stream about each change, and
/// records every call it was given. Anything else is answered with an empty success.
#[cfg(test)]
pub mod fake {
    use super::{GET_SETTINGS, UPDATE_SETTINGS};
    use crate::app::{App, Msg};
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;
    use tokio::sync::{broadcast, mpsc::UnboundedReceiver};
    use tokio_tungstenite::tungstenite::Message;

    pub struct Fake {
        pub url: String,
        pub settings: Arc<Mutex<Value>>,
        pub calls: Arc<Mutex<Vec<(String, Value)>>>,
        pub events: broadcast::Sender<Value>,
        pub providers: Value,
    }

    impl Fake {
        pub fn called(&self, tag: &str) -> Vec<Value> {
            let calls = self.calls.lock().unwrap();
            calls
                .iter()
                .filter(|(t, _)| t == tag)
                .map(|(_, p)| p.clone())
                .collect()
        }
    }

    pub async fn start(initial: Value) -> Fake {
        start_with(initial, json!([])).await
    }

    /// `providers` are what the config snapshot lists, for the crew's model lists.
    pub async fn start_with(initial: Value, providers: Value) -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let settings = Arc::new(Mutex::new(initial));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (events, _) = broadcast::channel(64);
        let (s, c, e) = (settings.clone(), calls.clone(), events.clone());
        let listed = providers.clone();
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let (s, c, e) = (s.clone(), c.clone(), e.clone());
                let listed = listed.clone();
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                    let mut config_streams: Vec<Value> = Vec::new();
                    let mut news = e.subscribe();
                    loop {
                        tokio::select! {
                            event = news.recv() => {
                                let Ok(event) = event else { continue };
                                for id in &config_streams {
                                    let chunk = json!({"_tag": "Chunk", "requestId": id, "values": [event]});
                                    if ws.send(Message::text(chunk.to_string())).await.is_err() {
                                        return;
                                    }
                                }
                            }
                            frame = ws.next() => {
                                let Some(Ok(Message::Text(text))) = frame else { return };
                                let m: Value = serde_json::from_str(text.as_str()).unwrap();
                                if m["_tag"] != "Request" {
                                    continue;
                                }
                                let tag = m["tag"].as_str().unwrap_or_default().to_string();
                                let payload = m["payload"].clone();
                                c.lock().unwrap().push((tag.clone(), payload.clone()));
                                let done = |value: Value| json!({"_tag": "Exit", "requestId": m["id"],
                                    "exit": {"_tag": "Success", "value": value}});
                                let reply = match tag.as_str() {
                                    GET_SETTINGS => Some(done(s.lock().unwrap().clone())),
                                    UPDATE_SETTINGS => {
                                        let now = {
                                            let mut settings = s.lock().unwrap();
                                            for (key, value) in payload["patch"].as_object().cloned().unwrap_or_default() {
                                                settings[key] = value;
                                            }
                                            settings.clone()
                                        };
                                        let _ = e.send(json!({"type": "settingsUpdated", "payload": {"settings": now}}));
                                        Some(done(now))
                                    }
                                    "subscribeServerConfig" => {
                                        let snapshot = json!({"type": "snapshot", "config": {"settings": s.lock().unwrap().clone(), "providers": listed}});
                                        let chunk = json!({"_tag": "Chunk", "requestId": m["id"], "values": [snapshot]});
                                        ws.send(Message::text(chunk.to_string())).await.unwrap();
                                        config_streams.push(m["id"].clone());
                                        None
                                    }
                                    "never.answered" => None,
                                    _ => Some(done(Value::Null)),
                                };
                                if let Some(reply) = reply {
                                    ws.send(Message::text(reply.to_string())).await.unwrap();
                                }
                            }
                        }
                    }
                });
            }
        });
        Fake {
            url: format!("ws://127.0.0.1:{port}/ws"),
            settings,
            calls,
            events,
            providers,
        }
    }

    /// An app connected to the fake, as `Msg::Connected` leaves it, with the receiver the app's
    /// background work answers on.
    pub async fn connected(fake: &Fake) -> (App, UnboundedReceiver<Msg>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp/oop-rs/work/demo", "/tmp", tx);
        app.last_model_path = std::env::temp_dir().join(format!(
            "oop-rs-none-{}/last-model.json",
            std::process::id()
        ));
        let rpc = crate::wire::Rpc::connect(&fake.url).await.unwrap();
        let config =
            json!({"settings": fake.settings.lock().unwrap().clone(), "providers": fake.providers});
        app.handle(Msg::Connected {
            rpc,
            config,
            server: "fake".into(),
            origin: String::new(),
            bearer: String::new(),
        });
        (app, rx)
    }

    /// Handles what the app's background work sends until `done` holds (five seconds at most).
    pub async fn pump(app: &mut App, rx: &mut UnboundedReceiver<Msg>, done: impl Fn(&App) -> bool) {
        let end = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while !done(app) {
            let msg = tokio::time::timeout_at(end, rx.recv())
                .await
                .expect("the condition came true in time")
                .expect("the app is alive");
            app.handle(msg);
        }
    }
}
