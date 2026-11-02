//! The newest release and what it brought: a port of `updateCheck.ts` of the TypeScript terminal.
//! The update feed (`version` only) and the release notes are fetched together, cut off after three
//! seconds each, kept in `update-cache.json` for an hour, and cleaned of anything a terminal could
//! act on. Nothing is installed; the report says what is newer and how to get it.

use crate::http;
use crate::i18n::{Lang, lang};
use crate::panels_common::{fill, s};
use crate::text::sanitize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The newest release's update feed, as the desktop app reads it. Only `version` is used.
pub const RELEASE_FEED_URL: &str = "https://github.com/AIBeginnerX/oh-our-pi-desktop/releases/latest/download/oop-update-macos.json";
/// The release notes shown inside the app, newest first.
pub const RELEASE_NOTES_URL: &str = "https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/packages/shared/src/releaseNotes.json";

pub const FETCH_TIMEOUT: Duration = Duration::from_millis(3000);
pub const CACHE_TTL_MS: i64 = 60 * 60 * 1000;
const FEED_LIMIT_BYTES: usize = 64 * 1024;
const NOTES_LIMIT_BYTES: usize = 1024 * 1024;
const MAX_ENTRIES: usize = 40;
const MAX_HIGHLIGHTS: usize = 6;
const TEXT_LIMIT: usize = 300;
const MAX_REDIRECTS: usize = 5;
/// Most releases the listing spells out, and highlights shown for each.
pub const LISTED_RELEASES: usize = 10;
pub const LISTED_HIGHLIGHTS: usize = 3;

/// The notes that ship with this build, for when the network gave none.
const BUNDLED_NOTES: &str = include_str!("../../../packages/shared/src/releaseNotes.json");

/// `0.0.127`: one to four dotted numbers of at most six digits each.
pub fn is_release_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    (2..=4).contains(&parts.len())
        && parts
            .iter()
            .all(|p| (1..=6).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Orders dotted numeric versions; a missing or non-numeric part counts as 0.
pub fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parts = |v: &str| -> Vec<i64> {
        v.split('.')
            .map(|p| {
                let digits: String = p.chars().take_while(char::is_ascii_digit).collect();
                digits.parse().unwrap_or(0)
            })
            .collect()
    };
    let (a, b) = (parts(left), parts(right));
    for i in 0..a.len().max(b.len()) {
        let order = a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0));
        if order.is_ne() {
            return order;
        }
    }
    std::cmp::Ordering::Equal
}

#[derive(Debug, Clone, PartialEq)]
pub struct Highlight {
    /// Empty when the note has no English text: an English reader gets no body, not Korean.
    pub en: String,
    pub ko: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseNote {
    pub version: String,
    /// `YYYY-MM-DD`, or empty.
    pub date: String,
    pub highlights: Vec<Highlight>,
}

/// The newest release and the notes of the recent ones, newest first.
#[derive(Debug, Clone, PartialEq)]
pub struct LatestRelease {
    pub latest: String,
    pub releases: Vec<ReleaseNote>,
}

fn one_line(value: &str) -> String {
    sanitize(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(TEXT_LIMIT)
        .collect()
}

fn clean_entry(raw: &Value) -> Option<ReleaseNote> {
    let version = raw.get("version")?.as_str()?.trim().to_string();
    if !is_release_version(&version) {
        return None;
    }
    let list = raw.get("highlights")?.as_array()?;
    let mut highlights = Vec::new();
    for item in list.iter().take(MAX_HIGHLIGHTS) {
        if !item.is_object() {
            continue;
        }
        let ko = item.get("ko").and_then(Value::as_str).map(one_line);
        let en = item
            .get("en")
            .and_then(Value::as_str)
            .map(one_line)
            .unwrap_or_default();
        let ko = ko.filter(|k| !k.is_empty());
        if en.is_empty() && ko.is_none() {
            continue;
        }
        highlights.push(Highlight { en, ko });
    }
    let date = raw
        .get("date")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|d| {
            let b = d.as_bytes();
            b.len() == 10
                && b.iter().enumerate().all(|(i, c)| {
                    if i == 4 || i == 7 {
                        *c == b'-'
                    } else {
                        c.is_ascii_digit()
                    }
                })
        })
        .unwrap_or("")
        .to_string();
    Some(ReleaseNote {
        version,
        date,
        highlights,
    })
}

fn clean_entries(raw: Option<&Value>) -> Vec<ReleaseNote> {
    raw.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_ENTRIES)
        .filter_map(clean_entry)
        .collect()
}

/// `version` of the update feed, or `None` when it is missing or does not look like a version.
pub fn parse_feed_version(text: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let version = parsed.get("version")?.as_str()?.trim();
    is_release_version(version).then(|| version.to_string())
}

/// The notes file `{ "versions": [...] }`, entry by entry; `None` when not one entry is usable.
pub fn parse_notes(text: &str) -> Option<Vec<ReleaseNote>> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let entries = clean_entries(parsed.get("versions"));
    (!entries.is_empty()).then_some(entries)
}

fn bundled_notes() -> Vec<ReleaseNote> {
    serde_json::from_str::<Value>(BUNDLED_NOTES)
        .ok()
        .map(|v| clean_entries(v.get("versions")))
        .unwrap_or_default()
}

// ---- cache ---------------------------------------------------------------------------------

pub fn cache_path(config_dir: &Path) -> PathBuf {
    config_dir.join("update-cache.json")
}

fn entries_json(entries: &[ReleaseNote]) -> Value {
    Value::Array(
        entries
            .iter()
            .map(|e| {
                json!({
                    "version": e.version, "date": e.date,
                    "highlights": e.highlights.iter().map(|h| {
                        let mut item = json!({"en": h.en});
                        if let Some(ko) = &h.ko { item["ko"] = json!(ko); }
                        item
                    }).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

fn read_cache(file: &Path) -> Option<(i64, LatestRelease)> {
    let parsed: Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    let checked_at = parsed.get("checkedAt")?.as_f64()? as i64;
    let latest = parsed.get("latest")?.as_str()?.trim().to_string();
    is_release_version(&latest).then(|| {
        (
            checked_at,
            LatestRelease {
                latest,
                releases: clean_entries(parsed.get("releases")),
            },
        )
    })
}

/// A cache that cannot be written is only a missed optimisation.
fn write_cache(file: &Path, checked_at: i64, info: &LatestRelease) {
    let body = json!({
        "checkedAt": checked_at, "latest": info.latest, "releases": entries_json(&info.releases),
    });
    let _ = write_private(file, &body.to_string());
}

fn write_private(file: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temporary = file.with_extension(format!("json.{}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = options
        .open(&temporary)
        .and_then(|mut out| out.write_all(text.as_bytes()))
        .and_then(|_| std::fs::rename(&temporary, file));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

// ---- the lookup ----------------------------------------------------------------------------

/// Where the two files are fetched from; the constants, except in tests.
#[derive(Clone)]
pub struct Urls {
    pub feed: String,
    pub notes: String,
}

impl Default for Urls {
    fn default() -> Urls {
        Urls {
            feed: RELEASE_FEED_URL.to_string(),
            notes: RELEASE_NOTES_URL.to_string(),
        }
    }
}

/// `https://host/path?q` -> (`https://host`, `/path?q`).
fn split_url(url: &str) -> Option<(String, String)> {
    let after = url.find("://")? + 3;
    match url[after..].find(['/', '?']) {
        Some(at) => {
            let (origin, path) = url.split_at(after + at);
            let path = if path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            };
            Some((origin.to_string(), path))
        }
        None => Some((url.to_string(), "/".to_string())),
    }
}

/// One GET, following redirects the way `fetch` does, with no headers of ours, cut off after
/// `timeout`; the body is refused when it is over `limit` bytes.
async fn get_text(url: &str, limit: usize, timeout: Duration) -> Result<String, String> {
    let mut url = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        let (origin, path) = split_url(&url).ok_or("bad address")?;
        let response = http::request("GET", &origin, &path, &[], None, timeout).await?;
        if matches!(response.status, 301 | 302 | 303 | 307 | 308) {
            let location = response
                .header("location")
                .ok_or("redirect without a place")?;
            url = if location.contains("://") {
                location.to_string()
            } else if location.starts_with('/') {
                format!("{origin}{location}")
            } else {
                return Err("bad redirect".into());
            };
            continue;
        }
        if !(200..300).contains(&response.status) {
            return Err(format!("HTTP {}", response.status));
        }
        if response.body.len() > limit {
            return Err(s("Response too large", "응답이 너무 큽니다").into());
        }
        return Ok(String::from_utf8_lossy(&response.body).into_owned());
    }
    Err("too many redirects".into())
}

/// The newest release and its notes: from the cache while it is under an hour old, else from two
/// GETs made at once. Notes the network did not give are the ones bundled with this build. Any
/// failure is `None`, or, when the caller did not ask for a fresh answer, whatever the cache holds.
pub async fn lookup(
    urls: &Urls,
    cache_file: Option<&Path>,
    now_ms: i64,
    refresh: bool,
    timeout: Duration,
) -> Option<LatestRelease> {
    let cached = cache_file.and_then(read_cache);
    if !refresh && let Some((checked_at, info)) = &cached {
        let age = now_ms - checked_at;
        if (0..CACHE_TTL_MS).contains(&age) {
            return Some(info.clone());
        }
    }
    let notes_url = urls.notes.clone();
    let notes_task =
        tokio::spawn(async move { get_text(&notes_url, NOTES_LIMIT_BYTES, timeout).await });
    let fetched = async {
        let feed = get_text(&urls.feed, FEED_LIMIT_BYTES, timeout).await?;
        parse_feed_version(&feed)
            .ok_or_else(|| s("Could not read the version", "버전을 읽을 수 없습니다").to_string())
    }
    .await;
    match fetched {
        Ok(latest) => {
            let notes = notes_task
                .await
                .ok()
                .and_then(Result::ok)
                .and_then(|text| parse_notes(&text));
            let info = LatestRelease {
                latest,
                releases: notes.unwrap_or_else(bundled_notes),
            };
            if let Some(file) = cache_file {
                write_cache(file, now_ms, &info);
            }
            Some(info)
        }
        Err(_) => {
            // The notes are of no use without the version they belong to.
            notes_task.abort();
            if refresh {
                None
            } else {
                cached.map(|(_, info)| info)
            }
        }
    }
}

// ---- what the lookup means for a given version ---------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseView {
    pub version: String,
    pub date: String,
    /// In the language of the app, one line each.
    pub highlights: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UpdateReport {
    pub newer: bool,
    pub current: String,
    pub latest: String,
    /// The releases after `current`, up to `latest`, newest first.
    pub releases: Vec<ReleaseView>,
}

/// A highlight in `language`; empty when it has no text a reader can use (English never falls back
/// to Korean; Korean falls back to English).
fn highlight_text(highlight: &Highlight, language: Lang) -> String {
    match language {
        Lang::Ko => highlight
            .ko
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map_or_else(|| highlight.en.clone(), str::to_string),
        Lang::En => highlight.en.clone(),
    }
}

pub fn build_report(current: &str, info: &LatestRelease, language: Lang) -> UpdateReport {
    use std::cmp::Ordering::Greater;
    if compare_versions(&info.latest, current) != Greater {
        return UpdateReport {
            newer: false,
            current: current.to_string(),
            latest: info.latest.clone(),
            releases: Vec::new(),
        };
    }
    let mut entries: Vec<&ReleaseNote> = info
        .releases
        .iter()
        .filter(|e| {
            compare_versions(&e.version, current) == Greater
                && compare_versions(&e.version, &info.latest) != Greater
        })
        .collect();
    entries.sort_by(|a, b| compare_versions(&b.version, &a.version));
    UpdateReport {
        newer: true,
        current: current.to_string(),
        latest: info.latest.clone(),
        releases: entries
            .into_iter()
            .map(|e| ReleaseView {
                version: e.version.clone(),
                date: e.date.clone(),
                highlights: e
                    .highlights
                    .iter()
                    .map(|h| highlight_text(h, language))
                    .filter(|t| !t.is_empty())
                    .collect(),
            })
            .collect(),
    }
}

pub fn report_now(current: &str, info: &LatestRelease) -> UpdateReport {
    build_report(current, info, lang())
}

/// `0.0.127 (2026-10-31)`; the date is left out when the notes had none.
pub fn release_title(release: &ReleaseView) -> String {
    if release.date.is_empty() {
        release.version.clone()
    } else {
        format!("{} ({})", release.version, release.date)
    }
}

/// The releases a listing spells out, and how many it leaves out.
pub fn listed(report: &UpdateReport) -> (&[ReleaseView], usize) {
    let shown = report.releases.len().min(LISTED_RELEASES);
    (&report.releases[..shown], report.releases.len() - shown)
}

// ---- how to update -------------------------------------------------------------------------

/// Whether `oop` runs from the terminal-only install, whose launcher sets this.
pub fn runs_from_terminal_install(env: impl Fn(&str) -> Option<String>) -> bool {
    env("OOP_TERMINAL_INSTALL").as_deref() == Some("1")
}

/// Whether the TypeScript terminal runs inside the desktop app's runtime (the launcher says so with
/// `OOP_TS_NODE_ELECTRON=1`), which is how the bundled terminal is started.
pub fn runs_in_desktop_app(env: impl Fn(&str) -> Option<String>) -> bool {
    env("OOP_TS_NODE_ELECTRON").as_deref() == Some("1")
}

const RAW: &str = "https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts";

pub fn terminal_install_command(windows: bool) -> String {
    if windows {
        format!("irm {RAW}/install-terminal.ps1 | iex")
    } else {
        format!("curl -fsSL {RAW}/install-terminal.sh | sh")
    }
}

/// What to run to bring an older `oop` up to the desktop app: the desktop installer on macOS and
/// Windows, the terminal installer elsewhere.
pub fn reinstall_command(macos: bool, windows: bool) -> String {
    if macos {
        format!("curl -fsSL {RAW}/install-desktop.sh | sh")
    } else if windows {
        format!("irm {RAW}/install-desktop.ps1 | iex")
    } else {
        terminal_install_command(false)
    }
}

pub fn update_how_to(terminal_install: bool, windows: bool) -> String {
    if terminal_install {
        fill(
            s(
                "How to update: run {command}, then oop stop",
                "업데이트 방법: {command} 실행 후 oop stop",
            ),
            &[("command", terminal_install_command(windows))],
        )
    } else {
        s(
            "How to update: app menu 'Check for Updates...' → 'Prepare Update' → 'Open Installer'",
            "업데이트 방법: 앱 메뉴 '업데이트 확인...' → '업데이트 준비' → '설치 프로그램 열기'",
        )
        .to_string()
    }
}

/// The terminal app is older than the desktop app it talks to.
pub fn terminal_is_behind(terminal: &str, app: Option<&str>) -> bool {
    app.is_some_and(|app| compare_versions(terminal, app) == std::cmp::Ordering::Less)
}

pub fn terminal_behind_text(
    terminal: &str,
    app: &str,
    in_desktop_app: bool,
    terminal_install: bool,
) -> String {
    let fix = if in_desktop_app {
        s(
            "updating the app updates it too",
            "앱을 업데이트하면 함께 갱신됩니다",
        )
        .to_string()
    } else {
        let command = if terminal_install {
            terminal_install_command(cfg!(windows))
        } else {
            reinstall_command(cfg!(target_os = "macos"), cfg!(windows))
        };
        fill(
            s("reinstall with: {command}", "다시 설치: {command}"),
            &[("command", command)],
        )
    };
    fill(
        s(
            "Terminal app {terminal} is older than the app {app} — {fix}",
            "터미널 앱 {terminal} 이 앱 {app} 보다 오래되었습니다 — {fix}",
        ),
        &[
            ("terminal", terminal.to_string()),
            ("app", app.to_string()),
            ("fix", fix),
        ],
    )
}

#[cfg(test)]
pub(crate) mod testserver {
    /// A tiny server on a free port that answers by path: `(status, extra header, body)`.
    pub async fn serve(
        routes: Vec<(&'static str, u16, Option<String>, &'static str)>,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let hits = std::sync::Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut tcp, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = tcp.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let answer = match routes.iter().find(|r| r.0 == path) {
                        Some((_, status, location, body)) => {
                            let extra = location
                                .as_ref()
                                .map(|l| format!("Location: {l}\r\n"))
                                .unwrap_or_default();
                            format!(
                                "HTTP/1.1 {status} X\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                        }
                        None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                    };
                    let _ = tcp.write_all(answer.as_bytes()).await;
                });
            }
        });
        (origin, hits)
    }
}

#[cfg(test)]
mod tests {
    use super::testserver::serve;
    use super::*;

    fn latest(version: &str, notes: &[(&str, &[(&str, &str)])]) -> LatestRelease {
        LatestRelease {
            latest: version.into(),
            releases: notes
                .iter()
                .map(|(v, hs)| ReleaseNote {
                    version: (*v).into(),
                    date: "2026-01-02".into(),
                    highlights: hs
                        .iter()
                        .map(|(en, ko)| Highlight {
                            en: (*en).into(),
                            ko: (!ko.is_empty()).then(|| (*ko).into()),
                        })
                        .collect(),
                })
                .collect(),
        }
    }

    #[test]
    fn versions_are_read_and_ordered() {
        assert!(is_release_version("0.0.127") && is_release_version("1.2"));
        assert!(
            !is_release_version("v1.2")
                && !is_release_version("1")
                && !is_release_version("1.2.3.4.5")
        );
        use std::cmp::Ordering::*;
        assert_eq!(compare_versions("0.0.10", "0.0.9"), Greater);
        assert_eq!(compare_versions("1.0", "1.0.0"), Equal);
        assert_eq!(compare_versions("0.9.9", "0.10.0"), Less);
    }

    #[test]
    fn the_feed_and_the_notes_are_cleaned() {
        assert_eq!(
            parse_feed_version(r#"{"version": " 0.0.9 "}"#).as_deref(),
            Some("0.0.9")
        );
        assert_eq!(parse_feed_version(r#"{"version": "latest"}"#), None);
        assert_eq!(parse_feed_version("nope"), None);
        let notes = parse_notes(
            r#"{"versions": [
                {"version": "0.0.2", "date": "2026-02-03", "highlights": [{"en": "a\u001b[31m b", "ko": "가"}, {"en": ""}, 5]},
                {"version": "bad", "highlights": []},
                {"version": "0.0.1", "date": "soon", "highlights": [{"ko": "한국어만"}]}
            ]}"#,
        )
        .unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].highlights.len(), 1);
        assert!(!notes[0].highlights[0].en.contains('\u{1b}'));
        assert_eq!(notes[1].date, "");
        assert_eq!(notes[1].highlights[0].en, "");
        assert_eq!(parse_notes(r#"{"versions": []}"#), None);
        assert!(!bundled_notes().is_empty());
    }

    #[test]
    fn the_report_lists_the_releases_between_in_the_readers_language() {
        let info = latest(
            "0.0.4",
            &[
                ("0.0.4", &[("four", "넷")]),
                ("0.0.3", &[("three", "")]),
                ("0.0.2", &[("two", "둘")]),
            ],
        );
        let report = build_report("0.0.2", &info, Lang::Ko);
        assert!(report.newer);
        let titles: Vec<String> = report.releases.iter().map(release_title).collect();
        assert_eq!(titles, ["0.0.4 (2026-01-02)", "0.0.3 (2026-01-02)"]);
        // Korean falls back to English text, English never to Korean.
        assert_eq!(report.releases[1].highlights, ["three"]);
        assert_eq!(report.releases[0].highlights, ["넷"]);
        let english = build_report(
            "0.0.2",
            &latest("0.0.3", &[("0.0.3", &[("", "한")])]),
            Lang::En,
        );
        assert!(english.releases[0].highlights.is_empty());
        assert!(!build_report("0.0.4", &info, Lang::En).newer);
        assert!(!build_report("0.0.9", &info, Lang::En).newer);
        let (shown, omitted) = listed(&report);
        assert_eq!((shown.len(), omitted), (2, 0));
    }

    #[test]
    fn behind_and_how_to_texts() {
        assert!(terminal_is_behind("0.0.1", Some("0.0.2")));
        assert!(!terminal_is_behind("0.0.2", Some("0.0.2")));
        assert!(!terminal_is_behind("0.0.1", None));
        let text = terminal_behind_text("0.0.1", "0.0.2", true, false);
        assert!(text.contains("0.0.1") && text.contains("0.0.2"));
        assert!(terminal_install_command(false).contains("install-terminal.sh"));
        assert!(terminal_install_command(true).contains("install-terminal.ps1"));
        assert!(reinstall_command(true, false).contains("install-desktop.sh"));
        assert!(reinstall_command(false, true).contains("install-desktop.ps1"));
        assert!(reinstall_command(false, false).contains("install-terminal.sh"));
        assert!(update_how_to(true, false).contains("oop stop"));
        let env = |k: &str| (k == "OOP_TERMINAL_INSTALL").then(|| "1".to_string());
        assert!(runs_from_terminal_install(env) && !runs_in_desktop_app(env));
    }

    #[test]
    fn urls_split_into_origin_and_path() {
        assert_eq!(
            split_url("https://a.b:8/x/y?z=1").unwrap(),
            ("https://a.b:8".to_string(), "/x/y?z=1".to_string())
        );
        assert_eq!(
            split_url("http://h").unwrap(),
            ("http://h".to_string(), "/".to_string())
        );
        assert_eq!(split_url("http://h?q").unwrap().1, "/?q");
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oop-rs-update-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn the_lookup_follows_a_redirect_reads_both_files_and_caches() {
        let (origin, hits) = serve(vec![
            ("/feed", 302, Some("/feed2".into()), ""),
            ("/feed2", 200, None, r#"{"version": "0.0.9"}"#),
            (
                "/notes",
                200,
                None,
                r#"{"versions": [{"version": "0.0.9", "date": "2026-03-04", "highlights": [{"en": "nine", "ko": "아홉"}]}]}"#,
            ),
        ])
        .await;
        let urls = Urls {
            feed: format!("{origin}/feed"),
            notes: format!("{origin}/notes"),
        };
        let dir = temp("lookup");
        let cache = cache_path(&dir);
        let info = lookup(&urls, Some(&cache), 1_000, true, Duration::from_secs(3))
            .await
            .unwrap();
        assert_eq!(info.latest, "0.0.9");
        assert_eq!(info.releases[0].highlights[0].ko.as_deref(), Some("아홉"));
        let seen = hits.load(std::sync::atomic::Ordering::SeqCst);
        // Under an hour old and not asked to refresh: the cache answers, no request is made.
        let again = lookup(
            &urls,
            Some(&cache),
            1_000 + CACHE_TTL_MS - 1,
            false,
            Duration::from_secs(3),
        )
        .await
        .unwrap();
        assert_eq!(again, info);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), seen);
        // Past the hour, with the network gone: the stale cache still answers, unless refresh.
        let dead = Urls {
            feed: "http://127.0.0.1:9/feed".into(),
            notes: "http://127.0.0.1:9/notes".into(),
        };
        let stale = lookup(
            &dead,
            Some(&cache),
            1_000 + 2 * CACHE_TTL_MS,
            false,
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(stale, Some(info.clone()));
        assert!(
            lookup(&dead, Some(&cache), 5, true, Duration::from_secs(1))
                .await
                .is_none()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_missing_notes_file_falls_back_to_the_bundled_notes_and_a_bad_feed_fails() {
        let (origin, _) = serve(vec![("/feed", 200, None, r#"{"version": "9.9.9"}"#)]).await;
        let urls = Urls {
            feed: format!("{origin}/feed"),
            notes: format!("{origin}/gone"),
        };
        let info = lookup(&urls, None, 0, true, Duration::from_secs(3))
            .await
            .unwrap();
        assert_eq!(info.latest, "9.9.9");
        assert_eq!(info.releases, bundled_notes());
        let (origin, _) = serve(vec![("/feed", 200, None, r#"{"version": "x"}"#)]).await;
        let urls = Urls {
            feed: format!("{origin}/feed"),
            notes: format!("{origin}/gone"),
        };
        assert!(
            lookup(&urls, None, 0, true, Duration::from_secs(3))
                .await
                .is_none()
        );
    }
}
