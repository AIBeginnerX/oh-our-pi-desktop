//! What this computer's Tailscale says about reaching the OOP server: the HTTPS address a phone on
//! the same tailnet can open (`https://<machine>.<tailnet>.ts.net`). The server does not tell
//! clients this (the desktop app works it out itself, `tailscaleEndpointProvider.ts`), so it is
//! read the same way here, with two read-only commands: `tailscale status --json` for the MagicDNS
//! name and `tailscale serve status --json` for the mapping that fronts the server's port. Where
//! `serve status` cannot be read (it can need more rights than `status`), the address is asked who
//! it is instead. Nothing is ever configured: no `serve` is started, no key is read or printed.

use crate::http;
use serde_json::Value;
use std::time::Duration;
use tokio::process::Command;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);

/// The MagicDNS name of this machine, when Tailscale is running (`Self.DNSName`, lower case, no
/// trailing dot).
pub fn magic_dns_name(status_json: &str) -> Option<String> {
    let status: Value = serde_json::from_str(status_json).ok()?;
    if status["BackendState"]
        .as_str()
        .is_some_and(|state| state != "Running")
    {
        return None;
    }
    let name = status["Self"]["DNSName"]
        .as_str()?
        .trim()
        .trim_end_matches('.');
    (!name.is_empty()).then(|| name.to_ascii_lowercase())
}

/// The `https://` address Tailscale Serve gives the server on `local_port`: an HTTPS listener on
/// this machine's own name whose `/` proxies to that loopback port. `None` when there is no such
/// mapping (another port, another program, plain HTTP).
pub fn served_https_origin(dns_name: &str, serve_json: &str, local_port: u16) -> Option<String> {
    let serve: Value = serde_json::from_str(serve_json).ok()?;
    serve["Web"].as_object()?.iter().find_map(|(key, site)| {
        let (host, port) = key.rsplit_once(':')?;
        let proxy = site["Handlers"]["/"]["Proxy"].as_str()?;
        let target = http::Origin::parse(proxy).ok()?;
        let loopback = matches!(target.host.as_str(), "127.0.0.1" | "localhost" | "::1");
        (host.eq_ignore_ascii_case(dns_name)
            && serve["TCP"][port]["HTTPS"].as_bool() == Some(true)
            && !target.tls
            && loopback
            && target.port == local_port)
            .then(|| match port {
                "443" => format!("https://{dns_name}"),
                port => format!("https://{dns_name}:{port}"),
            })
    })
}

/// Runs `tailscale <args>` and returns what it printed; `None` when it is missing, fails or is slow.
async fn output(args: &[&str]) -> Option<String> {
    let program = if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    };
    let child = Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let done = tokio::time::timeout(COMMAND_TIMEOUT, child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    done.status
        .success()
        .then(|| String::from_utf8(done.stdout).ok())?
}

/// The Tailscale HTTPS address of the server at `server_origin` (a loopback address of this
/// computer) whose environment id is `environment_id`, when this computer publishes it.
pub async fn https_origin(server_origin: &str, environment_id: &str) -> Option<String> {
    let local_port = http::Origin::parse(server_origin).ok()?.port;
    let dns_name = magic_dns_name(&output(&["status", "--json"]).await?)?;
    match output(&["serve", "status", "--json"]).await {
        Some(serve) => served_https_origin(&dns_name, &serve, local_port),
        None => {
            let origin = format!("https://{dns_name}");
            let (id, _) = crate::server::probe(&origin).await?;
            (id == environment_id).then_some(origin)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS: &str = r#"{"Version":"1.80.0","BackendState":"Running","Self":{"DNSName":"Devbox.tail0000ab.ts.net.","TailscaleIPs":["100.101.102.103"]}}"#;
    const SERVE: &str = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"devbox.tail0000ab.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3773"}}}}}"#;
    const NAME: &str = "devbox.tail0000ab.ts.net";

    #[test]
    fn the_machines_own_name_is_read_when_tailscale_runs() {
        assert_eq!(magic_dns_name(STATUS).as_deref(), Some(NAME));
        let stopped = STATUS.replace("Running", "Stopped");
        assert_eq!(magic_dns_name(&stopped), None);
        assert_eq!(magic_dns_name(r#"{"Self":{"DNSName":""}}"#), None);
        assert_eq!(magic_dns_name(r#"{"Self":{}}"#), None);
        assert_eq!(magic_dns_name("not json"), None);
    }

    #[test]
    fn a_serve_mapping_to_the_servers_port_gives_its_https_address() {
        assert_eq!(
            served_https_origin(NAME, SERVE, 3773).as_deref(),
            Some("https://devbox.tail0000ab.ts.net")
        );
        // Another HTTPS port is written into the address.
        let other = SERVE.replace("443", "8443");
        assert_eq!(
            served_https_origin(NAME, &other, 3773).as_deref(),
            Some("https://devbox.tail0000ab.ts.net:8443")
        );
    }

    #[test]
    fn a_mapping_that_is_not_this_server_over_https_gives_nothing() {
        // Another program's port, plain HTTP, a sub-path only, another machine, nothing served.
        assert_eq!(served_https_origin(NAME, SERVE, 4000), None);
        let plain = SERVE.replace(r#""HTTPS":true"#, r#""HTTP":true"#);
        assert_eq!(served_https_origin(NAME, &plain, 3773), None);
        let sub = SERVE.replace(r#""/":"#, r#""/api":"#);
        assert_eq!(served_https_origin(NAME, &sub, 3773), None);
        assert_eq!(served_https_origin("other.ts.net", SERVE, 3773), None);
        let remote = SERVE.replace("127.0.0.1", "10.0.0.9");
        assert_eq!(served_https_origin(NAME, &remote, 3773), None);
        assert_eq!(served_https_origin(NAME, "{}", 3773), None);
        assert_eq!(served_https_origin(NAME, "nope", 3773), None);
    }

    #[test]
    fn a_localhost_proxy_with_a_trailing_slash_still_counts() {
        let json = SERVE.replace("http://127.0.0.1:3773", "http://localhost:3773/");
        assert!(served_https_origin(NAME, &json, 3773).is_some());
    }
}
