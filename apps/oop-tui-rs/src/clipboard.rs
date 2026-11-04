//! Putting text on the clipboard, as the former TypeScript terminal did:
//! OSC 52 always, which the terminal turns into a copy on the machine it runs on, and for a session
//! on this computer also the platform's tool: pbcopy on macOS; wl-copy, xclip and xsel on Linux, the
//! one for the running display server first; clip.exe on Windows and in WSL. Over SSH only OSC 52, as
//! a tool would fill the remote machine's clipboard. A tool is run with no shell: its command and
//! arguments are fixed and the text only ever travels on its standard input.
//!
//! Reading goes the other way and only ever happens for an explicit paste (Ctrl-V, Cmd-V): pbpaste
//! on macOS; wl-paste, xclip and xsel on Linux; PowerShell's Get-Clipboard on Windows and in WSL.
//! Over SSH there is no tool, since it would read the remote machine's clipboard; the terminal's own
//! paste (bracketed paste) is what works there.

use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Most base64 characters sent: xterm's own limit is of this order and tmux and others cut below it.
pub const OSC52_MAX_BASE64: usize = 100_000;
pub const TOOL_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Other,
}

impl Platform {
    pub fn current() -> Platform {
        if cfg!(target_os = "macos") {
            Platform::Mac
        } else if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Other
        }
    }
}

/// A program that reads the text from its standard input and puts it on the system clipboard.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tool {
    pub command: String,
    pub args: Vec<String>,
    /// `clip.exe` reads the console's code page unless the input is UTF-16 with a byte order mark.
    pub utf16: bool,
}

fn tool(command: &str, args: &[&str], utf16: bool) -> Tool {
    Tool {
        command: command.into(),
        args: args.iter().map(|a| a.to_string()).collect(),
        utf16,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// OSC 52 is written; tmux needs it wrapped to pass it on.
    pub tmux: bool,
    /// Tried in order until one works; none over SSH.
    pub tools: Vec<Tool>,
}

pub fn plan(env: impl Fn(&str) -> Option<String>, platform: Platform) -> Plan {
    let set = |name: &str| env(name).is_some_and(|v| !v.is_empty());
    let tmux = set("TMUX");
    if ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"]
        .iter()
        .any(|n| set(n))
    {
        return Plan {
            tmux,
            tools: vec![],
        };
    }
    let tools = match platform {
        Platform::Mac => vec![tool("pbcopy", &[], false)],
        Platform::Windows => vec![tool("clip.exe", &[], true)],
        Platform::Other => {
            let xclip = tool("xclip", &["-selection", "clipboard"], false);
            let xsel = tool("xsel", &["--clipboard", "--input"], false);
            let wl = tool("wl-copy", &[], false);
            let x11_first = !set("WAYLAND_DISPLAY") && set("DISPLAY");
            let mut linux = if x11_first {
                vec![xclip, xsel, wl]
            } else {
                vec![wl, xclip, xsel]
            };
            if set("WSL_DISTRO_NAME") {
                linux.push(tool("clip.exe", &[], true));
            }
            linux
        }
    };
    Plan { tmux, tools }
}

/// The tools that print the system clipboard on their standard output, tried in order; none over SSH.
pub fn read_plan(env: impl Fn(&str) -> Option<String>, platform: Platform) -> Vec<Tool> {
    let set = |name: &str| env(name).is_some_and(|v| !v.is_empty());
    if ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"]
        .iter()
        .any(|n| set(n))
    {
        return vec![];
    }
    let powershell = || {
        tool(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-Clipboard -Raw",
            ],
            false,
        )
    };
    match platform {
        Platform::Mac => vec![tool("pbpaste", &[], false)],
        Platform::Windows => vec![powershell()],
        Platform::Other => {
            let xclip = tool("xclip", &["-selection", "clipboard", "-o"], false);
            let xsel = tool("xsel", &["--clipboard", "--output"], false);
            let wl = tool("wl-paste", &["--no-newline"], false);
            let x11_first = !set("WAYLAND_DISPLAY") && set("DISPLAY");
            let mut linux = if x11_first {
                vec![xclip, xsel, wl]
            } else {
                vec![wl, xclip, xsel]
            };
            if set("WSL_DISTRO_NAME") {
                linux.push(powershell());
            }
            linux
        }
    }
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// The OSC 52 sequence for `text`, or `None` when its base64 form is longer than `max_base64`.
pub fn osc52(text: &str, tmux: bool, max_base64: usize) -> Option<String> {
    let data = base64(text.as_bytes());
    if data.len() > max_base64 {
        return None;
    }
    let sequence = format!("\u{1b}]52;c;{data}\u{7}");
    // tmux hands a sequence on to the terminal only inside its DCS passthrough, with every ESC
    // doubled; without `allow-passthrough` the wrapper is dropped, which does no harm.
    Some(if tmux {
        format!(
            "\u{1b}Ptmux;{}\u{1b}\\",
            sequence.replace('\u{1b}', "\u{1b}\u{1b}")
        )
    } else {
        sequence
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    Missing,
    Failed,
    Timeout,
}

fn encode(text: &str, utf16: bool) -> Vec<u8> {
    if utf16 {
        std::iter::once(0xFEFFu16)
            .chain(text.replace('\n', "\r\n").encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect()
    } else {
        text.as_bytes().to_vec()
    }
}

/// Runs a tool with `text` on its standard input. It never panics and never waits past the timeout.
pub async fn run_tool(tool: &Tool, text: &str, timeout: Duration) -> Result<(), Why> {
    let mut child = Command::new(&tool.command)
        .args(&tool.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Why::Missing
            } else {
                Why::Failed
            }
        })?;
    let input = encode(text, tool.utf16);
    let work = async {
        if let Some(mut stdin) = child.stdin.take() {
            // A tool that exits before it has read everything breaks the pipe: its exit code says.
            let _ = stdin.write_all(&input).await;
            drop(stdin);
        }
        child.wait().await
    };
    match tokio::time::timeout(timeout, work).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(_) => Err(Why::Failed),
        Err(_) => Err(Why::Timeout),
    }
}

/// Most bytes taken from a clipboard tool: a paste is text, and the composer folds a long one.
const READ_MAX: usize = 8 * 1024 * 1024;

/// Runs a tool and returns what it printed. It never panics and never waits past the timeout.
pub async fn read_tool(tool: &Tool, timeout: Duration) -> Result<String, Why> {
    let child = Command::new(&tool.command)
        .args(&tool.args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Why::Missing
            } else {
                Why::Failed
            }
        })?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(out)) if out.status.success() => {
            let bytes = &out.stdout[..out.stdout.len().min(READ_MAX)];
            Ok(String::from_utf8_lossy(bytes).into_owned())
        }
        Ok(_) => Err(Why::Failed),
        Err(_) => Err(Why::Timeout),
    }
}

/// Reads with the first tool that works; the last real failure is what gets reported, and a
/// machine with no tool at all reports `Missing`.
pub async fn read_tools(tools: &[Tool], timeout: Duration) -> Result<String, Why> {
    let mut last = Why::Missing;
    for candidate in tools {
        match read_tool(candidate, timeout).await {
            Ok(text) => return Ok(text),
            Err(why) => {
                if why != Why::Missing || last == Why::Missing {
                    last = why;
                }
            }
        }
    }
    Err(last)
}

/// How a copy went.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    /// Characters (code points) copied.
    pub chars: usize,
    /// OSC 52 was written; false when it was too long or the terminal could not take it.
    pub osc52_sent: bool,
    /// The tool tried last and how it went; `None` when none is used (SSH) or none exists here.
    pub tool: Option<(String, Result<(), Why>)>,
    pub too_large: bool,
}

/// Runs the plan's tools in order until one works. A tool that is not installed is passed over; the
/// last real failure is what gets reported.
pub async fn run_tools(
    plan: &Plan,
    text: &str,
    timeout: Duration,
) -> Option<(String, Result<(), Why>)> {
    let mut last: Option<(String, Result<(), Why>)> = None;
    for candidate in &plan.tools {
        match run_tool(candidate, text, timeout).await {
            Ok(()) => return Some((candidate.command.clone(), Ok(()))),
            Err(why) => {
                if why != Why::Missing || last.is_none() {
                    last = Some((candidate.command.clone(), Err(why)));
                }
            }
        }
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn base64_matches_the_rfc_examples() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64("안녕".as_bytes()), "7JWI64WV");
    }

    #[test]
    fn osc52_wraps_for_tmux_and_refuses_too_much() {
        assert_eq!(osc52("hi", false, 100).unwrap(), "\u{1b}]52;c;aGk=\u{7}");
        let wrapped = osc52("hi", true, 100).unwrap();
        assert!(wrapped.starts_with("\u{1b}Ptmux;\u{1b}\u{1b}]52;c;aGk=\u{7}"));
        assert!(wrapped.ends_with("\u{1b}\\"));
        assert!(osc52("hello", false, 4).is_none());
    }

    #[test]
    fn the_plan_follows_the_machine_and_never_runs_a_tool_over_ssh() {
        let mac = plan(env(&[]), Platform::Mac);
        assert_eq!(mac.tools, vec![tool("pbcopy", &[], false)]);
        let ssh = plan(
            env(&[("SSH_CONNECTION", "1 2 3 4"), ("TMUX", "x")]),
            Platform::Mac,
        );
        assert!(ssh.tools.is_empty() && ssh.tmux);
        let wl = plan(
            env(&[("WAYLAND_DISPLAY", "w"), ("DISPLAY", ":0")]),
            Platform::Other,
        );
        assert_eq!(wl.tools[0].command, "wl-copy");
        let x11 = plan(env(&[("DISPLAY", ":0")]), Platform::Other);
        assert_eq!(x11.tools[0].command, "xclip");
        let wsl = plan(env(&[("WSL_DISTRO_NAME", "u")]), Platform::Other);
        assert_eq!(wsl.tools.last().unwrap().command, "clip.exe");
        assert!(plan(env(&[]), Platform::Windows).tools[0].utf16);
    }

    #[test]
    fn reading_has_a_tool_per_platform_and_none_over_ssh() {
        assert_eq!(
            read_plan(env(&[]), Platform::Mac),
            vec![tool("pbpaste", &[], false)]
        );
        assert!(read_plan(env(&[("SSH_TTY", "/dev/pts/1")]), Platform::Mac).is_empty());
        let wl = read_plan(
            env(&[("WAYLAND_DISPLAY", "w"), ("DISPLAY", ":0")]),
            Platform::Other,
        );
        assert_eq!(wl[0].command, "wl-paste");
        let x11 = read_plan(env(&[("DISPLAY", ":0")]), Platform::Other);
        assert_eq!(x11[0].command, "xclip");
        assert!(x11[0].args.contains(&"-o".to_string()));
        let wsl = read_plan(env(&[("WSL_DISTRO_NAME", "u")]), Platform::Other);
        assert_eq!(wsl.last().unwrap().command, "powershell.exe");
        assert_eq!(
            read_plan(env(&[]), Platform::Windows)[0].command,
            "powershell.exe"
        );
    }

    #[tokio::test]
    async fn a_read_tool_prints_text_and_a_missing_or_failing_one_is_told_apart() {
        let dir = std::env::temp_dir().join(format!("oop-rs-clip-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-paste.sh");
        std::fs::write(&script, "#!/bin/sh\nprintf '안녕 $(x)\\n둘째'\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let fake = Tool {
            command: script.to_string_lossy().into_owned(),
            args: vec![],
            utf16: false,
        };
        let missing = Tool {
            command: "/nonexistent/oop-paste".into(),
            args: vec![],
            utf16: false,
        };
        assert_eq!(
            read_tool(&fake, TOOL_TIMEOUT).await.unwrap(),
            "안녕 $(x)\n둘째"
        );
        assert_eq!(
            read_tools(&[missing.clone(), fake], TOOL_TIMEOUT)
                .await
                .unwrap(),
            "안녕 $(x)\n둘째"
        );
        assert_eq!(
            read_tools(&[missing], TOOL_TIMEOUT).await,
            Err(Why::Missing)
        );
        assert_eq!(read_tools(&[], TOOL_TIMEOUT).await, Err(Why::Missing));
        let failing = Tool {
            command: "false".into(),
            args: vec![],
            utf16: false,
        };
        assert_eq!(read_tool(&failing, TOOL_TIMEOUT).await, Err(Why::Failed));
        let sleeper = Tool {
            command: "sleep".into(),
            args: vec!["5".into()],
            utf16: false,
        };
        assert_eq!(
            read_tool(&sleeper, Duration::from_millis(100)).await,
            Err(Why::Timeout)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clip_exe_gets_utf16_with_a_byte_order_mark() {
        assert_eq!(
            encode("a\nb", true),
            vec![0xFF, 0xFE, b'a', 0, b'\r', 0, b'\n', 0, b'b', 0]
        );
        assert_eq!(encode("가", false), "가".as_bytes());
    }

    #[tokio::test]
    async fn a_tool_receives_the_text_on_stdin_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("oop-rs-clip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("got.txt");
        let script = dir.join("fake-copy.sh");
        std::fs::write(&script, format!("#!/bin/sh\ncat > '{}'\n", out.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let fake = Tool {
            command: script.to_string_lossy().into_owned(),
            args: vec![],
            utf16: false,
        };
        // text that a shell would act on stays text
        let text = "$(touch pwned); `x` 안녕\n둘째 줄";
        run_tool(&fake, text, TOOL_TIMEOUT).await.unwrap();
        assert_eq!(std::fs::read_to_string(&out).unwrap(), text);
        assert!(!dir.join("pwned").exists());
        let missing = Tool {
            command: "/nonexistent/oop-clip".into(),
            args: vec![],
            utf16: false,
        };
        assert_eq!(
            run_tool(&missing, "x", TOOL_TIMEOUT).await,
            Err(Why::Missing)
        );
        let sleeper = Tool {
            command: "sleep".into(),
            args: vec!["5".into()],
            utf16: false,
        };
        assert_eq!(
            run_tool(&sleeper, "x", Duration::from_millis(100)).await,
            Err(Why::Timeout)
        );
        let plan = Plan {
            tmux: false,
            tools: vec![missing, fake],
        };
        let reported = run_tools(&plan, "again", TOOL_TIMEOUT).await.unwrap();
        assert!(reported.1.is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
