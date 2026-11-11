//! Finding, starting and pairing with the local OOP server, the way the former TypeScript terminal's link module did:
//! the running server announces itself in `<home>/userdata/server-runtime.json`; the announcement
//! is believed only when the pid is this user's process listening on that port; a token is minted
//! by the server's own `pair` command and traded at `/oauth/token`; the credential file has the
//! same shape as the TypeScript app's, so both apps share one login.

use crate::http;
use crate::panels_common::{fill, s};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime};
use tokio::process::Command;

/// Same scopes as `AuthStandardClientScopes` in packages/contracts/src/auth.ts.
const SCOPES: &str =
    "orchestration:read orchestration:operate terminal:operate review:write relay:read";
const ORCHESTRATION_PROTOCOL: u64 = 1;
/// Exit code of a server that found the data directory locked by another one.
const LOCK_HELD_EXIT: i32 = 75;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// How long after the app wrote its installing marker this terminal still holds back a server of
/// its own (`UPDATE_MARKER_FRESH_MS` of the former TypeScript terminal).
const UPDATE_MARKER_FRESH: Duration = Duration::from_secs(15 * 60);

/// The file the desktop app writes before it quits to install an update, on every install path
/// (`DESKTOP_UPDATE_INSTALLING_MARKER_FILE` in packages/contracts/src/desktopBootstrap.ts).
/// While it is fresh the installer may be replacing the bundle, and on Windows a running OOP.exe
/// stops it, so no server is started then. The app removes it when the install fails to start.
const UPDATE_MARKER_FILE: &str = "desktop-update-installing";

/// What `resolve` reports while that marker is fresh: a failure the reconnect loop keeps retrying,
/// so the app's server is found when the updated app comes up.
pub const WAITING_FOR_UPDATE: &str = "the OOP app is installing an update; waiting for it";

#[path = "link_pair.rs"]
pub mod pair;

pub fn user_home() -> PathBuf {
    let from_env = std::env::var_os("HOME").filter(|v| !v.is_empty());
    #[cfg(windows)]
    let from_env = from_env.or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()));
    from_env
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" }))
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

#[derive(Serialize)]
struct CredentialFile {
    version: u32,
    environments: BTreeMap<String, Credential>,
}

fn credentials_path() -> PathBuf {
    config_dir().join("credentials.json")
}

/// The same server: loopback names (`localhost`, `127.0.0.1`, `[::1]`) are one server whatever the
/// port, because the app may move between loopback ports and the same environment answers;
/// anything else must match scheme, host and port (`originsMatch` in selectCredential.ts).
pub fn origins_match(a: &str, b: &str) -> bool {
    let (Ok(from), Ok(to)) = (
        http::Origin::parse(a.trim_end_matches('/')),
        http::Origin::parse(b.trim_end_matches('/')),
    ) else {
        return false;
    };
    let loopback = |o: &http::Origin| matches!(o.host.as_str(), "localhost" | "127.0.0.1" | "::1");
    if from.tls != to.tls {
        return false;
    }
    if loopback(&from) && loopback(&to) {
        return true;
    }
    from.host.eq_ignore_ascii_case(&to.host) && from.port == to.port
}

/// The credentials folder is the user's alone (Unix modes; on Windows the profile's own ACLs apply).
fn restrict_directory(directory: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
        Ok(())
    }
}

/// A new file nobody but the user can read (Unix mode 0600).
fn restrict_new_file(options: &mut std::fs::OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    {
        let _ = options;
    }
}

/// A credential file that exists but cannot be read as one; it is left alone so nothing in it is
/// lost (`link.credentialsDamaged`).
fn damaged(path: &Path, reason: &str) -> String {
    fill(
        s(
            "The credentials file is damaged ({reason}): {filePath}\nCheck or delete the file, then reconnect with 'oop pair <link>'.",
            "자격증명 파일이 손상되었습니다 ({reason}): {filePath}\n파일을 확인하거나 지운 뒤 'oop pair <링크>' 로 다시 연결하세요.",
        ),
        &[
            ("reason", reason.to_string()),
            ("filePath", path.display().to_string()),
        ],
    )
}

/// Entries that are not credentials are dropped; a file that is not a credential file is an error
/// (`parseCredentialFile` in credentials.ts). A missing `version` is no fault.
fn parse_credential_file(text: &str, path: &Path) -> Result<CredentialFile, String> {
    let parsed: Value =
        serde_json::from_str(text).map_err(|_| damaged(path, s("not JSON", "JSON이 아님")))?;
    let Some(environments) = parsed.get("environments").and_then(Value::as_object) else {
        return Err(damaged(path, s("unexpected format", "형식이 다름")));
    };
    Ok(CredentialFile {
        version: 1,
        environments: environments
            .iter()
            .filter_map(|(key, value)| {
                serde_json::from_value::<Credential>(value.clone())
                    .ok()
                    .filter(|c| !c.token.is_empty())
                    .map(|c| (key.clone(), c))
            })
            .collect(),
    })
}

/// A file left readable by others (an older version, a copy, a restore) is closed up when it is
/// read. Failing to do so must not lock the user out.
fn tighten(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path)
            && meta.permissions().mode() & 0o077 != 0
        {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// A missing file is an empty store; any other trouble is an error rather than a silent reset.
fn read_credentials() -> Result<CredentialFile, String> {
    let path = credentials_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CredentialFile {
                version: 1,
                environments: BTreeMap::new(),
            });
        }
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    tighten(&path);
    parse_credential_file(&text, &path)
}

/// Fails when the credential file is there but unusable: asked before a one-time pairing token is
/// spent on saving into it.
pub fn verify_credentials() -> Result<(), String> {
    read_credentials().map(|_| ())
}

fn newest<'a>(entries: impl Iterator<Item = &'a Credential>) -> Option<&'a Credential> {
    entries.max_by(|a, b| a.saved_at.cmp(&b.saved_at))
}

pub fn find_credential(environment_id: &str, origin: &str) -> Result<Option<Credential>, String> {
    let file = read_credentials()?;
    Ok(newest(
        file.environments.values().filter(|c| {
            c.environment_id == environment_id && origins_match(&c.http_base_url, origin)
        }),
    )
    .cloned())
}

/// Where else this server is saved (the newest address), for telling the user; never a token.
pub fn saved_address(environment_id: &str) -> Result<Option<String>, String> {
    let file = read_credentials()?;
    Ok(newest(
        file.environments
            .values()
            .filter(|c| c.environment_id == environment_id),
    )
    .map(|c| c.http_base_url.clone()))
}

pub fn save_credential(credential: &Credential) -> Result<(), String> {
    let path = credentials_path();
    let mut file = read_credentials()?;
    file.environments.retain(|_, c| {
        !(c.environment_id == credential.environment_id
            && origins_match(&c.http_base_url, &credential.http_base_url))
    });
    file.environments.insert(
        format!("{} {}", credential.environment_id, credential.http_base_url),
        credential.clone(),
    );
    let directory = path.parent().ok_or("no config directory")?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    restrict_directory(directory).map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", crate::text::new_id()));
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        restrict_new_file(&mut options);
        let mut out = options.open(&temporary)?;
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
    /// The announcement says the server is a terminal's own (`serve --daemon`), not the app's.
    pub daemon: bool,
}

/// What the server says at `/.well-known/t3/environment`; `None` when nothing OOP-like answers
/// or the server speaks another orchestration protocol.
async fn probe_descriptor(origin: &str) -> Option<Value> {
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
    // Servers from before the protocol was negotiated speak version 1 and do not say so.
    (protocol_version(&body) == Some(ORCHESTRATION_PROTOCOL)).then_some(body)
}

/// The environment id and label the server at `origin` announces.
pub async fn probe(origin: &str) -> Option<(String, String)> {
    let body = probe_descriptor(origin).await?;
    Some((
        body["environmentId"].as_str()?.to_string(),
        body["label"].as_str().unwrap_or("OOP").to_string(),
    ))
}

/// The version the server at `origin` says it is, untrimmed; `None` when nothing OOP-like answers.
pub async fn probe_version(origin: &str) -> Option<String> {
    let body = probe_descriptor(origin).await?;
    body["serverVersion"].as_str().map(str::to_string)
}

/// The orchestration protocol a server announces; version 1 when it says nothing.
pub(crate) fn protocol_version(descriptor: &Value) -> Option<u64> {
    match &descriptor["orchestrationProtocolVersion"] {
        Value::Null => Some(1),
        other => other.as_u64(),
    }
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

/// `ss -H -ltnp` output: does `pid` own a listener on `port`? (`listensOn` in localAccess.ts: the
/// local address, the fourth column, ends in `:port`, and the line names the pid as `pid=N`.)
pub fn listens_on(output: &str, pid: u32, port: u16) -> bool {
    let suffix = format!(":{port}");
    output.lines().any(|line| {
        let local = line.split_whitespace().nth(3);
        local.is_some_and(|l| l.ends_with(&suffix)) && owner_pids(line).contains(&pid)
    })
}

/// Every `pid=N` in one `ss` line (`users:(("node",pid=4242,fd=20))`), at a word boundary.
fn owner_pids(line: &str) -> Vec<u32> {
    line.match_indices("pid=")
        .filter(|(at, _)| {
            line[..*at]
                .chars()
                .next_back()
                .is_none_or(|c| !(c.is_alphanumeric() || c == '_'))
        })
        .filter_map(|(at, _)| {
            let digits: String = line[at + 4..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse().ok()
        })
        .collect()
}

/// The announced pid's executable and command line, if it is this user's process and listens on
/// the announced port. Anything else (stale file, someone else's server) gets nothing sent to it.
/// macOS asks `ps` and `lsof`; Linux `ps`, `ss` and `/proc/<pid>/exe` (no `lsof` needed); Windows
/// PowerShell. Other systems have no way to be sure, so they believe nothing.
pub async fn inspect(pid: u32, port: u16) -> Option<(String, String)> {
    if pid == 0 || port == 0 {
        return None;
    }
    if cfg!(windows) {
        let text = run(
            &windows_powershell().to_string_lossy(),
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &windows_inspect_script(pid, port),
            ],
            &[],
        )
        .await
        .ok()?;
        return parse_windows_inspect(&text);
    }
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return None;
    }
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
    let executable = if cfg!(target_os = "macos") {
        // lsof exits non-zero when the pid does not listen on the port.
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
        ps("comm=").await.ok()?
    } else {
        if !listens_on(&run("ss", &["-H", "-ltnp"], &[]).await.ok()?, pid, port) {
            return None;
        }
        std::fs::read_link(format!("/proc/{pid}/exe"))
            .ok()?
            .to_string_lossy()
            .into_owned()
    };
    let command = ps("command=").await.ok()?;
    (!executable.is_empty() && !command.is_empty()).then_some((executable, command))
}

/// Windows PowerShell by absolute path: a bare name is looked up in the current folder first,
/// where any program of that name would be run instead.
fn windows_powershell() -> PathBuf {
    system32_tool("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

/// Fixed script (the pid and port are integers): the process must belong to this user's SID and
/// listen on the port. It prints its executable and command line as one JSON line and exits
/// non-zero otherwise (`windowsInspectScript` in localAccess.ts).
fn windows_inspect_script(pid: u32, port: u16) -> String {
    let steps = [
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false".to_string(),
        format!("$serverPid = {pid}"),
        format!("$serverPort = {port}"),
        "$process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $serverPid)".into(),
        "$owner = (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid".into(),
        "$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value".into(),
        "if ($owner -ne $me) { exit 1 }".into(),
        "$null = Get-NetTCPConnection -State Listen -LocalPort $serverPort -OwningProcess $serverPid"
            .into(),
        "@{ executable = $process.ExecutablePath; command = $process.CommandLine } | ConvertTo-Json -Compress"
            .into(),
    ];
    format!(
        "$ErrorActionPreference = 'Stop'; try {{ {} }} catch {{ exit 1 }}",
        steps.join("; ")
    )
}

/// The script's answer: one JSON object, possibly after a byte order mark.
fn parse_windows_inspect(output: &str) -> Option<(String, String)> {
    let json: Value = serde_json::from_str(output.trim_start_matches('\u{feff}')).ok()?;
    let executable = json["executable"].as_str().filter(|e| !e.is_empty())?;
    let command = json["command"].as_str()?;
    Some((executable.to_string(), command.trim().to_string()))
}

/// The server's script inside its command line: an absolute POSIX path ending in
/// `/apps/server/dist/bin.mjs` or `/apps/server/src/bin.ts` (it may hold spaces but never a space
/// followed by another absolute path, where the next argument begins), or a Windows path to
/// `apps\server\dist\bin.mjs` / `apps\server\src\bin.ts`: quoted (Node quotes a path with spaces)
/// or, unquoted, ending at the first space.
pub fn parse_server_script(command: &str) -> Option<String> {
    parse_posix_script(command).or_else(|| parse_windows_script(command))
}

fn parse_posix_script(command: &str) -> Option<String> {
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

fn parse_windows_script(command: &str) -> Option<String> {
    const SUFFIXES: [&str; 2] = [r"\apps\server\dist\bin.mjs", r"\apps\server\src\bin.ts"];
    // `X:\` and, before the script's own leading backslash, at least a second one.
    let is_script = |path: &str| {
        let bytes = path.as_bytes();
        bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\'
            && SUFFIXES.iter().any(|suffix| path[3..].ends_with(suffix))
    };
    let mut previous_blank = true;
    for (at, c) in command.char_indices() {
        if previous_blank {
            let rest = &command[at..];
            if let Some(quoted) = rest.strip_prefix('"') {
                if let Some(body) = quoted.split('"').next().filter(|_| quoted.contains('"'))
                    && is_script(body)
                {
                    return Some(body.to_string());
                }
            } else if let Some(token) = rest.split_whitespace().next()
                && is_script(token)
            {
                return Some(token.to_string());
            }
        }
        previous_blank = c.is_whitespace();
    }
    None
}

pub fn parse_pairing_token(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.strip_prefix("Token: "))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty() && !t.contains(' '))
}

/// What looking for the server found. `Missing` is also what an announcement that does not check
/// out (not this user's process on that port) is reported as.
#[derive(Debug)]
pub enum Discovery {
    Found(Found),
    Missing(String),
    /// The announced process is gone: the last server has already exited.
    Stale(String),
    /// The process is alive but nothing OOP-like answers at its address.
    Unreachable(String),
}

impl Discovery {
    /// The reason a server was not found; empty for a found one.
    pub fn detail(&self) -> &str {
        match self {
            Discovery::Found(_) => "",
            Discovery::Missing(detail)
            | Discovery::Stale(detail)
            | Discovery::Unreachable(detail) => detail,
        }
    }
}

/// True while the process exists. Not being allowed to signal it (EPERM) still means it exists.
pub fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the process can be signalled.
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let output = std::process::Command::new(system32_tool("tasklist.exe"))
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        output.is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")))
    }
}

/// `<SystemRoot>\System32\<name>` by absolute path: a bare name is looked up in the current
/// folder first on Windows, where any program of that name would be run instead.
fn system32_tool(name: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .filter(|v| !v.is_empty())
        .map_or_else(|| PathBuf::from("C:\\Windows"), PathBuf::from);
    root.join("System32").join(name)
}

/// Asks the server to end: SIGTERM where there is a graceful signal (it finishes writing its
/// data), on Windows the whole process tree (`taskkill /T /F`), because ending only the server
/// would leave its provider and terminal children running. Errors are not reported: the caller
/// waits for the process to be gone.
pub fn terminate(pid: u32) {
    #[cfg(unix)]
    {
        // SAFETY: plain signal delivery to a pid the caller has verified.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = std::process::Command::new(system32_tool("taskkill.exe"))
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// The announcement as the server wrote it, with nothing checked beyond the pid being alive and
/// something OOP-like answering at the address. `oop stop` and `oop doctor` use this: they decide
/// for themselves how far the process is to be believed.
pub async fn discover_announced(home: &Path) -> Discovery {
    let file = home.join("userdata").join("server-runtime.json");
    let Ok(text) = tokio::fs::read_to_string(&file).await else {
        return Discovery::Missing(
            s(
                "No running OOP server was found. Open the desktop app or pass --server with an address.",
                "실행 중인 OOP 서버를 찾지 못했습니다. 데스크톱 앱을 켜거나 --server 주소를 지정하세요.",
            )
            .into(),
        );
    };
    let unreadable = || {
        Discovery::Missing(
            s(
                "Could not read the server runtime info. Pass --server with an address.",
                "서버 실행 정보를 읽을 수 없습니다. --server 주소를 지정하세요.",
            )
            .into(),
        )
    };
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let (Some(pid), Some(origin)) = (
        parsed["pid"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= u64::from(u32::MAX)),
        parsed["origin"]
            .as_str()
            .filter(|o| o.starts_with("http://") || o.starts_with("https://")),
    ) else {
        return unreadable();
    };
    let (pid, origin) = (pid as u32, origin.to_string());
    if !process_alive(pid) {
        return Discovery::Stale(
            s(
                "The last OOP server that ran has already exited.",
                "마지막으로 실행된 OOP 서버가 이미 종료되었습니다.",
            )
            .into(),
        );
    }
    let Some((environment_id, label)) = probe(&origin).await else {
        return Discovery::Unreachable(
            s(
                "The OOP server is not responding. Try again in a moment.",
                "OOP 서버가 응답하지 않습니다. 잠시 후 다시 시도하세요.",
            )
            .into(),
        );
    };
    Discovery::Found(Found {
        pid,
        origin,
        environment_id,
        label,
        daemon: parsed["daemon"].as_bool() == Some(true),
    })
}

/// What discovery makes of the announcement once the process behind it is checked too.
enum Checked {
    Found(Found),
    /// No server (see `Discovery`); one may be started.
    Down(Discovery),
    /// A loopback server is announced but its process could not be shown to be this user's and
    /// listening there. That is not "down": nothing is started, and no token goes to it.
    Unverified(String),
}

/// `127.0.0.1`, `localhost` or `[::1]` (`isLoopbackOrigin` in selectCredential.ts).
pub fn is_loopback_origin(origin: &str) -> bool {
    http::Origin::parse(origin.trim_end_matches('/'))
        .is_ok_and(|o| matches!(o.host.as_str(), "localhost" | "127.0.0.1" | "::1"))
}

/// The announced server, believed only when a loopback one's process is this user's and listens
/// on the announced port: the file may be stale or name someone else's server.
async fn discover_checked(home: &Path) -> Checked {
    let found = match discover_announced(home).await {
        Discovery::Found(found) => found,
        other => return Checked::Down(other),
    };
    if !is_loopback_origin(&found.origin) {
        return Checked::Found(found);
    }
    if let Some(port) = parse_port(&found.origin)
        && inspect(found.pid, port).await.is_some()
    {
        return Checked::Found(found);
    }
    Checked::Unverified(fill(
        s(
            "The token was not sent: could not confirm that the server at {origin} (pid {pid}) is this user's process and listening on that port.\nIf you trust it, pass it directly with 'oop --server <address>'.",
            "토큰을 보내지 않았습니다: {origin} 의 서버(pid {pid})가 이 사용자의 프로세스이고 그 포트에서 리슨 중인지 확인하지 못했습니다.\n믿을 수 있는 서버라면 'oop --server <주소>' 로 직접 지정하세요.",
        ),
        &[
            ("origin", found.origin.clone()),
            ("pid", found.pid.to_string()),
        ],
    ))
}

/// The announced server, believed only when its process is this user's and listens on the
/// announced port. One that cannot be confirmed is reported as `Missing`. The oracle the tests hold
/// the connection's own reasons against.
#[cfg(test)]
pub async fn discover(home: &Path) -> Discovery {
    match discover_checked(home).await {
        Checked::Found(found) => Discovery::Found(found),
        Checked::Down(down) => down,
        Checked::Unverified(detail) => Discovery::Missing(detail),
    }
}

/// Discovery again and again for up to `wait`, once per `step`, until a server is found.
async fn wait_until_found(home: &Path, wait: Duration, step: Duration) -> Checked {
    let deadline = Instant::now() + wait;
    loop {
        let result = discover_checked(home).await;
        if !matches!(result, Checked::Down(_)) || Instant::now() >= deadline {
            return result;
        }
        tokio::time::sleep(step).await;
    }
}

// ---------------------------------------------------------------------------------------------
// Starting the terminal's own server

struct AppProgram {
    executable: String,
    script: String,
    /// Chosen with `OOP_DAEMON_ENTRY`: allowed in an isolated home.
    explicit: bool,
    /// The app's own executable, which runs the script as plain Node only with
    /// `ELECTRON_RUN_AS_NODE`. A real `node` needs no such switch.
    electron: bool,
}

/// `OOP_DAEMON_ENTRY` names a server `bin.mjs` run by `node`; otherwise the installed app runs the
/// server inside its archive as plain Node (`ELECTRON_RUN_AS_NODE`): macOS' `OOP.app`, Windows'
/// `%LOCALAPPDATA%\Programs\OOP`. The app this client came with comes first. Linux has no app
/// bundle to look in.
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
            electron: false,
        });
    }
    if cfg!(target_os = "macos") {
        // The app this client came with, wherever it was put and whatever it is called (the `oop`
        // launcher also tries the bundle it was written for first), then the installed places.
        if let Some(program) = own_bundle().and_then(|bundle| app_program_at(&bundle)) {
            return Some(program);
        }
        return app_program_in(&[
            PathBuf::from("/Applications"),
            user_home().join("Applications"),
        ]);
    }
    if cfg!(windows) {
        if let Some(program) = own_windows_dir().and_then(|dir| windows_app_program_at(&dir)) {
            return Some(program);
        }
        let local = std::env::var("LOCALAPPDATA").ok();
        return windows_app_program_at(&windows_app_dir(local.as_deref(), &user_home()));
    }
    None
}

/// The program `oop doctor` reports as what this terminal would start a server with: the script
/// it would run itself, or `None` where there is no usable program.
pub fn standalone_script() -> Option<String> {
    find_app_program().map(|program| program.script)
}

/// The `.app` bundle that contains this executable (`oop-rs` sits in
/// `OOP.app/Contents/Resources/oop`), or None when it runs from anywhere else. The bundle is
/// returned as it is, name and all: it may have been renamed, and the `OOP.app` next to it is
/// not the app this client came with.
fn own_bundle() -> Option<PathBuf> {
    bundle_of(&std::env::current_exe().ok()?)
}

fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let bundle = exe.ancestors().nth(4)?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

/// The server program inside one `.app` bundle, when that bundle has its executable and archive.
fn app_program_at(bundle: &Path) -> Option<AppProgram> {
    let executable = bundle.join("Contents/MacOS/OOP");
    let archive = bundle.join("Contents/Resources/app.asar");
    if executable.exists() && archive.exists() {
        return Some(AppProgram {
            executable: executable.to_string_lossy().into_owned(),
            script: archive
                .join("apps/server/dist/bin.mjs")
                .to_string_lossy()
                .into_owned(),
            explicit: false,
            electron: true,
        });
    }
    None
}

/// The first `OOP.app` directly inside one of `bases` that has its executable and server archive.
fn app_program_in(bases: &[PathBuf]) -> Option<AppProgram> {
    bases
        .iter()
        .find_map(|base| app_program_at(&base.join("OOP.app")))
}

/// Where the per-user Windows installer puts the app: `%LOCALAPPDATA%\Programs\OOP`, else the
/// same under `~\AppData\Local` (an app put elsewhere through the installer's folder page is not
/// found).
fn windows_app_dir(local_app_data: Option<&str>, home: &Path) -> PathBuf {
    local_app_data
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map_or_else(|| home.join("AppData").join("Local"), PathBuf::from)
        .join("Programs")
        .join("OOP")
}

/// The app folder this executable sits in (`<app>\resources\oop\oop-rs.exe`), whatever it is
/// called. `windows_app_program_at` decides whether it really is one.
fn own_windows_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
}

/// The server program in one Windows app folder: `OOP.exe` next to `resources\server.asar`, with
/// the server at `apps\server\dist\bin.mjs` inside that archive.
fn windows_app_program_at(dir: &Path) -> Option<AppProgram> {
    let executable = dir.join("OOP.exe");
    let archive = dir.join("resources").join("server.asar");
    if executable.exists() && archive.exists() {
        return Some(AppProgram {
            executable: executable.to_string_lossy().into_owned(),
            script: archive
                .join("apps")
                .join("server")
                .join("dist")
                .join("bin.mjs")
                .to_string_lossy()
                .into_owned(),
            explicit: false,
            electron: true,
        });
    }
    None
}

fn which(program: &str) -> Option<String> {
    let names: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ""]
    } else {
        &[""]
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .flat_map(|dir| {
            names
                .iter()
                .map(move |ext| dir.join(format!("{program}{ext}")))
        })
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

/// How one start of the terminal's own server ended (`DaemonOutcome` in daemon.ts).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Daemon {
    /// A server is announced and answers.
    Ready,
    /// The lock is held by a server that is about to announce itself.
    Occupied,
    /// The program could not be run or ended any other way.
    Unusable(String),
    /// Still running, and not announced in time.
    Slow,
    /// The app is installing an update: nothing was started and nothing counts as failed.
    Updating,
    /// An earlier attempt failed or found the lock held a moment ago: nothing was started.
    Cooling,
}

/// After a start that ended with the lock held elsewhere, the earliest the next one may begin.
const HELD_GAP: Duration = Duration::from_secs(5);
const FAILURE_BACKOFF_FIRST: Duration = Duration::from_secs(10);
const FAILURE_BACKOFF_CAP: Duration = Duration::from_secs(120);

/// The wait after the `failures`-th failure in a row: 10 s, doubling, at most 120 s.
fn failure_backoff(failures: u32) -> Duration {
    let doubling = failures.saturating_sub(1).min(10);
    (FAILURE_BACKOFF_FIRST * 2u32.pow(doubling)).min(FAILURE_BACKOFF_CAP)
}

/// When the next start may begin; the memory of this process's launcher (`createDaemonLauncher`).
struct Cooldown {
    not_before: Option<Instant>,
    failures: u32,
}

impl Cooldown {
    const fn new() -> Self {
        Self {
            not_before: None,
            failures: 0,
        }
    }

    fn cooling(&self, now: Instant) -> bool {
        self.not_before.is_some_and(|at| now < at)
    }

    /// Records how an attempt ended. Not a start at all (`Updating`, `Cooling`) changes nothing.
    fn settle(&mut self, outcome: &Daemon, now: Instant) {
        match outcome {
            Daemon::Ready => *self = Self::new(),
            Daemon::Occupied => {
                self.failures = 0;
                self.not_before = Some(now + HELD_GAP);
            }
            Daemon::Unusable(_) | Daemon::Slow => {
                self.failures = self.failures.saturating_add(1);
                self.not_before = Some(now + failure_backoff(self.failures));
            }
            Daemon::Updating | Daemon::Cooling => {}
        }
    }
}

static LAUNCHER: std::sync::Mutex<Cooldown> = std::sync::Mutex::new(Cooldown::new());

fn launcher() -> std::sync::MutexGuard<'static, Cooldown> {
    LAUNCHER.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the server's environment changes from this one: nothing of the app's own settings
/// (`T3CODE_*`) goes through, and the switch that makes the app's executable run a script as plain
/// Node is set for that executable only. (`name`, `Some(value)`) sets, (`name`, `None`) removes.
fn daemon_environment(
    names: impl IntoIterator<Item = String>,
    electron: bool,
) -> Vec<(String, Option<&'static str>)> {
    let mut edits: Vec<(String, Option<&'static str>)> = names
        .into_iter()
        .filter(|name| name.starts_with("T3CODE_"))
        .map(|name| (name, None))
        .collect();
    edits.push((
        "ELECTRON_RUN_AS_NODE".into(),
        if electron { Some("1") } else { None },
    ));
    edits
}

/// The command that starts the server. The host is always the loopback: this server is for the
/// terminal on this computer, not for the network.
fn daemon_command(program: &AppProgram, home: &Path, port: u16) -> (String, Vec<String>) {
    (
        program.executable.clone(),
        vec![
            program.script.clone(),
            "serve".into(),
            "--daemon".into(),
            "--base-dir".into(),
            home.to_string_lossy().into_owned(),
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            port.to_string(),
        ],
    )
}

/// Keeps the server apart from this terminal. Unix: a session of its own, like the TypeScript
/// terminal's `detached: true`, so the server has no controlling terminal and can never take the
/// foreground away from this terminal's keys. Windows: a new process group with no console and no
/// window (`CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW`). The Windows side
/// could not be run where this was written.
fn detach(command: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: `setsid` is async-signal-safe and touches no memory of this process.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW);
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = command;
    }
}

/// Starts `serve --daemon` detached (no window, no stdio, own process group) unless the app is
/// installing an update or an earlier start ended badly a moment ago, and waits until the server
/// announces itself, exits because another one holds the lock, or the time is up.
async fn start_daemon(program: &AppProgram, home: &Path) -> Daemon {
    if launcher().cooling(Instant::now()) {
        return Daemon::Cooling;
    }
    if update_in_progress(home, SystemTime::now()) {
        return Daemon::Updating;
    }
    let outcome = attempt_daemon(program, home).await;
    launcher().settle(&outcome, Instant::now());
    outcome
}

async fn attempt_daemon(program: &AppProgram, home: &Path) -> Daemon {
    let Some(port) = pick_port() else {
        return Daemon::Unusable(
            s("Could not find a free port.", "빈 포트를 찾지 못했습니다.").into(),
        );
    };
    let (file, args) = daemon_command(program, home, port);
    let mut command = std::process::Command::new(file);
    command
        .args(args)
        .current_dir(user_home())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (name, value) in daemon_environment(std::env::vars().map(|(n, _)| n), program.electron) {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
    detach(&mut command);
    let Ok(mut child) = command.spawn() else {
        return Daemon::Unusable(
            s(
                "Could not launch the server program.",
                "서버 프로그램을 실행하지 못했습니다.",
            )
            .into(),
        );
    };
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        // An announcement counts even when the process behind it has just ended with the lock
        // held: the one that holds it is the server.
        if let Checked::Found(_) = discover_checked(home).await {
            return Daemon::Ready;
        }
        if let Ok(Some(status)) = child.try_wait() {
            return if status.code() == Some(LOCK_HELD_EXIT) {
                Daemon::Occupied
            } else {
                Daemon::Unusable(fill(
                    s(
                        "The server exited with code {code}.",
                        "서버가 코드 {code} 으로 끝났습니다.",
                    ),
                    &[(
                        "code",
                        status
                            .code()
                            .map_or_else(|| s("none", "없음").to_string(), |c| c.to_string()),
                    )],
                ))
            };
        }
        if Instant::now() >= deadline {
            return Daemon::Slow;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// `%LOCALAPPDATA%\Programs\OOP\OOP.exe` is started without the variable `oop.cmd` sets, which the
/// app and its terminals would inherit (cmd.exe could not run programs from the current folder).
/// `WINDOWS_START_APP_SCRIPT` in localAccess.ts.
const WINDOWS_START_APP_SCRIPT: &str = "$ErrorActionPreference = 'Stop'; try { $app = Join-Path $env:LOCALAPPDATA 'Programs\\OOP\\OOP.exe'; if (-not (Test-Path -LiteralPath $app -PathType Leaf)) { exit 1 }; Remove-Item Env:NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue; Start-Process -FilePath $app } catch { exit 1 }";

/// Starts the desktop app behind the terminal: macOS `open -g -a OOP`, Windows its installed
/// `OOP.exe`. False where this computer has no such app, and on Linux.
pub async fn start_desktop_app() -> bool {
    if cfg!(target_os = "macos") {
        run("open", &["-g", "-a", "OOP"], &[]).await.is_ok()
    } else if cfg!(windows) {
        run(
            &windows_powershell().to_string_lossy(),
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                WINDOWS_START_APP_SCRIPT,
            ],
            &[],
        )
        .await
        .is_ok()
    } else {
        false
    }
}

/// `<home>/runtime/desktop-update-installing`, where the app records that it is installing an
/// update (the same path `desktopUpdateMarkerPath` gives the TypeScript terminal).
pub fn update_marker_path(home: &Path) -> PathBuf {
    home.join("runtime").join(UPDATE_MARKER_FILE)
}

/// True when the marker exists and was written within `UPDATE_MARKER_FRESH` of `now`. A missing
/// file is no update. A timestamp from the future counts as fresh, as it does in TypeScript
/// (`now - written < FRESH`).
pub fn update_in_progress(home: &Path, now: SystemTime) -> bool {
    let Ok(modified) = std::fs::metadata(update_marker_path(home)).and_then(|m| m.modified())
    else {
        return false;
    };
    now.duration_since(modified).unwrap_or_default() < UPDATE_MARKER_FRESH
}

/// The program a server of this terminal's own is started with, or none where it must not be: no
/// usable app program, or an isolated home, which is someone's test server and not what the app's
/// program would serve (only `OOP_DAEMON_ENTRY` allows that).
fn own_program(isolated: bool) -> Option<AppProgram> {
    find_app_program().filter(|program| !isolated || program.explicit)
}

/// An `OOP_DAEMON_ENTRY` that names no file: said once, and then it is as if there were no program.
fn daemon_entry_missing() -> bool {
    std::env::var("OOP_DAEMON_ENTRY")
        .is_ok_and(|e| !e.trim().is_empty() && !Path::new(e.trim()).exists())
}

fn finish(checked: Checked) -> Result<Found, String> {
    match checked {
        Checked::Found(found) => Ok(found),
        Checked::Down(down) => Err(down.detail().to_string()),
        Checked::Unverified(detail) => Err(detail),
    }
}

/// A server to talk to: the announced one, else one started here (the terminal's own, then the
/// desktop app), as `resolveServer` of the former TypeScript terminal did. `may_start_own`
/// is false while a server that was there is still within its grace: the app may be restarting,
/// and a server of this terminal's own would only be killed by it when it comes back.
pub async fn resolve(
    home: &Path,
    isolated: bool,
    server: Option<&str>,
    may_start_own: bool,
    notify: impl Fn(&str),
) -> Result<Found, String> {
    // `--server <address>`: that one and no other; this terminal starts nothing for it.
    if let Some(address) = server {
        let origin = if address.contains("://") {
            address.trim_end_matches('/').to_string()
        } else {
            format!("http://{}", address.trim_end_matches('/'))
        };
        let (environment_id, label) = probe(&origin).await.ok_or_else(|| {
            fill(
                s(
                    "No OOP server is answering at {origin}.",
                    "{origin} 에서 OOP 서버가 응답하지 않습니다.",
                ),
                &[("origin", origin.clone())],
            )
        })?;
        return Ok(Found {
            pid: 0,
            origin,
            environment_id,
            label,
            daemon: false,
        });
    }
    let mut result = discover_checked(home).await;
    if !matches!(result, Checked::Down(_)) {
        return finish(result);
    }
    // Checked apart from the start itself: mid-install the app's program may be missing, and a
    // server started from a half-replaced bundle is what the installer cannot finish over.
    if !may_start_own {
        return finish(result);
    }
    if update_in_progress(home, SystemTime::now()) {
        return Err(WAITING_FOR_UPDATE.to_string());
    }
    match own_program(isolated) {
        Some(program) => {
            notify(s(
                "Starting the OOP server… (terminal only, no app. If you open the app it takes the server over and a turn in progress is interrupted)",
                "OOP 서버를 시작하는 중입니다… (앱 없이 터미널만 씁니다. 앱을 켜면 앱이 서버를 이어받고, 진행 중인 턴은 끊깁니다)",
            ));
            match start_daemon(&program, home).await {
                Daemon::Ready => result = discover_checked(home).await,
                // The lock is held by a server that is still coming up (the app's, or another
                // terminal's). It gets as long as a server of ours does: giving up sooner would
                // start the app behind it.
                Daemon::Occupied => {
                    result = wait_until_found(home, STARTUP_TIMEOUT, Duration::from_secs(1)).await;
                }
                Daemon::Slow => {
                    return Err(s(
                        "The standalone terminal server did not start in time. Run 'oop' again in a moment.",
                        "터미널 단독 서버가 제때 시작되지 않았습니다. 잠시 뒤 'oop' 을 다시 실행하세요.",
                    )
                    .to_string());
                }
                // The install began between the check above and this start.
                Daemon::Updating => return Err(WAITING_FOR_UPDATE.to_string()),
                // Could not be started (or not now): back to what it was.
                Daemon::Unusable(_) | Daemon::Cooling => {}
            }
        }
        None if daemon_entry_missing() => notify(&fill(
            s(
                "The file {variable} points to does not exist, so no server was started.",
                "{variable} 가 가리키는 파일이 없어 서버를 띄우지 않습니다.",
            ),
            &[("variable", "OOP_DAEMON_ENTRY".to_string())],
        )),
        None => {}
    }
    // An app that answers but whose process does not check out is running: starting it again would
    // only wait out the timeout, and the token has not gone anywhere. A terminal's own server that
    // could not be started leaves this as it was.
    if matches!(result, Checked::Down(_)) && !isolated && start_desktop_app().await {
        notify(s("Starting the OOP app…", "OOP 앱을 시작하는 중입니다…"));
        result = wait_until_found(home, Duration::from_secs(30), Duration::from_secs(1)).await;
    }
    finish(result)
}

/// Why a reconnection has no server yet, and whether one was found: a found-but-untrusted server
/// is not an absence, so the grace starts over (`reverifiedOrigin` in resolveServer.ts).
pub struct Unlocated {
    pub reason: String,
    pub found: bool,
}

/// The address for the next connection of a server that was found by discovery. The desktop app
/// may have restarted on another port, so it is looked up and verified again; the saved token
/// goes only to the same environment at an address that token is valid for. Anything else is a
/// short reason and nothing is sent. With `may_start_own` (the grace has passed) the terminal's own
/// server is started; the app takes it over when it comes back, with the same token.
pub async fn relocate(
    home: &Path,
    isolated: bool,
    may_start_own: bool,
    known: &Found,
    notify: impl Fn(&str),
) -> Result<Found, Unlocated> {
    let own = own_program(isolated);
    let mut result = discover_checked(home).await;
    let mut reason = s(
        "OOP app is closed — reconnects when it opens",
        "OOP 앱 꺼짐 — 켜면 자동 재연결",
    );
    if own.is_some() {
        reason = s(
            "No server — starting one shortly",
            "서버 없음 — 곧 자동으로 띄웁니다",
        );
    }
    if let (Checked::Down(_), Some(program), true) = (&result, &own, may_start_own) {
        notify(s(
            "Starting the OOP server… (terminal only, no app. If you open the app it takes the server over and a turn in progress is interrupted)",
            "OOP 서버를 시작하는 중입니다… (앱 없이 터미널만 씁니다. 앱을 켜면 앱이 서버를 이어받고, 진행 중인 턴은 끊깁니다)",
        ));
        match start_daemon(program, home).await {
            Daemon::Ready | Daemon::Occupied => result = discover_checked(home).await,
            Daemon::Unusable(_) => {
                reason = s(
                    "Server failed to start — open the app",
                    "서버 시작 실패 — 앱을 켜세요",
                );
            }
            Daemon::Slow => {
                reason = s(
                    "Server is slow to start — still checking",
                    "서버 시작이 느림 — 계속 확인",
                );
            }
            // Only the start is held back; the loop keeps looking, and the app's server is found
            // when the updated app comes up.
            Daemon::Updating => {
                reason = s(
                    "App is updating — reconnects automatically",
                    "앱 업데이트 중 — 자동 재연결",
                );
            }
            Daemon::Cooling => {}
        }
    }
    match result {
        Checked::Unverified(_) => Err(Unlocated {
            reason: s(
                "Server check failed, token not sent",
                "서버 확인 실패, 토큰 보내지 않음",
            )
            .into(),
            found: true,
        }),
        Checked::Down(_) => Err(Unlocated {
            reason: reason.into(),
            found: false,
        }),
        Checked::Found(found) => reverified(known, found),
    }
}

/// A server found again is the one that was known only when it is the same environment at an
/// address the saved token is valid for; a token is never minted for another one on a reconnect.
fn reverified(known: &Found, found: Found) -> Result<Found, Unlocated> {
    if found.environment_id == known.environment_id && origins_match(&known.origin, &found.origin) {
        Ok(found)
    } else {
        Err(Unlocated {
            reason: s(
                "Different server, token not sent",
                "다른 서버라서 토큰 보내지 않음",
            )
            .into(),
            found: true,
        })
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

/// Runs the running server's own program as `pair` and returns what it printed (the pairing link,
/// the token and when it expires), so the token always matches the server's version. `ttl` is
/// passed as `--ttl`; without it the server's own default applies. Whoever may run it can already
/// read this user's OOP data.
pub async fn pair_output(
    found: &Found,
    home: &Path,
    label: &str,
    ttl: Option<&str>,
) -> Option<String> {
    let port = parse_port(&found.origin)?;
    let (executable, command) = inspect(found.pid, port).await?;
    let script = parse_server_script(&command)?;
    let home = home.to_string_lossy();
    let mut args = vec![
        script.as_str(),
        "pair",
        "--base-dir",
        &home,
        "--label",
        label,
    ];
    if let Some(ttl) = ttl {
        args.extend(["--ttl", ttl]);
    }
    run(&executable, &args, &[("ELECTRON_RUN_AS_NODE", "1")])
        .await
        .ok()
}

async fn mint_local_pairing_token(found: &Found, home: &Path, label: &str) -> Option<String> {
    parse_pairing_token(&pair_output(found, home, label, Some("1m")).await?)
}

/// Trades a one-time token for a bearer token at `/oauth/token` (form-encoded token exchange).
pub async fn exchange(origin: &str, credential: &str, label: &str) -> Result<String, String> {
    pair::token_exchange(origin, credential, label)
        .await
        .map_err(|error| error.message)
}

/// False only when the server says the token is no good (an unreachable server is not that).
pub async fn session_valid(origin: &str, token: &str) -> bool {
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

/// The saved bearer token for this server, or a new one: on this computer, for a server this
/// terminal found on the loopback, one minted through the server's own program and saved. `Err`
/// carries what the user should do (`selectCredential` and `connectLocally` in the TypeScript
/// terminal).
pub async fn bearer_for(
    found: &Found,
    home: &Path,
    notify: impl Fn(&str),
) -> Result<String, String> {
    let saved = find_credential(&found.environment_id, &found.origin)?;
    let elsewhere = if saved.is_none() {
        saved_address(&found.environment_id)?
    } else {
        None
    };
    let local = found.pid != 0 && is_loopback_origin(&found.origin);
    if let Some(saved) = &saved
        && (!local || session_valid(&found.origin, &saved.token).await)
    {
        return Ok(saved.token.clone());
    }
    let missing = || match &elsewhere {
        None => fill(
            s(
                "Not connected to {label} yet.\nCreate a pairing link in the desktop app, then run 'oop pair <link>' once.",
                "{label} 와(과) 아직 연결되지 않았습니다.\n데스크톱 앱에서 페어링 링크를 만든 뒤 'oop pair <링크>' 를 한 번 실행하세요.",
            ),
            &[("label", found.label.clone())],
        ),
        Some(elsewhere) => fill(
            s(
                "{origin} is not the server you saved when pairing ({elsewhere}), so the saved token was not sent.\nTo use the saved server run 'oop --server {elsewhere}'; to use this one, run 'oop pair <link>' with a pairing link made on it.",
                "{origin} 은(는) 연결할 때 저장한 서버({elsewhere})가 아니므로 저장된 토큰을 보내지 않습니다.\n저장한 서버를 쓰려면 'oop --server {elsewhere}' 를, 이 서버를 쓰려면 이 서버에서 만든 페어링 링크로 'oop pair <링크>' 를 실행하세요.",
            ),
            &[
                ("origin", found.origin.clone()),
                ("elsewhere", elsewhere.clone()),
            ],
        ),
    };
    if !local {
        return Err(missing());
    }
    let label = client_label().await;
    notify(s(
        "Pairing with this computer's server…",
        "이 컴퓨터의 서버와 연결하는 중입니다…",
    ));
    let why = match mint_local_pairing_token(found, home, &label).await {
        None => s(
            "Automatic connection failed: the running OOP server did not give out a connection token.",
            "자동 연결 실패: 실행 중인 OOP 서버에서 연결 토큰을 받지 못했습니다.",
        )
        .to_string(),
        Some(token) => match exchange(&found.origin, &token, &label).await {
            Ok(bearer) => {
                save(found, &bearer)?;
                return Ok(bearer);
            }
            Err(reason) => fill(
                s(
                    "Automatic connection failed: {reason}",
                    "자동 연결 실패: {reason}",
                ),
                &[("reason", reason)],
            ),
        },
    };
    // An old token that could not be checked is still the best there is.
    match saved {
        Some(saved) => Ok(saved.token),
        None => Err(format!("{why}\n{}", missing())),
    }
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
    let scheme = http::ws_scheme(&found.origin)?;
    Ok(format!(
        "{scheme}://{authority}/ws?wsTicket={}&clientSurface=cli&clientAppVersion={}&clientDeviceType=desktop&clientOs={}&connectionMethod=direct&orchestrationProtocol={ORCHESTRATION_PROTOCOL}",
        http::form_encode(&ticket),
        http::form_encode(version),
        http::form_encode(client_os()),
    ))
}

/// How opening a gateway computer went. `Final` says the computer cannot be used now (the host
/// stopped sharing it, cannot reach it, or refused the login): the terminal goes back to this
/// computer instead of retrying. `Retry` leaves it open whether another try is worth it.
pub enum GatewayFail {
    Final(String),
    Retry(String),
}

/// The WebSocket address of a gateway computer: the computer's public descriptor and a one-time
/// host ticket, both asked through that computer's gateway path, then the same client parameters
/// the direct session sends, on the gateway's own `/ws`. The host's login goes with every step; the
/// gateway trades it for its own toward the upstream.
///
/// The descriptor goes first because the host answers the ticket itself while the computer is
/// still registered: only the descriptor is forwarded, so it is what tells an unreachable computer
/// (502) or a route that now leads somewhere else (another `environmentId`) from a working one.
pub async fn gateway_websocket_url(
    found: &Found,
    bearer: &str,
    remote: &crate::link::Remote,
    version: &str,
) -> Result<String, GatewayFail> {
    let prefix = crate::gateway::environment_prefix(&remote.environment_id);
    let auth = [("Authorization", format!("Bearer {bearer}"))];
    // The reason names the computer that was picked, not the host that answered.
    let gone = |en: &'static str, ko: &'static str| {
        GatewayFail::Final(fill(s(en, ko), &[("label", remote.label.clone())]))
    };
    let descriptor = http::request(
        "GET",
        &found.origin,
        &format!("{prefix}/.well-known/t3/environment"),
        &auth,
        None,
        Duration::from_secs(10),
    )
    .await
    .map_err(GatewayFail::Retry)?;
    match descriptor.status {
        401 | 403 => {
            return Err(gone(
                "The sign-in for {label} was refused. Back on this computer.",
                "{label} 의 로그인이 거부되었습니다. 이 컴퓨터로 돌아왔습니다.",
            ));
        }
        404 => {
            return Err(gone(
                "{label} is not shared from this computer any more. Back on this computer.",
                "{label} 이(가) 더 이상 이 컴퓨터에서 공유되지 않습니다. 이 컴퓨터로 돌아왔습니다.",
            ));
        }
        502 => {
            return Err(gone(
                "{label} cannot be reached right now. Back on this computer.",
                "지금 {label} 에 연결할 수 없습니다. 이 컴퓨터로 돌아왔습니다.",
            ));
        }
        200 => {
            // A descriptor without an id says nothing about which computer answered, so it is
            // taken as the one that was asked for.
            let answered = descriptor
                .json()
                .map_err(GatewayFail::Retry)?
                .get("environmentId")
                .and_then(|id| id.as_str())
                .map(str::to_string);
            if answered.is_some_and(|id| id != remote.environment_id) {
                return Err(gone(
                    "{label} answered as a different computer. Back on this computer.",
                    "{label} 이(가) 다른 컴퓨터로 응답했습니다. 이 컴퓨터로 돌아왔습니다.",
                ));
            }
        }
        status => return Err(GatewayFail::Retry(format!("the server answered {status}"))),
    }
    let answer = http::request(
        "POST",
        &found.origin,
        &format!("{prefix}/api/auth/websocket-ticket"),
        &auth,
        None,
        Duration::from_secs(10),
    )
    .await
    .map_err(GatewayFail::Retry)?;
    match answer.status {
        401 | 403 => {
            return Err(gone(
                "The sign-in for {label} was refused. Back on this computer.",
                "{label} 의 로그인이 거부되었습니다. 이 컴퓨터로 돌아왔습니다.",
            ));
        }
        404 => {
            return Err(gone(
                "{label} is not shared from this computer any more. Back on this computer.",
                "{label} 이(가) 더 이상 이 컴퓨터에서 공유되지 않습니다. 이 컴퓨터로 돌아왔습니다.",
            ));
        }
        502 => {
            return Err(gone(
                "{label} cannot be reached right now. Back on this computer.",
                "지금 {label} 에 연결할 수 없습니다. 이 컴퓨터로 돌아왔습니다.",
            ));
        }
        status if status != 200 => {
            return Err(GatewayFail::Retry(format!("the server answered {status}")));
        }
        _ => {}
    }
    let ticket = answer.json().map_err(GatewayFail::Retry)?["ticket"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| GatewayFail::Retry("the server issued no WebSocket ticket".into()))?;
    let authority = http::authority(&found.origin).map_err(GatewayFail::Retry)?;
    let scheme = http::ws_scheme(&found.origin).map_err(GatewayFail::Retry)?;
    Ok(format!(
        "{scheme}://{authority}{prefix}/ws?wsTicket={}&clientSurface=cli&clientAppVersion={}&clientDeviceType=desktop&clientOs={}&connectionMethod=direct&orchestrationProtocol={ORCHESTRATION_PROTOCOL}",
        http::form_encode(&ticket),
        http::form_encode(version),
        http::form_encode(client_os()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_is_found_in_the_app_this_client_came_with() {
        let dir = std::env::temp_dir().join(format!("oop-rs-bundle-{}", std::process::id()));
        let contents = dir.join("Elsewhere/OOP.app/Contents");
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        std::fs::create_dir_all(contents.join("Resources/oop")).unwrap();
        std::fs::write(contents.join("MacOS/OOP"), "").unwrap();
        std::fs::write(contents.join("Resources/app.asar"), "").unwrap();
        let exe = contents.join("Resources/oop/oop-rs");
        let bundle = bundle_of(&exe).expect("inside an app bundle");
        assert_eq!(bundle, dir.join("Elsewhere/OOP.app"));
        let program = app_program_at(&bundle).expect("the app's server");
        assert_eq!(
            PathBuf::from(&program.script),
            bundle
                .join("Contents/Resources/app.asar")
                .join("apps/server/dist/bin.mjs")
        );
        assert!(!program.explicit);
        assert!(bundle_of(Path::new("/usr/local/bin/oop-rs")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_renamed_app_is_used_rather_than_the_oop_app_beside_it() {
        // Nothing says the bundle this client came with is still called OOP.app: it may have been
        // renamed, and a different OOP.app next to it is not the app to start.
        let dir = std::env::temp_dir().join(format!("oop-rs-bundle-{}", crate::text::new_id()));
        let renamed = dir.join("Elsewhere/OOP 2.app");
        let decoy = dir.join("Elsewhere/OOP.app");
        for bundle in [&renamed, &decoy] {
            let contents = bundle.join("Contents");
            std::fs::create_dir_all(contents.join("MacOS")).unwrap();
            std::fs::create_dir_all(contents.join("Resources/oop")).unwrap();
            std::fs::write(contents.join("MacOS/OOP"), "").unwrap();
            std::fs::write(contents.join("Resources/app.asar"), "").unwrap();
        }
        let exe = renamed.join("Contents/Resources/oop/oop-rs");
        let bundle = bundle_of(&exe).expect("inside an app bundle");
        assert_eq!(bundle, renamed);
        let program = app_program_at(&bundle).expect("the renamed app's server");
        assert_eq!(
            PathBuf::from(&program.executable),
            renamed.join("Contents/MacOS/OOP")
        );
        assert_eq!(
            PathBuf::from(&program.script),
            renamed
                .join("Contents/Resources/app.asar")
                .join("apps/server/dist/bin.mjs")
        );
        // The bare folder is no bundle, so the fallback can never find this app by the parent.
        assert!(app_program_at(&dir.join("Elsewhere")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    /// A home of its own per test, removed again; the marker lives under `runtime/`.
    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oop-rs-{name}-{}", crate::text::new_id()));
        std::fs::create_dir_all(dir.join("runtime")).unwrap();
        dir
    }

    /// Writes the marker and, whatever the file system's timestamp granularity, reads its mtime
    /// back: `now` is built from that, so the age is the one the test means.
    fn marker_written(home: &Path) -> SystemTime {
        let file = update_marker_path(home);
        std::fs::write(&file, "").unwrap();
        std::fs::metadata(&file).unwrap().modified().unwrap()
    }

    #[test]
    fn the_update_marker_is_runtime_desktop_update_installing_under_the_home() {
        assert_eq!(
            update_marker_path(Path::new("/Users/me/.oop-desktop")),
            PathBuf::from("/Users/me/.oop-desktop/runtime/desktop-update-installing")
        );
    }

    #[test]
    fn a_recent_marker_counts_as_an_update_only_while_it_is_fresh() {
        let home = temp_home("marker-fresh");
        let written = marker_written(&home);
        assert!(update_in_progress(&home, written));
        assert!(update_in_progress(&home, written + Duration::from_secs(60)));
        assert!(update_in_progress(
            &home,
            written + UPDATE_MARKER_FRESH - Duration::from_millis(1)
        ));
        assert!(!update_in_progress(&home, written + UPDATE_MARKER_FRESH));
        assert!(!update_in_progress(
            &home,
            written + Duration::from_secs(60 * 60)
        ));
        // A timestamp from the future (a clock that moved back) is not an old install.
        assert!(update_in_progress(
            &home,
            written - Duration::from_secs(60 * 60)
        ));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_missing_marker_is_no_update() {
        let home = temp_home("marker-missing");
        assert!(!update_in_progress(&home, SystemTime::now()));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn a_fresh_marker_holds_back_a_server_of_our_own() {
        let home = temp_home("marker-holds-back");
        marker_written(&home);
        // `resolve` reads the clock itself, and the marker was just written: well within 15 min.
        let error = resolve(&home, false, None, true, |_| {})
            .await
            .expect_err("no server is started while the app installs an update");
        assert_eq!(error, WAITING_FOR_UPDATE);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn without_a_fresh_marker_a_held_back_start_says_why() {
        let home = temp_home("start-held-back");
        let error = resolve(&home, false, None, false, |_| {})
            .await
            .expect_err("the start is held back");
        assert_eq!(error, discover(&home).await.detail());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn loopback_names_are_one_server_whatever_the_port() {
        assert!(origins_match(
            "http://127.0.0.1:3911",
            "http://localhost:3911"
        ));
        // The app may move between loopback ports; it is still the same environment.
        assert!(origins_match(
            "http://127.0.0.1:3773/",
            "http://127.0.0.1:41000"
        ));
        assert!(origins_match(
            "http://127.0.0.1:3773/",
            "http://localhost:3999"
        ));
        assert!(origins_match("http://127.0.0.1:3773/", "http://[::1]:5000"));
        // But not across schemes, and not off the loopback.
        assert!(!origins_match(
            "http://127.0.0.1:3773",
            "https://127.0.0.1:3773"
        ));
        assert!(!origins_match(
            "http://192.168.0.5:3773",
            "http://192.168.0.5:3774"
        ));
        assert!(!origins_match(
            "http://192.168.0.5:3773",
            "http://evil.example:3773"
        ));
        assert!(origins_match(
            "http://192.168.0.5:3773/",
            "http://192.168.0.5:3773"
        ));
    }

    #[test]
    fn secure_and_plain_origins_are_different_servers() {
        assert!(origins_match("https://a.example/", "https://a.example:443"));
        assert!(!origins_match("https://a.example", "http://a.example:443"));
        assert!(!origins_match("https://a.example", "https://b.example"));
        assert!(origins_match("http://[::1]:3911", "http://localhost:3911"));
    }

    #[tokio::test]
    async fn the_socket_address_follows_the_scheme_of_the_origin() {
        // `websocket_url` asks the server for a ticket first, so only the pieces are checked here.
        assert_eq!(http::ws_scheme("https://t.example").unwrap(), "wss");
        assert_eq!(
            http::authority("https://t.example").unwrap(),
            "t.example:443"
        );
        assert_eq!(parse_port("https://t.example"), Some(443));
        assert_eq!(parse_port("http://127.0.0.1:3911"), Some(3911));
    }

    // ---- inspect: ss output, Windows script and answer ------------------------------------

    const SS: &str = "LISTEN 0 511 127.0.0.1:3873 0.0.0.0:* users:((\"node\",pid=4242,fd=20))\n\
LISTEN 0 4096 [::1]:3773 [::]:* users:((\"OOP\",pid=77,fd=9),(\"OOP\",pid=78,fd=9))\n\
LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n";

    #[test]
    fn ss_output_says_who_listens_on_a_port() {
        assert!(listens_on(SS, 4242, 3873));
        assert!(listens_on(SS, 78, 3773), "a socket shared by two pids");
        // Right port, wrong owner; right owner, wrong port; a port that only ends the same.
        assert!(!listens_on(SS, 4243, 3873));
        assert!(!listens_on(SS, 4242, 3773));
        assert!(!listens_on(SS, 4242, 873));
        assert!(!listens_on(SS, 4242, 22));
        // `pid=42` is not `pid=4242`.
        assert!(!listens_on(SS, 42, 3873));
        assert!(!listens_on("", 1, 1));
    }

    #[test]
    fn the_windows_inspect_script_checks_the_sid_and_the_listener() {
        let script = windows_inspect_script(4242, 3873);
        assert!(script.contains("$serverPid = 4242"));
        assert!(script.contains("$serverPort = 3873"));
        assert!(script.contains("GetOwnerSid"));
        assert!(script.contains("WindowsIdentity]::GetCurrent().User.Value"));
        assert!(script.contains(
            "Get-NetTCPConnection -State Listen -LocalPort $serverPort -OwningProcess $serverPid"
        ));
        assert!(script.contains("ConvertTo-Json -Compress"));
        assert!(script.starts_with("$ErrorActionPreference = 'Stop'; try { "));
        assert!(script.ends_with(" } catch { exit 1 }"));
    }

    #[test]
    fn the_windows_inspect_answer_is_json_after_an_optional_byte_order_mark() {
        let json = r#"{"executable":"C:\\Users\\a\\OOP\\OOP.exe","command":"  \"C:\\Users\\a\\OOP\\OOP.exe\" x  "}"#;
        let (exe, command) = parse_windows_inspect(&format!("\u{feff}{json}\r\n")).expect("parsed");
        assert_eq!(exe, "C:\\Users\\a\\OOP\\OOP.exe");
        assert_eq!(command, "\"C:\\Users\\a\\OOP\\OOP.exe\" x");
        assert_eq!(
            parse_windows_inspect(r#"{"executable":"","command":"x"}"#),
            None
        );
        assert_eq!(parse_windows_inspect(r#"{"command":"x"}"#), None);
        assert_eq!(parse_windows_inspect("not json"), None);
        assert_eq!(parse_windows_inspect(""), None);
    }

    #[test]
    fn windows_command_lines_give_their_server_script() {
        let quoted = r#""C:\Program Files\OOP\OOP.exe" "C:\Users\a b\OOP\resources\server.asar\apps\server\dist\bin.mjs" serve --daemon"#;
        assert_eq!(
            parse_server_script(quoted).as_deref(),
            Some(r"C:\Users\a b\OOP\resources\server.asar\apps\server\dist\bin.mjs")
        );
        let bare = r"C:\node\node.exe C:\repo\apps\server\src\bin.ts serve";
        assert_eq!(
            parse_server_script(bare).as_deref(),
            Some(r"C:\repo\apps\server\src\bin.ts")
        );
        // At the end of the line, and after a quoted executable.
        assert_eq!(
            parse_server_script(r#""C:\n.exe" D:\x\apps\server\dist\bin.mjs"#).as_deref(),
            Some(r"D:\x\apps\server\dist\bin.mjs")
        );
        // Not the server: another script, no second backslash after the drive, a longer name.
        assert_eq!(
            parse_server_script(r"C:\node.exe C:\repo\apps\other\bin.mjs"),
            None
        );
        assert_eq!(
            parse_server_script(r"node.exe C:\apps\server\dist\bin.mjs"),
            None
        );
        assert_eq!(
            parse_server_script(r"node.exe C:\r\apps\server\dist\bin.mjs.map"),
            None
        );
        assert_eq!(
            parse_server_script(r"node.exe x C:\r\apps\server\dist\bin.mjsx"),
            None
        );
        // A POSIX path still goes first.
        assert_eq!(
            parse_server_script("node /r/apps/server/dist/bin.mjs serve").as_deref(),
            Some("/r/apps/server/dist/bin.mjs")
        );
    }

    // ---- the app program on Windows and what it is started with ---------------------------

    #[test]
    fn the_per_user_windows_install_is_under_local_app_data() {
        let home = Path::new("/home/a");
        assert_eq!(
            windows_app_dir(Some("/L"), home),
            PathBuf::from("/L").join("Programs").join("OOP")
        );
        // Blank is as good as unset: the profile's own folder.
        assert_eq!(
            windows_app_dir(Some("  "), home),
            home.join("AppData")
                .join("Local")
                .join("Programs")
                .join("OOP")
        );
        assert_eq!(
            windows_app_dir(None, home),
            home.join("AppData")
                .join("Local")
                .join("Programs")
                .join("OOP")
        );
    }

    #[test]
    fn a_windows_app_folder_has_its_executable_and_server_archive() {
        let dir = std::env::temp_dir().join(format!("oop-rs-win-{}", crate::text::new_id()));
        assert!(windows_app_program_at(&dir).is_none());
        std::fs::create_dir_all(dir.join("resources")).unwrap();
        std::fs::write(dir.join("OOP.exe"), "").unwrap();
        assert!(
            windows_app_program_at(&dir).is_none(),
            "an executable alone has no server"
        );
        std::fs::write(dir.join("resources").join("server.asar"), "").unwrap();
        let program = windows_app_program_at(&dir).expect("the app's server");
        assert_eq!(PathBuf::from(&program.executable), dir.join("OOP.exe"));
        assert_eq!(
            PathBuf::from(&program.script),
            dir.join("resources")
                .join("server.asar")
                .join("apps")
                .join("server")
                .join("dist")
                .join("bin.mjs")
        );
        assert!(!program.explicit);
        assert!(
            program.electron,
            "the app's executable runs the script as Node"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_apps_own_executable_gets_the_run_as_node_switch() {
        let names = || ["PATH", "T3CODE_HOME", "T3CODE_PORT", "HOME"].map(String::from);
        let app = daemon_environment(names(), true);
        assert!(app.contains(&("T3CODE_HOME".to_string(), None)));
        assert!(app.contains(&("T3CODE_PORT".to_string(), None)));
        assert!(app.contains(&("ELECTRON_RUN_AS_NODE".to_string(), Some("1"))));
        assert!(!app.iter().any(|(name, _)| name == "PATH" || name == "HOME"));
        // A plain node must not be told to behave as Electron.
        let node = daemon_environment(names(), false);
        assert!(node.contains(&("ELECTRON_RUN_AS_NODE".to_string(), None)));
        assert!(node.contains(&("T3CODE_HOME".to_string(), None)));
    }

    #[test]
    fn the_server_is_started_on_the_loopback_in_the_given_home() {
        let program = AppProgram {
            executable: "/x/OOP".into(),
            script: "/x/bin.mjs".into(),
            explicit: false,
            electron: true,
        };
        let (file, args) = daemon_command(&program, Path::new("/h"), 3873);
        assert_eq!(file, "/x/OOP");
        assert_eq!(
            args,
            [
                "/x/bin.mjs",
                "serve",
                "--daemon",
                "--base-dir",
                "/h",
                "--host",
                "127.0.0.1",
                "--port",
                "3873"
            ]
        );
    }

    // ---- the launcher's cooldown ------------------------------------------------------------

    #[test]
    fn failures_back_off_from_ten_seconds_to_two_minutes() {
        let secs = |n| Duration::from_secs(n);
        assert_eq!(failure_backoff(1), secs(10));
        assert_eq!(failure_backoff(2), secs(20));
        assert_eq!(failure_backoff(3), secs(40));
        assert_eq!(failure_backoff(4), secs(80));
        assert_eq!(failure_backoff(5), secs(120));
        assert_eq!(failure_backoff(50), secs(120));
        assert_eq!(failure_backoff(u32::MAX), secs(120));
    }

    #[test]
    fn a_held_lock_waits_five_seconds_and_does_not_count_as_a_failure() {
        let now = Instant::now();
        let mut cooldown = Cooldown::new();
        assert!(!cooldown.cooling(now));
        cooldown.settle(&Daemon::Occupied, now);
        assert!(cooldown.cooling(now + Duration::from_millis(4_999)));
        assert!(!cooldown.cooling(now + HELD_GAP));
        assert_eq!(cooldown.failures, 0);
    }

    #[test]
    fn failed_and_slow_starts_back_off_more_each_time_and_a_good_one_resets() {
        let now = Instant::now();
        let mut cooldown = Cooldown::new();
        cooldown.settle(&Daemon::Unusable("x".into()), now);
        assert!(cooldown.cooling(now + Duration::from_secs(9)));
        assert!(!cooldown.cooling(now + Duration::from_secs(10)));
        cooldown.settle(&Daemon::Slow, now);
        assert!(cooldown.cooling(now + Duration::from_secs(19)));
        assert!(!cooldown.cooling(now + Duration::from_secs(20)));
        // Not starting at all says nothing about the launcher.
        let before = cooldown.not_before;
        cooldown.settle(&Daemon::Updating, now + Duration::from_secs(100));
        cooldown.settle(&Daemon::Cooling, now + Duration::from_secs(100));
        assert_eq!(cooldown.not_before, before);
        assert_eq!(cooldown.failures, 2);
        cooldown.settle(&Daemon::Ready, now);
        assert!(!cooldown.cooling(now));
        assert_eq!(cooldown.failures, 0);
    }

    // ---- reconnecting to the same server only ---------------------------------------------

    fn found(environment_id: &str, origin: &str) -> Found {
        Found {
            pid: 1,
            origin: origin.into(),
            environment_id: environment_id.into(),
            label: "OOP".into(),
            daemon: false,
        }
    }

    #[test]
    fn a_server_found_again_must_be_the_same_environment_at_a_matching_address() {
        crate::i18n::init(Some("en"));
        let known = found("env-1", "http://127.0.0.1:3773");
        // The app moved to another loopback port: still it.
        assert!(reverified(&known, found("env-1", "http://127.0.0.1:41000")).is_ok());
        // Another environment, or the same one off the loopback, gets no token.
        for other in [
            found("env-2", "http://127.0.0.1:3773"),
            found("env-1", "http://192.168.0.5:3773"),
            found("env-1", "https://127.0.0.1:3773"),
        ] {
            let error = reverified(&known, other).expect_err("not the same server");
            assert_eq!(error.reason, "Different server, token not sent");
            assert!(error.found, "a server is there: that is not an absence");
        }
    }

    // ---- the credential file ----------------------------------------------------------------

    #[test]
    fn a_credential_file_keeps_its_credentials_and_drops_what_is_not_one() {
        crate::i18n::init(Some("en"));
        let path = Path::new("/c/credentials.json");
        let good = r#"{"environmentId":"e","label":"L","httpBaseUrl":"http://127.0.0.1:3773","token":"t","savedAt":"2026-01-01T00:00:00Z"}"#;
        let text = format!(
            r#"{{"environments":{{"a":{good},"b":{{"environmentId":"e"}},"c":{}}}}}"#,
            good.replace(r#""token":"t""#, r#""token":"""#)
        );
        let file = parse_credential_file(&text, path).expect("a credential file");
        assert_eq!(file.environments.keys().collect::<Vec<_>>(), ["a"]);
        assert_eq!(file.version, 1, "a missing version is no fault");
        let not_json = parse_credential_file("{", path).err().expect("damaged");
        assert_eq!(
            not_json,
            "The credentials file is damaged (not JSON): /c/credentials.json\nCheck or delete the file, then reconnect with 'oop pair <link>'."
        );
        let wrong = parse_credential_file(r#"{"environments":null}"#, path)
            .err()
            .unwrap();
        assert!(wrong.contains("(unexpected format)"), "{wrong}");
        assert!(parse_credential_file("[]", path).is_err());
    }

    #[test]
    fn a_server_that_says_nothing_about_its_protocol_speaks_the_first() {
        assert_eq!(protocol_version(&serde_json::json!({})), Some(1));
        assert_eq!(
            protocol_version(&serde_json::json!({"orchestrationProtocolVersion": 1})),
            Some(1)
        );
        assert_eq!(
            protocol_version(&serde_json::json!({"orchestrationProtocolVersion": 2})),
            Some(2)
        );
        assert_eq!(
            protocol_version(&serde_json::json!({"orchestrationProtocolVersion": "1"})),
            None
        );
    }

    #[test]
    fn loopback_origins_are_recognised_by_their_host() {
        assert!(is_loopback_origin("http://127.0.0.1:3773"));
        assert!(is_loopback_origin("http://localhost:1/"));
        assert!(is_loopback_origin("http://[::1]:3773"));
        assert!(!is_loopback_origin("http://192.168.0.5:3773"));
        assert!(!is_loopback_origin("not an origin"));
    }

    #[tokio::test]
    async fn an_explicit_address_that_nothing_answers_says_so() {
        crate::i18n::init(Some("en"));
        let home = temp_home("explicit-silent");
        let error = resolve(&home, false, Some("127.0.0.1:1"), true, |_| {})
            .await
            .expect_err("nothing listens on port 1");
        assert_eq!(error, "No OOP server is answering at http://127.0.0.1:1.");
        let _ = std::fs::remove_dir_all(&home);
    }
}
