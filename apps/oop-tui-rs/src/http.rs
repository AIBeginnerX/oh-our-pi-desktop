//! A deliberately small HTTP/1.1 client for the handful of requests the pairing flow needs, over
//! plain TCP for `http://` and over rustls for `https://`. The TLS side is the same one the
//! WebSocket uses (`wire.rs`): `client_config()` builds it on first use only, so a session on this
//! computer never pays for it.

use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName};
use tokio_rustls::rustls::{ClientConfig, RootCertStore};

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
    /// Header names in lower case, in the order they came.
    pub headers: Vec<(String, String)>,
}

impl Response {
    /// The first header of this name (any case).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn json(&self) -> Result<serde_json::Value, String> {
        serde_json::from_slice(&self.body).map_err(|e| format!("answer is not JSON: {e}"))
    }
}

/// An origin read apart: `http://host[:port]` or `https://host[:port]`, nothing after the host.
#[derive(Debug, PartialEq, Eq)]
pub struct Origin {
    pub tls: bool,
    /// Without the brackets of an IPv6 address.
    pub host: String,
    pub port: u16,
}

impl Origin {
    pub fn parse(origin: &str) -> Result<Origin, String> {
        let (tls, rest) = if let Some(rest) = origin.strip_prefix("https://") {
            (true, rest)
        } else if let Some(rest) = origin.strip_prefix("http://") {
            (false, rest)
        } else {
            return Err(format!(
                "only http:// and https:// servers are supported: {origin}"
            ));
        };
        let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
        let default = if tls { 443 } else { 80 };
        let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
            let (host, after) = inner
                .split_once(']')
                .ok_or_else(|| format!("bad address: {origin}"))?;
            (host, after.strip_prefix(':'))
        } else {
            match authority.rsplit_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (authority, None),
            }
        };
        let port = match port {
            None | Some("") => default,
            Some(port) => port.parse().map_err(|_| format!("bad port in {origin}"))?,
        };
        if host.is_empty() {
            return Err(format!("bad address: {origin}"));
        }
        Ok(Origin {
            tls,
            host: host.to_string(),
            port,
        })
    }

    /// `host:port`, with brackets around an IPv6 host.
    pub fn authority(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// `host:port` of an `http://` or `https://` origin (443 or 80 when none is given).
pub fn authority(origin: &str) -> Result<String, String> {
    Origin::parse(origin).map(|o| o.authority())
}

/// `ws` or `wss`, to match the origin's `http` or `https`.
pub fn ws_scheme(origin: &str) -> Result<&'static str, String> {
    Origin::parse(origin).map(|o| if o.tls { "wss" } else { "ws" })
}

/// The TLS settings for every `https://` and `wss://` connection: the Mozilla roots that ship in
/// the binary, plus the PEM certificates in the file `SSL_CERT_FILE` names, when there is one (a
/// private CA, a corporate proxy). The system keychain is never read. Built on first use.
pub fn client_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            if let Some(path) = std::env::var_os("SSL_CERT_FILE").filter(|p| !p.is_empty())
                && let Ok(text) = std::fs::read_to_string(path)
            {
                for der in pem_certificates(&text) {
                    let _ = roots.add(der);
                }
            }
            Arc::new(config_with(roots))
        })
        .clone()
}

pub fn config_with(roots: RootCertStore) -> ClientConfig {
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("the ring provider supports the default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

/// The certificates in a PEM bundle, in order; blocks that do not decode are skipped.
fn pem_certificates(text: &str) -> Vec<CertificateDer<'static>> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("-----BEGIN CERTIFICATE-----") {
        let after = &rest[start + "-----BEGIN CERTIFICATE-----".len()..];
        let Some(end) = after.find("-----END CERTIFICATE-----") else {
            break;
        };
        if let Some(der) = base64_decode(&after[..end]) {
            out.push(CertificateDer::from(der));
        }
        rest = &after[end + "-----END CERTIFICATE-----".len()..];
    }
    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut bits, mut count) = (0u32, 0u32);
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' | b'\t' => continue,
            _ => return None,
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    (!out.is_empty()).then_some(out)
}

pub async fn request(
    method: &str,
    origin: &str,
    path: &str,
    headers: &[(&str, String)],
    body: Option<(&str, Vec<u8>)>,
    timeout: Duration,
) -> Result<Response, String> {
    request_with(None, method, origin, path, headers, body, timeout).await
}

/// `request` with the TLS settings named; `None` means `client_config()`, built only if the origin
/// is `https://`.
pub async fn request_with(
    tls: Option<Arc<ClientConfig>>,
    method: &str,
    origin: &str,
    path: &str,
    headers: &[(&str, String)],
    body: Option<(&str, Vec<u8>)>,
    timeout: Duration,
) -> Result<Response, String> {
    tokio::time::timeout(
        timeout,
        round_trip(tls, method, origin, path, headers, body),
    )
    .await
    .map_err(|_| "the server did not answer in time".to_string())?
}

async fn round_trip(
    tls: Option<Arc<ClientConfig>>,
    method: &str,
    origin: &str,
    path: &str,
    headers: &[(&str, String)],
    body: Option<(&str, Vec<u8>)>,
) -> Result<Response, String> {
    let target = Origin::parse(origin)?;
    let authority = target.authority();
    let tcp = TcpStream::connect(&authority)
        .await
        .map_err(|e| format!("cannot reach {authority}: {e}"))?;
    if !target.tls {
        return exchange(tcp, &authority, method, path, headers, body).await;
    }
    let name = ServerName::try_from(target.host.clone())
        .map_err(|_| format!("{} is not a valid server name", target.host))?;
    let connector = tokio_rustls::TlsConnector::from(tls.unwrap_or_else(client_config));
    let stream = connector
        .connect(name, tcp)
        .await
        .map_err(|e| format!("cannot make a secure connection to {authority}: {e}"))?;
    exchange(stream, &authority, method, path, headers, body).await
}

async fn exchange<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    authority: &str,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    body: Option<(&str, Vec<u8>)>,
) -> Result<Response, String> {
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\nAccept: application/json\r\n"
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    let payload = match &body {
        Some((content_type, bytes)) => {
            head.push_str(&format!(
                "Content-Type: {content_type}\r\nContent-Length: {}\r\n",
                bytes.len()
            ));
            bytes.as_slice()
        }
        // A POST without a body still needs a length, or some servers wait for one.
        None if method == "POST" => {
            head.push_str("Content-Length: 0\r\n");
            &[]
        }
        None => &[],
    };
    head.push_str("\r\n");
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.write_all(payload).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    match stream.read_to_end(&mut raw).await {
        Ok(_) => {}
        // A server that closes the socket without TLS's closing alert has still sent its answer;
        // `parse_response` says if it is cut short.
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof && !raw.is_empty() => {}
        Err(e) => return Err(e.to_string()),
    }
    parse_response(&raw)
}

pub fn parse_response(raw: &[u8]) -> Result<Response, String> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("the answer is cut short")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or("the answer has no status")?;
    let chunked = lines.any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let headers = head
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    let rest = &raw[split + 4..];
    Ok(Response {
        headers,
        status,
        body: if chunked {
            dechunk(rest)?
        } else {
            rest.to_vec()
        },
    })
}

fn dechunk(mut data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let eol = data
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or("bad chunk framing")?;
        let size_text = String::from_utf8_lossy(&data[..eol]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| "bad chunk size")?;
        data = &data[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        if data.len() < size + 2 {
            return Err("chunk is cut short".into());
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
}

/// `application/x-www-form-urlencoded` value encoding.
pub fn form_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Everything the TLS tests share: a certificate for `localhost` made on the spot, the
/// server side that presents it, and a client configuration that trusts it (or not).
#[cfg(test)]
pub(crate) mod testtls {
    use super::*;
    use tokio_rustls::rustls::ServerConfig;
    use tokio_rustls::rustls::pki_types::PrivateKeyDer;

    pub fn server_and_trusting_client() -> (tokio_rustls::TlsAcceptor, Arc<ClientConfig>) {
        let key = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
        let server = ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![key.cert.der().clone()],
                PrivateKeyDer::try_from(key.key_pair.serialize_der()).unwrap(),
            )
            .unwrap();
        let mut roots = RootCertStore::empty();
        roots.add(key.cert.der().clone()).unwrap();
        (
            tokio_rustls::TlsAcceptor::from(Arc::new(server)),
            Arc::new(config_with(roots)),
        )
    }

    /// A client configuration with no trusted roots at all.
    pub fn distrusting_client() -> Arc<ClientConfig> {
        Arc::new(config_with(RootCertStore::empty()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_plain_and_a_chunked_answer() {
        let plain = parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!((plain.status, plain.body.as_slice()), (200, &b"{}"[..]));
        let chunked = parse_response(
            b"HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n",
        )
        .unwrap();
        assert_eq!(
            (chunked.status, chunked.body.as_slice()),
            (401, &b"abcde"[..])
        );
    }

    #[test]
    fn form_values_are_escaped() {
        assert_eq!(form_encode("urn:a b"), "urn%3Aa+b");
    }

    #[test]
    fn origins_are_read_with_their_default_ports() {
        assert_eq!(
            authority("http://127.0.0.1:3911").unwrap(),
            "127.0.0.1:3911"
        );
        assert_eq!(authority("http://example.com").unwrap(), "example.com:80");
        assert_eq!(authority("https://example.com").unwrap(), "example.com:443");
        assert_eq!(
            authority("https://example.com:8443/x").unwrap(),
            "example.com:8443"
        );
        assert_eq!(authority("http://[::1]:3911").unwrap(), "[::1]:3911");
        assert_eq!(authority("https://[::1]").unwrap(), "[::1]:443");
        assert_eq!(ws_scheme("https://a").unwrap(), "wss");
        assert_eq!(ws_scheme("http://a").unwrap(), "ws");
        assert!(authority("ftp://x").is_err());
        assert!(authority("http://").is_err());
        assert!(authority("http://h:notaport").is_err());
    }

    #[test]
    fn a_pem_bundle_is_read_into_certificates() {
        let key = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let bundle = format!("junk\n{}\n{}", key.cert.pem(), key.cert.pem());
        let found = pem_certificates(&bundle);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].as_ref(), key.cert.der().as_ref());
    }

    #[tokio::test]
    async fn an_https_request_round_trips_over_tls() {
        let (acceptor, client) = testtls::server_and_trusting_client();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut tls = acceptor.accept(tcp).await.unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 1024];
            while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = tls.read(&mut buf).await.unwrap();
                seen.extend_from_slice(&buf[..n]);
            }
            let text = String::from_utf8_lossy(&seen).to_string();
            assert!(text.starts_with("GET /hello HTTP/1.1\r\n"), "{text}");
            assert!(text.contains("Host: localhost:"), "{text}");
            tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\n{\"secure\":true}")
                .await
                .unwrap();
            // No closing alert: the client must still keep what it read.
            drop(tls);
        });
        let origin = format!("https://localhost:{port}");
        let answer = request_with(
            Some(client),
            "GET",
            &origin,
            "/hello",
            &[],
            None,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(answer.status, 200);
        assert_eq!(answer.json().unwrap()["secure"], true);
    }

    #[tokio::test]
    async fn a_certificate_nobody_vouches_for_is_refused() {
        let (acceptor, _) = testtls::server_and_trusting_client();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            // The client walks away mid-handshake; the error is expected here.
            let _ = acceptor.accept(tcp).await;
        });
        let error = request_with(
            Some(testtls::distrusting_client()),
            "GET",
            &format!("https://localhost:{port}"),
            "/",
            &[],
            None,
            Duration::from_secs(10),
        )
        .await
        .err()
        .expect("an untrusted certificate must not be accepted");
        assert!(error.contains("secure connection"), "{error}");
    }

    #[test]
    fn the_default_configuration_is_built_once_and_trusts_the_bundled_roots() {
        let first = client_config();
        assert!(Arc::ptr_eq(&first, &client_config()));
    }
}
