//! A deliberately small HTTP/1.1 client for the handful of requests the pairing flow needs.
//! Plain `http://` only: the terminal talks to a server on this computer. Reaching a remote
//! `https://` server would need a TLS stack (see the report), which this slice leaves out.

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Response {
    pub fn json(&self) -> Result<serde_json::Value, String> {
        serde_json::from_slice(&self.body).map_err(|e| format!("answer is not JSON: {e}"))
    }
}

/// `host:port` of an `http://` origin.
pub fn authority(origin: &str) -> Result<String, String> {
    let rest = origin
        .strip_prefix("http://")
        .ok_or_else(|| format!("only http:// servers are supported here: {origin}"))?;
    let host = rest.split('/').next().unwrap_or(rest);
    Ok(if host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:80")
    })
}

pub async fn request(
    method: &str,
    origin: &str,
    path: &str,
    headers: &[(&str, String)],
    body: Option<(&str, Vec<u8>)>,
    timeout: Duration,
) -> Result<Response, String> {
    tokio::time::timeout(timeout, round_trip(method, origin, path, headers, body))
        .await
        .map_err(|_| "the server did not answer in time".to_string())?
}

async fn round_trip(
    method: &str,
    origin: &str,
    path: &str,
    headers: &[(&str, String)],
    body: Option<(&str, Vec<u8>)>,
) -> Result<Response, String> {
    let authority = authority(origin)?;
    let mut stream = TcpStream::connect(&authority)
        .await
        .map_err(|e| format!("cannot reach {authority}: {e}"))?;
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
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .await
        .map_err(|e| e.to_string())?;
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
    let rest = &raw[split + 4..];
    Ok(Response {
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
        assert_eq!(
            authority("http://127.0.0.1:3911").unwrap(),
            "127.0.0.1:3911"
        );
        assert!(authority("https://x").is_err());
    }
}
