//! `oop ssh <host>`: work on another computer's projects over SSH, the way the desktop app's
//! "Desktop-managed SSH" does, and on the same remote layout (`~/.oop-desktop`), so the app and the
//! terminal share one server there.
//!
//! The system `ssh` does all the talking (aliases from `~/.ssh/config` apply, and password or
//! passphrase prompts reach the user through the terminal before the screen is taken over).
//! Three short remote steps use one small `sh` script sent on standard input: look for a server
//! (`probe`), start one from the newest installed runtime when there is none (`start`), mint a
//! one-time pairing token (`pair`). Then `ssh -N -L` forwards a free local port to the server,
//! the token is traded through that loopback address like any pairing, and the ordinary
//! connection runs against the forwarded address. The forward ends when the terminal does; the
//! remote server is left running, as the desktop leaves it.

use crate::panels_common::{fill, s};
use crate::server;
use std::cmp::Ordering;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

/// How long one remote step may take, including typing a password.
const STEP_TIMEOUT: Duration = Duration::from_secs(180);
/// How long the forward may take to come up, including authentication.
const FORWARD_TIMEOUT: Duration = Duration::from_secs(120);

/// The remote steps, run as `sh -s -- <mode> [version] [label]`. The shell parts follow the
/// desktop's launch script (packages/ssh/src/tunnel.ts): a server counts when the runtime file
/// names a live pid and an http loopback origin; a new one is `t3 serve` from a pinned runtime,
/// noted in `ssh-launch/<id>/` with the same file names. No JSON tool is assumed on the host.
const REMOTE_SCRIPT: &str = r#"set -eu
HOME_DIR="$HOME/.oop-desktop"
RUNTIME_FILE="$HOME_DIR/userdata/server-runtime.json"
STATE_DIR="$HOME_DIR/ssh-launch/oop-terminal"
live_port() {
  [ -f "$RUNTIME_FILE" ] || return 1
  flat=$(tr -d '\n\r' < "$RUNTIME_FILE")
  pid=$(printf '%s' "$flat" | sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  port=$(printf '%s' "$flat" | sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  origin=$(printf '%s' "$flat" | sed -n 's/.*"origin"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  case "$origin" in
    http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) ;;
    *) return 1 ;;
  esac
  [ -n "$pid" ] && [ -n "$port" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$port"
}
# The runtime version a live server runs from, read off its pid's executable or command line.
# Empty when it cannot be told (a server started some other way).
server_version() {
  flat=$(tr -d '\n\r' < "$RUNTIME_FILE")
  pid=$(printf '%s' "$flat" | sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  cmd=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
  case "$cmd" in */runtime/versions/*/t3*) ;; *) cmd=$(ps -o command= -p "$pid" 2>/dev/null || true) ;; esac
  printf '%s' "$cmd" | sed -n 's|.*/runtime/versions/\([^/ ]*\)/t3.*|\1|p' | head -n 1
}
report_running() {
  printf 'OOP_SSH_RUNNING %s\n' "$1"
  v=$(server_version || true)
  [ -z "$v" ] || printf 'OOP_SSH_SERVER_VERSION %s\n' "$v"
}
versions() {
  for dir in "$HOME_DIR"/runtime/versions/*/; do
    [ -x "${dir}t3" ] && printf 'OOP_SSH_VERSION %s\n' "$(basename "$dir")"
  done
  return 0
}
case "$1" in
probe)
  if port=$(live_port); then report_running "$port"; else printf 'OOP_SSH_STOPPED\n'; fi
  versions
  ;;
start)
  T3="$HOME_DIR/runtime/versions/$2/t3"
  [ -x "$T3" ] || { printf 'The runtime %s is not installed on this host.\n' "$2" >&2; exit 1; }
  if port=$(live_port); then report_running "$port"; exit 0; fi
  mkdir -p "$STATE_DIR"
  port=$("$T3" __ssh-helper pick-port "$STATE_DIR/port" 3773 200) || { printf 'No free port on this host.\n' >&2; exit 1; }
  nohup env T3CODE_NO_BROWSER=1 "$T3" serve --host 127.0.0.1 --port "$port" --base-dir "$HOME_DIR" >>"$STATE_DIR/server.log" 2>&1 < /dev/null &
  pid=$!
  printf '%s\n' "$pid" >"$STATE_DIR/pid"
  printf '%s\n' "$port" >"$STATE_DIR/port"
  printf 'managed\n' >"$STATE_DIR/managed"
  if ! "$T3" __ssh-helper wait-ready "$port" 60000 1000; then
    printf 'The server did not become ready on 127.0.0.1:%s.\n' "$port" >&2
    tail -n 40 "$STATE_DIR/server.log" >&2 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    rm -f "$STATE_DIR/pid" "$STATE_DIR/port" "$STATE_DIR/managed"
    exit 1
  fi
  printf 'OOP_SSH_RUNNING %s\n' "$port"
  ;;
pair)
  T3="$HOME_DIR/runtime/versions/$2/t3"
  [ -x "$T3" ] || { printf 'The runtime %s that the running server uses is not installed under %s.\n' "$2" "$HOME_DIR/runtime/versions" >&2; exit 1; }
  "$T3" pair --base-dir "$HOME_DIR" --label "$3" --ttl 1m
  ;;
*)
  printf 'unknown step\n' >&2
  exit 2
  ;;
esac
"#;

// ---------------------------------------------------------------------------------------------
// Pure parts

/// The host of `oop ssh <host>`: anything `ssh` takes (`user@host`, an alias), but never something
/// that reads as an option.
pub fn parse_host(words: &[String]) -> Result<String, String> {
    let usage = || {
        s(
            "Usage: oop ssh <host or ssh alias>",
            "사용법: oop ssh <호스트 또는 ssh 별칭>",
        )
        .to_string()
    };
    let [host] = words else {
        return Err(usage());
    };
    let host = host.trim();
    if host.is_empty() || host.starts_with('-') || host.chars().any(char::is_whitespace) {
        return Err(usage());
    }
    Ok(host.to_string())
}

/// One word for the remote shell: ssh joins the command words with spaces and the far side's
/// shell splits them again.
fn shell_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

/// The `ssh` arguments that run one remote step, the script arriving on standard input.
fn step_args(host: &str, step: &[&str]) -> Vec<String> {
    let mut args = vec!["-o".to_string(), "LogLevel=ERROR".to_string()];
    args.extend(["--".to_string(), host.to_string()]);
    let words: Vec<String> = ["sh", "-s", "--"]
        .into_iter()
        .chain(step.iter().copied())
        .map(shell_quote)
        .collect();
    args.push(words.join(" "));
    args
}

/// The `ssh` arguments that forward a local loopback port to the server and do nothing else.
/// A forward that cannot be made ends ssh instead of leaving a session without it.
fn forward_args(host: &str, local: u16, remote: u16) -> Vec<String> {
    [
        "-N",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-L",
    ]
    .into_iter()
    .map(str::to_string)
    .chain([
        format!("127.0.0.1:{local}:127.0.0.1:{remote}"),
        "--".to_string(),
        host.to_string(),
    ])
    .collect()
}

/// What the `probe` step found on the host.
#[derive(Debug, PartialEq, Eq)]
pub struct Probe {
    /// The loopback port of a ready server, when one is running.
    pub running: Option<u16>,
    /// The runtime version the running server was started from, when the host could tell.
    pub server_version: Option<String>,
    /// The installed runtimes (`~/.oop-desktop/runtime/versions/*`), in the order listed.
    pub versions: Vec<String>,
}

/// Reads a step's output. Lines that are not ours (a login banner, a motd) are skipped, so only
/// the marked ones count.
pub fn parse_probe(output: &str) -> Result<Probe, String> {
    let (mut running, mut stopped, mut versions) = (None, false, Vec::new());
    let mut server_version = None;
    for line in output.lines() {
        if let Some(port) = line.strip_prefix("OOP_SSH_RUNNING ") {
            running = Some(port.trim().parse::<u16>().map_err(|_| unreadable())?);
        } else if line.trim() == "OOP_SSH_STOPPED" {
            stopped = true;
        } else if let Some(version) = line.strip_prefix("OOP_SSH_SERVER_VERSION ") {
            let version = version.trim();
            if is_version_name(version) {
                server_version = Some(version.to_string());
            }
        } else if let Some(version) = line.strip_prefix("OOP_SSH_VERSION ") {
            let version = version.trim();
            if is_version_name(version) {
                versions.push(version.to_string());
            }
        }
    }
    if running.is_none() && !stopped {
        return Err(unreadable());
    }
    Ok(Probe {
        running,
        server_version,
        versions,
    })
}

fn unreadable() -> String {
    s(
        "The host's answer could not be understood.",
        "호스트의 응답을 해석하지 못했습니다.",
    )
    .to_string()
}

/// A folder name that is safe to hand back to the host as a version.
fn is_version_name(name: &str) -> bool {
    !name.is_empty()
        && name.starts_with(|c: char| c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'))
}

/// Semantic-version order: the numbers of the core first, a release above its pre-releases, then
/// the pre-release words (numbers as numbers).
fn compare_versions(a: &str, b: &str) -> Ordering {
    fn split(version: &str) -> (Vec<u64>, Option<&str>) {
        let version = version.split('+').next().unwrap_or(version);
        let (core, pre) = match version.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (version, None),
        };
        let numbers = core
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect();
        (numbers, pre)
    }
    let ((core_a, pre_a), (core_b, pre_b)) = (split(a), split(b));
    core_a.cmp(&core_b).then_with(|| match (pre_a, pre_b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => {
            let mut x = x.split('.');
            let mut y = y.split('.');
            loop {
                match (x.next(), y.next()) {
                    (None, None) => return Ordering::Equal,
                    (None, Some(_)) => return Ordering::Less,
                    (Some(_), None) => return Ordering::Greater,
                    (Some(p), Some(q)) => {
                        let order = match (p.parse::<u64>(), q.parse::<u64>()) {
                            (Ok(p), Ok(q)) => p.cmp(&q),
                            (Ok(_), Err(_)) => Ordering::Less,
                            (Err(_), Ok(_)) => Ordering::Greater,
                            (Err(_), Err(_)) => p.cmp(q),
                        };
                        if order != Ordering::Equal {
                            return order;
                        }
                    }
                }
            }
        }
    })
}

/// The newest installed runtime.
pub fn newest_version(versions: &[String]) -> Option<&str> {
    versions
        .iter()
        .max_by(|a, b| compare_versions(a, b))
        .map(String::as_str)
}

/// Whether a one-time token has to be minted: no saved login for this server, or the server no
/// longer accepts the saved one.
pub fn needs_pairing(has_saved: bool, saved_is_valid: bool) -> bool {
    !(has_saved && saved_is_valid)
}

/// The runtime whose `t3 pair` may mint the token: the one the running server was started from.
/// A newer `pair` would migrate the database under an older server, so nothing else will do; when
/// the version is unknown or not installed there is no fallback. `started` is the version this
/// terminal started the server from, which is known without asking the host.
pub fn pair_runtime(
    server_version: Option<&str>,
    started: Option<&str>,
    installed: &[String],
    host: &str,
) -> Result<String, String> {
    let version = match (server_version, started) {
        (Some(version), _) | (None, Some(version)) => version,
        (None, None) => {
            return Err(fill(
                s(
                    "Could not tell which OOP runtime the server on {host} runs, so no pairing token was made (a different version could change its database). Connect to the host from the OOP desktop app, or restart the server there from an installed runtime.",
                    "{host} 의 서버가 어느 OOP 런타임으로 실행 중인지 알 수 없어 페어링 토큰을 만들지 않았습니다(다른 버전이면 데이터베이스가 바뀔 수 있습니다). OOP 데스크톱 앱으로 그 호스트에 연결하거나, 설치된 런타임으로 서버를 다시 시작하세요.",
                ),
                &[("host", host.to_string())],
            ));
        }
    };
    if started.is_none() && !installed.iter().any(|v| v == version) {
        return Err(fill(
            s(
                "The server on {host} runs runtime {version}, which is not installed under ~/.oop-desktop/runtime/versions, so no pairing token was made.",
                "{host} 의 서버는 런타임 {version} 으로 실행 중인데 ~/.oop-desktop/runtime/versions 에 설치되어 있지 않아 페어링 토큰을 만들지 않았습니다.",
            ),
            &[("host", host.to_string()), ("version", version.to_string())],
        ));
    }
    Ok(version.to_string())
}

fn no_runtime(host: &str) -> String {
    fill(
        s(
            "No OOP server is running on {host} and no runtime is installed there. Connect to it once from the OOP desktop app (Settings -> Connections -> SSH), or install t3 under ~/.oop-desktop/runtime/versions/<version>/ on the host.",
            "{host} 에서 실행 중인 OOP 서버도, 설치된 런타임도 없습니다. OOP 데스크톱 앱에서 한 번 연결하거나(설정 -> 연결 -> SSH), 호스트의 ~/.oop-desktop/runtime/versions/<버전>/ 에 t3 를 설치하세요.",
        ),
        &[("host", host.to_string())],
    )
}

// ---------------------------------------------------------------------------------------------
// Running ssh

/// One remote step; `Ok` is its standard output.
async fn remote_step(host: &str, step: &[&str]) -> Result<String, String> {
    let mut child = Command::new("ssh")
        .args(step_args(host, step))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            fill(
                s(
                    "Could not run ssh: {error}",
                    "ssh 를 실행하지 못했습니다: {error}",
                ),
                &[("error", e.to_string())],
            )
        })?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let script = REMOTE_SCRIPT.to_string();
    // A step that ends before reading the whole script closes the pipe; its exit status says why.
    tokio::spawn(async move {
        let _ = stdin.write_all(script.as_bytes()).await;
    });
    let output = tokio::time::timeout(STEP_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| {
            s(
                "The SSH command took too long.",
                "SSH 명령이 너무 오래 걸립니다.",
            )
            .to_string()
        })?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(step_failure(
            host,
            output.status.code(),
            &String::from_utf8_lossy(&output.stderr),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// What a failed remote step says: ssh's own words, or its exit status when it said nothing, and
/// for a refused host key the way forward. (Host key questions themselves are asked by ssh on the
/// terminal, `/dev/tty`, before the screen is taken over; only a "no" or a changed key lands here.)
fn step_failure(host: &str, code: Option<i32>, stderr: &str) -> String {
    let said = stderr.trim();
    let why = if said.is_empty() {
        match code {
            Some(code) => fill(
                s(
                    "ssh exited with status {code}",
                    "ssh 가 종료 코드 {code} 로 끝났습니다",
                ),
                &[("code", code.to_string())],
            ),
            None => s(
                "ssh was stopped by a signal",
                "ssh 가 시그널로 중단되었습니다",
            )
            .to_string(),
        }
    } else {
        said.to_string()
    };
    let failure = fill(
        s(
            "ssh to {host} failed: {why}",
            "{host} 로의 ssh 가 실패했습니다: {why}",
        ),
        &[("host", host.to_string()), ("why", why)],
    );
    if !said.contains("Host key verification failed") {
        return failure;
    }
    fill(
        s(
            "{failure}\nThe host's key was not accepted. Run 'ssh {host}' once to check its fingerprint and answer yes, or fix the entry in ~/.ssh/known_hosts if the key changed.",
            "{failure}\n호스트 키가 수락되지 않았습니다. 'ssh {host}' 를 한 번 실행해 지문을 확인하고 yes 로 답하거나, 키가 바뀐 경우 ~/.ssh/known_hosts 의 항목을 고치세요.",
        ),
        &[("failure", failure), ("host", host.to_string())],
    )
}

/// The forward to the host's server; it is torn down with the value.
pub struct Tunnel {
    child: Child,
    /// The local address of the server: `http://127.0.0.1:<port>`.
    pub origin: String,
}

impl Tunnel {
    /// Resolves when ssh ends: the connection was lost or closed.
    pub async fn exited(&mut self) {
        let _ = self.child.wait().await;
    }
}

fn free_local_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|e| e.to_string())
}

async fn open_tunnel(host: &str, remote_port: u16) -> Result<Tunnel, String> {
    let local = free_local_port()?;
    let mut child = Command::new("ssh")
        .args(forward_args(host, local, remote_port))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    // What ssh says is kept for a failure and then thrown away, so it never draws on the screen.
    let said = Arc::new(Mutex::new(String::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let said = said.clone();
        tokio::spawn(async move {
            let mut buffer = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
                let mut said = said.lock().unwrap_or_else(|e| e.into_inner());
                if said.len() < 4096 {
                    said.push_str(&String::from_utf8_lossy(&buffer[..n]));
                }
            }
        });
    }
    let origin = format!("http://127.0.0.1:{local}");
    let deadline = tokio::time::Instant::now() + FORWARD_TIMEOUT;
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let why = said
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .trim()
                .to_string();
            return Err(fill(
                s(
                    "The SSH forward to {host} ended: {why}",
                    "{host} 로의 SSH 포워드가 끝났습니다: {why}",
                ),
                &[("host", host.to_string()), ("why", why)],
            ));
        }
        if server::probe(&origin).await.is_some() {
            return Ok(Tunnel { child, origin });
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(s(
                "The server on the host did not answer through the SSH forward.",
                "호스트의 서버가 SSH 포워드를 통해 응답하지 않습니다.",
            )
            .to_string());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Makes sure the host has a server, forwards a port to it and has a valid login for it saved.
/// The returned tunnel carries the address to connect to.
pub async fn connect(host: &str, progress: impl Fn(&str)) -> Result<Tunnel, String> {
    server::verify_credentials()?;
    progress(&fill(
        s(
            "Connecting to {host} over SSH...",
            "{host} 에 SSH 로 연결하는 중입니다...",
        ),
        &[("host", host.to_string())],
    ));
    let probe = parse_probe(&remote_step(host, &["probe"]).await?)?;
    let mut server_version = probe.server_version.clone();
    let mut started_version = None;
    let port = match probe.running {
        Some(port) => port,
        None => {
            let version = newest_version(&probe.versions).ok_or_else(|| no_runtime(host))?;
            progress(&fill(
                s(
                    "Starting an OOP server on {host}...",
                    "{host} 에서 OOP 서버를 시작하는 중입니다...",
                ),
                &[("host", host.to_string())],
            ));
            let started = parse_probe(&remote_step(host, &["start", version]).await?)?;
            server_version = started.server_version;
            started_version = Some(version.to_string());
            started.running.ok_or_else(unreadable)?
        }
    };
    let tunnel = open_tunnel(host, port).await?;
    let (environment_id, label) = server::probe(&tunnel.origin).await.ok_or_else(unreadable)?;
    let saved = server::find_credential(&environment_id, &tunnel.origin)?;
    let valid = match &saved {
        Some(saved) => server::session_valid(&tunnel.origin, &saved.token).await,
        None => false,
    };
    if !needs_pairing(saved.is_some(), valid) {
        return Ok(tunnel);
    }
    progress(s("Pairing...", "연결(페어링) 중입니다..."));
    let version = pair_runtime(
        server_version.as_deref(),
        started_version.as_deref(),
        &probe.versions,
        host,
    )?;
    let client = server::client_label().await;
    let output = remote_step(host, &["pair", &version, &client]).await?;
    let token = server::parse_pairing_token(&output).ok_or_else(|| {
        s(
            "The host did not give out a pairing token.",
            "호스트가 페어링 토큰을 주지 않았습니다.",
        )
        .to_string()
    })?;
    let bearer = server::exchange(&tunnel.origin, &token, &client).await?;
    server::save_credential(&server::Credential {
        environment_id,
        label,
        http_base_url: tunnel.origin.clone(),
        token: bearer,
        saved_at: crate::text::iso_now(),
    })?;
    Ok(tunnel)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn one_host_is_taken_and_options_are_not() {
        assert_eq!(parse_host(&words(&["me@box"])).unwrap(), "me@box");
        assert_eq!(parse_host(&words(&["devbox"])).unwrap(), "devbox");
        assert!(parse_host(&words(&[])).is_err());
        assert!(parse_host(&words(&["a", "b"])).is_err());
        assert!(parse_host(&words(&["-oProxyCommand=x"])).is_err());
        assert!(parse_host(&words(&["a b"])).is_err());
        assert!(parse_host(&words(&[" "])).is_err());
    }

    #[test]
    fn remote_words_are_quoted_for_the_far_shell() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(
            shell_quote("oop terminal (it's)"),
            "'oop terminal (it'\\''s)'"
        );
        let args = step_args("box", &["pair", "1.2.3", "oop terminal (mac)"]);
        assert_eq!(&args[2..4], ["--", "box"]);
        assert_eq!(
            args.last().unwrap(),
            "'sh' '-s' '--' 'pair' '1.2.3' 'oop terminal (mac)'"
        );
    }

    #[test]
    fn a_tailnet_name_or_address_is_one_host_for_every_step() {
        for host in [
            "devbox.tail0000ab.ts.net",
            "me@100.101.102.103",
            "fd7a:115c:a1e0::1",
        ] {
            assert_eq!(parse_host(&words(&[host])).unwrap(), host);
            assert_eq!(step_args(host, &["probe"])[2..4], ["--", host]);
            assert_eq!(forward_args(host, 5000, 3773).last().unwrap(), host);
        }
    }

    #[test]
    fn a_failed_step_says_why_and_a_refused_host_key_says_what_to_do() {
        crate::i18n::init(Some("en"));
        let refused = step_failure(
            "100.101.102.103",
            Some(255),
            "Host key verification failed.\n",
        );
        assert!(
            refused.starts_with("ssh to 100.101.102.103 failed: Host key verification failed.")
        );
        assert!(
            refused.contains("Run 'ssh 100.101.102.103' once"),
            "{refused}"
        );
        // Silence is not swallowed: the exit status stands in for the words.
        assert_eq!(
            step_failure("box", Some(255), "  \n"),
            "ssh to box failed: ssh exited with status 255"
        );
        assert_eq!(
            step_failure("box", None, ""),
            "ssh to box failed: ssh was stopped by a signal"
        );
        let other = step_failure("box", Some(255), "Permission denied (publickey).");
        assert!(!other.contains("known_hosts"));
    }

    #[test]
    fn the_forward_binds_loopback_and_fails_loudly() {
        let args = forward_args("box", 5000, 3773);
        assert!(args.contains(&"-N".to_string()));
        assert!(args.contains(&"ExitOnForwardFailure=yes".to_string()));
        let at = args.iter().position(|a| a == "-L").unwrap();
        assert_eq!(args[at + 1], "127.0.0.1:5000:127.0.0.1:3773");
        assert_eq!(args[args.len() - 2..], ["--", "box"]);
    }

    #[test]
    fn a_running_server_and_the_installed_versions_are_read() {
        let output =
            "Welcome to box\nOOP_SSH_RUNNING 3790\nOOP_SSH_VERSION 0.0.9\nOOP_SSH_VERSION 0.0.10\n";
        assert_eq!(
            parse_probe(output).unwrap(),
            Probe {
                running: Some(3790),
                server_version: None,
                versions: words(&["0.0.9", "0.0.10"]),
            }
        );
    }

    #[test]
    fn the_runtime_of_the_running_server_is_read() {
        let output = "OOP_SSH_RUNNING 3790\nOOP_SSH_SERVER_VERSION 0.0.142\nOOP_SSH_VERSION 0.0.142\nOOP_SSH_VERSION 0.0.144\n";
        let probe = parse_probe(output).unwrap();
        assert_eq!(probe.server_version.as_deref(), Some("0.0.142"));
        let odd = parse_probe("OOP_SSH_RUNNING 1\nOOP_SSH_SERVER_VERSION ../x\n").unwrap();
        assert_eq!(odd.server_version, None);
    }

    #[test]
    fn pairing_uses_the_servers_runtime_never_the_newest() {
        let installed = words(&["0.0.142", "0.0.144"]);
        // The service runs 0.0.142 while 0.0.144 is installed: 0.0.142 pairs.
        assert_eq!(
            pair_runtime(Some("0.0.142"), None, &installed, "box").unwrap(),
            "0.0.142"
        );
        // A server this terminal started is known without asking.
        assert_eq!(
            pair_runtime(None, Some("0.0.144"), &installed, "box").unwrap(),
            "0.0.144"
        );
        // Unknown, or not installed: a message, not a guess.
        assert!(pair_runtime(None, None, &installed, "box").is_err());
        let gone = pair_runtime(Some("0.0.100"), None, &installed, "box").unwrap_err();
        assert!(gone.contains("0.0.100"), "{gone}");
    }

    #[test]
    fn no_server_is_a_state_of_its_own_and_noise_is_an_error() {
        let stopped = parse_probe("OOP_SSH_STOPPED\n").unwrap();
        assert_eq!(stopped.running, None);
        assert!(stopped.versions.is_empty());
        assert!(parse_probe("Welcome\n").is_err());
        assert!(parse_probe("OOP_SSH_RUNNING nope\n").is_err());
        // A version name that could carry shell syntax is dropped.
        let odd = parse_probe("OOP_SSH_STOPPED\nOOP_SSH_VERSION 1.0;rm\nOOP_SSH_VERSION 1.0.1\n");
        assert_eq!(odd.unwrap().versions, words(&["1.0.1"]));
    }

    #[test]
    fn the_newest_version_wins_by_number_not_by_text() {
        let list = words(&["0.0.9", "0.0.10", "0.0.2"]);
        assert_eq!(newest_version(&list), Some("0.0.10"));
        let list = words(&["1.2.0-nightly.5", "1.2.0", "1.1.9"]);
        assert_eq!(newest_version(&list), Some("1.2.0"));
        let list = words(&["1.2.0-nightly.5", "1.2.0-nightly.12", "1.1.9"]);
        assert_eq!(newest_version(&list), Some("1.2.0-nightly.12"));
        assert_eq!(newest_version(&[]), None);
    }

    #[test]
    fn a_saved_login_is_reused_only_while_the_server_accepts_it() {
        assert!(!needs_pairing(true, true));
        assert!(needs_pairing(true, false));
        assert!(needs_pairing(false, false));
    }

    #[test]
    fn the_remote_script_covers_every_step_it_is_asked_for() {
        for step in ["probe)", "start)", "pair)"] {
            assert!(REMOTE_SCRIPT.contains(step), "{step}");
        }
        // The desktop's layout, so both share one server and one data folder.
        assert!(REMOTE_SCRIPT.contains("$HOME/.oop-desktop"));
        assert!(REMOTE_SCRIPT.contains("userdata/server-runtime.json"));
        assert!(REMOTE_SCRIPT.contains("ssh-launch/"));
    }
}
