//! `oop pair <link or token>`: turns what the user pasted into a server address and a one-time
//! token, trades the token for a login, and saves it. Ports the former TypeScript terminal's pair module and
//! `runPair`, with the URL rules of packages/shared/src/remote.ts
//! (`resolveRemotePairingTarget`, `getPairingTokenFromUrl`) and the failure classes of
//! packages/client-runtime/src/connection/errors.ts. Declared inside `server.rs`, which it extends.

use super::{
    Credential, ORCHESTRATION_PROTOCOL, SCOPES, client_label, client_os, is_loopback_origin,
    protocol_version, resolve, save_credential, verify_credentials,
};
use crate::http;
use crate::panels_common::{fill, s};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// Why pairing failed, as far as the server said. Only a refused or unusable link gets advice;
/// a cause that was not named gets none rather than a wrong one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairKind {
    /// The token was refused: a new link fixes it.
    Authentication,
    /// The credential is valid but does not grant what was asked; no advice.
    Permission,
    /// The server rejected the request, e.g. a link that may not grant this client its scopes
    /// (read-only): the server has used the link up by then.
    Configuration,
    /// The server speaks another protocol and never looked at the link: only an update fixes it.
    Unsupported,
    /// Anything else (network, timeouts, server errors, bad input).
    Transient,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairError {
    pub kind: PairKind,
    pub message: String,
}

impl PairError {
    fn new(kind: PairKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn plain(message: impl Into<String>) -> Self {
        Self::new(PairKind::Transient, message)
    }
}

/// What the server's HTTP status says went wrong (`mapRemoteEnvironmentError`).
fn classify(status: u16) -> PairError {
    match status {
        401 => PairError::new(
            PairKind::Authentication,
            "The environment credential is invalid.",
        ),
        403 => PairError::new(
            PairKind::Permission,
            "The environment credential does not grant the required access.",
        ),
        400 => PairError::new(
            PairKind::Configuration,
            "The environment rejected the authentication request.",
        ),
        404 => PairError::new(
            PairKind::Configuration,
            "The environment endpoint could not be found.",
        ),
        other => PairError::plain(format!(
            "The environment returned an unexpected response ({other})."
        )),
    }
}

/// What `oop pair` prints when pairing fails (`pairFailureMessage`).
pub fn pair_failure_message(error: &PairError) -> String {
    let failure = fill(
        s(
            "Pairing failed: {message}",
            "페어링에 실패했습니다: {message}",
        ),
        &[("message", error.message.clone())],
    );
    let advice = match error.kind {
        PairKind::Authentication => s(
            "{failure}\nA link works once and expires soon. Create a new link and try again.",
            "{failure}\n링크는 한 번만 쓸 수 있고 곧 만료됩니다. 새 링크를 만들어 다시 시도하세요.",
        ),
        PairKind::Unsupported => s(
            "{failure}\nProtocol mismatch: update the app or oop.",
            "{failure}\n프로토콜 불일치: 앱이나 oop 을 업데이트하세요.",
        ),
        PairKind::Configuration => s(
            "{failure}\nThis link's permissions cannot connect oop, and the link is already used up. Create a new link that is not read-only and try again.",
            "{failure}\n이 링크의 권한으로는 oop 을 연결할 수 없고 링크는 이미 쓰였습니다. 읽기 전용이 아닌 새 링크를 만들어 다시 시도하세요.",
        ),
        PairKind::Permission | PairKind::Transient => return failure,
    };
    fill(advice, &[("failure", failure)])
}

/// What `oop pair` prints on success (`link.paired`).
pub fn paired_message(label: &str) -> String {
    fill(
        s(
            "Connected: {label}\nNow start with 'oop'.",
            "연결되었습니다: {label}\n이제 'oop' 으로 시작하세요.",
        ),
        &[("label", label.to_string())],
    )
}

// ---------------------------------------------------------------------------------------------
// Addresses

/// Just enough of a URL for a pairing link: scheme, authority, query and fragment.
struct Url {
    scheme: String,
    authority: String,
    query: String,
    fragment: String,
}

fn has_scheme_prefix(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once("://") else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
}

/// Splits `scheme://authority/path?query#fragment`. `None` when there is no `scheme://`.
fn split_url(value: &str) -> Option<Url> {
    if !has_scheme_prefix(value) {
        return None;
    }
    let (scheme, rest) = value.split_once("://")?;
    let (rest, fragment) = rest.split_once('#').unwrap_or((rest, ""));
    let (rest, query) = rest.split_once('?').unwrap_or((rest, ""));
    let authority = rest.split(['/', '\\']).next().unwrap_or("");
    Some(Url {
        scheme: scheme.to_ascii_lowercase(),
        authority: authority.to_string(),
        query: query.to_string(),
        fragment: fragment.to_string(),
    })
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'+' => out.push(b' '),
            b'%' if at + 2 < bytes.len() => {
                let pair = std::str::from_utf8(&bytes[at + 1..at + 3])
                    .ok()
                    .and_then(|hex| u8::from_str_radix(hex, 16).ok());
                if let Some(byte) = pair {
                    out.push(byte);
                    at += 2;
                } else {
                    out.push(b'%');
                }
            }
            other => out.push(other),
        }
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The first value of a parameter in `a=b&c=d` (`URLSearchParams.get`).
fn param(params: &str, name: &str) -> Option<String> {
    params.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (percent_decode(key) == name).then(|| percent_decode(value))
    })
}

/// The token of a link: the fragment's first, else the query's (`getPairingTokenFromUrl`).
fn token_of(url: &Url) -> Option<String> {
    [&url.fragment, &url.query].into_iter().find_map(|params| {
        param(params, "token")
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
    })
}

/// A valid address: `scheme://host[:port]` with ws/wss written as http/https and the scheme's own
/// default port left out, or `None` when the scheme or the authority is not usable.
fn http_base(url: &Url) -> Option<String> {
    let secure = match url.scheme.as_str() {
        "http" | "ws" => false,
        "https" | "wss" => true,
        _ => return None,
    };
    let host_port = url
        .authority
        .rsplit_once('@')
        .map_or(url.authority.as_str(), |(_, rest)| rest);
    let (host, port) = if let Some(inner) = host_port.strip_prefix('[') {
        let (host, after) = inner.split_once(']')?;
        if host.is_empty()
            || !host
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
        {
            return None;
        }
        (
            format!("[{}]", host.to_ascii_lowercase()),
            after.strip_prefix(':'),
        )
    } else {
        let (host, port) = match host_port.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (host_port, None),
        };
        if host.is_empty()
            || !host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
        {
            return None;
        }
        (host.to_ascii_lowercase(), port)
    };
    let port = match port {
        None | Some("") => None,
        Some(port) => Some(port.parse::<u16>().ok()?),
    };
    let default = if secure { 443 } else { 80 };
    let scheme = if secure { "https" } else { "http" };
    Some(match port.filter(|p| *p != default) {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

/// A typed or discovered server address: a scheme is optional (https is assumed), leading slashes
/// are dropped, and anything after the host is ignored (`normalizeRemoteBaseUrl`).
fn normalize_base(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter a backend URL.".into());
    }
    let without_slashes = trimmed.trim_start_matches('/');
    let with_scheme = if has_scheme_prefix(without_slashes) {
        without_slashes.to_string()
    } else {
        format!("https://{without_slashes}")
    };
    split_url(&with_scheme)
        .and_then(|url| http_base(&url))
        .ok_or_else(|| "Backend URL is invalid.".to_string())
}

fn is_app_window_link(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("t3code://") || lower.starts_with("t3code-dev://")
}

/// With network access off the desktop app links to its own window, which is not a server address.
pub fn carries_server_address(input: &str) -> bool {
    let value = input.trim();
    has_scheme_prefix(value) && !is_app_window_link(value)
}

/// What a pairing link or token means: the one-time token and the server it is for.
#[derive(Debug, PartialEq, Eq)]
pub struct PairTarget {
    pub credential: String,
    /// Scheme, host and non-default port, no trailing slash.
    pub http_base_url: String,
}

/// `oop pair` takes either the full pairing link the app shows or the bare one-time token. A bare
/// token, or a link to the app's own window, needs a server address: the discovered one, or
/// `--server` (`resolvePairTarget`). `Err` is the message, before `pair_failure_message`.
pub fn resolve_pair_target(input: &str, server_origin: Option<&str>) -> Result<PairTarget, String> {
    let value = input.trim();
    if value.is_empty() {
        return Err(s(
            "Enter a pairing link or token.",
            "페어링 링크 또는 토큰을 입력하세요.",
        )
        .into());
    }
    let invalid = || "Pairing URL is invalid.".to_string();
    if carries_server_address(value) {
        let url = split_url(value).ok_or_else(invalid)?;
        let base = http_base(&url).ok_or_else(invalid)?;
        // A hosted link names the server in `host` and carries the token on its own.
        let hosted_host = param(&url.query, "host")
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty());
        if let (Some(host), Some(token)) = (hosted_host, token_of(&url)) {
            return Ok(PairTarget {
                credential: token,
                http_base_url: normalize_base(&host)?,
            });
        }
        let credential = token_of(&url).ok_or("Pairing URL is missing its token.")?;
        return Ok(PairTarget {
            credential,
            http_base_url: base,
        });
    }
    let Some(origin) = server_origin else {
        return Err(s(
            "A token alone does not say which server to use. Use the full pairing link or pass --server with an address.",
            "토큰만으로는 서버를 알 수 없습니다. 페어링 링크 전체를 쓰거나 --server 주소를 지정하세요.",
        )
        .into());
    };
    let code = if is_app_window_link(value) {
        split_url(value)
            .and_then(|url| token_of(&url))
            .unwrap_or_default()
    } else {
        value.to_string()
    };
    let base = normalize_base(origin)?;
    if code.is_empty() {
        return Err("Enter a pairing code.".into());
    }
    Ok(PairTarget {
        credential: code,
        http_base_url: base,
    })
}

/// One line for the user when the address is plain http to another machine
/// (`plainHttpWarning`).
pub fn plain_http_warning(origin: &str) -> Option<String> {
    let parsed = http::Origin::parse(origin.trim_end_matches('/')).ok()?;
    if parsed.tls || is_loopback_origin(origin) {
        return None;
    }
    let host = if parsed.host.contains(':') {
        format!("[{}]", parsed.host)
    } else {
        parsed.host.clone()
    };
    let host = if parsed.port == 80 {
        host
    } else {
        format!("{host}:{}", parsed.port)
    };
    Some(fill(
        s(
            "Warning: connecting to {host} over unencrypted http. Your token and conversation are visible on the network.",
            "주의: {host} 에 암호화 없는 http 로 연결합니다. 토큰과 대화 내용이 네트워크에 그대로 보입니다.",
        ),
        &[("host", host)],
    ))
}

// ---------------------------------------------------------------------------------------------
// Talking to the server

/// What the server says it is, and whether this client can talk to it. A server that speaks
/// another protocol never gets the token (`orchestrationProtocolCompatibilityError`).
pub(super) async fn descriptor(origin: &str) -> Result<(String, String), PairError> {
    let answer = http::request(
        "GET",
        origin,
        "/.well-known/t3/environment",
        &[],
        None,
        Duration::from_secs(10),
    )
    .await
    .map_err(PairError::plain)?;
    if answer.status != 200 {
        return Err(classify(answer.status));
    }
    let body: Value = answer.json().unwrap_or(Value::Null);
    let (Some(environment_id), label) = (
        body["environmentId"].as_str(),
        body["label"].as_str().unwrap_or("OOP"),
    ) else {
        return Err(PairError::plain("The environment did not describe itself."));
    };
    match protocol_version(&body) {
        Some(ORCHESTRATION_PROTOCOL) => Ok((environment_id.to_string(), label.to_string())),
        other => Err(PairError::new(
            PairKind::Unsupported,
            if other.unwrap_or(0) > ORCHESTRATION_PROTOCOL {
                format!(
                    "This client is not supported by this server. Update your app or use a compatible release to connect to {label}."
                )
            } else {
                format!("This client requires a newer server. Update OOP on {label} to connect.")
            },
        )),
    }
}

/// Trades a one-time token for a bearer token at `/oauth/token` (form-encoded token exchange).
pub(super) async fn token_exchange(
    origin: &str,
    credential: &str,
    label: &str,
) -> Result<String, PairError> {
    let fields = [
        (
            "grant_type",
            "urn:ietf:params:oauth:grant-type:token-exchange",
        ),
        ("subject_token", credential),
        (
            "subject_token_type",
            "urn:t3:params:oauth:token-type:environment-bootstrap",
        ),
        (
            "requested_token_type",
            "urn:ietf:params:oauth:token-type:access_token",
        ),
        ("scope", SCOPES),
        ("client_label", label),
        ("client_device_type", "desktop"),
        ("client_os", client_os()),
    ];
    let body = fields
        .iter()
        .map(|(k, v)| format!("{k}={}", http::form_encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let answer = http::request(
        "POST",
        origin,
        "/oauth/token",
        &[],
        Some(("application/x-www-form-urlencoded", body.into_bytes())),
        Duration::from_secs(10),
    )
    .await
    .map_err(PairError::plain)?;
    if answer.status != 200 {
        return Err(classify(answer.status));
    }
    answer
        .json()
        .ok()
        .and_then(|json| json["access_token"].as_str().map(str::to_string))
        .ok_or_else(|| PairError::plain("The server sent no access token."))
}

/// `oop pair <link or token> [--server <address>]` (`runPair`). A link carries its own server; a
/// bare token (or a link to the app's window) uses `server` or the discovered one, and nothing is
/// started for it. The credential file is checked before the one-time token is spent. `Ok` is the
/// server's label (print `paired_message`); `Err` is the message to print, exit status 1.
pub async fn pair_command(
    target: &str,
    server: Option<&str>,
    home: &Path,
) -> Result<String, String> {
    let origin = if carries_server_address(target) {
        None
    } else {
        Some(resolve(home, false, server, false, |_| {}).await?.origin)
    };
    let failed = |message: String| pair_failure_message(&PairError::plain(message));
    let target = resolve_pair_target(target, origin.as_deref()).map_err(failed)?;
    if let Some(warning) = plain_http_warning(&target.http_base_url) {
        eprintln!("{warning}");
    }
    verify_credentials().map_err(failed)?;
    let paired = async {
        let (environment_id, label) = descriptor(&target.http_base_url).await?;
        let token = token_exchange(
            &target.http_base_url,
            &target.credential,
            &client_label().await,
        )
        .await?;
        Ok::<_, PairError>((environment_id, label, token))
    }
    .await
    .map_err(|error| pair_failure_message(&error))?;
    let (environment_id, label, token) = paired;
    save_credential(&Credential {
        environment_id,
        label: label.clone(),
        http_base_url: target.http_base_url,
        token,
        saved_at: crate::text::iso_now(),
    })
    .map_err(failed)?;
    Ok(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn english() {
        crate::i18n::init(Some("en"));
    }

    fn target(input: &str, server: Option<&str>) -> Result<(String, String), String> {
        english();
        resolve_pair_target(input, server).map(|t| (t.credential, t.http_base_url))
    }

    #[test]
    fn a_link_to_a_server_carries_its_address_but_the_apps_window_does_not() {
        assert!(carries_server_address("https://app.example/pair#token=abc"));
        assert!(carries_server_address(
            "  http://127.0.0.1:3773/?token=abc "
        ));
        assert!(!carries_server_address("t3code://pair?token=abc"));
        assert!(!carries_server_address("T3CODE-DEV://pair?token=abc"));
        assert!(!carries_server_address("abcdef"));
        assert!(!carries_server_address(""));
    }

    #[test]
    fn a_link_gives_its_token_and_its_server_without_asking_the_discovered_one() {
        assert_eq!(
            target("http://192.168.0.5:3773/pair#token=abc123", None).unwrap(),
            ("abc123".into(), "http://192.168.0.5:3773".into())
        );
        // The query holds it too; the fragment wins when both do.
        assert_eq!(
            target("https://h.example/pair?token=q", None).unwrap(),
            ("q".into(), "https://h.example".into())
        );
        assert_eq!(
            target("https://h.example/pair?token=q#token=f", None).unwrap(),
            ("f".into(), "https://h.example".into())
        );
        // Socket schemes are the same server, and default ports are not written.
        assert_eq!(
            target("wss://h.example:443/pair?token=t", None).unwrap(),
            ("t".into(), "https://h.example".into())
        );
        assert_eq!(
            target("ws://H.Example:80/?token=t", None).unwrap(),
            ("t".into(), "http://h.example".into())
        );
        assert_eq!(
            target("http://[::1]:3911/?token=t", None).unwrap(),
            ("t".into(), "http://[::1]:3911".into())
        );
    }

    #[test]
    fn a_tailscale_https_link_or_bare_tailnet_name_gives_the_machines_origin() {
        assert_eq!(
            target("https://devbox.tail0000ab.ts.net/pair#token=abc", None).unwrap(),
            ("abc".into(), "https://devbox.tail0000ab.ts.net".into())
        );
        // The MagicDNS name in capitals, with the default port written, is the same server.
        assert_eq!(
            target("https://Devbox.tail0000ab.ts.net:443/pair#token=abc", None)
                .unwrap()
                .1,
            "https://devbox.tail0000ab.ts.net"
        );
        // `--server` takes the bare name: https is assumed.
        for server in [
            "devbox.tail0000ab.ts.net",
            "https://devbox.tail0000ab.ts.net/",
        ] {
            assert_eq!(
                target("tok", Some(server)).unwrap(),
                ("tok".into(), "https://devbox.tail0000ab.ts.net".into())
            );
        }
        // A tailnet address is plain http on the server's port, with the warning that says so.
        let ip = target("http://100.101.102.103:3773/pair#token=abc", None).unwrap();
        assert_eq!(ip.1, "http://100.101.102.103:3773");
        assert!(plain_http_warning(&ip.1).is_some());
        assert!(plain_http_warning("https://devbox.tail0000ab.ts.net").is_none());
    }

    #[test]
    fn percent_signs_and_plus_signs_in_a_link_are_decoded_like_a_browser_does() {
        assert_eq!(
            target("http://h.example/?token=a%2Bb+c", None).unwrap().0,
            "a+b c"
        );
        // Not an escape: kept as it is.
        assert_eq!(
            target("http://h.example/?token=100%", None).unwrap().0,
            "100%"
        );
    }

    #[test]
    fn a_hosted_link_names_the_server_in_its_host_parameter() {
        assert_eq!(
            target(
                "https://app.t3.codes/pair?host=my.box:3773&token=t#x=1",
                None
            )
            .unwrap(),
            ("t".into(), "https://my.box:3773".into())
        );
        assert_eq!(
            target(
                "https://app.t3.codes/?host=http%3A%2F%2F10.0.0.2%3A3773&label=Box#token=t",
                None
            )
            .unwrap(),
            ("t".into(), "http://10.0.0.2:3773".into())
        );
        // Without a token it is just a link to the hosted page, which has no token to give.
        assert_eq!(
            target("https://app.t3.codes/pair?host=my.box", None).unwrap_err(),
            "Pairing URL is missing its token."
        );
    }

    #[test]
    fn a_link_that_cannot_be_used_says_so() {
        assert_eq!(
            target("ftp://h.example/?token=t", None).unwrap_err(),
            "Pairing URL is invalid."
        );
        assert_eq!(
            target("http:///?token=t", None).unwrap_err(),
            "Pairing URL is invalid."
        );
        assert_eq!(
            target("http://h.example:99999/?token=t", None).unwrap_err(),
            "Pairing URL is invalid."
        );
        assert_eq!(
            target("http://h.example/pair", None).unwrap_err(),
            "Pairing URL is missing its token."
        );
        assert_eq!(
            target("http://h.example/pair?token=%20", None).unwrap_err(),
            "Pairing URL is missing its token."
        );
        assert_eq!(
            target("   ", None).unwrap_err(),
            "Enter a pairing link or token."
        );
    }

    #[test]
    fn a_bare_token_needs_a_server_and_uses_it() {
        assert_eq!(
            target("abcd-1234", None).unwrap_err(),
            "A token alone does not say which server to use. Use the full pairing link or pass --server with an address."
        );
        assert_eq!(
            target(" abcd-1234 ", Some("http://127.0.0.1:3873")).unwrap(),
            ("abcd-1234".into(), "http://127.0.0.1:3873".into())
        );
        // The address `--server` takes may lack a scheme (https is assumed, as for a typed host).
        assert_eq!(
            target("tok", Some("box.example:3773")).unwrap().1,
            "https://box.example:3773"
        );
    }

    #[test]
    fn a_link_to_the_apps_window_gives_its_token_for_the_discovered_server() {
        assert_eq!(
            target("t3code://pair?token=win", Some("http://127.0.0.1:3773")).unwrap(),
            ("win".into(), "http://127.0.0.1:3773".into())
        );
        assert_eq!(
            target(
                "t3code-dev://pair#token=hash",
                Some("http://127.0.0.1:3773")
            )
            .unwrap()
            .0,
            "hash"
        );
        assert_eq!(
            target("t3code://pair", Some("http://127.0.0.1:3773")).unwrap_err(),
            "Enter a pairing code."
        );
        assert_eq!(
            target("t3code://pair?token=win", None).unwrap_err(),
            "A token alone does not say which server to use. Use the full pairing link or pass --server with an address."
        );
    }

    #[test]
    fn plain_http_to_another_machine_is_warned_about_and_nothing_else_is() {
        english();
        let warning = plain_http_warning("http://192.168.0.5:3773").expect("a warning");
        assert!(
            warning.starts_with("Warning: connecting to 192.168.0.5:3773 over unencrypted http.")
        );
        assert!(
            plain_http_warning("http://box.example")
                .unwrap()
                .contains("box.example over")
        );
        assert_eq!(plain_http_warning("http://127.0.0.1:3773"), None);
        assert_eq!(plain_http_warning("http://localhost:3773"), None);
        assert_eq!(plain_http_warning("http://[::1]:3773"), None);
        assert_eq!(plain_http_warning("https://box.example"), None);
    }

    #[test]
    fn statuses_are_classified_as_the_typescript_client_classifies_them() {
        assert_eq!(classify(401).kind, PairKind::Authentication);
        assert_eq!(classify(403).kind, PairKind::Permission);
        assert_eq!(classify(400).kind, PairKind::Configuration);
        assert_eq!(classify(404).kind, PairKind::Configuration);
        assert_eq!(classify(500).kind, PairKind::Transient);
        assert_eq!(classify(502).kind, PairKind::Transient);
    }

    #[test]
    fn a_failure_gets_the_advice_its_cause_deserves_and_no_other() {
        english();
        let message = |kind| pair_failure_message(&PairError::new(kind, "boom"));
        assert_eq!(message(PairKind::Transient), "Pairing failed: boom");
        assert_eq!(message(PairKind::Permission), "Pairing failed: boom");
        assert_eq!(
            message(PairKind::Authentication),
            "Pairing failed: boom\nA link works once and expires soon. Create a new link and try again."
        );
        assert_eq!(
            message(PairKind::Unsupported),
            "Pairing failed: boom\nProtocol mismatch: update the app or oop."
        );
        assert_eq!(
            message(PairKind::Configuration),
            "Pairing failed: boom\nThis link's permissions cannot connect oop, and the link is already used up. Create a new link that is not read-only and try again."
        );
        assert_eq!(
            paired_message("Work Mac"),
            "Connected: Work Mac\nNow start with 'oop'."
        );
    }

    /// A server that answers each connection with the next canned response and records the
    /// request line it got. Returns its origin and the recorded lines.
    async fn serve(
        responses: Vec<(u16, &'static str)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            for (status, body) in responses {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                // Everything the client sent (head and body arrive apart), until it goes quiet.
                let mut request = Vec::new();
                loop {
                    let mut buffer = vec![0u8; 8192];
                    match tokio::time::timeout(
                        std::time::Duration::from_millis(50),
                        socket.read(&mut buffer),
                    )
                    .await
                    {
                        Ok(Ok(read)) if read > 0 => request.extend_from_slice(&buffer[..read]),
                        _ => break,
                    }
                }
                let request = String::from_utf8_lossy(&request).to_string();
                log.lock()
                    .unwrap()
                    .push(request.lines().next().unwrap_or("").to_string());
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
        (origin, seen)
    }

    #[tokio::test]
    async fn the_server_is_asked_who_it_is_before_it_is_given_the_token() {
        english();
        let (origin, seen) = serve(vec![(
            200,
            r#"{"environmentId":"env-1","label":"Work Mac","orchestrationProtocolVersion":1}"#,
        )])
        .await;
        assert_eq!(
            descriptor(&origin).await,
            Ok(("env-1".to_string(), "Work Mac".to_string()))
        );
        assert_eq!(
            seen.lock().unwrap()[0],
            "GET /.well-known/t3/environment HTTP/1.1"
        );
    }

    #[tokio::test]
    async fn a_server_of_another_protocol_is_told_apart_and_never_gets_the_token() {
        english();
        let (newer, _) = serve(vec![(
            200,
            r#"{"environmentId":"e","label":"Box","orchestrationProtocolVersion":2}"#,
        )])
        .await;
        let error = descriptor(&newer).await.expect_err("incompatible");
        assert_eq!(error.kind, PairKind::Unsupported);
        assert_eq!(
            error.message,
            "This client is not supported by this server. Update your app or use a compatible release to connect to Box."
        );
        let (older, _) = serve(vec![(
            200,
            r#"{"environmentId":"e","label":"Box","orchestrationProtocolVersion":0}"#,
        )])
        .await;
        assert_eq!(
            descriptor(&older).await.unwrap_err().message,
            "This client requires a newer server. Update OOP on Box to connect."
        );
        // No version at all is the first protocol.
        let (plain, _) = serve(vec![(200, r#"{"environmentId":"e","label":"Box"}"#)]).await;
        assert!(descriptor(&plain).await.is_ok());
    }

    #[tokio::test]
    async fn a_refused_exchange_is_classified_by_the_servers_status() {
        english();
        for (status, kind, message) in [
            (
                401,
                PairKind::Authentication,
                "The environment credential is invalid.",
            ),
            (
                403,
                PairKind::Permission,
                "The environment credential does not grant the required access.",
            ),
            (
                400,
                PairKind::Configuration,
                "The environment rejected the authentication request.",
            ),
            (
                404,
                PairKind::Configuration,
                "The environment endpoint could not be found.",
            ),
            (
                500,
                PairKind::Transient,
                "The environment returned an unexpected response (500).",
            ),
        ] {
            let (origin, seen) = serve(vec![(status, r#"{"error":"x"}"#)]).await;
            let error = token_exchange(&origin, "one-time", "oop terminal (t)")
                .await
                .expect_err("refused");
            assert_eq!(
                (error.kind, error.message.as_str()),
                (kind, message),
                "{status}"
            );
            assert_eq!(seen.lock().unwrap()[0], "POST /oauth/token HTTP/1.1");
        }
    }

    #[tokio::test]
    async fn an_accepted_exchange_gives_the_access_token() {
        english();
        let (origin, _) = serve(vec![(200, r#"{"access_token":"bearer-1"}"#)]).await;
        assert_eq!(
            token_exchange(&origin, "one-time", "L").await,
            Ok("bearer-1".to_string())
        );
        let (empty, _) = serve(vec![(200, "{}")]).await;
        assert_eq!(
            token_exchange(&empty, "one-time", "L")
                .await
                .unwrap_err()
                .kind,
            PairKind::Transient
        );
    }
}
