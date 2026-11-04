//! What can be added as a provider and the draft the user fills in: ported from
//! the former TypeScript terminal's provider spec. The driver table and their fields come from the schemas in
//! packages/contracts (`providerSettingsForm` annotations) and the presets from
//! packages/client-runtime/src/provider-presets.ts; `tests::tables_match_the_typescript_sources`
//! cannot read them, so a field the desktop app adds is added here by hand.

use crate::provider_text::{t, tf};
use std::collections::{BTreeMap, HashSet};

// ---- untrusted text -----------------------------------------------------------------------------

/// Text from the server or the user is untrusted: escape sequences are dropped whole, line ends are
/// unified, a tab is two spaces and every other control character goes (`sanitizeForTerminal`).
pub fn sanitize_terminal(value: &str) -> String {
    let stripped = strip_ansi(value);
    let mut out = String::with_capacity(stripped.len());
    let mut chars = stripped.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\t' => out.push_str("  "),
            '\n' => out.push('\n'),
            c if is_control(c) => {}
            c => out.push(c),
        }
    }
    out
}

fn is_control(c: char) -> bool {
    matches!(c,
        '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}'
        | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// CSI sequences, OSC strings and two-character escapes.
fn strip_ansi(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '\u{1b}' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        match chars.get(i + 1) {
            Some('[') => {
                let mut j = i + 2;
                while j < chars.len() && ('\u{30}'..='\u{3f}').contains(&chars[j]) {
                    j += 1;
                }
                while j < chars.len() && ('\u{20}'..='\u{2f}').contains(&chars[j]) {
                    j += 1;
                }
                if j < chars.len() && ('\u{40}'..='\u{7e}').contains(&chars[j]) {
                    i = j + 1;
                } else {
                    i += 1;
                }
            }
            Some(']') => {
                let mut j = i + 2;
                while j < chars.len() && chars[j] != '\u{7}' && chars[j] != '\u{1b}' {
                    j += 1;
                }
                if j < chars.len() && chars[j] == '\u{7}' {
                    i = j + 1;
                } else if j + 1 < chars.len() && chars[j] == '\u{1b}' && chars[j + 1] == '\\' {
                    i = j + 2;
                } else {
                    i += 1;
                }
            }
            Some(c) if ('\u{40}'..='\u{5a}').contains(c) || ('\u{5c}'..='\u{5f}').contains(c) => {
                i += 2;
            }
            _ => i += 1,
        }
    }
    out
}

/// `sanitize_terminal` on one line: runs of white space become one space.
pub fn one_line(text: &str) -> String {
    sanitize_terminal(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---- drivers ------------------------------------------------------------------------------------

/// A provider the user can add, in the order the desktop app lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Driver {
    pub value: &'static str,
    pub label: &'static str,
    /// The desktop app marks these as early access.
    pub early_access: bool,
}

pub const DRIVERS: [Driver; 8] = [
    Driver {
        value: "codex",
        label: "Codex",
        early_access: false,
    },
    Driver {
        value: "claudeAgent",
        label: "Claude",
        early_access: false,
    },
    Driver {
        value: "cursor",
        label: "Cursor",
        early_access: true,
    },
    Driver {
        value: "grok",
        label: "Grok",
        early_access: true,
    },
    Driver {
        value: "opencode",
        label: "OpenCode",
        early_access: false,
    },
    Driver {
        value: "antigravity",
        label: "Antigravity",
        early_access: false,
    },
    Driver {
        value: "minimax",
        label: "MiniMax Code",
        early_access: true,
    },
    Driver {
        value: "zcode",
        label: "ZCode",
        early_access: true,
    },
];

/// An instance whose id is the name of a driver is that driver's built-in default. It cannot be
/// removed, and a new instance may not take the id.
pub fn is_default_instance_id(id: &str) -> bool {
    DRIVERS.iter().any(|driver| driver.value == id)
}

pub fn driver_label(driver: &str) -> String {
    DRIVERS
        .iter()
        .find(|entry| entry.value == driver)
        .map_or(driver, |entry| entry.label)
        .to_string()
}

// ---- presets ------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    Zai,
    Minimax,
}

pub const PRESET_IDS: [Preset; 2] = [Preset::Zai, Preset::Minimax];

pub struct Service {
    pub value: &'static str,
    pub label: &'static str,
    pub provider_id: &'static str,
    pub base_url: &'static str,
    pub default_model: &'static str,
}

pub struct PresetInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub suggested_instance_id: &'static str,
    pub default_service: &'static str,
    pub api_key_environment_variable: &'static str,
    pub services: [Service; 2],
}

const ZAI: PresetInfo = PresetInfo {
    id: "zai",
    label: "Z.AI",
    suggested_instance_id: "opencode_zai",
    default_service: "api",
    api_key_environment_variable: "OOP_ZAI_API_KEY",
    services: [
        Service {
            value: "api",
            label: "API",
            provider_id: "zai",
            base_url: "https://api.z.ai/api/paas/v4",
            default_model: "glm-5.3",
        },
        Service {
            value: "coding",
            label: "Coding Plan",
            provider_id: "zai-coding-plan",
            base_url: "https://api.z.ai/api/coding/paas/v4",
            default_model: "glm-5.3",
        },
    ],
};

const MINIMAX: PresetInfo = PresetInfo {
    id: "minimax",
    label: "MiniMax",
    suggested_instance_id: "opencode_minimax",
    default_service: "api",
    api_key_environment_variable: "OOP_MINIMAX_API_KEY",
    services: [
        Service {
            value: "api",
            label: "API",
            provider_id: "minimax",
            base_url: "https://api.minimax.io/anthropic/v1",
            default_model: "MiniMax-M3",
        },
        Service {
            value: "coding",
            label: "Token Plan",
            provider_id: "minimax-coding-plan",
            base_url: "https://api.minimax.io/anthropic/v1",
            default_model: "MiniMax-M3.1-Flash",
        },
    ],
};

pub fn preset_info(preset: Preset) -> &'static PresetInfo {
    match preset {
        Preset::Zai => &ZAI,
        Preset::Minimax => &MINIMAX,
    }
}

// ---- what can be added --------------------------------------------------------------------------

/// Something to pick in the add wizard: a driver, or a ready-made OpenCode setup for a service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// An index into `DRIVERS`.
    Driver(usize),
    Preset(Preset),
}

pub const TARGET_COUNT: usize = DRIVERS.len() + PRESET_IDS.len();

pub fn targets() -> Vec<Target> {
    (0..DRIVERS.len())
        .map(Target::Driver)
        .chain(PRESET_IDS.iter().copied().map(Target::Preset))
        .collect()
}

pub fn target_label(target: Target) -> &'static str {
    match target {
        Target::Driver(index) => DRIVERS[index].label,
        Target::Preset(preset) => preset_info(preset).label,
    }
}

/// The driver kind the instance will have: a preset is an OpenCode instance.
pub fn target_driver(target: Target) -> &'static str {
    match target {
        Target::Driver(index) => DRIVERS[index].value,
        Target::Preset(_) => "opencode",
    }
}

/// Every word `parse_target` takes, for the message that says what was meant.
pub fn target_words() -> String {
    DRIVERS
        .iter()
        .map(|driver| driver.value.to_string())
        .chain(PRESET_IDS.iter().map(|preset| match preset {
            Preset::Zai => "zai".to_string(),
            Preset::Minimax => "preset:minimax".to_string(),
        }))
        .collect::<Vec<_>>()
        .join(" | ")
}

/// The target a command-line word names; `None` when it names none.
pub fn parse_target(word: &str) -> Option<Target> {
    let wanted = word.trim().to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    if wanted == "claude" {
        return Some(Target::Driver(1));
    }
    if let Some(index) = DRIVERS
        .iter()
        .position(|entry| entry.value.to_lowercase() == wanted)
    {
        return Some(Target::Driver(index));
    }
    let preset_word = wanted.strip_prefix("preset:").unwrap_or(&wanted);
    PRESET_IDS
        .iter()
        .find(|preset| preset_info(**preset).id == preset_word)
        .map(|preset| Target::Preset(*preset))
}

// ---- the fields of a target ---------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Text,
    Password,
    Select,
    Switch,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub key: &'static str,
    pub control: Control,
    pub label: String,
    pub placeholder: Option<&'static str>,
    /// `(value, label)` of a select.
    pub options: Vec<(String, String)>,
    /// The value of a switch the server uses when nothing is set.
    pub default_bool: bool,
    /// The instance cannot be added without it.
    pub required: bool,
}

fn field_label(key: &str) -> String {
    t(&format!("providers.field.{key}")).to_string()
}

fn text_field(key: &'static str, placeholder: Option<&'static str>) -> Field {
    Field {
        key,
        control: Control::Text,
        label: field_label(key),
        placeholder,
        options: Vec::new(),
        default_bool: false,
        required: false,
    }
}

fn password_field(key: &'static str, placeholder: Option<&'static str>) -> Field {
    Field {
        control: Control::Password,
        ..text_field(key, placeholder)
    }
}

fn switch_field(key: &'static str, default_bool: bool) -> Field {
    Field {
        control: Control::Switch,
        default_bool,
        ..text_field(key, None)
    }
}

/// The fields the desktop app's form shows for a driver, in its order.
pub fn driver_fields(driver: &Driver) -> Vec<Field> {
    match driver.value {
        "codex" => vec![
            text_field("binaryPath", Some("codex")),
            text_field("homePath", Some("~/.codex")),
            text_field("shadowHomePath", Some("~/.codex-t3/personal")),
            text_field("launchArgs", None),
            switch_field("telemetry", false),
        ],
        "claudeAgent" => vec![
            text_field("binaryPath", Some("claude")),
            text_field("homePath", Some("~/.claude")),
            text_field("autoCompactWindow", Some("e.g. 300000")),
            switch_field("claudeAiConnectors", false),
            switch_field("telemetry", true),
            text_field("launchArgs", Some("e.g. --chrome")),
        ],
        "cursor" => vec![
            text_field("binaryPath", Some("cursor-agent")),
            text_field("apiEndpoint", Some("https://...")),
        ],
        "grok" => vec![
            text_field("binaryPath", Some("grok")),
            switch_field("telemetry", false),
        ],
        "opencode" => vec![
            text_field("binaryPath", Some("opencode")),
            text_field("serverUrl", Some("http://127.0.0.1:4096")),
            password_field("serverPassword", Some("Optional")),
        ],
        "antigravity" => vec![
            Field {
                control: Control::Select,
                options: [
                    ("oauth-personal", "Google account"),
                    ("oauth-business", "Gemini Enterprise"),
                    ("gemini-api-key", "Gemini API key"),
                    ("agent-platform", "Agent Platform (Vertex AI)"),
                ]
                .iter()
                .map(|(value, label)| (value.to_string(), label.to_string()))
                .collect(),
                ..text_field("authMethod", None)
            },
            password_field("apiKey", Some("Optional")),
            text_field("gcpProject", Some("my-project-id")),
            text_field("gcpLocation", Some("us-central1")),
            text_field("binaryPath", Some("Automatic")),
        ],
        "minimax" => vec![text_field("binaryPath", Some("mcode"))],
        "zcode" => vec![
            text_field("binaryPath", Some("zcode")),
            text_field("bridgePath", Some("zcode-acp-server")),
            switch_field("telemetry", false),
        ],
        _ => Vec::new(),
    }
}

/// What the form asks for a preset: the key, the service, the model and where OpenCode is.
pub fn preset_fields(preset: Preset) -> Vec<Field> {
    let info = preset_info(preset);
    vec![
        Field {
            required: true,
            ..password_field("apiKey", None)
        },
        Field {
            key: "service",
            control: Control::Select,
            label: t("providers.spec.service").to_string(),
            placeholder: None,
            options: info
                .services
                .iter()
                .map(|service| (service.value.to_string(), service.label.to_string()))
                .collect(),
            default_bool: false,
            required: false,
        },
        Field {
            key: "model",
            control: Control::Text,
            label: t("providers.spec.model").to_string(),
            placeholder: None,
            options: Vec::new(),
            default_bool: false,
            required: false,
        },
        Field {
            key: "binaryPath",
            control: Control::Text,
            label: t("providers.spec.openCodePath").to_string(),
            placeholder: Some("opencode"),
            options: Vec::new(),
            default_bool: false,
            required: false,
        },
    ]
}

pub fn target_fields(target: Target) -> Vec<Field> {
    match target {
        Target::Driver(index) => driver_fields(&DRIVERS[index]),
        Target::Preset(preset) => preset_fields(preset),
    }
}

// ---- values -------------------------------------------------------------------------------------

/// A field's value: text, or a switch.
#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    S(String),
    B(bool),
}

pub type Values = BTreeMap<String, Val>;

fn preset_service(preset: Preset, service: Option<&Val>) -> &'static Service {
    let info = preset_info(preset);
    let named = |wanted: &str| {
        info.services
            .iter()
            .find(|candidate| candidate.value == wanted)
    };
    if let Some(Val::S(wanted)) = service
        && let Some(found) = named(wanted)
    {
        return found;
    }
    named(info.default_service).unwrap_or(&info.services[0])
}

/// The values a new draft starts with: a preset's default service and model, as the desktop app
/// fills them.
pub fn initial_values(target: Target) -> Values {
    let mut values = Values::new();
    if let Target::Preset(preset) = target {
        let service = preset_service(preset, None);
        values.insert(
            "service".into(),
            Val::S(preset_info(preset).default_service.into()),
        );
        values.insert("model".into(), Val::S(service.default_model.into()));
    }
    values
}

/// `values` with one field changed. Picking another service of a preset moves the model along if it
/// was still the first service's default, as in the desktop app.
pub fn with_value(target: Target, values: &Values, key: &str, value: Option<Val>) -> Values {
    let mut next = values.clone();
    match &value {
        None => {
            next.remove(key);
        }
        Some(value) => {
            next.insert(key.to_string(), value.clone());
        }
    }
    if let (Target::Preset(preset), "service", Some(Val::S(_))) = (target, key, &value) {
        let before = preset_service(preset, values.get("service")).default_model;
        let after = preset_service(preset, value.as_ref()).default_model;
        let moves = match values.get("model") {
            None => true,
            Some(Val::S(model)) => model == before,
            Some(Val::B(_)) => false,
        };
        if moves {
            next.insert("model".into(), Val::S(after.into()));
        }
    }
    next
}

// ---- ids and names ------------------------------------------------------------------------------

const INSTANCE_ID_MAX: usize = 64;
const ENVIRONMENT_NAME_MAX: usize = 128;

fn id_shape(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Why `id` cannot name a new instance, as a sentence; `None` when it can. `taken` holds every id
/// in use.
pub fn validate_instance_id(id: &str, taken: &HashSet<String>) -> Option<String> {
    if id.is_empty() {
        return Some(t("providers.spec.idRequired").into());
    }
    if id.chars().count() > INSTANCE_ID_MAX {
        return Some(tf(
            "providers.spec.idTooLong",
            &[("max", INSTANCE_ID_MAX.to_string())],
        ));
    }
    if !id_shape(id) {
        return Some(t("providers.spec.idShape").into());
    }
    if is_default_instance_id(id) {
        return Some(tf("providers.spec.idBuiltIn", &[("id", id.to_string())]));
    }
    if taken.contains(id) {
        return Some(tf("providers.cmd.idTaken", &[("id", id.to_string())]));
    }
    None
}

/// Whether `id` is shaped like an instance id; what is not is never repeated back in a complaint.
pub fn is_instance_id_shape(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= INSTANCE_ID_MAX && id_shape(id)
}

/// Why `name` cannot be the name of an environment variable; `None` when it can. The name is not
/// repeated: a value typed where a name belongs would otherwise be printed.
pub fn validate_environment_name(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some(t("providers.spec.envNameRequired").into());
    }
    if name.chars().count() > ENVIRONMENT_NAME_MAX {
        return Some(tf(
            "providers.spec.envNameTooLong",
            &[("max", ENVIRONMENT_NAME_MAX.to_string())],
        ));
    }
    let mut chars = name.chars();
    let shaped = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !shaped {
        return Some(t("providers.spec.envNameShape").into());
    }
    None
}

/// Parts of a name: split at every character that is not a letter or digit and where a lower-case
/// letter or digit meets a capital.
fn name_parts(name: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(name.len() + 4);
    let mut previous: Option<char> = None;
    for c in name.chars() {
        if c.is_ascii_uppercase()
            && previous.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit())
        {
            spaced.push('_');
        }
        spaced.push(c);
        previous = Some(c);
    }
    spaced
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_lowercase)
        .collect()
}

const SECRET_PARTS: [&str; 7] = [
    "auth",
    "authorization",
    "authentication",
    "pass",
    "passwd",
    "password",
    "passphrase",
];

/// A name that looks like it holds a credential, which belongs in `--secret`, not on the command
/// line. `key`, `token`, `secret`, `passw`, `pwd`, `bearer`, `cred`, `cookie` and `private` count
/// anywhere in the name (`PGPASSWORD` is a credential); `auth` and `pass` as a whole part or at
/// the end of the name (`BASICAUTH`, `SMTPPASS`), so `AUTHOR_NAME` and `BYPASS_CACHE` pass. Still
/// on the side of caution: a harmless name sent through `--secret` costs a flag, a missed
/// credential costs the credential.
pub fn looks_secret(name: &str) -> bool {
    let lower = name.to_lowercase();
    const ANYWHERE: [&str; 9] = [
        "key", "token", "secret", "passw", "pwd", "bearer", "cred", "cookie", "private",
    ];
    if ANYWHERE.iter().any(|word| lower.contains(word)) {
        return true;
    }
    if lower.ends_with("auth") {
        return true;
    }
    if let Some(before) = lower.strip_suffix("pass")
        && !before.ends_with("by")
        && !before.ends_with("com")
    {
        return true;
    }
    name_parts(name)
        .iter()
        .any(|part| SECRET_PARTS.contains(&part.as_str()))
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut gap = false;
    for c in value.trim().to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !slug.is_empty() {
                slug.push('_');
            }
            gap = false;
            slug.push(c);
        } else {
            gap = true;
        }
    }
    slug.chars()
        .take(48)
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

/// The id a name suggests, as the desktop app makes it (`codex_work`); a preset with no name
/// suggests its own id. Empty when there is nothing to make one from.
pub fn suggest_instance_id(target: Target, name: &str) -> String {
    let slug = slugify(name);
    match target {
        Target::Preset(preset) => {
            if slug.is_empty() {
                preset_info(preset).suggested_instance_id.to_string()
            } else {
                format!("opencode_{slug}")
            }
        }
        Target::Driver(index) => {
            if slug.is_empty() {
                String::new()
            } else {
                format!("{}_{slug}", DRIVERS[index].value)
            }
        }
    }
}

// ---- the draft and the instance it becomes ------------------------------------------------------

/// A variable the instance's process gets. A sensitive one is kept by the server in its secret
/// store.
#[derive(Debug, Clone, PartialEq)]
pub struct EnvEntry {
    pub name: String,
    pub value: String,
    pub sensitive: bool,
}

/// An instance as the user has filled it in so far. Secrets are in `values` and `env`; never print
/// it whole.
#[derive(Clone, PartialEq)]
pub struct AddDraft {
    pub target: Target,
    pub name: String,
    pub id: String,
    /// The id was typed by the user, so a change of name no longer changes it.
    pub id_touched: bool,
    pub values: Values,
    pub env: Vec<EnvEntry>,
}

// A draft holds secrets: even a debug print must not show them.
impl std::fmt::Debug for AddDraft {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AddDraft")
            .field("target", &self.target)
            .field("name", &self.name)
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

pub fn new_draft(target: Target) -> AddDraft {
    AddDraft {
        target,
        name: String::new(),
        id: suggest_instance_id(target, ""),
        id_touched: false,
        values: initial_values(target),
        env: Vec::new(),
    }
}

/// The draft with a new name; the id follows it until the user has typed an id of their own.
pub fn with_name(mut draft: AddDraft, name: &str) -> AddDraft {
    draft.name = name.to_string();
    if !draft.id_touched {
        draft.id = suggest_instance_id(draft.target, name);
    }
    draft
}

pub fn with_id(mut draft: AddDraft, id: &str) -> AddDraft {
    if id.is_empty() {
        draft.id = suggest_instance_id(draft.target, &draft.name);
        draft.id_touched = false;
    } else {
        draft.id = id.to_string();
        draft.id_touched = true;
    }
    draft
}

fn secret_of(draft: &AddDraft, key: &str) -> String {
    match draft.values.get(key) {
        Some(Val::S(value)) => value.trim().to_string(),
        _ => String::new(),
    }
}

/// What is still missing before the draft can be added, as a sentence; `None` when nothing is.
pub fn draft_problem(draft: &AddDraft, taken: &HashSet<String>) -> Option<String> {
    if let Some(problem) = validate_instance_id(&draft.id, taken) {
        return Some(problem);
    }
    target_fields(draft.target)
        .into_iter()
        .find(|field| field.required && secret_of(draft, field.key).is_empty())
        .map(|field| tf("providers.spec.fieldRequired", &[("label", field.label)]))
}

/// Every value in the draft that must not be printed: the password fields and the sensitive
/// variables.
pub fn draft_secrets(draft: &AddDraft) -> Vec<String> {
    target_fields(draft.target)
        .iter()
        .filter(|field| field.control == Control::Password)
        .map(|field| secret_of(draft, field.key))
        .chain(
            draft
                .env
                .iter()
                .filter(|entry| entry.sensitive)
                .map(|entry| entry.value.trim().to_string()),
        )
        .collect()
}

/// `text` with every secret in it replaced, for a message that came back from the server.
pub fn redact_secrets(text: &str, secrets: &[String]) -> String {
    let mut known: Vec<&String> = secrets.iter().filter(|s| s.chars().count() >= 3).collect();
    known.sort_by_key(|secret| std::cmp::Reverse(secret.chars().count()));
    known.into_iter().fold(text.to_string(), |out, secret| {
        out.replace(secret.as_str(), "****")
    })
}

// ---- an ordered JSON value ----------------------------------------------------------------------

/// JSON with the keys in the order they are written, so `--dry-run` prints the payload the way the
/// TypeScript command does (`serde_json` sorts keys).
#[derive(Debug, Clone, PartialEq)]
pub enum Jv {
    Str(String),
    Bool(bool),
    Arr(Vec<Jv>),
    Obj(Vec<(String, Jv)>),
}

impl Jv {
    pub fn s(text: impl Into<String>) -> Jv {
        Jv::Str(text.into())
    }

    pub fn obj(entries: Vec<(&str, Jv)>) -> Jv {
        Jv::Obj(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        )
    }

    #[cfg(test)]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Jv::Str(text) => Some(text),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Jv> {
        match self {
            Jv::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn to_value(&self) -> serde_json::Value {
        match self {
            Jv::Str(text) => serde_json::Value::String(text.clone()),
            Jv::Bool(flag) => serde_json::Value::Bool(*flag),
            Jv::Arr(items) => serde_json::Value::Array(items.iter().map(Jv::to_value).collect()),
            Jv::Obj(entries) => serde_json::Value::Object(
                entries
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_value()))
                    .collect(),
            ),
        }
    }

    /// `JSON.stringify(value, null, 2)`.
    pub fn pretty(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, 0);
        out
    }

    fn write(&self, out: &mut String, depth: usize) {
        let quote = |text: &str| serde_json::to_string(text).unwrap_or_default();
        let pad = |depth: usize| "  ".repeat(depth);
        match self {
            Jv::Str(text) => out.push_str(&quote(text)),
            Jv::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
            Jv::Arr(items) if items.is_empty() => out.push_str("[]"),
            Jv::Arr(items) => {
                out.push_str("[\n");
                for (index, item) in items.iter().enumerate() {
                    out.push_str(&pad(depth + 1));
                    item.write(out, depth + 1);
                    out.push_str(if index + 1 < items.len() { ",\n" } else { "\n" });
                }
                out.push_str(&pad(depth));
                out.push(']');
            }
            Jv::Obj(entries) if entries.is_empty() => out.push_str("{}"),
            Jv::Obj(entries) => {
                out.push_str("{\n");
                for (index, (key, value)) in entries.iter().enumerate() {
                    out.push_str(&pad(depth + 1));
                    out.push_str(&quote(key));
                    out.push_str(": ");
                    value.write(out, depth + 1);
                    out.push_str(if index + 1 < entries.len() {
                        ",\n"
                    } else {
                        "\n"
                    });
                }
                out.push_str(&pad(depth));
                out.push('}');
            }
        }
    }
}

fn env_entry_json(entry: &EnvEntry) -> Jv {
    Jv::obj(vec![
        ("name", Jv::s(&entry.name)),
        ("value", Jv::s(&entry.value)),
        ("sensitive", Jv::Bool(entry.sensitive)),
    ])
}

/// The instance the draft describes, the way the desktop app's wizard builds it: a driver instance
/// carries the fields that were changed from their defaults, a preset is made like
/// `createPresetProviderInstance`. The message of the failure is the builder's, in English.
pub fn build_instance(draft: &AddDraft) -> Result<Jv, String> {
    let name = draft.name.trim();
    let extra: Vec<Jv> = draft.env.iter().map(env_entry_json).collect();
    match draft.target {
        Target::Preset(preset) => build_preset(draft, preset, name, extra),
        Target::Driver(index) => {
            let driver = &DRIVERS[index];
            let mut config: Vec<(String, Jv)> = Vec::new();
            for field in driver_fields(driver) {
                match draft.values.get(field.key) {
                    None => {}
                    Some(Val::B(value)) => {
                        if *value != field.default_bool {
                            config.push((field.key.to_string(), Jv::Bool(*value)));
                        }
                    }
                    Some(Val::S(value)) if !value.trim().is_empty() => {
                        config.push((field.key.to_string(), Jv::s(value.trim())));
                    }
                    Some(Val::S(_)) => {}
                }
            }
            // A new Codex instance uses the Codex that is already installed; the desktop app's
            // wizard does too.
            if driver.value == "codex" {
                config.push(("setupMode".into(), Jv::s("existing")));
            }
            let mut entries = vec![
                ("driver".to_string(), Jv::s(driver.value)),
                ("enabled".to_string(), Jv::Bool(true)),
            ];
            if !name.is_empty() {
                entries.push(("displayName".into(), Jv::s(name)));
            }
            if !config.is_empty() {
                entries.push(("config".into(), Jv::Obj(config)));
            }
            if !extra.is_empty() {
                entries.push(("environment".into(), Jv::Arr(extra)));
            }
            Ok(Jv::Obj(entries))
        }
    }
}

fn build_preset(
    draft: &AddDraft,
    preset: Preset,
    name: &str,
    extra: Vec<Jv>,
) -> Result<Jv, String> {
    let info = preset_info(preset);
    let text = |key: &str| match draft.values.get(key) {
        Some(Val::S(value)) => value.trim().to_string(),
        _ => String::new(),
    };
    let service = match draft.values.get("service") {
        Some(Val::S(value)) if value == "api" || value == "coding" => value.as_str(),
        _ => info.default_service,
    };
    let service = info
        .services
        .iter()
        .find(|candidate| candidate.value == service)
        .ok_or_else(|| format!("Unsupported {} service: {service}", info.label))?;
    let api_key = secret_of(draft, "apiKey");
    if api_key.is_empty() {
        return Err(format!("{} API key is required.", info.label));
    }
    let chosen = {
        let model = text("model");
        if model.is_empty() {
            service.default_model.to_string()
        } else {
            model
        }
    };
    let prefix = format!("{}/", service.provider_id);
    let model = chosen.strip_prefix(&prefix).unwrap_or(&chosen).to_string();
    if model.is_empty()
        || model.contains('/')
        || model.chars().any(|c| (c as u32) < 32 || c as u32 == 127)
    {
        return Err(format!(
            "Model must be a valid {} model ID.",
            service.provider_id
        ));
    }
    let slug = format!("{}/{model}", service.provider_id);
    let quote = |text: &str| serde_json::to_string(text).unwrap_or_default();
    // The credential is a sensitive instance environment value; OpenCode sees only a reference to
    // it in its config, so it cannot select a global account.
    let config_content = format!(
        "{{\"enabled_providers\":[{}],\"model\":{},\"small_model\":{},\"provider\":{{{}:{{\"options\":{{\"baseURL\":{},\"apiKey\":{}}}}}}}}}",
        quote(service.provider_id),
        quote(&slug),
        quote(&slug),
        quote(service.provider_id),
        quote(service.base_url),
        quote(&format!("{{env:{}}}", info.api_key_environment_variable)),
    );
    let binary_path = {
        let path = text("binaryPath");
        if path.is_empty() {
            "opencode".to_string()
        } else {
            path
        }
    };
    let made = [
        EnvEntry {
            name: info.api_key_environment_variable.into(),
            value: api_key,
            sensitive: true,
        },
        EnvEntry {
            name: "OPENCODE_CONFIG_CONTENT".into(),
            value: config_content,
            sensitive: false,
        },
        EnvEntry {
            name: "T3CODE_OPENCODE_PROVIDER_ID".into(),
            value: service.provider_id.into(),
            sensitive: false,
        },
    ];
    if let Some(clash) = draft
        .env
        .iter()
        .find(|entry| made.iter().any(|set| set.name == entry.name))
    {
        return Err(tf(
            "providers.spec.presetFixes",
            &[("name", clash.name.clone())],
        ));
    }
    let mut environment: Vec<Jv> = made.iter().map(env_entry_json).collect();
    environment.extend(extra);
    Ok(Jv::obj(vec![
        ("driver", Jv::s("opencode")),
        (
            "displayName",
            Jv::s(if name.is_empty() { info.label } else { name }),
        ),
        ("enabled", Jv::Bool(true)),
        (
            "config",
            Jv::obj(vec![
                ("enabled", Jv::Bool(true)),
                ("binaryPath", Jv::s(binary_path)),
                ("serverUrl", Jv::s("")),
                ("customModels", Jv::Arr(vec![Jv::s(slug)])),
            ]),
        ),
        ("environment", Jv::Arr(environment)),
    ]))
}

// ---- showing it ---------------------------------------------------------------------------------

/// Word for a value that is set but not shown.
pub fn secret_set() -> &'static str {
    t("providers.spec.secretSet")
}

const SHOWN_LIMIT: usize = 60;

fn shown(value: &str) -> String {
    let one = one_line(value);
    if one.chars().count() > SHOWN_LIMIT {
        format!("{}…", one.chars().take(SHOWN_LIMIT - 1).collect::<String>())
    } else {
        one
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SummaryRow {
    pub label: String,
    pub value: String,
}

/// What adding the draft would write, as rows safe to print: a secret is said to be set and
/// nothing more, and the generated OpenCode config of a preset is not spelled out.
pub fn summarize(draft: &AddDraft) -> Vec<SummaryRow> {
    let target = draft.target;
    let row = |label: String, value: String| SummaryRow { label, value };
    let mut rows = vec![
        row("ID".into(), shown(&draft.id)),
        row(
            t("providers.cmd.colName").into(),
            if draft.name.trim().is_empty() {
                tf(
                    "providers.spec.defaultName",
                    &[("name", target_label(target).to_string())],
                )
            } else {
                shown(&draft.name)
            },
        ),
        row(
            t("providers.cmd.colKind").into(),
            target_label(target).into(),
        ),
    ];
    for field in target_fields(target) {
        let Some(value) = draft.values.get(field.key) else {
            continue;
        };
        if field.control == Control::Password {
            if !secret_of(draft, field.key).is_empty() {
                rows.push(row(field.label, secret_set().into()));
            }
        } else if let Val::B(flag) = value {
            let word = if *flag {
                "providers.cmd.on"
            } else {
                "providers.cmd.off"
            };
            rows.push(row(field.label, t(word).into()));
        } else if let Val::S(text) = value
            && !text.trim().is_empty()
        {
            let label = field
                .options
                .iter()
                .find(|(option, _)| option == text)
                .map_or(text.as_str(), |(_, label)| label.as_str());
            rows.push(row(field.label.clone(), shown(label)));
        }
    }
    for entry in &draft.env {
        rows.push(row(
            tf("providers.spec.envLabel", &[("name", entry.name.clone())]),
            if entry.sensitive {
                secret_set().into()
            } else {
                shown(&entry.value)
            },
        ));
    }
    rows
}

/// A line for what the user still has to do by hand once the instance exists, or `None`.
pub fn after_add_advice(draft: &AddDraft) -> Option<String> {
    match draft.target {
        Target::Preset(preset) => Some(tf(
            "providers.spec.adviceOpenCode",
            &[("label", preset_info(preset).label.to_string())],
        )),
        Target::Driver(index) => {
            let driver = DRIVERS[index].value;
            let method = draft.values.get("authMethod");
            let oauth = match method {
                None => true,
                Some(Val::S(value)) => value.starts_with("oauth"),
                Some(Val::B(_)) => false,
            };
            if driver == "antigravity" && oauth {
                Some(t("providers.spec.adviceGoogle").into())
            } else if driver == "codex" || driver == "claudeAgent" {
                Some(t("providers.spec.adviceLogin").into())
            } else {
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-value-1234";

    fn english() {
        crate::i18n::init(Some("en"));
    }

    fn target(word: &str) -> Target {
        parse_target(word).unwrap_or_else(|| panic!("no target {word}"))
    }

    fn none() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn names_every_driver_of_the_desktop_app_and_both_presets() {
        let values: Vec<&str> = DRIVERS.iter().map(|d| d.value).collect();
        assert_eq!(
            values,
            [
                "codex",
                "claudeAgent",
                "cursor",
                "grok",
                "opencode",
                "antigravity",
                "minimax",
                "zcode"
            ]
        );
        assert_eq!(targets().len(), 10);
    }

    #[test]
    fn reads_a_driver_in_any_case_claude_as_claude_agent_and_a_preset_with_or_without_its_prefix() {
        assert_eq!(target("CODEX"), Target::Driver(0));
        assert_eq!(target("claude"), Target::Driver(1));
        assert_eq!(target("claudeagent"), Target::Driver(1));
        assert_eq!(target("zai"), Target::Preset(Preset::Zai));
        assert_eq!(target("preset:zai"), Target::Preset(Preset::Zai));
        assert_eq!(target("preset:minimax"), Target::Preset(Preset::Minimax));
        assert_eq!(parse_target("nope"), None);
        assert_eq!(parse_target(""), None);
    }

    #[test]
    fn keeps_the_minimax_code_driver_and_the_minimax_preset_apart() {
        assert_eq!(target_driver(target("minimax")), "minimax");
        assert!(matches!(target("preset:minimax"), Target::Preset(_)));
    }

    #[test]
    fn target_words_list_everything_parse_target_takes() {
        assert_eq!(
            target_words(),
            "codex | claudeAgent | cursor | grok | opencode | antigravity | minimax | zcode | zai | preset:minimax"
        );
    }

    #[test]
    fn the_fields_of_a_driver_follow_the_desktop_app_form() {
        english();
        let keys = |word: &str| -> Vec<&'static str> {
            target_fields(target(word)).iter().map(|f| f.key).collect()
        };
        assert_eq!(
            keys("codex"),
            [
                "binaryPath",
                "homePath",
                "shadowHomePath",
                "launchArgs",
                "telemetry"
            ]
        );
        assert_eq!(
            keys("opencode"),
            ["binaryPath", "serverUrl", "serverPassword"]
        );
        assert!(keys("antigravity").contains(&"apiKey"));
        assert_eq!(keys("antigravity")[0], "authMethod");
        let control = |word: &str, key: &str| {
            target_fields(target(word))
                .into_iter()
                .find(|f| f.key == key)
                .unwrap()
        };
        assert_eq!(
            control("opencode", "serverPassword").control,
            Control::Password
        );
        assert_eq!(control("antigravity", "apiKey").control, Control::Password);
        let telemetry = control("claude", "telemetry");
        assert_eq!(telemetry.control, Control::Switch);
        assert!(telemetry.default_bool);
        assert_eq!(control("codex", "binaryPath").label, "Executable path");
    }

    #[test]
    fn validating_an_id() {
        english();
        assert_eq!(validate_instance_id("codex_work", &none()), None);
        assert!(
            validate_instance_id("", &none())
                .unwrap()
                .contains("required")
        );
        assert!(
            validate_instance_id("1abc", &none())
                .unwrap()
                .contains("start with a letter")
        );
        assert!(
            validate_instance_id("a b", &none())
                .unwrap()
                .contains("start with a letter")
        );
        assert!(
            validate_instance_id(&"a".repeat(65), &none())
                .unwrap()
                .contains("64")
        );
        assert_eq!(validate_instance_id(&"a".repeat(64), &none()), None);
        let taken: HashSet<String> = ["work".to_string()].into();
        assert!(
            validate_instance_id("work", &taken)
                .unwrap()
                .contains("already taken")
        );
    }

    #[test]
    fn an_id_of_a_built_in_instance_is_refused() {
        english();
        for driver in DRIVERS {
            assert!(
                validate_instance_id(driver.value, &none())
                    .unwrap()
                    .contains("built-in"),
                "{}",
                driver.value
            );
            assert!(is_default_instance_id(driver.value));
        }
        assert!(!is_default_instance_id("codex_work"));
    }

    #[test]
    fn environment_names_follow_the_contracts_pattern_and_length() {
        english();
        assert_eq!(validate_environment_name("MY_VAR_1"), None);
        assert_eq!(validate_environment_name("_x"), None);
        assert!(
            validate_environment_name("1X")
                .unwrap()
                .contains("start with a letter or '_'")
        );
        assert!(
            validate_environment_name("A-B")
                .unwrap()
                .contains("start with a letter or '_'")
        );
        assert!(validate_environment_name("").unwrap().contains("required"));
        assert!(
            validate_environment_name(&"A".repeat(129))
                .unwrap()
                .contains("128")
        );
    }

    #[test]
    fn a_name_that_holds_a_credential_is_flagged() {
        for name in [
            "API_KEY",
            "github_token",
            "DB_PASSWORD",
            "MY_SECRET",
            "AWS_CREDENTIALS",
            "DB_PASS",
            "MYSQL_PASSWD",
            "DB_PWD",
            "PROXY_AUTH",
            "AUTHORIZATION",
            "BEARER",
            "HTTP_CRED",
            "SESSION_COOKIE",
            "PRIVATE_KEY_PATH",
        ] {
            assert!(looks_secret(name), "{name}");
        }
        assert!(!looks_secret("LOG_LEVEL"));
    }

    #[test]
    fn auth_and_pass_count_as_whole_parts_not_as_the_start_of_another_word() {
        for name in [
            "AUTHOR_NAME",
            "GIT_AUTHOR_EMAIL",
            "authorName",
            "BYPASS_CACHE",
            "COMPASS_DIR",
            "PASSENGER_COUNT",
        ] {
            assert!(!looks_secret(name), "{name}");
        }
        for name in [
            "AUTH",
            "AUTH_URL",
            "proxyAuth",
            "http-auth",
            "MY_PASS",
            "userPassword",
            "APIKEY",
            "PGPASSWORD",
            "MYSQLPASSWORD",
            "SMTPPASS",
            "BASICAUTH",
            "HTTPAUTH",
        ] {
            assert!(looks_secret(name), "{name}");
        }
    }

    #[test]
    fn the_id_follows_the_name_until_the_user_types_one() {
        let mut draft = new_draft(target("codex"));
        assert_eq!(draft.id, "");
        draft = with_name(draft, "Work Account");
        assert_eq!(draft.id, "codex_work_account");
        draft = with_id(draft, "mine");
        draft = with_name(draft, "Other");
        assert_eq!(draft.id, "mine");
        draft = with_id(draft, "");
        assert_eq!(draft.id, "codex_other");
    }

    #[test]
    fn a_preset_suggests_its_own_id_and_a_driver_nothing() {
        assert_eq!(suggest_instance_id(target("zai"), ""), "opencode_zai");
        assert_eq!(suggest_instance_id(target("codex"), ""), "");
        assert_eq!(suggest_instance_id(target("codex"), "  한글  "), "");
        assert_eq!(suggest_instance_id(target("codex"), "a--b"), "codex_a_b");
        assert_eq!(
            suggest_instance_id(target("codex"), &"x".repeat(80)),
            format!("codex_{}", "x".repeat(48))
        );
    }

    #[test]
    fn a_preset_starts_on_its_default_service_and_moves_the_model_with_the_service() {
        let minimax = target("preset:minimax");
        let values = initial_values(minimax);
        assert_eq!(values.get("service"), Some(&Val::S("api".into())));
        assert_eq!(values.get("model"), Some(&Val::S("MiniMax-M3".into())));
        let moved = with_value(minimax, &values, "service", Some(Val::S("coding".into())));
        assert_eq!(moved.get("service"), Some(&Val::S("coding".into())));
        assert_eq!(
            moved.get("model"),
            Some(&Val::S("MiniMax-M3.1-Flash".into()))
        );
        // A model the user typed stays when the service changes.
        let mut typed = values.clone();
        typed.insert("model".into(), Val::S("my-model".into()));
        let kept = with_value(minimax, &typed, "service", Some(Val::S("coding".into())));
        assert_eq!(kept.get("model"), Some(&Val::S("my-model".into())));
    }

    #[test]
    fn a_preset_needs_an_api_key_before_it_can_be_added() {
        english();
        let draft = with_id(new_draft(target("zai")), "opencode_zai");
        assert!(draft_problem(&draft, &none()).unwrap().contains("API key"));
        let mut filled = draft.clone();
        filled.values = with_value(
            draft.target,
            &draft.values,
            "apiKey",
            Some(Val::S(SECRET.into())),
        );
        assert_eq!(draft_problem(&filled, &none()), None);
    }

    #[test]
    fn a_driver_instance_carries_only_what_was_changed() {
        let draft = with_name(new_draft(target("codex")), "Work");
        assert_eq!(
            build_instance(&draft).unwrap().to_value(),
            serde_json::json!({
                "driver": "codex", "enabled": true, "displayName": "Work",
                "config": {"setupMode": "existing"}
            })
        );
        let mut custom = draft.clone();
        custom.values = Values::from([
            ("binaryPath".to_string(), Val::S(" /opt/codex ".into())),
            ("homePath".to_string(), Val::S("".into())),
            ("telemetry".to_string(), Val::B(true)),
        ]);
        assert_eq!(
            build_instance(&custom)
                .unwrap()
                .get("config")
                .unwrap()
                .to_value(),
            serde_json::json!({"binaryPath": "/opt/codex", "telemetry": true, "setupMode": "existing"})
        );
    }

    #[test]
    fn a_switch_left_at_its_default_is_left_out() {
        let mut draft = new_draft(target("claude"));
        draft.values = Values::from([("telemetry".to_string(), Val::B(true))]);
        assert!(build_instance(&draft).unwrap().get("config").is_none());
    }

    fn preset_draft() -> AddDraft {
        let mut draft = with_id(new_draft(target("zai")), "opencode_zai");
        draft.values = Values::from([
            ("service".to_string(), Val::S("api".into())),
            ("model".to_string(), Val::S("glm-5.3".into())),
            ("apiKey".to_string(), Val::S(SECRET.into())),
        ]);
        draft
    }

    #[test]
    fn a_preset_instance_keeps_the_key_as_a_sensitive_variable_not_in_the_config() {
        let instance = build_instance(&preset_draft()).unwrap();
        assert_eq!(instance.get("driver").unwrap().as_str(), Some("opencode"));
        let Some(Jv::Arr(environment)) = instance.get("environment") else {
            panic!("no environment");
        };
        let sensitive = environment
            .iter()
            .find(|e| e.get("sensitive") == Some(&Jv::Bool(true)))
            .unwrap();
        assert_eq!(
            sensitive.get("name").unwrap().as_str(),
            Some("OOP_ZAI_API_KEY")
        );
        assert_eq!(sensitive.get("value").unwrap().as_str(), Some(SECRET));
        assert!(!instance.get("config").unwrap().pretty().contains(SECRET));
        let content = environment
            .iter()
            .find(|e| e.get("name").unwrap().as_str() == Some("OPENCODE_CONFIG_CONTENT"))
            .unwrap();
        let text = content.get("value").unwrap().as_str().unwrap();
        assert!(!text.contains(SECRET));
        let parsed: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["model"], "zai/glm-5.3");
        assert_eq!(
            parsed["provider"]["zai"]["options"]["apiKey"],
            "{env:OOP_ZAI_API_KEY}"
        );
        assert_eq!(
            instance.get("config").unwrap().to_value(),
            serde_json::json!({
                "enabled": true, "binaryPath": "opencode", "serverUrl": "",
                "customModels": ["zai/glm-5.3"]
            })
        );
    }

    #[test]
    fn the_name_given_for_a_preset_is_used_and_extra_variables_follow() {
        let mut draft = with_id(with_name(preset_draft(), "Mine"), "opencode_mine");
        draft.env = vec![EnvEntry {
            name: "LOG_LEVEL".into(),
            value: "debug".into(),
            sensitive: false,
        }];
        let instance = build_instance(&draft).unwrap();
        assert_eq!(instance.get("displayName").unwrap().as_str(), Some("Mine"));
        let Some(Jv::Arr(environment)) = instance.get("environment") else {
            panic!("no environment");
        };
        assert_eq!(
            environment.last().unwrap().to_value(),
            serde_json::json!({"name": "LOG_LEVEL", "value": "debug", "sensitive": false})
        );
    }

    #[test]
    fn a_variable_the_preset_already_sets_is_refused() {
        english();
        let mut draft = preset_draft();
        draft.env = vec![EnvEntry {
            name: "OOP_ZAI_API_KEY".into(),
            value: "x".into(),
            sensitive: true,
        }];
        assert!(
            build_instance(&draft)
                .unwrap_err()
                .contains("OOP_ZAI_API_KEY")
        );
    }

    #[test]
    fn a_preset_model_must_be_a_plain_model_id() {
        let mut draft = preset_draft();
        draft
            .values
            .insert("model".into(), Val::S("zai/glm-5".into()));
        let instance = build_instance(&draft).unwrap();
        assert_eq!(
            instance
                .get("config")
                .unwrap()
                .get("customModels")
                .unwrap()
                .to_value(),
            serde_json::json!(["zai/glm-5"])
        );
        draft.values.insert("model".into(), Val::S("a/b".into()));
        assert!(
            build_instance(&draft)
                .unwrap_err()
                .contains("valid zai model ID")
        );
    }

    fn shown_draft() -> AddDraft {
        let mut draft = preset_draft();
        draft.env = vec![
            EnvEntry {
                name: "LOG_LEVEL".into(),
                value: "debug".into(),
                sensitive: false,
            },
            EnvEntry {
                name: "EXTRA".into(),
                value: format!("{SECRET}-env"),
                sensitive: true,
            },
        ];
        draft
    }

    #[test]
    fn a_summary_says_a_secret_is_set_and_never_what_it_is() {
        english();
        let rows = summarize(&shown_draft());
        let everything = format!("{rows:?}");
        assert!(!everything.contains(SECRET));
        let value = |label: &str| {
            rows.iter()
                .find(|r| r.label == label)
                .unwrap()
                .value
                .clone()
        };
        assert!(value("API key").contains("set (masked)"));
        assert!(value("Environment variable EXTRA").contains("set (masked)"));
        assert_eq!(value("Environment variable LOG_LEVEL"), "debug");
        assert_eq!(value("Service"), "API");
    }

    #[test]
    fn the_secrets_to_hide_are_listed_for_redacting() {
        let secrets: Vec<String> = draft_secrets(&shown_draft())
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect();
        assert_eq!(secrets, [SECRET.to_string(), format!("{SECRET}-env")]);
    }

    #[test]
    fn redacting_takes_the_longest_secret_first_and_ignores_one_too_short() {
        let secrets = [SECRET.to_string(), format!("{SECRET}-env")];
        assert_eq!(
            redact_secrets(&format!("bad {SECRET}-env and {SECRET}"), &secrets),
            "bad **** and ****"
        );
        assert_eq!(
            redact_secrets("ab is fine", &["ab".to_string()]),
            "ab is fine"
        );
    }

    #[test]
    fn advice_points_to_the_app_for_a_login_that_needs_a_browser() {
        english();
        assert!(
            after_add_advice(&new_draft(target("antigravity")))
                .unwrap()
                .contains("Settings > Providers")
        );
        assert!(
            after_add_advice(&new_draft(target("zai")))
                .unwrap()
                .contains("OpenCode 1.14.19")
        );
        assert_eq!(after_add_advice(&new_draft(target("grok"))), None);
        let mut keyed = new_draft(target("antigravity"));
        keyed
            .values
            .insert("authMethod".into(), Val::S("gemini-api-key".into()));
        assert_eq!(after_add_advice(&keyed), None);
    }

    #[test]
    fn untrusted_text_loses_escapes_and_controls() {
        assert_eq!(
            sanitize_terminal("a\u{1b}[31mred\u{1b}[0m b\u{7}c"),
            "ared bc"
        );
        assert_eq!(sanitize_terminal("x\u{1b}]0;title\u{7}y"), "xy");
        assert_eq!(sanitize_terminal("a\r\nb\rc\td"), "a\nb\nc  d");
        assert_eq!(one_line(" a \n b\t c "), "a b c");
    }

    #[test]
    fn the_dry_run_json_keeps_the_key_order_and_the_stringify_layout() {
        let value = Jv::obj(vec![
            ("b", Jv::Arr(vec![])),
            (
                "a",
                Jv::obj(vec![("x", Jv::Bool(true)), ("y", Jv::s("q\"z"))]),
            ),
            ("c", Jv::Arr(vec![Jv::s("1")])),
        ]);
        assert_eq!(
            value.pretty(),
            "{\n  \"b\": [],\n  \"a\": {\n    \"x\": true,\n    \"y\": \"q\\\"z\"\n  },\n  \"c\": [\n    \"1\"\n  ]\n}"
        );
    }
}
