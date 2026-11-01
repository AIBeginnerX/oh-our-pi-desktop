//! Finding, starting and pairing with the local OOP server, the way apps/oop-tui/src/link does it:
//! the running server announces itself in `<home>/userdata/server-runtime.json`; the announcement
//! is believed only when the pid is this user's process listening on that port; a token is minted
//! by the server's own `pair` command and traded at `/oauth/token`; the credential file has the
//! same shape as the TypeScript app's, so both apps share one login.

use crate::http;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::process::Command;

/// Same scopes as `AuthStandardClientScopes` in packages/contracts/src/auth.ts.
const SCOPES: &str =
    "orchestration:read orchestration:operate terminal:operate review:write relay:read";
const ORCHESTRATION_PROTOCOL: u64 = 1;
/// Exit code of a server that found the data directory locked by another one.
const LOCK_HELD_EXIT: i32 = 75;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

pub fn user_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// The flag, else `OOP_HOME`, else the desktop app's own home. Whether it was named on purpose
/// matters: an isolated home never gets the installed app's server started in it.
pub fn server_home(flag: Option<&str>) -> (PathBuf, bool) {
    if let Some(path) = flag.map(str::trim).filter(|p| !p.is_empty()) {
        return (PathBuf::from(path), true);
    }
    if let Some(path) = std::env::var("OOP_HOME")
        .ok()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
    {
        return (PathBuf::from(path), true);
    }
    (user_home().join(".oop-desktop"), false)
}

pub fn config_dir() -> PathBuf {
    let env = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    if let Some(dir) = env("OOP_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    env("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".config"))
        .join("oop-tui")
}

// ---------------------------------------------------------------------------------------------
// Credentials: ~/.config/oop-tui/credentials.json, shared with the TypeScript terminal.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub environment_id: String,
    pub label: String,
    pub http_base_url: String,
    pub token: String,
    pub saved_at: String,
}

#[derive(Serialize, Deserialize)]
struct CredentialFile {
    version: u32,
    environments: BTreeMap<String, Value>,
}

fn credentials_path() -> PathBuf {
    config_dir().join("credentials.json")
}

/// Loopback names are one server: `localhost`, `127.0.0.1` and `[::1]` with the same port.
pub fn origins_match(a: &str, b: &str) -> bool {
    let norm = |o: &str| {
        let rest = o
            .trim_end_matches('/')
            .strip_prefix("http://")
            .unwrap_or(o)
            .to_string();
        let (host, port) = rest.rsplit_once(':').unwrap_or((&rest, "80"));
        let host = if matches!(host, "localhost" | "127.0.0.1" | "[::1]") {
            "loopback"
        } else {
            host
        };
        format!("{host}:{port}")
    };
    norm(a) == norm(b)
}

pub fn find_credential(environment_id: &str, origin: &str) -> Result<Option<Credential>, String> {
    let path = credentials_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let file: CredentialFile = serde_json::from_str(&text)
        .map_err(|_| format!("{} is damaged; it was left alone", path.display()))?;
    Ok(file
        .environments
        .values()
        .filter_map(|v| serde_json::from_value::<Credential>(v.clone()).ok())
        .filter(|c| c.environment_id == environment_id && origins_match(&c.http_base_url, origin))
        .max_by(|a, b| a.saved_at.cmp(&b.saved_at)))
}

pub fn save_credential(credential: &Credential) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let path = credentials_path();
    let mut file = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<CredentialFile>(&text)
            .map_err(|_| format!("{} is damaged; it was left alone", path.display()))?,
        Err(_) => CredentialFile {
            version: 1,
            environments: BTreeMap::new(),
        },
    };
    file.environments.retain(|_, v| {
        serde_json::from_value::<Credential>(v.clone()).map_or(true, |c| {
            !(c.environment_id == credential.environment_id
                && origins_match(&c.http_base_url, &credential.http_base_url))
        })
    });
    file.environments.insert(
        format!("{} {}", credential.environment_id, credential.http_base_url),
        serde_json::to_value(credential).map_err(|e| e.to_string())?,
    );
    let directory = path.parent().ok_or("no config directory")?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", crate::text::new_id()));
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        out.write_all(format!("{}\n", serde_json::to_string_pretty(&file)?).as_bytes())?;
        std::fs::rename(&temporary, &path)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        e.to_string()
    })
}

// ---------------------------------------------------------------------------------------------
// Discovery

#[derive(Debug, Clone)]
pub struct Found {
    pub pid: u32,
    pub origin: String,
    pub environment_id: String,
    pub label: String,
}

/// What the server says at `/.well-known/t3/environment`; `None` when nothing OOP-like answers
/// or the server speaks another orchestration protocol.
pub async fn probe(origin: &str) -> Option<(String, String)> {
    let answer = http::request(
        "GET",
        origin,
        "/.well-known/t3/environment",
        &[],
        None,
        PROBE_TIMEOUT,
    )
    .await
    .ok()?;
    let body = answer.json().ok()?;
    if body["orchestrationProtocolVersion"].as_u64() != Some(ORCHESTRATION_PROTOCOL) {
        return None;
    }
    Some((
        body["environmentId"].as_str()?.to_string(),
        body["label"].as_str().unwrap_or("OOP").to_string(),
    ))
}

async fn run(file: &str, args: &[&str], env: &[(&str, &str)]) -> Result<String, String> {
    let mut command = Command::new(file);
    command
        .args(args)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| format!("{file} timed out"))?
        .map_err(|e| format!("{file} failed: {e}"))?;
    if !output.status.success() {
        return Err(format!("{file} failed"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn parse_port(origin: &str) -> Option<u16> {
    http::authority(origin)
        .ok()?
        .rsplit_once(':')?
        .1
        .parse()
        .ok()
}

/// The announced pid's executable and command line, if it is this user's process and listens on
/// the announced port. Anything else (stale file, someone else's server) gets nothing sent to it.
pub async fn inspect(pid: u32, port: u16) -> Option<(String, String)> {
    let pid_text = pid.to_string();
    let ps = |field: &'static str| {
        let pid_text = pid_text.clone();
        async move {
            run("ps", &["-o", field, "-p", &pid_text], &[])
                .await
                .map(|s| s.trim().to_string())
        }
    };
    let me = run("id", &["-u"], &[]).await.ok()?.trim().to_string();
    if ps("uid=").await.ok()? != me {
        return None;
    }
    run(
        "lsof",
        &[
            "-a",
            "-p",
            &pid_text,
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
            "-t",
        ],
        &[],
    )
    .await
    .ok()?;
    let executable = ps("comm=").await.ok()?;
    let command = ps("command=").await.ok()?;
    (!executable.is_empty() && !command.is_empty()).then_some((executable, command))
}

/// The server's script inside its command line: an absolute path ending in
/// `/apps/server/dist/bin.mjs` or `/apps/server/src/bin.ts`. The path may hold spaces but never
/// a space followed by another absolute path (that is where the next argument begins).
pub fn parse_server_script(command: &str) -> Option<String> {
    let end = ["/apps/server/dist/bin.mjs", "/apps/server/src/bin.ts"]
        .iter()
        .filter_map(|suffix| command.find(suffix).map(|at| at + suffix.len()))
        .min()?;
    if command[end..]
        .chars()
        .next()
        .is_some_and(|c| !c.is_whitespace())
    {
        return None;
    }
    let head = &command[..end];
    let start = match head.rfind(" /") {
        Some(at) => at + 1,
        None if head.starts_with('/') => 0,
        None => return None,
    };
    Some(head[start..].to_string())
}

pub fn parse_pairing_token(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.strip_prefix("Token: "))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty() && !t.contains(' '))
}

#[derive(Debug)]
pub enum Discovery {
    Found(Found),
    Missing(String),
}

pub async fn discover(home: &Path) -> Discovery {
    let file = home.join("userdata").join("server-runtime.json");
    let Ok(text) = tokio::fs::read_to_string(&file).await else {
        return Discovery::Missing("no server has announced itself".into());
    };
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let (Some(pid), Some(origin)) = (
        parsed["pid"].as_u64().filter(|p| *p > 0),
        parsed["origin"].as_str(),
    ) else {
        return Discovery::Missing("the server's announcement is unreadable".into());
    };
    let (pid, origin) = (pid as u32, origin.to_string());
    let Some(port) = parse_port(&origin) else {
        return Discovery::Missing("the announced address is not usable".into());
    };
    let Some((environment_id, label)) = probe(&origin).await else {
        return Discovery::Missing(format!("the announced server at {origin} does not answer"));
    };
    if inspect(pid, port).await.is_none() {
        return Discovery::Missing(format!(
            "{origin} (pid {pid}) is not this user's server on that port"
        ));
    }
    Discovery::Found(Found {
        pid,
        origin,
        environment_id,
        label,
    })
}

// ---------------------------------------------------------------------------------------------
// Starting the terminal's own server

struct AppProgram {
    executable: String,
    script: String,
    /// Chosen with `OOP_DAEMON_ENTRY`: allowed in an isolated home.
    explicit: bool,
}

/// `OOP_DAEMON_ENTRY` names a server `bin.mjs` run by `node`; otherwise the installed macOS app
/// runs the server inside its archive as plain Node (`ELECTRON_RUN_AS_NODE`).
fn find_app_program() -> Option<AppProgram> {
    if let Some(entry) = std::env::var("OOP_DAEMON_ENTRY")
        .ok()
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
    {
        return Path::new(&entry).exists().then(|| AppProgram {
            executable: which("node").unwrap_or_else(|| "node".into()),
            script: entry,
            explicit: true,
        });
    }
    if cfg!(target_os = "macos") {
        for base in [
            PathBuf::from("/Applications"),
            user_home().join("Applications"),
        ] {
            let executable = base.join("OOP.app/Contents/MacOS/OOP");
            let archive = base.join("OOP.app/Contents/Resources/app.asar");
            if executable.exists() && archive.exists() {
                return Some(AppProgram {
                    executable: executable.to_string_lossy().into_owned(),
                    script: archive
                        .join("apps/server/dist/bin.mjs")
                        .to_string_lossy()
                        .into_owned(),
                    explicit: false,
                });
            }
        }
    }
    None
}

fn which(program: &str) -> Option<String> {
    std::env::var_os("PATH")?
        .to_string_lossy()
        .split(':')
        .map(|dir| Path::new(dir).join(program))
        .find(|candidate| candidate.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// First free port at or after 3873 (the desktop app keeps 3773). `OOP_RS_FIRST_PORT` moves the
/// start for tests that must stay clear of both.
fn pick_port() -> Option<u16> {
    let first: u16 = std::env::var("OOP_RS_FIRST_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3873);
    (first..first.saturating_add(100)).find(|port| {
        ["127.0.0.1", "0.0.0.0", "::"].iter().all(|host| {
            match std::net::TcpListener::bind((*host, *port)) {
                Ok(_) => true,
                // No address for that family (no IPv6) counts as free.
                Err(e) => e.kind() == std::io::ErrorKind::AddrNotAvailable,
            }
        })
    })
}

enum Started {
    Ready,
    Occupied,
}

/// Starts `serve --daemon` detached (no window, no stdio, own process group) and waits until it
/// announces itself, exits because another one holds the lock, or the time is up.
async fn start_daemon(
    home: &Path,
    isolated: bool,
    notify: &impl Fn(&str),
) -> Result<Started, String> {
    let program =
        find_app_program().ok_or("no OOP app is installed here to start a server from")?;
    if isolated && !program.explicit {
        return Err(
            "an isolated home is only served by OOP_DAEMON_ENTRY, not by the installed app".into(),
        );
    }
    let port = pick_port().ok_or("no free port to start a server on")?;
    notify("starting the OOP server…");
    let mut command = std::process::Command::new(&program.executable);
    command
        .args([&program.script, "serve", "--daemon", "--base-dir"])
        .arg(home)
        .args(["--host", "127.0.0.1", "--port"])
        .arg(port.to_string())
        .current_dir(user_home())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("ELECTRON_RUN_AS_NODE", "1");
    for (name, _) in std::env::vars().filter(|(n, _)| n.starts_with("T3CODE_")) {
        command.env_remove(name);
    }
    use std::os::unix::process::CommandExt;
    // A session of its own, like the TypeScript terminal's `detached: true`: the server keeps no
    // controlling terminal, so it can never take the foreground away from this terminal's keys.
    // SAFETY: `setsid` is async-signal-safe and touches no memory of this process.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("cannot run the server: {e}"))?;
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if let Discovery::Found(_) = discover(home).await {
            return Ok(Started::Ready);
        }
        if let Ok(Some(status)) = child.try_wait() {
            return if status.code() == Some(LOCK_HELD_EXIT) {
                Ok(Started::Occupied)
            } else {
                Err(format!("the server ended at once ({status})"))
            };
        }
        if Instant::now() >= deadline {
            return Err("the server did not come up in time".into());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// A server to talk to: the announced one, else one started here.
pub async fn resolve(home: &Path, isolated: bool, notify: impl Fn(&str)) -> Result<Found, String> {
    if let Discovery::Found(found) = discover(home).await {
        return Ok(found);
    }
    match start_daemon(home, isolated, &notify).await? {
        Started::Ready => {}
        Started::Occupied => {
            // Whoever holds the lock is about to announce itself.
            let deadline = Instant::now() + STARTUP_TIMEOUT;
            while Instant::now() < deadline {
                if let Discovery::Found(_) = discover(home).await {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    match discover(home).await {
        Discovery::Found(found) => Ok(found),
        Discovery::Missing(detail) => Err(detail),
    }
}

// ---------------------------------------------------------------------------------------------
// Pairing and sessions

pub fn client_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        _ => "Linux",
    }
}

pub async fn client_label() -> String {
    let host = run("hostname", &[], &[]).await.unwrap_or_default();
    format!("oop terminal ({})", host.trim())
}

/// Asks the running server's own program for a one-time token (`pair --ttl 1m`), so it always
/// matches the server's version. Whoever may run it can already read this user's OOP data.
async fn mint_local_pairing_token(found: &Found, home: &Path, label: &str) -> Option<String> {
    let port = parse_port(&found.origin)?;
    let (executable, command) = inspect(found.pid, port).await?;
    let script = parse_server_script(&command)?;
    let output = run(
        &executable,
        &[
            &script,
            "pair",
            "--base-dir",
            &home.to_string_lossy(),
            "--label",
            label,
            "--ttl",
            "1m",
        ],
        &[("ELECTRON_RUN_AS_NODE", "1")],
    )
    .await
    .ok()?;
    parse_pairing_token(&output)
}

/// Trades a one-time token for a bearer token at `/oauth/token` (form-encoded token exchange).
pub async fn exchange(origin: &str, credential: &str, label: &str) -> Result<String, String> {
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
    .await?;
    let json = answer.json().unwrap_or(Value::Null);
    if answer.status != 200 {
        let why = json["error_description"]
            .as_str()
            .or(json["message"].as_str())
            .unwrap_or("the token was refused");
        return Err(format!("pairing failed ({}): {why}", answer.status));
    }
    json["access_token"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "the server sent no access token".into())
}

/// False only when the server says the token is no good (an unreachable server is not that).
async fn session_valid(origin: &str, token: &str) -> bool {
    let auth = [("Authorization", format!("Bearer {token}"))];
    match http::request(
        "GET",
        origin,
        "/api/auth/session",
        &auth,
        None,
        PROBE_TIMEOUT,
    )
    .await
    {
        Ok(answer) if answer.status == 401 || answer.status == 403 => false,
        Ok(answer) if answer.status == 200 => answer
            .json()
            .map_or(true, |b| b["authenticated"] != Value::Bool(false)),
        _ => true,
    }
}

/// The saved bearer token for this server, or a new one: minted through the server's own program
/// and saved. `Err` carries what the user should do.
pub async fn bearer_for(
    found: &Found,
    home: &Path,
    notify: impl Fn(&str),
) -> Result<String, String> {
    if let Some(saved) = find_credential(&found.environment_id, &found.origin)?
        && session_valid(&found.origin, &saved.token).await
    {
        return Ok(saved.token);
    }
    let label = client_label().await;
    notify("pairing with this computer's server…");
    let token = mint_local_pairing_token(found, home, &label).await.ok_or(
        "this server cannot be paired automatically; run `oop-rs pair <token> --server <address>`",
    )?;
    let bearer = exchange(&found.origin, &token, &label).await?;
    save(found, &bearer)?;
    Ok(bearer)
}

pub fn save(found: &Found, bearer: &str) -> Result<(), String> {
    save_credential(&Credential {
        environment_id: found.environment_id.clone(),
        label: found.label.clone(),
        http_base_url: found.origin.clone(),
        token: bearer.to_string(),
        saved_at: crate::text::iso_now(),
    })
}

/// `oop-rs pair <token> --server <address>`: the manual path for a server that is not started or
/// paired by this terminal.
pub async fn pair_manually(origin: &str, credential: &str) -> Result<Found, String> {
    let (environment_id, label) = probe(origin)
        .await
        .ok_or_else(|| format!("nothing answers at {origin}"))?;
    let bearer = exchange(origin, credential, &client_label().await).await?;
    let found = Found {
        pid: 0,
        origin: origin.to_string(),
        environment_id,
        label,
    };
    save(&found, &bearer)?;
    Ok(found)
}

/// The WebSocket address for one session: a one-time ticket from the bearer token, plus the same
/// client parameters the TypeScript transport sends.
pub async fn websocket_url(found: &Found, bearer: &str, version: &str) -> Result<String, String> {
    let auth = [("Authorization", format!("Bearer {bearer}"))];
    let answer = http::request(
        "POST",
        &found.origin,
        "/api/auth/websocket-ticket",
        &auth,
        None,
        Duration::from_secs(10),
    )
    .await?;
    if answer.status == 401 || answer.status == 403 {
        return Err("the saved login was refused; run oop-rs again to pair anew".into());
    }
    let ticket = answer.json()?["ticket"]
        .as_str()
        .ok_or("the server issued no WebSocket ticket")?
        .to_string();
    let authority = http::authority(&found.origin)?;
    Ok(format!(
        "ws://{authority}/ws?wsTicket={}&clientSurface=cli&clientAppVersion={}&clientDeviceType=desktop&clientOs={}&connectionMethod=direct&orchestrationProtocol={ORCHESTRATION_PROTOCOL}",
        http::form_encode(&ticket),
        http::form_encode(version),
        http::form_encode(client_os()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_server_script_in_a_command_line() {
        let command = "/Applications/OOP.app/Contents/MacOS/OOP /Applications/OOP.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs serve --daemon --base-dir /x";
        assert_eq!(
            parse_server_script(command).as_deref(),
            Some("/Applications/OOP.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs")
        );
        let spaced = "node /Users/a b/repo/apps/server/dist/bin.mjs serve";
        assert_eq!(
            parse_server_script(spaced).as_deref(),
            Some("/Users/a b/repo/apps/server/dist/bin.mjs")
        );
        assert_eq!(parse_server_script("node other.js"), None);
    }

    #[test]
    fn reads_the_token_line() {
        assert_eq!(
            parse_pairing_token("Pairing URL: x\nToken: 42ATXLU3TPXM\nExpires: y").as_deref(),
            Some("42ATXLU3TPXM")
        );
        assert_eq!(parse_pairing_token("nothing"), None);
    }

    #[test]
    fn loopback_names_are_one_server() {
        assert!(origins_match(
            "http://127.0.0.1:3911",
            "http://localhost:3911"
        ));
        assert!(!origins_match(
            "http://127.0.0.1:3911",
            "http://127.0.0.1:3912"
        ));
    }
}
