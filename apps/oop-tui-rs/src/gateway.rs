//! The host's environment gateway: the other computers whose projects and threads this terminal
//! may open, as the running desktop app shares them. The list is read when it is needed (the
//! picker, `oop status`) and never in the background; the session of one computer goes through
//! that computer's own gateway path (`environment_prefix`) with the host's login. `/_gw` and the
//! list endpoint are `GATEWAY_PATH_PREFIX` and `GATEWAY_ENVIRONMENTS_PATH` of
//! packages/contracts/src/gateway.ts; the upstream addresses and logins never reach this client.

use crate::http;
use crate::panels_common::s;
use serde_json::Value;
use std::time::Duration;

const ENVIRONMENTS_PATH: &str = "/api/gateway/environments";
pub const GATEWAY_PATH_PREFIX: &str = "/_gw";

/// How long asking the host for the list may take.
const LIST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq)]
pub struct Environment {
    pub environment_id: String,
    pub label: String,
    pub status: Status,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Online,
    Offline,
    AuthFailed,
}

impl Status {
    fn parse(text: &str) -> Option<Status> {
        match text {
            "online" => Some(Status::Online),
            "offline" => Some(Status::Offline),
            "auth-failed" => Some(Status::AuthFailed),
            _ => None,
        }
    }

    /// The word a row of the picker and `oop status` show.
    pub fn word(self) -> &'static str {
        match self {
            Status::Online => s("online", "온라인"),
            Status::Offline => s("offline", "오프라인"),
            Status::AuthFailed => s("sign-in failed", "로그인 실패"),
        }
    }
}

/// The host path whose HTTP and WebSocket calls the gateway forwards to one computer, the id
/// encoded as one path segment (`gatewayEnvironmentPath`).
pub fn environment_prefix(environment_id: &str) -> String {
    format!(
        "{GATEWAY_PATH_PREFIX}/{}",
        http::encode_component(environment_id)
    )
}

/// The list the host answers with. An entry that is not a named computer in one of the three
/// states is dropped; a body of another shape is an error.
pub fn parse_list(body: &Value) -> Result<Vec<Environment>, String> {
    let Some(environments) = body.get("environments").and_then(Value::as_array) else {
        return Err(s(
            "the answer says nothing about environments",
            "응답에 컴퓨터 목록이 없습니다",
        )
        .to_string());
    };
    Ok(environments
        .iter()
        .filter_map(|entry| {
            let environment_id = entry["environmentId"].as_str()?.to_string();
            let label = entry["label"].as_str()?.to_string();
            let status = Status::parse(entry["status"].as_str()?)?;
            (!environment_id.is_empty() && !label.is_empty()).then_some(Environment {
                environment_id,
                label,
                status,
            })
        })
        .collect())
}

/// Asks the host for the computers it can reach. A refused login is said in words; anything else
/// wrong comes back as the reason it could not be asked.
pub async fn environments(origin: &str, bearer: &str) -> Result<Vec<Environment>, String> {
    let auth = [("Authorization", format!("Bearer {bearer}"))];
    let answer = http::request("GET", origin, ENVIRONMENTS_PATH, &auth, None, LIST_TIMEOUT).await?;
    match answer.status {
        200 => parse_list(&answer.json()?),
        401 | 403 => Err(s(
            "the desktop app refused the login",
            "데스크톱 앱이 로그인을 거부했습니다",
        )
        .to_string()),
        status => Err(format!("the server answered {status}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_prefix_encodes_the_id_as_one_path_segment() {
        assert_eq!(environment_prefix("dev-1"), "/_gw/dev-1");
        // `encodeURIComponent` keeps -_. and nothing of a path: a space, a slash and a plus are
        // %XX, so the id cannot add a segment of its own.
        assert_eq!(environment_prefix("a b/c+d"), "/_gw/a%20b%2Fc%2Bd");
        assert_eq!(
            environment_prefix("x_y.z!~*'()"),
            "/_gw/x_y.z!~*'()",
            "the characters a segment keeps are left as they are"
        );
    }

    #[test]
    fn the_list_is_read_with_its_three_states_and_keeps_whole_entries_only() {
        let body = json!({"environments": [
            {"environmentId": "e1", "label": "ai-server", "status": "online"},
            {"environmentId": "e2", "label": "lab", "status": "offline"},
            {"environmentId": "e3", "label": "old", "status": "auth-failed"},
            {"environmentId": "e4", "label": "half", "status": "sleeping"},
            {"environmentId": "", "label": "nameless", "status": "online"},
            {"label": "no id", "status": "online"},
        ]});
        let list = parse_list(&body).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].status, Status::Online);
        assert_eq!(list[1].status, Status::Offline);
        assert_eq!(list[2].status, Status::AuthFailed);
        assert_eq!(list[0].label, "ai-server");
        assert_eq!(parse_list(&json!({"environments": []})).unwrap(), []);
    }

    #[test]
    fn a_body_of_another_shape_is_an_error() {
        for body in [
            json!({}),
            json!([]),
            json!({"environments": "no"}),
            json!({"environments": {"a": 1}}),
        ] {
            assert!(parse_list(&body).is_err(), "{body}");
        }
    }

    #[test]
    fn the_states_are_named_in_the_words_of_the_language() {
        // One language per process; whatever it is, the words are the picker's own.
        assert_eq!(Status::Online.word(), s("online", "온라인"));
        assert_eq!(Status::Offline.word(), s("offline", "오프라인"));
        assert_eq!(
            Status::AuthFailed.word(),
            s("sign-in failed", "로그인 실패")
        );
    }

    /// A raw HTTP answer of one response, on a port of its own.
    async fn http_server(answer: String) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 1024];
            while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                let read = tokio::io::AsyncReadExt::read(&mut tcp, &mut buf)
                    .await
                    .unwrap();
                if read == 0 {
                    break;
                }
                seen.extend_from_slice(&buf[..read]);
            }
            let _ = tokio::io::AsyncWriteExt::write_all(&mut tcp, answer.as_bytes()).await;
        });
        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn asking_the_host_for_the_list_parses_whats_answered() {
        crate::i18n::init(Some("en"));
        let body =
            r#"{"environments":[{"environmentId":"e1","label":"ai-server","status":"online"}]}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let origin = http_server(response).await;
        let list = environments(&origin, "b").await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].environment_id, "e1");

        let origin =
            http_server("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".into()).await;
        assert!(
            environments(&origin, "b")
                .await
                .unwrap_err()
                .contains("404")
        );

        let origin =
            http_server("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n".into()).await;
        assert_eq!(
            environments(&origin, "b").await.unwrap_err(),
            "the desktop app refused the login"
        );
    }
}
