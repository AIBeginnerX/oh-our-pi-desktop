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
use tokio_rustls::rustls::ClientConfig;
use tokio_tungstenite::Connector;
use tokio_tungstenite::tungstenite::Message;

const PING_EVERY: Duration = Duration::from_secs(10);
/// Three pings with nothing at all coming back means the socket is dead even if it never closed
/// (sleep, a network switch, a dropped tunnel): the reader gives up and the link reconnects.
const STALE_AFTER: Duration = PING_EVERY.saturating_mul(3);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

pub enum StreamMsg {
    Item(Value),
    /// The stream is over: `None` for a clean end, else the server's or the socket's reason.
    End(Option<String>),
}

#[derive(Debug, PartialEq, Eq)]
pub enum CallError {
    TimedOut,
    Closed(String),
    Remote(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TimedOut => f.write_str(crate::i18n::tr("notice.rpcTimedOut")),
            Self::Closed(reason) | Self::Remote(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for CallError {}

enum Pending {
    Unary(oneshot::Sender<Result<Value, CallError>>),
    Stream(mpsc::UnboundedSender<StreamMsg>),
}

struct Inner {
    out: mpsc::UnboundedSender<Message>,
    pending: Mutex<HashMap<String, Pending>>,
    next: AtomicU64,
    closed: watch::Sender<Option<String>>,
}

struct PendingCall {
    rpc: Rpc,
    id: String,
}

impl Drop for PendingCall {
    fn drop(&mut self) {
        self.rpc.interrupt_pending(&self.id);
    }
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
        self.rpc.interrupt_pending(&self.id);
    }
}

impl Rpc {
    pub async fn connect(url: &str) -> Result<Rpc, String> {
        Rpc::connect_with(url, None).await
    }

    /// `connect` with the TLS settings named; `None` means `http::client_config()`, built only
    /// for a `wss://` address.
    pub async fn connect_with(url: &str, tls: Option<Arc<ClientConfig>>) -> Result<Rpc, String> {
        let connector = url
            .starts_with("wss://")
            .then(|| Connector::Rustls(tls.unwrap_or_else(crate::http::client_config)));
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(15),
            tokio_tungstenite::connect_async_tls_with_config(url, None, false, connector),
        )
        .await
        .map_err(|_| "the WebSocket did not open in time".to_string())?
        .map_err(|e| format!("cannot open the WebSocket: {e}"))?;
        Ok(Self::from_socket(socket))
    }

    fn from_socket<S>(socket: tokio_tungstenite::WebSocketStream<S>) -> Rpc
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
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

        let writer = rpc.clone();
        tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = writer.closed() => {}
                result = async {
                    while let Some(message) = out_rx.recv().await {
                        sink.send(message).await?;
                    }
                    Ok::<(), tokio_tungstenite::tungstenite::Error>(())
                } => {
                    let reason = result.err().map_or_else(
                        || "the connection closed".to_string(),
                        |e| format!("the connection failed: {e}"),
                    );
                    writer.fail_all(&reason);
                }
            }
            // Give the close frame a chance to flush without keeping a blocked socket alive.
            let _ = tokio::time::timeout(Duration::from_secs(1), sink.close()).await;
        });

        let reader = rpc.clone();
        tokio::spawn(async move {
            let closed = reader.closed();
            tokio::pin!(closed);
            let mut ping =
                tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
            let mut last_inbound = tokio::time::Instant::now();
            let reason = loop {
                tokio::select! {
                    biased;
                    _ = &mut closed => return,
                    _ = ping.tick() => {
                        if last_inbound.elapsed() > STALE_AFTER {
                            break "the server stopped answering".to_string();
                        }
                        let _ = reader.send(&json!({"_tag": "Ping"}));
                    }
                    frame = source.next() => {
                        last_inbound = tokio::time::Instant::now();
                        match frame {
                            Some(Ok(Message::Text(text))) => reader.handle_frame(text.as_str()),
                            Some(Ok(Message::Close(_))) | None => {
                                break "the connection closed".to_string();
                            }
                            Some(Ok(_)) => {}
                            Some(Err(e)) => break format!("the connection failed: {e}"),
                        }
                    }
                }
            };
            reader.fail_all(&reason);
        });
        rpc
    }

    fn send(&self, message: &Value) -> Result<(), String> {
        if self.is_closed() {
            return Err("the connection is closed".into());
        }
        self.inner
            .out
            .send(Message::text(message.to_string()))
            .map_err(|_| "the connection is closed".to_string())
    }

    fn interrupt_pending(&self, id: &str) {
        let was_pending = self.inner.pending.lock().unwrap().remove(id).is_some();
        if was_pending {
            let _ = self.send(&json!({"_tag": "Interrupt", "requestId": id}));
        }
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
        self.call_with_timeout(tag, payload, Some(CALL_TIMEOUT))
            .await
    }

    /// Overrides the response deadline. With no deadline, socket closure still ends the call.
    pub async fn call_with_timeout(
        &self,
        tag: &str,
        payload: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, String> {
        let reply = self
            .start_call_with_timeout(tag, payload, timeout)
            .map_err(|e| e.to_string())?;
        reply.await.map_err(|e| e.to_string())
    }

    pub fn is_closed(&self) -> bool {
        self.inner.out.is_closed() || self.inner.closed.borrow().is_some()
    }

    /// Hands the request to the socket writer before returning its reply future.
    pub fn start_call(
        &self,
        tag: &str,
        payload: Value,
    ) -> Result<impl Future<Output = Result<Value, CallError>> + use<>, CallError> {
        self.start_call_with_timeout(tag, payload, Some(CALL_TIMEOUT))
    }

    fn start_call_with_timeout(
        &self,
        tag: &str,
        payload: Value,
        timeout: Option<Duration>,
    ) -> Result<impl Future<Output = Result<Value, CallError>> + use<>, CallError> {
        if self.is_closed() {
            return Err(CallError::Closed("the connection is closed".into()));
        }
        let id = self.next_id();
        let (tx, rx) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .unwrap()
            .insert(id.clone(), Pending::Unary(tx));
        let pending = PendingCall {
            rpc: self.clone(),
            id,
        };
        let deadline = timeout.map(|duration| tokio::time::Instant::now() + duration);
        self.send(&request(&pending.id, tag, payload))
            .map_err(CallError::Closed)?;
        Ok(async move {
            let _pending = pending;
            let result = match deadline {
                Some(deadline) => tokio::time::timeout_at(deadline, rx)
                    .await
                    .map_err(|_| CallError::TimedOut)?,
                None => rx.await,
            };
            result.map_err(|_| CallError::Closed("the connection closed".into()))?
        })
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

    pub fn close(&self) {
        self.fail_all("the connection closed");
    }

    fn fail_all(&self, reason: &str) {
        if !self.inner.closed.send_if_modified(|closed| {
            if closed.is_some() {
                return false;
            }
            *closed = Some(reason.to_string());
            true
        }) {
            return;
        }
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
                    let _ = tx.send(Err(CallError::Closed(reason.to_string())));
                }
                Pending::Stream(tx) => {
                    let _ = tx.send(StreamMsg::End(Some(reason.to_string())));
                }
            }
        }
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
                        let _ = tx.send(result.map_err(CallError::Remote));
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
pub(crate) async fn fake_socket() -> (
    Rpc,
    tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
) {
    use tokio_tungstenite::{WebSocketStream, tungstenite::protocol::Role};
    let (client, server) = tokio::io::duplex(8192);
    let client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
    let server = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
    (Rpc::from_socket(client), server)
}

#[cfg(test)]
pub(crate) async fn delayed_reply(
    rpc: &Rpc,
    mut peer: tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
    method: &str,
    answer: Value,
) -> bool {
    let (requested, request_seen) = oneshot::channel();
    let server = async {
        let mut requested = Some(requested);
        let mut waiting = None;
        let mut interrupted = false;
        while let Some(Ok(Message::Text(text))) = peer.next().await {
            let message: Value = serde_json::from_str(&text).unwrap();
            let id = message["id"].clone();
            let response = match message["_tag"].as_str() {
                Some("Ping") => json!({"_tag": "Pong"}),
                Some("Request") if message["tag"] == method => {
                    waiting = Some(id);
                    requested.take().unwrap().send(()).unwrap();
                    continue;
                }
                Some("Interrupt") => {
                    interrupted |= waiting.as_ref() == Some(&message["requestId"]);
                    continue;
                }
                Some("Request") if message["tag"] == "release" => {
                    let reply = json!({"_tag": "Exit", "requestId": waiting.take().unwrap(),
                        "exit": {"_tag": "Success", "value": answer}});
                    peer.send(Message::text(reply.to_string())).await.unwrap();
                    json!({"_tag": "Exit", "requestId": id, "exit": {"_tag": "Success", "value": null}})
                }
                Some("Request") => json!({"_tag": "Exit", "requestId": id,
                    "exit": {"_tag": "Success", "value": null}}),
                _ => continue,
            };
            let released = message["tag"] == "release";
            peer.send(Message::text(response.to_string()))
                .await
                .unwrap();
            if released {
                break;
            }
        }
        interrupted
    };
    let clock = async {
        request_seen.await.unwrap();
        for _ in 0..9 {
            tokio::time::advance(PING_EVERY).await;
            rpc.call("barrier", json!({})).await.unwrap();
        }
        rpc.call("release", json!({})).await.unwrap();
    };
    tokio::join!(server, clock).0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test(start_paused = true)]
    async fn unanswered_rpc_times_out_while_the_socket_keeps_answering_pings() {
        let (rpc, mut server) = fake_socket().await;
        let peer = tokio::spawn(async move {
            while let Some(Ok(Message::Text(text))) = server.next().await {
                let message: Value = serde_json::from_str(&text).unwrap();
                if message["_tag"] == "Ping" {
                    server
                        .send(Message::text(r#"{"_tag":"Pong"}"#))
                        .await
                        .unwrap();
                }
            }
        });
        let reply = rpc.start_call("never.answers", json!({})).unwrap();
        let result = tokio::select! {
            result = reply => result,
            _ = tokio::time::sleep(Duration::from_secs(70)) => panic!("RPC still pending"),
        };
        assert_eq!(result.unwrap_err(), CallError::TimedOut);
        assert!(rpc.inner.pending.lock().unwrap().is_empty());
        assert!(!rpc.is_closed());
        peer.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_unary_request_interrupts_its_server_request_id() {
        let (rpc, peer) = fake_socket().await;
        let reply = rpc.start_call("unary", json!({})).unwrap();
        let (result, interrupted) =
            tokio::join!(reply, delayed_reply(&rpc, peer, "unary", json!(null)),);
        assert_eq!(result.unwrap_err(), CallError::TimedOut);
        assert!(
            interrupted,
            "the peer never received Interrupt for the request"
        );
    }

    #[test]
    fn timed_out_rpc_has_an_english_and_korean_notice() {
        use crate::i18n::tr_in_lang;
        assert_eq!(
            tr_in_lang("notice.rpcTimedOut", false),
            "The server did not respond in time."
        );
        assert_eq!(
            tr_in_lang("notice.rpcTimedOut", true),
            "서버가 제시간에 응답하지 않았습니다."
        );
        assert_eq!(
            CallError::TimedOut.to_string(),
            crate::i18n::tr("notice.rpcTimedOut")
        );
    }

    #[tokio::test]
    async fn dropping_an_unpolled_reply_removes_the_pending_rpc() {
        let (rpc, _server) = fake_socket().await;
        let reply = rpc.start_call("never.answers", json!({})).unwrap();
        assert_eq!(rpc.inner.pending.lock().unwrap().len(), 1);
        drop(reply);
        assert!(rpc.inner.pending.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn silent_server_closes_and_fails_pending_calls() {
        let (rpc, _server) = fake_socket().await;
        let call = rpc.call("never.answers", json!({}));
        let closed = rpc.closed();
        let (result, reason) = tokio::select! {
            result = async { tokio::join!(call, closed) } => result,
            _ = tokio::time::sleep(PING_EVERY * 6) => panic!("silent connection stayed open"),
        };
        assert_eq!(reason, "the server stopped answering");
        assert_eq!(result.unwrap_err(), reason);
    }

    #[tokio::test(start_paused = true)]
    async fn answering_server_stays_open_past_stale_limit() {
        let (rpc, mut server) = fake_socket().await;
        let server_task = tokio::spawn(async move {
            while let Some(Ok(Message::Text(text))) = server.next().await {
                let message: Value = serde_json::from_str(&text).unwrap();
                let response = match message["_tag"].as_str() {
                    Some("Ping") => json!({"_tag": "Pong"}),
                    Some("Request") => json!({"_tag": "Exit", "requestId": message["id"],
                        "exit": {"_tag": "Success", "value": null}}),
                    _ => continue,
                };
                server
                    .send(Message::text(response.to_string()))
                    .await
                    .unwrap();
            }
        });
        for _ in 0..12 {
            tokio::time::advance(PING_EVERY).await;
            // The reply receipt ensures all preceding Pong frames have reached the reader.
            rpc.call("barrier", json!({})).await.unwrap();
            assert!(rpc.inner.closed.borrow().is_none());
        }
        server_task.abort();
    }

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

    /// The same protocol over `wss://`: the server presents a certificate made for the test, and
    /// the client trusts that one only. A client that trusts nothing never gets to speak.
    #[tokio::test]
    async fn a_secure_socket_carries_calls_and_refuses_an_untrusted_certificate() {
        let (acceptor, trusting) = crate::http::testtls::server_and_trusting_client();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(tcp).await else {
                        return;
                    };
                    let mut ws = tokio_tungstenite::accept_async(tls).await.unwrap();
                    while let Some(Ok(Message::Text(text))) = ws.next().await {
                        let m: Value = serde_json::from_str(text.as_str()).unwrap();
                        if m["_tag"] == "Request" {
                            let done = json!({"_tag": "Exit", "requestId": m["id"],
                                "exit": {"_tag": "Success", "value": {"echo": m["tag"]}}});
                            ws.send(Message::text(done.to_string())).await.unwrap();
                        }
                    }
                });
            }
        });
        let url = format!("wss://localhost:{port}/ws");
        let rpc = Rpc::connect_with(&url, Some(trusting)).await.unwrap();
        assert_eq!(
            rpc.call("say.hi", json!({})).await.unwrap(),
            json!({"echo": "say.hi"})
        );
        let refused = Rpc::connect_with(&url, Some(crate::http::testtls::distrusting_client()))
            .await
            .err()
            .expect("an untrusted certificate must not be accepted");
        assert!(refused.contains("cannot open the WebSocket"), "{refused}");
    }
}
