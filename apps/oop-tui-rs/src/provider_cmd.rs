//! `oop provider list|add|remove`: ported from the former TypeScript terminal's provider command and its
//! `runProvider` glue. The command itself (`run`) works over `Deps`, so its tests run
//! against a fake; `run_cli` is the real one, which connects, waits for the server like
//! `waitReady`, and prints through a sanitizing `say`. Exit codes: 0 done, 1 failed or cancelled,
//! 2 used wrongly.

use crate::provider_args::{AddOptions, ProviderRequest, SecretInput, resolve_add, wants_stdin};
use crate::provider_plan::{
    Context, add_patch, plan_lines, preview_payload, provider_rows, remove_patch, row_of_provider,
    try_build,
};
use crate::provider_spec::{
    AddDraft, Target, after_add_advice, draft_problem, draft_secrets, redact_secrets,
    sanitize_terminal, summarize, target_label,
};
use crate::provider_text::{t, tf};
use crate::text;
use serde_json::Value;
use std::collections::HashMap;

/// How long to wait for the server before giving up (`PROVIDER_ONLINE_TIMEOUT_MS`).
const ONLINE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// How long the thread list is waited for once the server is there (`PROVIDER_SHELL_GRACE_MS`).
const SHELL_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// Everything the command needs from the outside.
pub(crate) trait Deps {
    /// The server's configuration as it was read, for the provider states.
    fn config(&self) -> Option<Value>;
    /// The shell snapshot (`projects` and `threads`) when it has arrived.
    fn shell(&self) -> Option<Value>;
    async fn get_settings(&mut self) -> Result<Value, String>;
    async fn update_settings(&mut self, patch: Value) -> Result<Value, String>;
    /// The providers the server reports after looking again.
    async fn refresh_providers(&mut self, instance_id: Option<&str>) -> Result<Vec<Value>, String>;
    /// Waits until the server has answered (and, for `shell`, sent the thread list). A message
    /// when it cannot be reached in time.
    async fn wait_ready(&mut self, shell: bool) -> Option<String>;
    fn out(&mut self, line: &str);
    fn err(&mut self, line: &str);
    fn env(&self) -> HashMap<String, String>;
    /// Standard input and output are a terminal, so a question can be asked.
    fn interactive(&self) -> bool;
    /// Standard input is a terminal: reading it to the end would wait with no prompt.
    fn stdin_is_terminal(&self) -> bool;
    /// All of standard input; only called when a secret is to come from it.
    async fn read_stdin(&mut self) -> String;
    /// Asks one line on the terminal; `None` when the input ended.
    async fn ask(&mut self, question: &str) -> Option<String>;
    /// The add screens, started from `start` (`None`: from the list of kinds); `None` when the
    /// user left.
    async fn wizard(&mut self, start: Option<AddDraft>, context: &Context) -> Option<AddDraft>;
    /// The list of what can be removed, when `remove` was given no id; the id picked, or `None`
    /// when the user left.
    async fn pick_remove(&mut self, context: &Context) -> Option<String>;
}

fn fail<D: Deps>(deps: &mut D, message: &str, code: i32) -> i32 {
    deps.err(&format!("error: {}", sanitize_terminal(message)));
    code
}

fn pad_end(text: &str, width: usize) -> String {
    let used = text::width(text);
    format!("{text}{}", " ".repeat(width.saturating_sub(used)))
}

// ---- list ---------------------------------------------------------------------------------------

const MESSAGE_LIMIT: usize = 60;

/// The table of `oop provider list`, one line per provider.
pub fn list_table(rows: &[crate::provider_plan::ProviderRow]) -> Vec<String> {
    let header = [
        "ID".to_string(),
        t("providers.cmd.colName").into(),
        t("providers.cmd.colKind").into(),
        t("providers.cmd.colEnabled").into(),
        t("providers.cmd.colStatus").into(),
        t("providers.cmd.colModels").into(),
        t("providers.cmd.colDefault").into(),
        t("providers.cmd.colNote").into(),
    ];
    let mut all: Vec<[String; 8]> = vec![header];
    for row in rows {
        all.push([
            row.id.clone(),
            row.name.clone(),
            row.driver.clone(),
            t(if row.enabled {
                "providers.cmd.on"
            } else {
                "providers.cmd.off"
            })
            .into(),
            row.status.clone(),
            row.models
                .map_or_else(|| "-".to_string(), |n| n.to_string()),
            if row.is_default {
                t("providers.cmd.default").into()
            } else {
                String::new()
            },
            row.message
                .as_deref()
                .map_or_else(String::new, |m| text::truncate(m, MESSAGE_LIMIT)),
        ]);
    }
    let widths: Vec<usize> = (0..8)
        .map(|column| {
            all.iter()
                .map(|row| text::width(&row[column]))
                .max()
                .unwrap_or(0)
        })
        .collect();
    all.iter()
        .map(|row| {
            row.iter()
                .enumerate()
                .map(|(column, cell)| pad_end(cell, widths[column]))
                .collect::<Vec<_>>()
                .join("  ")
                .trim_end()
                .to_string()
        })
        .collect()
}

async fn run_list<D: Deps>(deps: &mut D) -> i32 {
    if let Some(message) = deps.wait_ready(false).await {
        return fail(deps, &message, 1);
    }
    let config = deps.config();
    let settings = deps
        .get_settings()
        .await
        .ok()
        .or_else(|| config.as_ref().and_then(|c| c.get("settings").cloned()));
    let rows = provider_rows(config.as_ref(), settings.as_ref());
    if rows.is_empty() {
        deps.out(t("providers.cmd.none"));
        return 0;
    }
    for line in list_table(&rows) {
        deps.out(&line);
    }
    0
}

// ---- applying -----------------------------------------------------------------------------------

/// The server could not be asked, or its answer did not come: the request may or may not have
/// been applied. Anything else is the server reading the request and saying no.
pub fn is_unsure(message: &str) -> bool {
    [
        "the connection closed",
        "the connection is closed",
        "the connection failed",
        "protocol error",
        "server fault",
        "the request was interrupted",
    ]
    .iter()
    .any(|prefix| message.starts_with(prefix))
}

struct Failure {
    message: String,
    /// The server read the patch and refused it.
    rejected: bool,
}

struct Patched {
    changed: bool,
}

/// Settings patches that replace a whole record must be built from the newest value: the settings
/// are read first and the patch is made from what was read (`createSettingsPatcher`). `None` from
/// `build` means there is nothing to change and nothing is sent.
async fn patch_settings<D: Deps>(
    deps: &mut D,
    build: impl FnOnce(&Value) -> Option<Value>,
) -> Result<Patched, Failure> {
    let failure = |message: String| Failure {
        rejected: !is_unsure(&message),
        message: sanitize_terminal(&message)
            .lines()
            .next()
            .unwrap_or_default()
            .to_string(),
    };
    let before = deps.get_settings().await.map_err(failure)?;
    let Some(patch) = build(&before) else {
        return Ok(Patched { changed: false });
    };
    deps.update_settings(patch).await.map_err(failure)?;
    Ok(Patched { changed: true })
}

/// Asks the server to look at the providers again; says what the new one turned out to be.
async fn refresh_and_report<D: Deps>(deps: &mut D, instance_id: Option<&str>) {
    match deps.refresh_providers(instance_id).await {
        Ok(providers) => {
            let found = providers.iter().find(|p| {
                p.get("instanceId").and_then(Value::as_str) == instance_id && instance_id.is_some()
            });
            if let Some(provider) = found {
                let row = row_of_provider(provider);
                let models = row
                    .models
                    .map(|n| {
                        format!(
                            " · {}",
                            tf("providers.cmd.modelCount", &[("count", n.to_string())])
                        )
                    })
                    .unwrap_or_default();
                let note = row.message.map(|m| format!(" · {m}")).unwrap_or_default();
                deps.out(&format!(
                    "{}{models}{note}",
                    tf("providers.cmd.status", &[("status", row.status)])
                ));
            }
        }
        Err(_) => deps.err(t("providers.cmd.refreshFailed")),
    }
}

fn is_yes_answer(answer: &str) -> bool {
    let lower = answer.trim().to_lowercase();
    lower == "y" || lower == "yes"
}

/// The `yes` a removal waits for, in any case, with spaces around ignored.
pub fn is_yes(answer: &str) -> bool {
    answer.trim().eq_ignore_ascii_case("yes")
}

async fn read_context<D: Deps>(deps: &mut D) -> Result<Context, String> {
    let settings = deps.get_settings().await?;
    Ok(Context::new(deps.config().as_ref(), settings, deps.shell()))
}

async fn run_add<D: Deps>(deps: &mut D, target: Option<Target>, options: AddOptions) -> i32 {
    if target.is_none() && !deps.interactive() {
        return fail(deps, t("providers.cmd.kindNeeded"), 2);
    }
    if let Some(message) = deps.wait_ready(false).await {
        return fail(deps, &message, 1);
    }
    let context = match read_context(deps).await {
        Ok(context) => context,
        Err(reason) => {
            return fail(
                deps,
                &tf("providers.cmd.settingsReadFailed", &[("reason", reason)]),
                1,
            );
        }
    };

    let mut confirmed = false;
    // Standard input was read to its end for a secret, so no question can be answered afterwards.
    let mut stdin_consumed = false;
    let draft: Option<AddDraft> = match target {
        None => {
            let drafted = deps.wizard(None, &context).await;
            confirmed = drafted.is_some();
            drafted
        }
        Some(target) => {
            let from_stdin = wants_stdin(target, &options);
            if from_stdin && deps.stdin_is_terminal() {
                return fail(deps, t("providers.cmd.stdinPipeOnly"), 2);
            }
            let stdin = if from_stdin {
                Some(deps.read_stdin().await)
            } else {
                None
            };
            let input = SecretInput {
                refs: true,
                env: deps.env(),
                stdin,
            };
            let resolved = match resolve_add(target, &options, &input) {
                Ok(draft) => draft,
                Err(message) => return fail(deps, &message, 1),
            };
            stdin_consumed = from_stdin;
            // Something is missing (an id, a key): on a terminal the screens ask for it; in a
            // script it is an error.
            match draft_problem(&resolved, &context.taken) {
                Some(problem) => {
                    if !deps.interactive() || options.dry_run || stdin_consumed {
                        return fail(deps, &problem, 1);
                    }
                    let drafted = deps.wizard(Some(resolved), &context).await;
                    confirmed = drafted.is_some();
                    drafted
                }
                None => Some(resolved),
            }
        }
    };
    let Some(draft) = draft else {
        deps.err(t("providers.cmd.cancelled"));
        return 1;
    };

    let secrets = draft_secrets(&draft);
    if let Some(problem) = draft_problem(&draft, &context.taken) {
        return fail(deps, &problem, 1);
    }
    let instance = match try_build(&draft) {
        Ok(instance) => instance,
        Err(message) => return fail(deps, &message, 1),
    };

    for row in summarize(&draft) {
        deps.out(&format!("{} {}", pad_end(&row.label, 14), row.value));
    }
    if options.dry_run {
        deps.out("");
        deps.out(t("providers.cmd.dryRunAdd"));
        for line in preview_payload(&draft, &instance).split('\n') {
            deps.out(line);
        }
        return 0;
    }
    if !confirmed && !options.yes {
        if !deps.interactive() || stdin_consumed {
            return fail(deps, t("providers.cmd.confirmNeeded"), 1);
        }
        let answer = deps.ask(t("providers.cmd.askAdd")).await;
        if !answer.as_deref().is_some_and(is_yes_answer) {
            deps.err(t("providers.cmd.cancelled"));
            return 1;
        }
    }

    let id = draft.id.clone();
    match patch_settings(deps, |current| add_patch(current, &id, &instance)).await {
        Err(failure) => {
            let reason = redact_secrets(&failure.message, &secrets);
            let unsure = if failure.rejected {
                String::new()
            } else {
                format!(" {}", t("providers.cmd.unsure"))
            };
            return fail(
                deps,
                &format!(
                    "{}{unsure}",
                    tf("providers.cmd.addFailed", &[("reason", reason)])
                ),
                1,
            );
        }
        Ok(Patched { changed: false }) => {
            return fail(deps, &tf("providers.cmd.idTaken", &[("id", id)]), 1);
        }
        Ok(_) => {}
    }
    deps.out(&tf(
        "providers.cmd.added",
        &[
            ("id", id.clone()),
            ("kind", target_label(draft.target).to_string()),
        ],
    ));
    if let Some(advice) = after_add_advice(&draft) {
        deps.out(&advice);
    }
    refresh_and_report(deps, Some(&id)).await;
    0
}

async fn run_remove<D: Deps>(deps: &mut D, id: Option<String>, yes: bool, dry_run: bool) -> i32 {
    // Without an id the list opens, which needs a terminal (the slash command allows it).
    if id.is_none() && !deps.interactive() {
        return fail(deps, t("providers.cmd.removeNeedsId"), 2);
    }
    if let Some(message) = deps.wait_ready(true).await {
        return fail(deps, &message, 1);
    }
    let context = match read_context(deps).await {
        Ok(context) => context,
        Err(reason) => {
            return fail(
                deps,
                &tf("providers.cmd.settingsReadFailed", &[("reason", reason)]),
                1,
            );
        }
    };
    let id = match id {
        Some(id) => id,
        None => match deps.pick_remove(&context).await {
            Some(id) => id,
            None => {
                deps.err(t("providers.cmd.cancelled"));
                return 1;
            }
        },
    };
    let plan = match context.check_remove(&id) {
        Ok(plan) => plan,
        Err(reason) => return fail(deps, &reason, 1),
    };
    for line in plan_lines(&plan) {
        deps.out(&line);
    }
    if dry_run {
        deps.out(t("providers.cmd.dryRunRemove"));
        return 0;
    }
    if !yes {
        if !deps.interactive() {
            return fail(deps, t("providers.cmd.confirmNeeded"), 1);
        }
        let answer = deps.ask(t("providers.cmd.askRemove")).await;
        if !answer.as_deref().is_some_and(is_yes) {
            deps.err(t("providers.cmd.cancelled"));
            return 1;
        }
    }
    match patch_settings(deps, |current| remove_patch(current, &id)).await {
        Err(failure) => {
            let unsure = if failure.rejected {
                String::new()
            } else {
                format!(" {}", t("providers.cmd.unsure"))
            };
            return fail(
                deps,
                &format!(
                    "{}{unsure}",
                    tf("providers.cmd.removeFailed", &[("reason", failure.message)])
                ),
                1,
            );
        }
        Ok(Patched { changed: false }) => {
            return fail(deps, &tf("providers.cmd.alreadyGone", &[("id", id)]), 1);
        }
        Ok(_) => {}
    }
    deps.out(&tf("providers.cmd.removed", &[("id", id)]));
    refresh_and_report(deps, None).await;
    0
}

/// `oop provider ...` over `deps`. Returns the exit code.
pub(crate) async fn run<D: Deps>(request: ProviderRequest, deps: &mut D) -> i32 {
    match request {
        ProviderRequest::List => run_list(deps).await,
        ProviderRequest::Add { target, options } => run_add(deps, target, options).await,
        ProviderRequest::Remove { id, yes, dry_run } => run_remove(deps, id, yes, dry_run).await,
    }
}

// ---- the real thing -----------------------------------------------------------------------------

struct Live {
    rpc: crate::wire::Rpc,
    config: Value,
    shell: Option<Value>,
    interactive: bool,
    stdin_terminal: bool,
}

fn say(stream: &mut dyn std::io::Write, line: &str) {
    let _ = writeln!(stream, "{}", sanitize_terminal(line));
    let _ = stream.flush();
}

impl Deps for Live {
    fn config(&self) -> Option<Value> {
        Some(self.config.clone())
    }

    fn shell(&self) -> Option<Value> {
        self.shell.clone()
    }

    async fn get_settings(&mut self) -> Result<Value, String> {
        self.rpc
            .call(crate::server_settings::GET_SETTINGS, serde_json::json!({}))
            .await
    }

    async fn update_settings(&mut self, patch: Value) -> Result<Value, String> {
        self.rpc
            .call(
                crate::server_settings::UPDATE_SETTINGS,
                serde_json::json!({"patch": patch}),
            )
            .await
    }

    async fn refresh_providers(&mut self, instance_id: Option<&str>) -> Result<Vec<Value>, String> {
        let payload = match instance_id {
            Some(id) => serde_json::json!({"instanceId": id}),
            None => serde_json::json!({}),
        };
        let answer = self.rpc.call("server.refreshProviders", payload).await?;
        Ok(answer
            .get("providers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    async fn wait_ready(&mut self, shell: bool) -> Option<String> {
        // The connection is open and the configuration read by now (`run_cli` connects first).
        // The thread list only sharpens the impact of a removal; without it that part is unknown.
        if shell && self.shell.is_none() {
            self.shell = read_shell(&self.rpc, SHELL_GRACE).await;
        }
        None
    }

    fn out(&mut self, line: &str) {
        say(&mut std::io::stdout(), line);
    }

    fn err(&mut self, line: &str) {
        say(&mut std::io::stderr(), line);
    }

    fn env(&self) -> HashMap<String, String> {
        std::env::vars().collect()
    }

    fn interactive(&self) -> bool {
        self.interactive
    }

    fn stdin_is_terminal(&self) -> bool {
        self.stdin_terminal
    }

    async fn read_stdin(&mut self) -> String {
        tokio::task::spawn_blocking(|| {
            let mut all = String::new();
            let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut all);
            all
        })
        .await
        .unwrap_or_default()
    }

    async fn ask(&mut self, question: &str) -> Option<String> {
        let question = question.to_string();
        tokio::task::spawn_blocking(move || {
            use std::io::Write;
            print!("{}", sanitize_terminal(&question));
            let _ = std::io::stdout().flush();
            let mut line = String::new();
            match std::io::stdin().read_line(&mut line) {
                Ok(0) | Err(_) => None,
                Ok(_) => Some(line.trim_end_matches(['\n', '\r']).to_string()),
            }
        })
        .await
        .ok()
        .flatten()
    }

    async fn wizard(&mut self, start: Option<AddDraft>, context: &Context) -> Option<AddDraft> {
        crate::provider_wizard::run(start, context.clone()).await
    }

    async fn pick_remove(&mut self, context: &Context) -> Option<String> {
        crate::provider_wizard::pick_remove(context.clone()).await
    }
}

/// The shell snapshot (`projects`, `threads`) as the server sends it, or `None` when it does not
/// come within `grace`.
async fn read_shell(rpc: &crate::wire::Rpc, grace: std::time::Duration) -> Option<Value> {
    let mut stream = rpc.stream(crate::app::SHELL_RPC, serde_json::json!({}));
    let wait = async {
        while let Some(message) = stream.rx.recv().await {
            match message {
                crate::wire::StreamMsg::Item(item) if item["kind"] == "snapshot" => {
                    return Some(item["snapshot"].clone());
                }
                crate::wire::StreamMsg::Item(_) => {}
                crate::wire::StreamMsg::End(_) => return None,
            }
        }
        None
    };
    tokio::time::timeout(grace, wait).await.ok().flatten()
}

/// `oop provider ...`: connects, does the one thing, disconnects. It starts a server of this
/// terminal's own only when it can be seen and answered (standard input and output are a
/// terminal). Works from a plain shell and, after the full-screen UI has stepped aside, from
/// inside it. Returns the exit code.
pub async fn run_cli(
    request: ProviderRequest,
    server: Option<String>,
    home: Option<String>,
) -> i32 {
    use std::io::IsTerminal;
    crate::i18n::init(
        crate::settings::read_settings(&crate::settings::settings_path())
            .0
            .language
            .as_deref(),
    );
    let stdin_terminal = std::io::stdin().is_terminal();
    let interactive = stdin_terminal && std::io::stdout().is_terminal();
    let (home, isolated) = crate::server::server_home(home.as_deref());
    let version = crate::version();
    let connecting = crate::link::connect_once_with(
        &home,
        isolated,
        server.as_deref(),
        &version,
        interactive,
        |what: &str| say(&mut std::io::stderr(), what),
    );
    let session = match tokio::time::timeout(ONLINE_TIMEOUT, connecting).await {
        Err(_) => {
            say(
                &mut std::io::stderr(),
                &format!("error: {}", t("link.serverUnreachable")),
            );
            return 1;
        }
        Ok(Err(failure)) => {
            let reason = crate::link::one_shot_reason(failure.reason);
            say(&mut std::io::stderr(), &format!("error: {reason}"));
            return 1;
        }
        Ok(Ok(session)) => session,
    };
    let mut live = Live {
        rpc: session.rpc,
        config: session.config,
        shell: None,
        interactive,
        stdin_terminal,
    };
    run(request, &mut live).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_args::{Origin, collect_flags, resolve_request};
    use crate::provider_spec::{Val, new_draft, parse_target, with_id};
    use serde_json::json;

    const SECRET: &str = "test-value-1234";

    fn english() {
        crate::i18n::init(Some("en"));
    }

    fn request(argv: &[&str]) -> ProviderRequest {
        let words: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        let (positional, flags) = collect_flags(&words).unwrap();
        resolve_request(&positional, &flags, Origin::Cli).unwrap()
    }

    fn provider(id: &str, over: Value) -> Value {
        let mut base = json!({"instanceId": id, "driver": "codex", "enabled": true, "installed": true,
            "availability": "available", "status": "ready", "models": [{"slug": "m"}]});
        for (key, value) in over.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    struct Fake {
        settings: Value,
        providers: Vec<Value>,
        shell: Value,
        out: Vec<String>,
        err: Vec<String>,
        sent: Vec<Value>,
        asked: Vec<String>,
        refreshed: Vec<Option<String>>,
        wizard_starts: Vec<Option<AddDraft>>,
        env: HashMap<String, String>,
        stdin: String,
        stdin_reads: usize,
        interactive: bool,
        stdin_terminal: bool,
        answers: Vec<Option<String>>,
        wizard_draft: Option<Option<AddDraft>>,
        picked: Option<String>,
        wait_error: Option<String>,
        refresh_fails: bool,
        update_error: Option<String>,
    }

    impl Fake {
        fn new() -> Fake {
            english();
            Fake {
                settings: json!({"providerInstances": {
                    "codex": {"driver": "codex", "enabled": true},
                    "opencode_zai": {"driver": "opencode", "displayName": "Z.AI", "environment": [
                        {"name": "OOP_ZAI_API_KEY", "value": "", "sensitive": true, "valueRedacted": true}]},
                    "codex_work": {"driver": "codex"}}}),
                providers: vec![
                    provider("codex", json!({"models": []})),
                    provider(
                        "opencode_zai",
                        json!({"status": "error", "message": "login needed"}),
                    ),
                    provider(
                        "codex_work",
                        json!({"enabled": false, "status": "disabled"}),
                    ),
                ],
                shell: json!({"projects": [{"id": "p"}], "threads": [
                    {"id": "a", "title": "t", "modelSelection": {"instanceId": "opencode_zai", "model": "m"}}]}),
                out: vec![],
                err: vec![],
                sent: vec![],
                asked: vec![],
                refreshed: vec![],
                wizard_starts: vec![],
                env: HashMap::new(),
                stdin: String::new(),
                stdin_reads: 0,
                interactive: false,
                stdin_terminal: false,
                answers: vec![],
                wizard_draft: None,
                picked: None,
                wait_error: None,
                refresh_fails: false,
                update_error: None,
            }
        }

        fn everything(&self) -> String {
            [self.out.clone(), self.err.clone(), self.asked.clone()]
                .concat()
                .join("\n")
        }

        async fn run(&mut self, argv: &[&str]) -> i32 {
            run(request(argv), self).await
        }
    }

    impl Deps for Fake {
        fn config(&self) -> Option<Value> {
            Some(json!({"settings": self.settings, "providers": self.providers}))
        }
        fn shell(&self) -> Option<Value> {
            Some(self.shell.clone())
        }
        async fn get_settings(&mut self) -> Result<Value, String> {
            Ok(self.settings.clone())
        }
        async fn update_settings(&mut self, patch: Value) -> Result<Value, String> {
            if let Some(error) = &self.update_error {
                return Err(error.clone());
            }
            for (key, value) in patch.as_object().unwrap() {
                self.settings[key] = value.clone();
            }
            self.sent.push(patch);
            Ok(self.settings.clone())
        }
        async fn refresh_providers(&mut self, id: Option<&str>) -> Result<Vec<Value>, String> {
            self.refreshed.push(id.map(str::to_string));
            if self.refresh_fails {
                return Err("no".into());
            }
            Ok(vec![provider(
                id.unwrap_or("x"),
                json!({"status": "ready"}),
            )])
        }
        async fn wait_ready(&mut self, _shell: bool) -> Option<String> {
            self.wait_error.clone()
        }
        fn out(&mut self, line: &str) {
            self.out.push(line.to_string());
        }
        fn err(&mut self, line: &str) {
            self.err.push(line.to_string());
        }
        fn env(&self) -> HashMap<String, String> {
            self.env.clone()
        }
        fn interactive(&self) -> bool {
            self.interactive
        }
        fn stdin_is_terminal(&self) -> bool {
            self.stdin_terminal
        }
        async fn read_stdin(&mut self) -> String {
            self.stdin_reads += 1;
            self.stdin.clone()
        }
        async fn ask(&mut self, question: &str) -> Option<String> {
            self.asked.push(question.to_string());
            if self.answers.is_empty() {
                None
            } else {
                self.answers.remove(0)
            }
        }
        async fn wizard(
            &mut self,
            start: Option<AddDraft>,
            _context: &Context,
        ) -> Option<AddDraft> {
            self.wizard_starts.push(start.clone());
            match self.wizard_draft.clone() {
                Some(draft) => draft,
                None => start,
            }
        }
        async fn pick_remove(&mut self, _context: &Context) -> Option<String> {
            self.picked.clone()
        }
    }

    fn sent_ids(fake: &Fake) -> Vec<String> {
        fake.sent[0]["providerInstances"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    }

    // ---- list ----

    #[tokio::test]
    async fn list_prints_a_table_with_the_state_of_each_instance() {
        let mut fake = Fake::new();
        assert_eq!(fake.run(&["list"]).await, 0);
        let text = fake.out.join("\n");
        let header: Vec<&str> = fake.out[0].split_whitespace().collect();
        assert_eq!(
            &header[..6],
            ["ID", "Name", "Kind", "Enabled", "Status", "Models"]
        );
        assert!(
            text.contains("ready") && text.contains("error") && text.contains("login needed"),
            "{text}"
        );
        assert!(
            fake.out
                .iter()
                .find(|l| l.starts_with("codex "))
                .unwrap()
                .contains("default")
        );
    }

    #[test]
    fn list_lines_the_columns_up_even_with_wide_characters() {
        english();
        let config = json!({"providers": [provider("a", json!({"displayName": "한글 이름"})), provider("bbbb", json!({}))]});
        let lines = list_table(&provider_rows(Some(&config), None));
        let starts: Vec<usize> = lines
            .iter()
            .map(|line| {
                let at = line.find("ready").or_else(|| line.find("Status")).unwrap();
                text::width(&line[..at])
            })
            .collect();
        assert!(
            starts.windows(2).all(|w| w[0] == w[1]),
            "{starts:?} {lines:?}"
        );
    }

    #[tokio::test]
    async fn list_says_so_when_the_server_cannot_be_reached() {
        let mut fake = Fake::new();
        fake.wait_error = Some("Could not connect.".into());
        assert_eq!(fake.run(&["list"]).await, 1);
        assert_eq!(fake.err, ["error: Could not connect."]);
    }

    // ---- add ----

    #[tokio::test]
    async fn add_with_dash_y_reads_the_key_from_the_environment_and_prints_neither() {
        let mut fake = Fake::new();
        fake.env.insert("ZAI_KEY".into(), SECRET.into());
        let code = fake
            .run(&[
                "add",
                "zai",
                "--id",
                "opencode_zai2",
                "--set",
                "apiKey=@ZAI_KEY",
                "-y",
            ])
            .await;
        assert_eq!(code, 0, "{:?}", fake.err);
        assert_eq!(fake.sent.len(), 1);
        assert_eq!(
            sent_ids(&fake),
            ["codex", "codex_work", "opencode_zai", "opencode_zai2"]
        );
        assert!(fake.sent[0].to_string().contains(SECRET));
        assert!(!fake.everything().contains(SECRET));
        let text = fake.out.join("\n");
        assert!(text.contains("Added: opencode_zai2 (Z.AI)"), "{text}");
        assert!(text.contains("Status: ready"), "{text}");
        assert_eq!(fake.refreshed, [Some("opencode_zai2".to_string())]);
    }

    #[tokio::test]
    async fn add_reads_the_key_from_standard_input() {
        let mut fake = Fake::new();
        fake.stdin = format!("{SECRET}\n");
        assert_eq!(
            fake.run(&[
                "add",
                "zai",
                "--id",
                "opencode_zai2",
                "--set",
                "apiKey=-",
                "-y"
            ])
            .await,
            0
        );
        assert!(fake.sent[0].to_string().contains(SECRET));
        assert!(!fake.everything().contains(SECRET));
    }

    #[tokio::test]
    async fn add_does_not_wait_on_a_terminal_for_a_key_named_as_dash() {
        let mut fake = Fake::new();
        fake.interactive = true;
        fake.stdin_terminal = true;
        assert_eq!(
            fake.run(&["add", "zai", "--id", "opencode_zai2", "--set", "apiKey=-"])
                .await,
            2
        );
        assert_eq!(fake.stdin_reads, 0);
        let text = fake.err.join("\n");
        assert!(
            text.contains("piped") && text.contains("--set apiKey=@"),
            "{text}"
        );
        assert!(fake.asked.is_empty() && fake.wizard_starts.is_empty() && fake.sent.is_empty());
    }

    #[tokio::test]
    async fn add_asks_no_question_once_standard_input_has_been_used_up() {
        let mut fake = Fake::new();
        fake.interactive = true;
        fake.stdin = format!("{SECRET}\n");
        assert_eq!(
            fake.run(&["add", "zai", "--id", "opencode_zai2", "--set", "apiKey=-"])
                .await,
            1
        );
        assert!(fake.err.join("\n").contains("-y"));
        assert!(fake.asked.is_empty() && fake.sent.is_empty());
        assert!(!fake.everything().contains(SECRET));
    }

    #[tokio::test]
    async fn add_keeps_other_instances_secret_markers_in_what_it_sends() {
        let mut fake = Fake::new();
        fake.run(&["add", "codex", "--id", "codex_new", "-y"]).await;
        let kept = &fake.sent[0]["providerInstances"]["opencode_zai"]["environment"][0];
        assert_eq!(
            (kept["valueRedacted"].clone(), kept["value"].clone()),
            (json!(true), json!(""))
        );
    }

    #[tokio::test]
    async fn add_dry_run_prints_with_every_secret_hidden_and_sends_nothing() {
        let mut fake = Fake::new();
        fake.env.insert("ZAI_KEY".into(), SECRET.into());
        let code = fake
            .run(&[
                "add",
                "zai",
                "--id",
                "opencode_zai2",
                "--set",
                "apiKey=@ZAI_KEY",
                "--dry-run",
            ])
            .await;
        assert_eq!(code, 0);
        assert!(fake.sent.is_empty() && !fake.everything().contains(SECRET));
        let text = fake.out.join("\n");
        assert!(
            text.contains("****") && text.contains("opencode_zai2"),
            "{text}"
        );
        // The payload is printed in the order the TypeScript command prints it.
        assert!(text.contains("\"driver\": \"opencode\",\n"), "{text}");
        assert!(text.find("\"driver\"").unwrap() < text.find("\"displayName\"").unwrap());
    }

    #[tokio::test]
    async fn add_refuses_when_the_key_is_missing_and_nobody_can_be_asked() {
        let mut fake = Fake::new();
        assert_eq!(
            fake.run(&["add", "zai", "--id", "opencode_zai2", "-y"])
                .await,
            1
        );
        assert!(fake.err.join("\n").contains("API key"));
        assert!(fake.sent.is_empty());
    }

    #[tokio::test]
    async fn add_refuses_an_id_that_is_taken_or_is_a_built_in_name() {
        let mut fake = Fake::new();
        assert_eq!(
            fake.run(&["add", "codex", "--id", "codex_work", "-y"])
                .await,
            1
        );
        assert!(fake.err.join("\n").contains("already taken"));
        assert_eq!(fake.run(&["add", "codex", "--id", "codex", "-y"]).await, 1);
        assert!(fake.err.join("\n").contains("built-in"));
        assert!(fake.sent.is_empty());
    }

    #[tokio::test]
    async fn add_needs_a_confirmation_refuses_in_a_script_and_asks_on_a_terminal() {
        let mut script = Fake::new();
        assert_eq!(script.run(&["add", "codex", "--id", "codex_new"]).await, 1);
        assert!(script.err.join("\n").contains("-y") && script.sent.is_empty());

        let mut yes = Fake::new();
        yes.interactive = true;
        yes.answers = vec![Some("y".into())];
        assert_eq!(yes.run(&["add", "codex", "--id", "codex_new"]).await, 0);
        assert_eq!(yes.asked, ["Add it? [y/N] "]);
        assert_eq!(yes.sent.len(), 1);

        for answer in [Some(""), Some("n"), Some("yes please"), None] {
            let mut no = Fake::new();
            no.interactive = true;
            no.answers = vec![answer.map(str::to_string)];
            assert_eq!(
                no.run(&["add", "codex", "--id", "codex_new"]).await,
                1,
                "{answer:?}"
            );
            assert!(no.err.join("\n").contains("Cancelled") && no.sent.is_empty());
        }
    }

    #[tokio::test]
    async fn add_opens_the_screens_for_what_is_missing_on_a_terminal_and_does_not_ask_twice() {
        let zai = parse_target("zai").unwrap();
        let mut draft = with_id(new_draft(zai), "opencode_zai2");
        draft.values.insert("apiKey".into(), Val::S(SECRET.into()));
        let mut fake = Fake::new();
        fake.interactive = true;
        fake.wizard_draft = Some(Some(draft));
        assert_eq!(
            fake.run(&["add", "zai", "--id", "opencode_zai2"]).await,
            0,
            "{:?}",
            fake.err
        );
        assert_eq!(fake.wizard_starts.len(), 1);
        assert_eq!(fake.wizard_starts[0].as_ref().unwrap().id, "opencode_zai2");
        assert!(fake.asked.is_empty() && !fake.everything().contains(SECRET));
        assert_eq!(fake.sent.len(), 1);
    }

    #[tokio::test]
    async fn add_with_no_kind_starts_the_screens_at_the_list_and_needs_a_terminal_for_it() {
        let mut fake = Fake::new();
        fake.interactive = true;
        fake.wizard_draft = Some(None);
        assert_eq!(fake.run(&["add"]).await, 1);
        assert_eq!(fake.wizard_starts.len(), 1);
        assert!(fake.wizard_starts[0].is_none());
        assert!(fake.err.join("\n").contains("Cancelled"));
        let mut script = Fake::new();
        assert_eq!(script.run(&["add"]).await, 2);
        assert!(script.wizard_starts.is_empty());
    }

    #[tokio::test]
    async fn add_reports_a_refusal_without_the_secret_and_says_when_it_may_not_have_arrived() {
        let mut refused = Fake::new();
        refused.env.insert("ZAI_KEY".into(), SECRET.into());
        refused.update_error = Some(format!("bad {SECRET}"));
        let argv = [
            "add",
            "zai",
            "--id",
            "opencode_zai2",
            "--set",
            "apiKey=@ZAI_KEY",
            "-y",
        ];
        assert_eq!(refused.run(&argv).await, 1);
        assert!(refused.err.join("\n").contains("Could not add it"));
        assert!(!refused.everything().contains(SECRET));
        assert!(!refused.err.join("\n").contains("Not sure"));

        let mut lost = Fake::new();
        lost.update_error = Some("the connection closed".into());
        assert_eq!(
            lost.run(&["add", "codex", "--id", "codex_new", "-y"]).await,
            1
        );
        assert!(lost.err.join("\n").contains("Not sure"));
    }

    #[tokio::test]
    async fn add_succeeds_even_when_the_refresh_fails() {
        let mut fake = Fake::new();
        fake.refresh_fails = true;
        assert_eq!(
            fake.run(&["add", "codex", "--id", "codex_new", "-y"]).await,
            0
        );
        assert!(fake.err.join("\n").contains("Could not refresh the status"));
    }

    #[tokio::test]
    async fn add_reports_the_bad_arguments_the_options_hold() {
        let mut fake = Fake::new();
        assert_eq!(
            fake.run(&["add", "codex", "--id", "x", "--set", "nope=1", "-y"])
                .await,
            1
        );
        assert!(fake.err.join("\n").contains("binaryPath"));
    }

    // ---- remove ----

    #[tokio::test]
    async fn remove_prints_the_plan_first_asks_for_yes_and_removes_only_that_instance() {
        let mut fake = Fake::new();
        fake.interactive = true;
        fake.answers = vec![Some("yes".into())];
        assert_eq!(
            fake.run(&["remove", "opencode_zai"]).await,
            0,
            "{:?}",
            fake.err
        );
        let text = fake.out.join("\n");
        assert!(
            text.find("Remove: opencode_zai").unwrap()
                < text.find("Removed: opencode_zai").unwrap()
        );
        assert!(
            text.contains("1 threads") && text.contains("1 secrets"),
            "{text}"
        );
        assert_eq!(fake.asked, ["Type yes to remove it: "]);
        assert_eq!(sent_ids(&fake), ["codex", "codex_work"]);
        assert_eq!(fake.refreshed, [None]);
    }

    #[tokio::test]
    async fn remove_cancels_on_anything_but_yes_leaving_settings_alone() {
        for answer in [Some(""), Some("y"), Some("no"), None] {
            let mut fake = Fake::new();
            fake.interactive = true;
            fake.answers = vec![answer.map(str::to_string)];
            assert_eq!(fake.run(&["remove", "codex_work"]).await, 1, "{answer:?}");
            assert!(fake.err.join("\n").contains("Cancelled") && fake.sent.is_empty());
        }
    }

    #[tokio::test]
    async fn remove_skips_the_question_with_dash_y_and_refuses_in_a_script_without_it() {
        let mut yes = Fake::new();
        assert_eq!(yes.run(&["remove", "codex_work", "-y"]).await, 0);
        assert!(yes.asked.is_empty());
        let mut script = Fake::new();
        assert_eq!(script.run(&["remove", "codex_work"]).await, 1);
        assert!(script.err.join("\n").contains("-y") && script.sent.is_empty());
    }

    #[tokio::test]
    async fn remove_dry_run_prints_the_plan_and_removes_nothing() {
        let mut fake = Fake::new();
        assert_eq!(fake.run(&["remove", "opencode_zai", "--dry-run"]).await, 0);
        assert!(fake.sent.is_empty());
        assert!(fake.out.join("\n").contains("nothing was removed"));
    }

    #[tokio::test]
    async fn remove_explains_why_the_built_in_stays_and_reports_an_id_that_is_not_there() {
        let mut fake = Fake::new();
        assert_eq!(fake.run(&["remove", "codex", "-y"]).await, 1);
        assert!(fake.err.join("\n").contains("built-in"));
        assert_eq!(fake.run(&["remove", "ghost", "-y"]).await, 1);
        assert!(fake.err.join("\n").contains("There is no provider"));
        assert!(fake.sent.is_empty());
    }

    #[tokio::test]
    async fn remove_without_an_id_opens_the_list_on_a_terminal_and_goes_on_with_the_pick() {
        let none = ProviderRequest::Remove {
            id: None,
            yes: false,
            dry_run: false,
        };
        let mut script = Fake::new();
        assert_eq!(run(none.clone(), &mut script).await, 2);
        assert!(
            script
                .err
                .join("\n")
                .contains("An ID to remove is required")
        );

        let mut fake = Fake::new();
        fake.interactive = true;
        fake.picked = Some("codex_work".into());
        fake.answers = vec![Some("yes".into())];
        assert_eq!(run(none.clone(), &mut fake).await, 0, "{:?}", fake.err);
        assert_eq!(sent_ids(&fake), ["codex", "opencode_zai"]);

        let mut left = Fake::new();
        left.interactive = true;
        assert_eq!(run(none, &mut left).await, 1);
        assert!(left.err.join("\n").contains("Cancelled") && left.sent.is_empty());
    }

    #[tokio::test]
    async fn remove_reports_a_refusal_from_the_server() {
        let mut fake = Fake::new();
        fake.update_error = Some("refused".into());
        assert_eq!(fake.run(&["remove", "codex_work", "-y"]).await, 1);
        assert!(fake.err.join("\n").contains("Could not remove it: refused"));
        assert!(!fake.err.join("\n").contains("Not sure"));
    }

    #[test]
    fn a_failure_is_unsure_only_when_the_server_may_not_have_read_the_request() {
        for message in [
            "the connection closed",
            "the connection is closed",
            "the connection failed: x",
            "protocol error: y",
            "server fault: z",
            "the request was interrupted",
        ] {
            assert!(is_unsure(message), "{message}");
        }
        for message in [
            "Settings are invalid",
            "the server refused the request",
            "ServerSettingsError",
        ] {
            assert!(!is_unsure(message), "{message}");
        }
    }

    #[test]
    fn only_the_word_yes_confirms_a_removal() {
        assert!(is_yes(" YES ") && !is_yes("y") && !is_yes(""));
    }
}
