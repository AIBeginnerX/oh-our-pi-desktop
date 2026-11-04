//! What `list` shows, the settings patches of an add and a remove, the `--dry-run` preview and the
//! impact of a removal: ported from the former TypeScript terminal's provider plan. Everything works on the JSON
//! the server sent (`serde_json::Value`), so an instance this program does not know passes through
//! a patch exactly as it came.

use crate::provider_spec::{
    AddDraft, Control, Jv, build_instance, draft_secrets, driver_label, is_default_instance_id,
    is_instance_id_shape, one_line, redact_secrets, target_fields,
};
use crate::provider_text::{t, tf};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

// ---- the list -----------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Ok,
    Warn,
    Bad,
    Dim,
}

/// One provider instance as `list` shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderRow {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub enabled: bool,
    /// One word: ready, warning, error, off, not installed or unavailable.
    pub status: String,
    pub tone: Tone,
    /// How many models the server reports; `None` when the server has not reported the instance.
    pub models: Option<usize>,
    /// The server's one-line note about the instance, sanitized.
    pub message: Option<String>,
    /// The instance is the built-in one of its driver.
    pub is_default: bool,
}

fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn state_of(provider: &Value) -> (String, Tone) {
    let enabled = provider
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if text_of(provider, "availability") == Some("unavailable") {
        return (t("providers.plan.unavailable").into(), Tone::Bad);
    }
    if !enabled || text_of(provider, "status") == Some("disabled") {
        return (t("providers.cmd.off").into(), Tone::Dim);
    }
    if provider.get("installed").and_then(Value::as_bool) != Some(true) {
        return (t("providers.plan.notInstalled").into(), Tone::Bad);
    }
    match text_of(provider, "status") {
        Some("error") => (t("providers.plan.error").into(), Tone::Bad),
        Some("warning") => (t("providers.plan.warning").into(), Tone::Warn),
        _ => (t("providers.plan.ready").into(), Tone::Ok),
    }
}

fn name_of(entry: &Value) -> String {
    let driver = text_of(entry, "driver").unwrap_or_default();
    one_line(
        text_of(entry, "displayName")
            .map_or_else(|| driver_label(driver), str::to_string)
            .as_str(),
    )
}

/// One provider as the server reports it.
pub fn row_of_provider(provider: &Value) -> ProviderRow {
    let id = text_of(provider, "instanceId")
        .unwrap_or_default()
        .to_string();
    let (status, tone) = state_of(provider);
    ProviderRow {
        name: name_of(provider),
        driver: text_of(provider, "driver").unwrap_or_default().to_string(),
        enabled: provider
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        status,
        tone,
        models: Some(
            provider
                .get("models")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
        ),
        message: text_of(provider, "message")
            .map(one_line)
            .filter(|message| !message.is_empty()),
        is_default: is_default_instance_id(&id),
        id,
    }
}

fn instances(settings: Option<&Value>) -> Option<&Map<String, Value>> {
    settings?.get("providerInstances")?.as_object()
}

/// Every instance the server runs or the settings define. The server's report comes first; an
/// instance that is only in the settings (the server has not started it) is listed after it.
pub fn provider_rows(config: Option<&Value>, settings: Option<&Value>) -> Vec<ProviderRow> {
    let mut rows = Vec::new();
    let mut seen = BTreeSet::new();
    for provider in config
        .and_then(|c| c.get("providers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let row = row_of_provider(provider);
        seen.insert(row.id.clone());
        rows.push(row);
    }
    for (id, instance) in instances(settings).into_iter().flatten() {
        if seen.contains(id) {
            continue;
        }
        let enabled = instance.get("enabled").and_then(Value::as_bool) != Some(false);
        rows.push(ProviderRow {
            id: id.clone(),
            name: name_of(instance),
            driver: text_of(instance, "driver").unwrap_or_default().to_string(),
            enabled,
            status: t(if enabled {
                "providers.plan.checking"
            } else {
                "providers.cmd.off"
            })
            .into(),
            tone: Tone::Dim,
            models: None,
            message: None,
            is_default: is_default_instance_id(id),
        });
    }
    rows
}

/// Every id an instance already has, from the settings and from what the server reports.
pub fn taken_ids(
    config: Option<&Value>,
    settings: Option<&Value>,
) -> std::collections::HashSet<String> {
    let mut ids: std::collections::HashSet<String> = instances(settings)
        .into_iter()
        .flatten()
        .map(|(id, _)| id.clone())
        .collect();
    for provider in config
        .and_then(|c| c.get("providers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = text_of(provider, "instanceId") {
            ids.insert(id.to_string());
        }
    }
    ids
}

// ---- the patches --------------------------------------------------------------------------------

/// The whole `providerInstances` record with `instance` added. The other instances are passed on
/// exactly as the server sent them, including a secret's `valueRedacted` marker, which is how the
/// server knows to keep the secret it holds. `None` when the id is taken.
pub fn add_patch(current: &Value, id: &str, instance: &Jv) -> Option<Value> {
    let mut record = current
        .get("providerInstances")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if record.contains_key(id) {
        return None;
    }
    record.insert(id.to_string(), instance.to_value());
    Some(json!({"providerInstances": record}))
}

/// The whole `providerInstances` record without `id`; `None` when it is not there.
pub fn remove_patch(current: &Value, id: &str) -> Option<Value> {
    let mut record = current
        .get("providerInstances")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    record.remove(id)?;
    Some(json!({"providerInstances": record}))
}

// ---- what an add would send ---------------------------------------------------------------------

/// `build_instance`, with the builder's complaint as a message that cannot hold a secret.
pub fn try_build(draft: &AddDraft) -> Result<Jv, String> {
    build_instance(draft).map_err(|text| redact_secrets(&one_line(&text), &draft_secrets(draft)))
}

const MASK: &str = "****";

/// The patch an add would send, as indented JSON with every secret hidden. For `--dry-run`.
pub fn preview_payload(draft: &AddDraft, instance: &Jv) -> String {
    let passwords: Vec<&str> = target_fields(draft.target)
        .iter()
        .filter(|field| field.control == Control::Password)
        .map(|field| field.key)
        .collect();
    let hidden = match instance {
        Jv::Obj(entries) => Jv::Obj(
            entries
                .iter()
                .map(|(key, value)| {
                    let value = match (key.as_str(), value) {
                        ("config", Jv::Obj(config)) => Jv::Obj(
                            config
                                .iter()
                                .map(|(k, v)| {
                                    let v = if passwords.contains(&k.as_str()) {
                                        Jv::s(MASK)
                                    } else {
                                        v.clone()
                                    };
                                    (k.clone(), v)
                                })
                                .collect(),
                        ),
                        ("environment", Jv::Arr(items)) => Jv::Arr(
                            items
                                .iter()
                                .map(|item| match item {
                                    Jv::Obj(fields)
                                        if item.get("sensitive") == Some(&Jv::Bool(true)) =>
                                    {
                                        Jv::Obj(
                                            fields
                                                .iter()
                                                .map(|(k, v)| {
                                                    let v = if k == "value" {
                                                        Jv::s(MASK)
                                                    } else {
                                                        v.clone()
                                                    };
                                                    (k.clone(), v)
                                                })
                                                .collect(),
                                        )
                                    }
                                    other => other.clone(),
                                })
                                .collect(),
                        ),
                        _ => value.clone(),
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        other => other.clone(),
    };
    let text = Jv::obj(vec![(
        "providerInstances",
        Jv::Obj(vec![(draft.id.clone(), hidden)]),
    )])
    .pretty();
    redact_secrets(&text, &draft_secrets(draft))
}

// ---- removing -----------------------------------------------------------------------------------

/// What removing an instance leaves behind, so the user sees it before confirming.
#[derive(Debug, Clone, PartialEq)]
pub struct RemovePlan {
    pub id: String,
    pub name: String,
    pub driver: String,
    /// Secret environment values the server holds for the instance and drops with it.
    pub secrets: usize,
    pub threads_total: usize,
    pub threads_running: usize,
    pub titles: Vec<String>,
    /// Crew roles pinned to a model of the instance, in the defaults and in thread overrides.
    pub crew_pins: usize,
    pub text_generation: bool,
    pub projects: usize,
    /// The thread list was not available, so the thread counts are unknown.
    pub threads_known: bool,
}

const TITLES_SHOWN: usize = 3;

fn is_thread_running(thread: &Value) -> bool {
    let session = thread.get("session").and_then(|s| text_of(s, "status"));
    matches!(session, Some("running" | "starting"))
        || thread
            .get("latestTurn")
            .and_then(|turn| text_of(turn, "state"))
            == Some("running")
}

/// Whether `id` can be removed and what depends on it. Nothing is cleared automatically, as in the
/// app. `shell` is the shell snapshot as the server sent it, when it was read.
pub fn plan_remove(
    id: &str,
    settings: &Value,
    shell: Option<&Value>,
) -> Result<RemovePlan, String> {
    if is_default_instance_id(id) {
        return Err(tf(
            "providers.plan.builtIn",
            &[("id", id.to_string()), ("driver", driver_label(id))],
        ));
    }
    let Some(instance) = instances(Some(settings)).and_then(|record| record.get(id)) else {
        // An id that cannot be one is not repeated: it may be something else typed in its place.
        return Err(if is_instance_id_shape(id) {
            tf("providers.plan.noSuchProvider", &[("id", id.to_string())])
        } else {
            t("providers.plan.badId").into()
        });
    };
    let uses =
        |selection: Option<&Value>| selection.and_then(|s| text_of(s, "instanceId")) == Some(id);
    let pinned_by = |pins: Option<&Value>| {
        pins.and_then(Value::as_object).map_or(0, |map| {
            map.values()
                .filter(|selection| uses(Some(selection)))
                .count()
        })
    };
    let all_threads: &[Value] = shell
        .and_then(|s| s.get("threads"))
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice);
    let threads: Vec<&Value> = all_threads
        .iter()
        .filter(|thread| uses(thread.get("modelSelection")))
        .collect();
    let projects = shell
        .and_then(|s| s.get("projects"))
        .and_then(Value::as_array)
        .map_or(0, |list| {
            list.iter()
                .filter(|p| uses(p.get("defaultModelSelection")))
                .count()
        });
    Ok(RemovePlan {
        id: id.to_string(),
        name: name_of(instance),
        driver: text_of(instance, "driver").unwrap_or_default().to_string(),
        secrets: instance
            .get("environment")
            .and_then(Value::as_array)
            .map_or(0, |env| {
                env.iter()
                    .filter(|e| e.get("sensitive") == Some(&Value::Bool(true)))
                    .count()
            }),
        threads_total: threads.len(),
        threads_running: threads
            .iter()
            .filter(|thread| is_thread_running(thread))
            .count(),
        titles: threads
            .iter()
            .take(TITLES_SHOWN)
            .map(|thread| one_line(text_of(thread, "title").unwrap_or_default()))
            .collect(),
        crew_pins: pinned_by(settings.get("crew").and_then(|crew| crew.get("pinned")))
            + all_threads
                .iter()
                .map(|thread| pinned_by(thread.get("crew").and_then(|crew| crew.get("pinned"))))
                .sum::<usize>(),
        text_generation: uses(settings.get("textGenerationModelSelection")),
        projects,
        threads_known: shell.is_some(),
    })
}

/// What the add and remove screens need to know about the server, read once when they open.
#[derive(Debug, Clone)]
pub struct Context {
    /// Every id an instance already has.
    pub taken: std::collections::HashSet<String>,
    pub rows: Vec<ProviderRow>,
    settings: Value,
    shell: Option<Value>,
}

impl Context {
    pub fn new(config: Option<&Value>, settings: Value, shell: Option<Value>) -> Context {
        Context {
            taken: taken_ids(config, Some(&settings)),
            rows: provider_rows(config, Some(&settings)),
            settings,
            shell,
        }
    }

    pub fn check_remove(&self, id: &str) -> Result<RemovePlan, String> {
        plan_remove(id, &self.settings, self.shell.as_ref())
    }
}

/// The plan as plain sentences, one per line.
pub fn plan_lines(plan: &RemovePlan) -> Vec<String> {
    let count = |n: usize| ("count", n.to_string());
    let mut lines = vec![
        tf(
            "providers.plan.remove",
            &[
                ("id", plan.id.clone()),
                ("name", plan.name.clone()),
                ("driver", driver_label(&plan.driver)),
            ],
        ),
        if plan.secrets > 0 {
            tf("providers.plan.secrets", &[count(plan.secrets)])
        } else {
            t("providers.plan.noSecrets").into()
        },
    ];
    if !plan.threads_known {
        lines.push(t("providers.plan.threadsUnknown").into());
    } else if plan.threads_total > 0 {
        let running = if plan.threads_running > 0 {
            format!(
                " {}",
                tf("providers.plan.running", &[count(plan.threads_running)])
            )
        } else {
            String::new()
        };
        lines.push(tf(
            "providers.plan.threadsKept",
            &[count(plan.threads_total), ("running", running)],
        ));
        lines.extend(plan.titles.iter().map(|title| format!("  - {title}")));
        if plan.threads_total > plan.titles.len() {
            lines.push(tf(
                "providers.plan.more",
                &[count(plan.threads_total - plan.titles.len())],
            ));
        }
    } else {
        lines.push(t("providers.plan.noThreads").into());
    }
    if plan.crew_pins > 0 {
        lines.push(tf("providers.plan.crewPins", &[count(plan.crew_pins)]));
    }
    if plan.text_generation {
        lines.push(t("providers.plan.textGeneration").into());
    }
    if plan.projects > 0 {
        lines.push(tf("providers.plan.projects", &[count(plan.projects)]));
    }
    if plan.threads_total + plan.crew_pins + plan.projects > 0 || plan.text_generation {
        lines.push(t("providers.plan.notAutomatic").into());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_spec::{Val, new_draft, parse_target, with_id};

    const SECRET: &str = "test-value-1234";

    fn english() {
        crate::i18n::init(Some("en"));
    }

    fn settings() -> Value {
        json!({"providerInstances": {
            "codex": {"driver": "codex", "enabled": true},
            "opencode_zai": {"driver": "opencode", "displayName": "Z.AI", "environment": [
                {"name": "OOP_ZAI_API_KEY", "value": "", "sensitive": true, "valueRedacted": true}]},
            "codex_work": {"driver": "codex"},
        }})
    }

    fn server_provider(id: &str, over: Value) -> Value {
        let mut base = json!({"instanceId": id, "driver": "codex", "enabled": true, "installed": true,
            "availability": "available", "status": "ready", "models": [{"slug": "m"}]});
        for (key, value) in over.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    fn target(word: &str) -> crate::provider_spec::Target {
        parse_target(word).unwrap()
    }

    #[test]
    fn rows_say_what_the_server_says_with_sanitized_text() {
        english();
        let config = json!({"providers": [
            server_provider("codex", json!({})),
            server_provider("codex_work", json!({"status": "warning", "message": "slow\u{1b}[31m\nsecond"})),
            server_provider("opencode_zai", json!({"status": "error", "models": []})),
            server_provider("off", json!({"enabled": false, "status": "disabled"})),
            server_provider("gone", json!({"installed": false})),
            server_provider("shadow", json!({"availability": "unavailable"})),
        ]});
        let rows = provider_rows(Some(&config), Some(&settings()));
        let seen: Vec<(&str, &str, Option<usize>)> = rows
            .iter()
            .map(|r| (r.id.as_str(), r.status.as_str(), r.models))
            .collect();
        assert_eq!(
            seen,
            [
                ("codex", "ready", Some(1)),
                ("codex_work", "warning", Some(1)),
                ("opencode_zai", "error", Some(0)),
                ("off", "off", Some(1)),
                ("gone", "not installed", Some(1)),
                ("shadow", "unavailable", Some(1)),
            ]
        );
        assert_eq!(rows[1].message.as_deref(), Some("slow second"));
        assert!(rows[0].is_default && !rows[1].is_default);
        assert_eq!(rows[2].tone, Tone::Bad);
    }

    #[test]
    fn rows_add_an_instance_only_the_settings_know_and_work_with_no_server_report() {
        english();
        let rows = provider_rows(None, Some(&settings()));
        let mut ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["codex", "codex_work", "opencode_zai"]);
        assert!(
            rows.iter()
                .all(|r| r.models.is_none() && r.status == "checking")
        );
        assert_eq!(
            rows.iter().find(|r| r.id == "opencode_zai").unwrap().name,
            "Z.AI"
        );
        assert!(provider_rows(None, None).is_empty());
    }

    #[test]
    fn collects_every_id_in_use() {
        let config = json!({"providers": [server_provider("claudeAgent", json!({}))]});
        let mut ids: Vec<String> = taken_ids(Some(&config), Some(&settings()))
            .into_iter()
            .collect();
        ids.sort();
        assert_eq!(ids, ["claudeAgent", "codex", "codex_work", "opencode_zai"]);
    }

    #[test]
    fn the_add_patch_passes_every_other_instance_on_exactly_as_it_came() {
        let draft = with_id(new_draft(target("codex")), "codex_new");
        let instance = build_instance(&draft).unwrap();
        let current = settings();
        let patch = add_patch(&current, "codex_new", &instance).unwrap();
        assert_eq!(
            patch.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["providerInstances"]
        );
        let sent = &patch["providerInstances"];
        assert_eq!(
            sent["opencode_zai"],
            current["providerInstances"]["opencode_zai"]
        );
        assert_eq!(
            sent["opencode_zai"]["environment"][0]["valueRedacted"],
            true
        );
        assert_eq!(sent["codex_new"]["driver"], "codex");
        assert_eq!(sent.as_object().unwrap().len(), 4);
    }

    #[test]
    fn the_add_patch_does_nothing_when_the_id_is_taken() {
        let draft = with_id(new_draft(target("codex")), "codex_work");
        assert_eq!(
            add_patch(&settings(), "codex_work", &build_instance(&draft).unwrap()),
            None
        );
    }

    #[test]
    fn the_add_patch_is_built_from_the_settings_it_is_given() {
        let mut newer = settings();
        newer["providerInstances"]["added_elsewhere"] = json!({"driver": "grok"});
        let draft = with_id(new_draft(target("codex")), "codex_new");
        let patch = add_patch(&newer, "codex_new", &build_instance(&draft).unwrap()).unwrap();
        assert!(patch["providerInstances"].get("added_elsewhere").is_some());
    }

    #[test]
    fn the_remove_patch_drops_only_the_one_instance() {
        let current = settings();
        let patch = remove_patch(&current, "codex_work").unwrap();
        let sent = patch["providerInstances"].as_object().unwrap();
        assert_eq!(sent.keys().collect::<Vec<_>>(), ["codex", "opencode_zai"]);
        assert_eq!(
            sent["opencode_zai"],
            current["providerInstances"]["opencode_zai"]
        );
        for id in ["nope", "bad id!", "constructor"] {
            assert_eq!(remove_patch(&current, id), None, "{id}");
        }
    }

    fn preset() -> AddDraft {
        let mut draft = with_id(new_draft(target("zai")), "opencode_zai2");
        draft.values = [
            ("service".to_string(), Val::S("api".into())),
            ("model".to_string(), Val::S("glm-5.3".into())),
            ("apiKey".to_string(), Val::S(SECRET.into())),
        ]
        .into();
        draft.env = vec![crate::provider_spec::EnvEntry {
            name: "EXTRA".into(),
            value: format!("{SECRET}-env"),
            sensitive: true,
        }];
        draft
    }

    fn gemini() -> AddDraft {
        let mut draft = with_id(new_draft(target("antigravity")), "antigravity_key");
        draft.values.insert("apiKey".into(), Val::S(SECRET.into()));
        draft
    }

    #[test]
    fn the_preview_hides_every_secret_in_the_environment_and_in_plain_config_fields() {
        for draft in [preset(), gemini()] {
            let instance = try_build(&draft).unwrap();
            let preview = preview_payload(&draft, &instance);
            assert!(!preview.contains(SECRET), "{preview}");
            assert!(
                preview.contains("****") && preview.contains(&draft.id),
                "{preview}"
            );
            assert!(
                preview.starts_with("{\n  \"providerInstances\": {"),
                "{preview}"
            );
        }
        // The API key really is in the instance, so the preview is hiding something.
        assert!(build_instance(&gemini()).unwrap().pretty().contains(SECRET));
    }

    #[test]
    fn a_failing_builder_is_reported_without_echoing_a_secret() {
        let mut bad = preset();
        bad.values
            .insert("model".into(), Val::S(format!("a/{SECRET}")));
        let text = try_build(&bad).unwrap_err();
        assert!(!text.contains(SECRET) && text.contains("valid"), "{text}");
    }

    fn thread(id: &str, instance: &str, over: Value) -> Value {
        let mut base = json!({"id": id, "title": format!("title {id}"),
            "modelSelection": {"instanceId": instance, "model": "m"}});
        for (key, value) in over.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    #[test]
    fn planning_refuses_a_built_in_instance_and_says_why() {
        english();
        let reason = plan_remove("codex", &settings(), None).unwrap_err();
        assert!(reason.contains("built-in instance of Codex"), "{reason}");
    }

    #[test]
    fn planning_refuses_an_id_that_is_not_there_or_not_a_plain_id() {
        english();
        for id in ["nope", "bad id\u{1b}[0m", "constructor"] {
            let reason = plan_remove(id, &settings(), None).unwrap_err();
            assert!(!reason.contains('\u{1b}'), "{id}");
        }
        assert!(
            plan_remove("nothere", &settings(), None)
                .unwrap_err()
                .contains("'nothere'")
        );
        let odd = plan_remove(&format!("{SECRET}.x y"), &settings(), None).unwrap_err();
        assert!(odd.contains("Invalid ID") && !odd.contains(SECRET), "{odd}");
    }

    #[test]
    fn planning_counts_what_depends_on_the_instance_and_the_secrets_it_holds() {
        english();
        let mut with_pins = settings();
        with_pins["crew"] = json!({"enabled": true, "pinned": {
            "explore": {"instanceId": "opencode_zai", "model": "m"},
            "plan": {"instanceId": "codex", "model": "m"}}});
        with_pins["textGenerationModelSelection"] =
            json!({"instanceId": "opencode_zai", "model": "m"});
        let shell = json!({
        "projects": [{"id": "p", "defaultModelSelection": {"instanceId": "opencode_zai", "model": "m"}}],
        "threads": [
            thread("a", "opencode_zai", json!({"crew": {"pinned": {"worker": {"instanceId": "opencode_zai", "model": "m"}}}})),
            thread("b", "opencode_zai", json!({"session": {"status": "running"}})),
            thread("c", "opencode_zai", json!({})),
            thread("d", "opencode_zai", json!({})),
            thread("e", "codex", json!({})),
        ]});
        let plan = plan_remove("opencode_zai", &with_pins, Some(&shell)).unwrap();
        assert_eq!(
            (
                plan.secrets,
                plan.crew_pins,
                plan.text_generation,
                plan.projects,
                plan.threads_known
            ),
            (1, 2, true, 1, true)
        );
        assert_eq!(
            (plan.threads_total, plan.threads_running, plan.titles.len()),
            (4, 1, 3)
        );
        let lines = plan_lines(&plan).join("\n");
        assert!(
            lines.contains("4 threads using this provider's models (1 running)"),
            "{lines}"
        );
        assert!(lines.contains("… and 1 more"), "{lines}");
        assert!(lines.contains("1 secrets stored"), "{lines}");
        assert!(lines.contains("do not change automatically"), "{lines}");
    }

    #[test]
    fn planning_says_plainly_when_nothing_depends_on_it_and_when_threads_are_not_known() {
        english();
        let shell = json!({"projects": [], "threads": []});
        let none = plan_remove("codex_work", &settings(), Some(&shell)).unwrap();
        let lines = plan_lines(&none).join("\n");
        assert!(
            lines.contains("No threads use this provider") && !lines.contains("automatically"),
            "{lines}"
        );
        let unknown = plan_remove("codex_work", &settings(), None).unwrap();
        assert!(!unknown.threads_known);
        assert!(
            plan_lines(&unknown)
                .join("\n")
                .contains("impact is unknown")
        );
    }

    #[test]
    fn a_title_taken_from_the_server_is_cleaned() {
        english();
        let shell = json!({"projects": [], "threads": [
            thread("a", "codex_work", json!({"title": "bad\u{1b}]0;x\u{7} title\nsecond"}))]});
        let plan = plan_remove("codex_work", &settings(), Some(&shell)).unwrap();
        assert!(
            plan.titles[0].chars().all(|c| !c.is_control()),
            "{:?}",
            plan.titles
        );
    }

    #[test]
    fn a_turn_in_flight_counts_as_running() {
        let turning = json!({"latestTurn": {"state": "running"}});
        assert!(is_thread_running(&turning));
        assert!(is_thread_running(
            &json!({"session": {"status": "starting"}})
        ));
        assert!(!is_thread_running(&json!({"session": {"status": "idle"}})));
    }
}
