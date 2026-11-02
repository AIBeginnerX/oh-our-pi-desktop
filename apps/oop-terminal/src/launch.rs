//! 첫 pane에서 실행할 프로그램 탐색과 자식 프로세스 환경 구성.
//!
//! macOS GUI 앱은 셸 프로필을 읽지 않고 최소 PATH만 받으므로,
//! 여기서 PATH/TERM/LANG를 직접 정해 준다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Program {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolved {
    /// oop (또는 OOP_TERMINAL_COMMAND) 를 직접 실행한다.
    Oop(Program),
    /// oop를 못 찾아 로그인 셸을 연다. `notice`는 pane 맨 위에 한 줄로 보인다.
    Shell { program: Program, notice: String },
}

/// 탐색에 필요한 모든 입력. 테스트에서 주입할 수 있도록 분리했다.
pub struct Probe<'a> {
    pub exe_dir: Option<PathBuf>,
    pub command_override: Option<String>,
    pub search_path: Vec<PathBuf>,
    pub shell: Option<String>,
    pub is_executable: &'a dyn Fn(&Path) -> bool,
}

pub fn resolve(probe: &Probe) -> Resolved {
    if let Some(cmd) = probe
        .command_override
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        let words = split_words(cmd);
        if let Some((program, args)) = words.split_first() {
            return Resolved::Oop(Program {
                program: program.clone(),
                args: args.to_vec(),
            });
        }
    }
    if let Some(dir) = &probe.exe_dir {
        // .app 안: Contents/MacOS (실행 파일 옆) 와 Contents/Resources.
        let mut candidates = vec![dir.join("oop-rs")];
        if let Some(contents) = dir.parent() {
            candidates.push(contents.join("Resources").join("oop-rs"));
        }
        for c in candidates {
            if (probe.is_executable)(&c) {
                return Resolved::Oop(Program {
                    program: c.to_string_lossy().into_owned(),
                    args: vec![],
                });
            }
        }
    }
    for name in ["oop-rs", "oop"] {
        for dir in &probe.search_path {
            let c = dir.join(name);
            if (probe.is_executable)(&c) {
                return Resolved::Oop(Program {
                    program: c.to_string_lossy().into_owned(),
                    args: vec![],
                });
            }
        }
    }
    Resolved::Shell {
        program: Program { program: default_shell(probe.shell.as_deref()), args: login_args() },
        notice: "OOP Terminal: oop을 찾지 못해 로그인 셸을 엽니다 (OOP_TERMINAL_COMMAND 또는 PATH에 oop-rs/oop 필요).".into(),
    }
}

/// 사용자가 명시적으로 고른 "일반 셸" pane용 프로그램.
pub fn shell_program(shell: Option<&str>) -> Program {
    Program {
        program: default_shell(shell),
        args: login_args(),
    }
}

fn default_shell(shell: Option<&str>) -> String {
    match shell.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s.to_string(),
        None if cfg!(target_os = "macos") => "/bin/zsh".into(),
        None if cfg!(windows) => "cmd.exe".into(),
        None => "/bin/sh".into(),
    }
}

fn login_args() -> Vec<String> {
    if cfg!(windows) {
        vec![]
    } else {
        vec!["-l".into()]
    }
}

/// 따옴표(' ")와 백슬래시 이스케이프만 지원하는 단순 단어 분리.
pub fn split_words(input: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') => match chars.next() {
                Some(n @ ('"' | '\\' | '$' | '`')) => cur.push(n),
                Some(n) => {
                    cur.push('\\');
                    cur.push(n);
                }
                None => cur.push('\\'),
            },
            (Some(_), c) => cur.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                in_word = true;
            }
            (None, '\\') => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                    in_word = true;
                }
            }
            (None, c) if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            (None, c) => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    if in_word {
        words.push(cur);
    }
    words
}

/// GUI 실행 시 비어 있기 쉬운 PATH를 보강한다. 기존 순서를 유지하고 중복을 제거한다.
pub fn sane_path(existing: Option<&str>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !p.as_os_str().is_empty() && !out.contains(&p) {
            out.push(p);
        }
    };
    if let Some(e) = existing {
        for p in std::env::split_paths(e) {
            push(p);
        }
    }
    if let Some(h) = home {
        for sub in [".local/bin", ".cargo/bin", ".bun/bin", ".npm-global/bin"] {
            push(h.join(sub));
        }
    }
    for p in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push(PathBuf::from(p));
    }
    out
}

pub fn join_path(dirs: &[PathBuf]) -> String {
    std::env::join_paths(dirs)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 자식에게 줄 환경 변수 (alacritty tty가 상속 환경 위에 덮어쓴다).
pub fn child_env(home: &Path, path: &[PathBuf], lang: Option<&str>) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env.insert("TERM_PROGRAM".into(), "OOP Terminal".into());
    env.insert(
        "TERM_PROGRAM_VERSION".into(),
        env!("CARGO_PKG_VERSION").into(),
    );
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    env.insert("PATH".into(), join_path(path));
    env.insert("LANG".into(), utf8_lang(lang));
    env
}

fn utf8_lang(lang: Option<&str>) -> String {
    match lang {
        Some(l)
            if l.to_ascii_lowercase().contains("utf-8")
                || l.to_ascii_lowercase().contains("utf8") =>
        {
            l.to_string()
        }
        _ => "en_US.UTF-8".into(),
    }
}

/// 첫 pane의 작업 폴더: 명령행에 준 폴더(존재할 때) 또는 홈.
pub fn start_dir(arg: Option<&str>, home: &Path, is_dir: &dyn Fn(&Path) -> bool) -> PathBuf {
    if let Some(a) = arg {
        let p = PathBuf::from(a);
        if is_dir(&p) {
            return p;
        }
    }
    home.to_path_buf()
}

pub fn is_executable_file(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe<'a>(
        existing: &'a [&'a str],
        over: Option<&str>,
        exe_dir: Option<&str>,
    ) -> (Vec<String>, Option<String>, Option<PathBuf>, &'a [&'a str]) {
        (
            vec![],
            over.map(String::from),
            exe_dir.map(PathBuf::from),
            existing,
        )
    }

    fn run(
        existing: &[&str],
        over: Option<&str>,
        exe_dir: Option<&str>,
        path: &[&str],
    ) -> Resolved {
        let (_, over, exe_dir, existing) = probe(existing, over, exe_dir);
        let exists = move |p: &Path| existing.iter().any(|e| Path::new(e) == p);
        resolve(&Probe {
            exe_dir,
            command_override: over,
            search_path: path.iter().map(PathBuf::from).collect(),
            shell: Some("/bin/zsh".into()),
            is_executable: &exists,
        })
    }

    fn prog(r: &Resolved) -> &str {
        match r {
            Resolved::Oop(p) => &p.program,
            Resolved::Shell { program, .. } => &program.program,
        }
    }

    #[test]
    fn env_override_wins_over_everything() {
        let r = run(
            &["/app/Contents/MacOS/oop-rs", "/bin/oop"],
            Some("/bin/echo hi 'a b'"),
            Some("/app/Contents/MacOS"),
            &["/bin"],
        );
        assert_eq!(
            r,
            Resolved::Oop(Program {
                program: "/bin/echo".into(),
                args: vec!["hi".into(), "a b".into()]
            })
        );
    }

    #[test]
    fn blank_override_is_ignored() {
        let r = run(&["/x/oop"], Some("   "), None, &["/x"]);
        assert_eq!(prog(&r), "/x/oop");
    }

    #[test]
    fn oop_rs_beside_executable_beats_path() {
        let r = run(
            &["/app/Contents/MacOS/oop-rs", "/bin/oop-rs"],
            None,
            Some("/app/Contents/MacOS"),
            &["/bin"],
        );
        assert_eq!(prog(&r), "/app/Contents/MacOS/oop-rs");
    }

    #[test]
    fn oop_rs_in_resources_is_found() {
        let r = run(
            &["/app/Contents/Resources/oop-rs"],
            None,
            Some("/app/Contents/MacOS"),
            &["/bin"],
        );
        assert_eq!(prog(&r), "/app/Contents/Resources/oop-rs");
    }

    #[test]
    fn path_prefers_oop_rs_then_oop() {
        let r = run(&["/a/oop", "/b/oop-rs"], None, None, &["/a", "/b"]);
        assert_eq!(prog(&r), "/b/oop-rs");
        let r = run(&["/a/oop"], None, None, &["/a", "/b"]);
        assert_eq!(prog(&r), "/a/oop");
    }

    #[test]
    fn falls_back_to_login_shell_with_notice() {
        match run(&[], None, None, &["/a"]) {
            Resolved::Shell { program, notice } => {
                assert_eq!(program.program, "/bin/zsh");
                assert_eq!(program.args, vec!["-l".to_string()]);
                assert!(!notice.contains('\n'));
                assert!(notice.contains("oop"));
            }
            other => panic!("셸 폴백이어야 함: {other:?}"),
        }
    }

    #[test]
    fn split_words_handles_quotes_and_escapes() {
        assert_eq!(
            split_words(r#"a "b c" 'd e' f\ g"#),
            vec!["a", "b c", "d e", "f g"]
        );
        assert_eq!(
            split_words(r#"sh -c "echo \"hi\"""#),
            vec!["sh", "-c", "echo \"hi\""]
        );
        assert_eq!(split_words("''"), vec![""]);
        assert!(split_words("   ").is_empty());
    }

    #[test]
    fn sane_path_keeps_order_and_adds_gui_gaps() {
        let p = sane_path(Some("/usr/bin:/custom"), Some(Path::new("/home/u")));
        assert_eq!(p[0], PathBuf::from("/usr/bin"));
        assert_eq!(p[1], PathBuf::from("/custom"));
        assert!(p.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(p.contains(&PathBuf::from("/home/u/.local/bin")));
        assert_eq!(
            p.iter()
                .filter(|x| x.as_path() == std::path::Path::new("/usr/bin"))
                .count(),
            1
        );
        let empty = sane_path(None, None);
        assert!(empty.contains(&PathBuf::from("/bin")));
    }

    #[test]
    fn child_env_is_profile_independent() {
        let env = child_env(
            Path::new("/h"),
            &[PathBuf::from("/a"), PathBuf::from("/b")],
            None,
        );
        assert_eq!(env["TERM"], "xterm-256color");
        assert_eq!(env["COLORTERM"], "truecolor");
        assert_eq!(env["LANG"], "en_US.UTF-8");
        assert_eq!(env["PATH"], "/a:/b");
        assert_eq!(env["HOME"], "/h");
        let env = child_env(Path::new("/h"), &[], Some("ko_KR.UTF-8"));
        assert_eq!(env["LANG"], "ko_KR.UTF-8");
        let env = child_env(Path::new("/h"), &[], Some("C"));
        assert_eq!(env["LANG"], "en_US.UTF-8");
    }

    #[test]
    fn start_dir_uses_arg_only_when_it_is_a_directory() {
        let home = Path::new("/home/u");
        let is_dir = |p: &Path| p == Path::new("/work");
        assert_eq!(
            start_dir(Some("/work"), home, &is_dir),
            PathBuf::from("/work")
        );
        assert_eq!(start_dir(Some("/nope"), home, &is_dir), home);
        assert_eq!(start_dir(None, home, &is_dir), home);
    }
}
