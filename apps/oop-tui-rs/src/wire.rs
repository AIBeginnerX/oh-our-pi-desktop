//! The Effect RPC wire protocol over one WebSocket, written against the observed framing rather
//! than a copy of the contracts. Each text frame is JSON: a message or an array of messages.
//!
//!   client -> server  {"_tag":"Request","id":"7","tag":"<rpc name>","payload":{..},"headers":[]}
//!                     {"_tag":"Ack","requestId":"7"}  (after every Chunk of a stream)
//!                     {"_tag":"Interrupt","requestId":"7"}  {"_tag":"Ping"}
//!   server -> client  {"_tag":"Chunk","requestId":"7","values":[..]}   (stream items)
//!                     {"_tag":"Exit","requestId":"7","exit":{"_tag":"Success","value":..}}
//!                     {"_tag":"Exit",..,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":..}]}}
//!                     {"_tag":"Pong"}  {"_tag":"Defect",..}
//!
//! Payloads and items stay `serde_json::Value`; callers read only the fields they need.

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

const PING_EVERY: Duration = Duration::from_secs(10);

pub enum StreamMsg {
    Item(Value),
    /// The stream is over: `None` for a clean end, else the server's or the socket's reason.
    End(Option<String>),
}

enum Pending {
    Unary(oneshot::Sender<Result<Value, String>>),
    Stream(mpsc::UnboundedSender<StreamMsg>),
}

struct Inner {
    out: mpsc::UnboundedSender<Message>,
    pending: Mutex<HashMap<String, Pending>>,
    next: AtomicU64,
    closed: watch::Sender<Option<String>>,
}

#[derive(Clone)]
pub struct Rpc {
    inner: Arc<Inner>,
}

/// A live subscription. Dropping it tells the server to stop sending.
pub struct RpcStream {
    pub rx: mpsc::UnboundedReceiver<StreamMsg>,
    id: String,
    rpc: Rpc,
}

impl Drop for RpcStream {
    fn drop(&mut self) {
        let was_open = self
            .rpc
            .inner
            .pending
            .lock()
            .unwrap()
            .remove(&self.id)
            .is_some();
        if was_open {
            let _ = self
                .rpc
                .send(&json!({"_tag": "Interrupt", "requestId": self.id}));
        }
    }
}

impl Rpc {
    pub async fn connect(url: &str) -> Result<Rpc, String> {
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(15),
            tokio_tungstenite::connect_async(url),
        )
        .await
        .map_err(|_| "the WebSocket did not open in time".to_string())?
        .map_err(|e| format!("cannot open the WebSocket: {e}"))?;
        let (mut sink, mut source) = socket.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let (closed, _) = watch::channel(None);
        let rpc = Rpc {
            inner: Arc::new(Inner {
                out,
                pending: Mutex::new(HashMap::new()),
                next: AtomicU64::new(1),
                closed,
            }),
        };

        tokio::spawn(async move {
            while let Some(message) = out_rx.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        let reader = rpc.clone();
        tokio::spawn(async move {
            let mut ping =
                tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
            let reason = loop {
                tokio::select! {
                    _ = ping.tick() => { let _ = reader.send(&json!({"_tag": "Ping"})); }
                    frame = source.next() => match frame {
                        Some(Ok(Message::Text(text))) => reader.handle_frame(text.as_str()),
                        Some(Ok(Message::Close(_))) | None => break "the connection closed".to_string(),
                        Some(Ok(_)) => {}
                        Some(Err(e)) => break format!("the connection failed: {e}"),
                    }
                }
            };
            reader.fail_all(&reason);
        });
        Ok(rpc)
    }

    fn send(&self, message: &Value) -> Result<(), String> {
        self.inner
            .out
            .send(Message::text(message.to_string()))
            .map_err(|_| "the connection is closed".to_string())
    }

    fn next_id(&self) -> String {
        self.inner.next.fetch_add(1, Ordering::Relaxed).to_string()
    }

    /// Resolves with the reason once the socket is gone.
    pub async fn closed(&self) -> String {
        let mut rx = self.inner.closed.subscribe();
        loop {
            if let Some(reason) = rx.borrow_and_update().clone() {
                return reason;
            }
            if rx.changed().await.is_err() {
                return "the connection closed".into();
            }
        }
    }

    /// One request, one answer.
    pub async fn call(&self, tag: &str, payload: Value) -> Result<Value, String> {
        let id = self.next_id();
        let (tx, rx) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .unwrap()
            .insert(id.clone(), Pending::Unary(tx));
        if let Err(e) = self.send(&request(&id, tag, payload)) {
            self.inner.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        rx.await
            .unwrap_or_else(|_| Err("the connection closed".into()))
    }

    /// A request answered by a sequence of items.
    pub fn stream(&self, tag: &str, payload: Value) -> RpcStream {
        let id = self.next_id();
        let (tx, rx) = mpsc::unbounded_channel();
        self.inner
            .pending
            .lock()
            .unwrap()
            .insert(id.clone(), Pending::Stream(tx.clone()));
        if let Err(e) = self.send(&request(&id, tag, payload)) {
            self.inner.pending.lock().unwrap().remove(&id);
            let _ = tx.send(StreamMsg::End(Some(e)));
        }
        RpcStream {
            rx,
            id,
            rpc: self.clone(),
        }
    }

    fn fail_all(&self, reason: &str) {
        let pending: Vec<Pending> = self
            .inner
            .pending
            .lock()
            .unwrap()
            .drain()
            .map(|(_, p)| p)
            .collect();
        for entry in pending {
            match entry {
                Pending::Unary(tx) => {
                    let _ = tx.send(Err(reason.to_string()));
                }
                Pending::Stream(tx) => {
                    let _ = tx.send(StreamMsg::End(Some(reason.to_string())));
                }
            }
        }
        let _ = self.inner.closed.send(Some(reason.to_string()));
    }

    fn handle_frame(&self, text: &str) {
        let Ok(parsed) = serde_json::from_str::<Value>(text) else {
            return;
        };
        match parsed {
            Value::Array(messages) => messages.iter().for_each(|m| self.handle_message(m)),
            message => self.handle_message(&message),
        }
    }

    fn handle_message(&self, message: &Value) {
        let key = message.get("requestId").map(id_text).unwrap_or_default();
        match message.get("_tag").and_then(Value::as_str) {
            Some("Chunk") => {
                let values = message.get("values").and_then(Value::as_array);
                let pending = self.inner.pending.lock().unwrap();
                if let (Some(Pending::Stream(tx)), Some(values)) = (pending.get(&key), values) {
                    for value in values {
                        let _ = tx.send(StreamMsg::Item(value.clone()));
                    }
                    // The server sends the next chunk only after this one is acknowledged.
                    let _ = self.send(&json!({"_tag": "Ack", "requestId": message["requestId"]}));
                }
            }
            Some("Exit") => {
                let Some(entry) = self.inner.pending.lock().unwrap().remove(&key) else {
                    return;
                };
                let exit = &message["exit"];
                let result = if exit.get("_tag").and_then(Value::as_str) == Some("Success") {
                    Ok(exit.get("value").cloned().unwrap_or(Value::Null))
                } else {
                    Err(describe_cause(exit.get("cause")))
                };
                match entry {
                    Pending::Unary(tx) => {
                        let _ = tx.send(result);
                    }
                    Pending::Stream(tx) => {
                        let _ = tx.send(StreamMsg::End(result.err()));
                    }
                }
            }
            Some("Ping") => {
                let _ = self.send(&json!({"_tag": "Pong"}));
            }
            Some("Defect") | Some("ClientProtocolError") => {
                self.fail_all(&format!("protocol error: {message}"));
            }
            _ => {}
        }
    }
}

fn request(id: &str, tag: &str, payload: Value) -> Value {
    json!({"_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": []})
}

fn id_text(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// The readable reason inside an encoded failure cause: a typed error's `message`, else its tag,
/// else the defect.
pub fn describe_cause(cause: Option<&Value>) -> String {
    let Some(entries) = cause.and_then(Value::as_array) else {
        return "the server refused the request".into();
    };
    for entry in entries {
        match entry.get("_tag").and_then(Value::as_str) {
            Some("Fail") => {
                let error = &entry["error"];
                if let Some(text) = error.as_str() {
                    return text.to_string();
                }
                if let Some(text) = error
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                {
                    return text.to_string();
                }
                if let Some(tag) = error.get("_tag").and_then(Value::as_str) {
                    return tag.to_string();
                }
            }
            Some("Die") => return format!("server fault: {}", entry["defect"]),
            _ => {}
        }
    }
    "the request was interrupted".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn failure_causes_read_as_messages() {
        let cause = json!([{"_tag": "Fail", "error": {"_tag": "OrchestrationDispatchCommandError", "message": "nope"}}]);
        assert_eq!(describe_cause(Some(&cause)), "nope");
        let tag_only = json!([{"_tag": "Fail", "error": {"_tag": "ServerSettingsError"}}]);
        assert_eq!(describe_cause(Some(&tag_only)), "ServerSettingsError");
    }

    /// A fake server speaking the observed protocol: it answers a stream request with two chunks
    /// (the second only after the first is acknowledged) and a clean exit, and a unary call with
    /// a typed failure. Proves streaming, acking and error mapping without a provider.
    #[tokio::test]
    async fn streams_chunks_with_acks_and_maps_failures() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let m: Value = serde_json::from_str(text.as_str()).unwrap();
                if m["_tag"] != "Request" {
                    continue;
                }
                let id = m["id"].clone();
                if m["tag"] == "stream.me" {
                    let chunk = |v: Value| {
                        json!({"_tag": "Chunk", "requestId": id, "values": [v]}).to_string()
                    };
                    ws.send(Message::text(chunk(json!({"delta": "안"}))))
                        .await
                        .unwrap();
                    // Wait for the Ack before the next chunk, as the real server does.
                    let ack = ws.next().await.unwrap().unwrap().into_text().unwrap();
                    assert!(ack.as_str().contains("\"Ack\""), "{ack}");
                    ws.send(Message::text(chunk(json!({"delta": "녕"}))))
                        .await
                        .unwrap();
                    ws.send(Message::text(json!({"_tag": "Exit", "requestId": id, "exit": {"_tag": "Success", "value": null}}).to_string())).await.unwrap();
                } else {
                    let fail = json!([{"_tag": "Exit", "requestId": id, "exit": {"_tag": "Failure",
                        "cause": [{"_tag": "Fail", "error": {"_tag": "OrchestrationDispatchCommandError", "message": "no provider"}}]}}]);
                    ws.send(Message::text(fail.to_string())).await.unwrap();
                }
            }
        });
        let rpc = Rpc::connect(&format!("ws://127.0.0.1:{port}/ws"))
            .await
            .unwrap();
        let mut stream = rpc.stream("stream.me", json!({}));
        let mut text = String::new();
        let mut ended = false;
        while let Some(msg) = stream.rx.recv().await {
            match msg {
                StreamMsg::Item(v) => text.push_str(v["delta"].as_str().unwrap()),
                StreamMsg::End(reason) => {
                    assert!(reason.is_none());
                    ended = true;
                    break;
                }
            }
        }
        assert!(ended);
        assert_eq!(text, "안녕");
        assert_eq!(
            rpc.call("do.it", json!({})).await.unwrap_err(),
            "no provider"
        );
    }
}
