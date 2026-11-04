//! Words to a request: ported from the former TypeScript terminal's provider arguments. The shell command and the
//! slash command both go through `resolve_request`, so they agree. A secret is only ever taken by
//! reference (`@ENV_VAR` or `-` for standard input); a literal is refused without being repeated.

use crate::provider_spec::{
    AddDraft, Control, EnvEntry, Target, Val, looks_secret, new_draft, parse_target,
    sanitize_terminal, target_fields, target_words, validate_environment_name, with_id, with_name,
    with_value,
};
use crate::provider_text::{t, tf};
use std::collections::HashMap;

const NAME_LIMIT: usize = 24;

/// The name in a word of the user's, to quote back in a complaint; `None` when the word does not
/// look like a name (too long, odd characters), so its content is not repeated. What follows `=`
/// is dropped: a mistyped option (`--api-key=<key>`) or a key typed where a word belongs would
/// otherwise be printed, and the chat keeps what is printed.
pub fn echo_word(word: &str) -> Option<String> {
    let clean = sanitize_terminal(word);
    let name = clean.split('=').next().unwrap_or("");
    let mut chars = name.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '-');
    let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'));
    // A run of digits is the body of a key more often than part of a name.
    let digits = name
        .as_bytes()
        .windows(3)
        .any(|w| w.iter().all(u8::is_ascii_digit));
    (name.chars().count() <= NAME_LIMIT && first_ok && rest_ok && !digits).then(|| name.to_string())
}

/// `Unknown <what>: <name>`, or, when the word is not shaped like a name, that its form is wrong.
fn unknown_word(what: &str, word: &str) -> String {
    match echo_word(word) {
        None => tf("providers.args.badForm", &[("what", what.to_string())]),
        Some(name) => tf(
            "providers.args.unknownWord",
            &[("what", what.to_string()), ("name", name)],
        ),
    }
}

/// Where the words came from: the shell command line, or the chat's slash command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Cli,
    Slash,
}

const VALUE_FLAGS: [&str; 5] = ["--id", "--name", "--set", "--env", "--secret"];
const SWITCH_FLAGS: [&str; 2] = ["--yes", "--dry-run"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawFlag {
    pub name: String,
    pub value: Option<String>,
}

/// Where a secret comes from when it must stay off the command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretRef {
    Env(String),
    Stdin,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AddOptions {
    pub id: Option<String>,
    pub name: Option<String>,
    pub sets: Vec<(String, String)>,
    pub env: Vec<(String, String)>,
    pub secrets: Vec<(String, SecretRef)>,
    pub yes: bool,
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderRequest {
    List,
    Add {
        target: Option<Target>,
        options: AddOptions,
    },
    Remove {
        id: Option<String>,
        yes: bool,
        dry_run: bool,
    },
}

fn secret_hint() -> &'static str {
    t("providers.args.secretHint")
}

/// `@NAME` reads the environment, `-` reads standard input; anything else is not a reference.
pub fn parse_secret_ref(text: &str) -> Option<SecretRef> {
    if text == "-" {
        return Some(SecretRef::Stdin);
    }
    let name = text.strip_prefix('@')?;
    validate_environment_name(name)
        .is_none()
        .then(|| SecretRef::Env(name.to_string()))
}

// ---- splitting a slash command's text into words ------------------------------------------------

/// Words of `text`, with single or double quotes keeping spaces inside a word.
pub fn split_words(text: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    for c in text.chars() {
        if let Some(open) = quote {
            if c == open {
                quote = None;
            } else {
                current.push(c);
            }
        } else if c == '"' || c == '\'' {
            quote = Some(c);
            started = true;
        } else if c.is_whitespace() {
            if started {
                words.push(std::mem::take(&mut current));
            }
            started = false;
        } else {
            current.push(c);
            started = true;
        }
    }
    if quote.is_some() {
        return Err(t("providers.args.unclosedQuote").into());
    }
    if started {
        words.push(current);
    }
    Ok(words)
}

/// Splits `words` into positional words and provider flags.
pub fn collect_flags(words: &[String]) -> Result<(Vec<String>, Vec<RawFlag>), String> {
    let mut positional = Vec::new();
    let mut flags = Vec::new();
    let mut index = 0;
    while index < words.len() {
        let word = &words[index];
        let equals = if word.starts_with("--") {
            word.find('=')
        } else {
            None
        };
        let raw = equals.map_or(word.as_str(), |at| &word[..at]);
        let name = if raw == "-y" { "--yes" } else { raw };
        if SWITCH_FLAGS.contains(&name) {
            if equals.is_some() {
                return Err(tf("providers.args.noValue", &[("name", name.to_string())]));
            }
            flags.push(RawFlag {
                name: name.to_string(),
                value: None,
            });
        } else if VALUE_FLAGS.contains(&name) {
            let value = match equals {
                Some(at) => word[at + 1..].to_string(),
                None => match words.get(index + 1) {
                    Some(next) if !next.starts_with('-') => {
                        index += 1;
                        next.clone()
                    }
                    _ => {
                        return Err(tf(
                            "providers.args.needsValue",
                            &[("name", name.to_string())],
                        ));
                    }
                },
            };
            flags.push(RawFlag {
                name: name.to_string(),
                value: Some(value),
            });
        } else if word.starts_with('-') && word.chars().count() > 1 {
            return Err(unknown_word(t("providers.args.whatOption"), word));
        } else {
            positional.push(word.clone());
        }
        index += 1;
    }
    Ok((positional, flags))
}

// ---- turning words into a request ---------------------------------------------------------------

fn usage(origin: Origin) -> String {
    t(if origin == Origin::Cli {
        "providers.args.usageCli"
    } else {
        "providers.args.usageSlash"
    })
    .into()
}

fn split_assignment(flag: &str, text: &str, shape: &str) -> Result<(String, String), String> {
    match text.find('=') {
        Some(at) if at > 0 => Ok((text[..at].to_string(), text[at + 1..].to_string())),
        _ => Err(tf(
            "providers.args.shape",
            &[("flag", flag.to_string()), ("shape", shape.to_string())],
        )),
    }
}

fn read_add_options(flags: &[RawFlag], origin: Origin) -> Result<AddOptions, String> {
    let mut options = AddOptions::default();
    for flag in flags {
        let value = flag.value.clone().unwrap_or_default();
        match flag.name.as_str() {
            "--id" => options.id = Some(value.trim().to_string()),
            "--name" => options.name = Some(value),
            "--yes" => {
                if origin == Origin::Slash {
                    return Err(t("providers.args.slashYesAdd").into());
                }
                options.yes = true;
            }
            "--dry-run" => options.dry_run = true,
            "--set" => {
                options.sets.push(split_assignment(
                    "--set",
                    &value,
                    t("providers.args.shapeKeyValue"),
                )?);
            }
            "--env" => {
                options.env.push(split_assignment(
                    "--env",
                    &value,
                    t("providers.args.shapeNameValue"),
                )?);
            }
            "--secret" => {
                if origin == Origin::Slash {
                    return Err(t("providers.args.slashNoSecret").into());
                }
                let (name, text) =
                    split_assignment("--secret", &value, t("providers.args.shapeSecret"))?;
                let Some(reference) = parse_secret_ref(&text) else {
                    return Err(format!(
                        "--secret {}: {}",
                        echo_word(&name).unwrap_or_else(|| "…".into()),
                        secret_hint()
                    ));
                };
                options.secrets.push((name, reference));
            }
            _ => {}
        }
    }
    Ok(options)
}

/// Reads `provider <verb> ...` into a request. `words` start after `provider`: the verb is
/// the first word, and a missing verb means `list`. `rest` here is the whole list of positional
/// words, verb included.
pub fn resolve_request(
    rest: &[String],
    flags: &[RawFlag],
    origin: Origin,
) -> Result<ProviderRequest, String> {
    let verb = rest.first().map_or("list", String::as_str);
    let args = rest.get(1..).unwrap_or(&[]);
    match verb {
        "list" => {
            if !args.is_empty() || !flags.is_empty() {
                return Err(usage(origin));
            }
            Ok(ProviderRequest::List)
        }
        "add" => {
            if args.len() > 1 {
                return Err(usage(origin));
            }
            let target = match args.first() {
                None => None,
                Some(word) => Some(parse_target(word).ok_or_else(|| {
                    format!(
                        "{} ({})",
                        unknown_word(t("providers.args.whatKind"), word),
                        target_words()
                    )
                })?),
            };
            let options = read_add_options(flags, origin)?;
            let given = flags
                .iter()
                .any(|f| f.name != "--dry-run" && f.name != "--yes");
            if target.is_none() && (given || options.dry_run || options.yes) {
                return Err(tf(
                    "providers.args.kindRequired",
                    &[("kinds", target_words())],
                ));
            }
            Ok(ProviderRequest::Add { target, options })
        }
        "remove" => {
            if args.len() > 1 || (args.is_empty() && origin == Origin::Cli) {
                return Err(usage(origin));
            }
            let (mut yes, mut dry_run) = (false, false);
            for flag in flags {
                match flag.name.as_str() {
                    "--yes" => {
                        if origin == Origin::Slash {
                            return Err(t("providers.args.slashYesRemove").into());
                        }
                        yes = true;
                    }
                    "--dry-run" => dry_run = true,
                    _ => return Err(usage(origin)),
                }
            }
            Ok(ProviderRequest::Remove {
                id: args.first().cloned(),
                yes,
                dry_run,
            })
        }
        _ => Err(format!(
            "{}. {}",
            unknown_word(t("providers.args.whatSubcommand"), verb),
            usage(origin)
        )),
    }
}

/// The slash command's text after `/provider`, as a request.
pub fn parse_provider_slash(text: &str) -> Result<ProviderRequest, String> {
    let words = split_words(text)?;
    let (positional, flags) = collect_flags(&words)?;
    resolve_request(&positional, &flags, Origin::Slash)
}

// ---- filling in a draft from the options --------------------------------------------------------

pub struct SecretInput {
    /// False where a secret cannot be named by reference (the chat), so it must be typed in.
    pub refs: bool,
    pub env: HashMap<String, String>,
    /// Everything read from standard input, or `None` when none was read.
    pub stdin: Option<String>,
}

/// True when the options name standard input as a secret's source, so the caller must read it
/// first.
pub fn wants_stdin(target: Target, options: &AddOptions) -> bool {
    let passwords: Vec<&str> = target_fields(target)
        .iter()
        .filter(|field| field.control == Control::Password)
        .map(|field| field.key)
        .collect();
    options
        .secrets
        .iter()
        .any(|(_, reference)| *reference == SecretRef::Stdin)
        || options
            .sets
            .iter()
            .any(|(key, value)| passwords.contains(&key.as_str()) && value == "-")
}

const BOOLEAN_WORDS: [(&str, bool); 8] = [
    ("true", true),
    ("on", true),
    ("yes", true),
    ("1", true),
    ("false", false),
    ("off", false),
    ("no", false),
    ("0", false),
];

struct Reader<'a> {
    input: &'a SecretInput,
    stdin_used: bool,
}

impl Reader<'_> {
    fn read(&mut self, label: &str, reference: &SecretRef) -> Result<String, String> {
        let text = match reference {
            SecretRef::Env(variable) => self
                .input
                .env
                .get(variable)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    tf(
                        "providers.args.envEmpty",
                        &[("label", label.to_string()), ("variable", variable.clone())],
                    )
                })?,
            SecretRef::Stdin => {
                if self.stdin_used {
                    return Err(t("providers.args.stdinOnce").into());
                }
                self.stdin_used = true;
                let raw = self.input.stdin.as_deref().unwrap_or("");
                let raw = raw.strip_suffix('\n').unwrap_or(raw);
                let raw = raw.strip_suffix('\r').unwrap_or(raw);
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return Err(tf(
                        "providers.args.stdinEmpty",
                        &[("label", label.to_string())],
                    ));
                }
                trimmed.to_string()
            }
        };
        Ok(text)
    }
}

/// The draft the options describe. A secret is only ever read from a reference; naming a value
/// outright is refused without repeating it.
pub fn resolve_add(
    target: Target,
    options: &AddOptions,
    input: &SecretInput,
) -> Result<AddDraft, String> {
    let mut draft = new_draft(target);
    if let Some(name) = &options.name {
        draft = with_name(draft, sanitize_terminal(name).trim());
    }
    if let Some(id) = &options.id {
        draft = with_id(draft, id);
    }
    let mut reader = Reader {
        input,
        stdin_used: false,
    };
    let fields = target_fields(target);
    for (key, value) in &options.sets {
        let Some(field) = fields.iter().find(|candidate| candidate.key == key) else {
            return Err(format!(
                "{}. {}",
                unknown_word(t("providers.args.whatSettingKey"), key),
                tf(
                    "providers.args.allowedKeys",
                    &[(
                        "keys",
                        fields.iter().map(|f| f.key).collect::<Vec<_>>().join(", ")
                    )]
                )
            ));
        };
        let next = match field.control {
            Control::Password => {
                if !input.refs {
                    return Err(tf(
                        "providers.args.maskedOnly",
                        &[("label", field.label.clone())],
                    ));
                }
                let Some(reference) = parse_secret_ref(value) else {
                    return Err(format!("--set {}: {}", field.key, secret_hint()));
                };
                Some(Val::S(
                    reader.read(&format!("--set {}", field.key), &reference)?,
                ))
            }
            Control::Select => {
                let wanted = value.trim().to_lowercase();
                let option = field
                    .options
                    .iter()
                    .find(|(v, _)| v.to_lowercase() == wanted);
                let Some((chosen, _)) = option else {
                    return Err(tf(
                        "providers.args.oneOf",
                        &[
                            ("key", field.key.to_string()),
                            (
                                "options",
                                field
                                    .options
                                    .iter()
                                    .map(|(v, _)| v.as_str())
                                    .collect::<Vec<_>>()
                                    .join(" | "),
                            ),
                        ],
                    ));
                };
                Some(Val::S(chosen.clone()))
            }
            Control::Switch => {
                let wanted = value.trim().to_lowercase();
                let Some((_, flag)) = BOOLEAN_WORDS.iter().find(|(word, _)| *word == wanted) else {
                    return Err(tf(
                        "providers.args.trueOrFalse",
                        &[("key", field.key.to_string())],
                    ));
                };
                Some(Val::B(*flag))
            }
            Control::Text => {
                let text = sanitize_terminal(value).trim().to_string();
                (!text.is_empty()).then_some(Val::S(text))
            }
        };
        draft.values = with_value(target, &draft.values, field.key, next);
    }

    let mut env: Vec<EnvEntry> = Vec::new();
    let mut add_env = |name: &str, value: String, sensitive: bool| -> Option<String> {
        if let Some(problem) = validate_environment_name(name) {
            return Some(problem);
        }
        if env.iter().any(|entry| entry.name == name) {
            return Some(tf(
                "providers.args.envTwice",
                &[(
                    "name",
                    echo_word(name).unwrap_or_else(|| t("providers.args.nameFallback").into()),
                )],
            ));
        }
        env.push(EnvEntry {
            name: name.to_string(),
            value,
            sensitive,
        });
        None
    };
    for (name, value) in &options.env {
        if looks_secret(name) {
            let Some(shown) = echo_word(name) else {
                return Err(t("providers.args.envNameBad").into());
            };
            // The chat takes no secret by reference: the way to add one is the shell command.
            let key = if input.refs {
                "providers.args.secretNameCli"
            } else {
                "providers.args.secretNameChat"
            };
            return Err(tf(key, &[("shown", shown)]));
        }
        if let Some(problem) = add_env(name, sanitize_terminal(value), false) {
            return Err(problem);
        }
    }
    for (name, reference) in &options.secrets {
        let value = reader.read(&format!("--secret {name}"), reference)?;
        if let Some(problem) = add_env(name, value, true) {
            return Err(problem);
        }
    }
    draft.env = env;
    Ok(draft)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_spec::Preset;

    const SECRET: &str = "test-value-1234";

    fn english() {
        crate::i18n::init(Some("en"));
    }

    fn target(word: &str) -> Target {
        parse_target(word).unwrap_or_else(|| panic!("no target {word}"))
    }

    fn strings(argv: &[&str]) -> Vec<String> {
        argv.iter().map(|s| s.to_string()).collect()
    }

    fn cli(argv: &[&str]) -> Result<ProviderRequest, String> {
        english();
        let (positional, flags) = collect_flags(&strings(argv))?;
        resolve_request(&positional, &flags, Origin::Cli)
    }

    fn add(request: Result<ProviderRequest, String>) -> (Option<Target>, AddOptions) {
        match request.unwrap() {
            ProviderRequest::Add { target, options } => (target, options),
            other => panic!("not add: {other:?}"),
        }
    }

    fn message<T: std::fmt::Debug>(result: Result<T, String>) -> String {
        result.err().unwrap_or_else(|| panic!("expected a refusal"))
    }

    fn input(env: &[(&str, &str)], stdin: Option<&str>) -> SecretInput {
        SecretInput {
            refs: true,
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            stdin: stdin.map(str::to_string),
        }
    }

    fn resolve(
        word: &str,
        options: AddOptions,
        secret_input: &SecretInput,
    ) -> Result<AddDraft, String> {
        english();
        resolve_add(target(word), &options, secret_input)
    }

    fn sets(pairs: &[(&str, &str)]) -> AddOptions {
        AddOptions {
            sets: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ..AddOptions::default()
        }
    }

    #[test]
    fn splits_on_spaces_and_keeps_quoted_words_whole() {
        english();
        assert_eq!(
            split_words(r#"add codex --name "My Work" --id 'a b'"#).unwrap(),
            ["add", "codex", "--name", "My Work", "--id", "a b"]
        );
        assert_eq!(split_words("  a   b ").unwrap(), ["a", "b"]);
        assert_eq!(split_words(r#"--name """#).unwrap(), ["--name", ""]);
    }

    #[test]
    fn refuses_an_open_quote() {
        english();
        assert_eq!(split_words("add \"x").unwrap_err(), "Unclosed quote.");
    }

    #[test]
    fn reads_list_with_no_verb_meaning_list() {
        assert_eq!(cli(&[]).unwrap(), ProviderRequest::List);
        assert_eq!(cli(&["list"]).unwrap(), ProviderRequest::List);
        assert!(cli(&["list", "extra"]).is_err());
        assert!(cli(&["list", "--yes"]).is_err());
    }

    #[test]
    fn reads_add_with_its_flags_from_the_shell_or_from_the_chat_alike() {
        let (target_, options) = add(cli(&[
            "add",
            "codex",
            "--id",
            "codex_work",
            "--name",
            "Work",
            "--set",
            "binaryPath=/x",
            "--dry-run",
        ]));
        assert_eq!(target_, Some(target("codex")));
        assert_eq!(
            options,
            AddOptions {
                id: Some("codex_work".into()),
                name: Some("Work".into()),
                sets: vec![("binaryPath".into(), "/x".into())],
                dry_run: true,
                ..AddOptions::default()
            }
        );
        let (_, from_chat) = add(parse_provider_slash(
            r#"add codex --id codex_work --name "Work" --set binaryPath=/x --dry-run"#,
        ));
        assert_eq!(from_chat, options);
    }

    #[test]
    fn takes_dash_y_and_yes_alike_and_equals_after_a_flag() {
        assert!(add(cli(&["add", "codex", "-y"])).1.yes);
        assert!(add(cli(&["add", "codex", "--yes"])).1.yes);
        assert_eq!(
            add(cli(&["add", "codex", "--id=x"])).1.id.as_deref(),
            Some("x")
        );
    }

    #[test]
    fn allows_add_with_no_kind_only_where_nothing_else_is_given() {
        assert_eq!(add(cli(&["add"])).0, None);
        assert!(cli(&["add", "--id", "x"]).is_err());
        assert!(cli(&["add", "--dry-run"]).is_err());
    }

    #[test]
    fn names_the_kinds_when_one_is_unknown() {
        let text = message(cli(&["add", "nope"]));
        assert!(
            text.contains("codex") && text.contains("preset:minimax"),
            "{text}"
        );
    }

    #[test]
    fn reads_remove_with_its_id_and_needs_the_id_in_the_shell() {
        assert_eq!(
            cli(&["remove", "work", "-y", "--dry-run"]).unwrap(),
            ProviderRequest::Remove {
                id: Some("work".into()),
                yes: true,
                dry_run: true
            }
        );
        assert!(cli(&["remove"]).is_err());
        assert!(cli(&["remove", "a", "b"]).is_err());
        assert!(cli(&["remove", "a", "--id", "x"]).is_err());
    }

    #[test]
    fn lets_the_chats_remove_leave_out_the_id() {
        english();
        assert_eq!(
            parse_provider_slash("remove").unwrap(),
            ProviderRequest::Remove {
                id: None,
                yes: false,
                dry_run: false
            }
        );
        assert!(matches!(
            parse_provider_slash("remove work --dry-run").unwrap(),
            ProviderRequest::Remove { dry_run: true, .. }
        ));
    }

    #[test]
    fn keeps_secrets_and_confirmation_skipping_out_of_the_chat() {
        english();
        for text in [
            "add zai --secret KEY=@VAR",
            "add codex -y",
            "remove work --yes",
        ] {
            assert!(parse_provider_slash(text).is_err(), "{text}");
        }
    }

    #[test]
    fn refuses_an_unknown_verb_and_an_unknown_flag() {
        english();
        assert!(parse_provider_slash("frob").is_err());
        assert!(parse_provider_slash("add codex --bogus").is_err());
        assert!(cli(&["add", "codex", "--set", "noequals"]).is_err());
        assert!(cli(&["add", "codex", "--env", "A"]).is_err());
        assert!(cli(&["add", "codex", "--set"]).is_err());
        assert!(cli(&["add", "codex", "--yes=1"]).is_err());
    }

    #[test]
    fn names_a_well_formed_unknown_word_and_only_the_part_before_the_equals_sign() {
        assert!(message(cli(&["add", "nope"])).contains("Unknown kind: nope"));
        let bogus = message(cli(&["add", "codex", &format!("--bogus={SECRET}")]));
        assert!(bogus.contains("Unknown option: --bogus"), "{bogus}");
        assert!(!bogus.contains(SECRET));
        assert!(message(cli(&["frob"])).contains("Unknown subcommand: frob"));
    }

    #[test]
    fn says_the_form_is_wrong_for_a_word_that_does_not_look_like_a_name() {
        let word = format!("{SECRET}-and-more-letters");
        for result in [
            cli(&["add", &word]),
            cli(&[&word]),
            cli(&["add", "codex", &format!("-{word}")]),
        ] {
            let text = message(result);
            assert!(
                text.contains("format of") && text.contains("is invalid"),
                "{text}"
            );
            assert!(!text.contains(&SECRET[..6]), "{text}");
        }
        // A run of digits is the body of a key, short as it is.
        let text = message(cli(&["add", "x1234567"]));
        assert!(
            text.contains("is invalid") && !text.contains("1234"),
            "{text}"
        );
    }

    #[test]
    fn does_the_same_for_a_settings_key_that_is_not_one_and_still_lists_the_ones_that_are() {
        let fields = |key: &str| message(resolve("codex", sets(&[(key, "x")]), &input(&[], None)));
        let plain = fields("colour");
        assert!(
            plain.contains("Unknown setting key: colour") && plain.contains("binaryPath"),
            "{plain}"
        );
        let odd = fields(SECRET);
        assert!(
            odd.contains("setting key") && odd.contains("is invalid"),
            "{odd}"
        );
        assert!(!odd.contains(SECRET) && odd.contains("binaryPath"), "{odd}");
    }

    #[test]
    fn does_not_repeat_an_environment_name_that_is_not_shaped_like_one() {
        let named = |name: &str| {
            let options = AddOptions {
                env: vec![(name.into(), "x".into())],
                ..AddOptions::default()
            };
            message(resolve("codex", options, &input(&[], None)))
        };
        assert!(!named(&format!("{SECRET}.x")).contains(SECRET));
        assert!(!named("1BAD").is_empty());
        assert!(!named(&"A".repeat(200)).contains("AAAAAAAAAAAA"));
    }

    #[test]
    fn a_secret_looking_variable_name_points_to_secret_in_the_shell_and_to_the_shell_in_the_chat() {
        let with_name = |name: &str, refs: bool| {
            let options = AddOptions {
                env: vec![(name.into(), "x".into())],
                ..AddOptions::default()
            };
            let mut secret_input = input(&[], None);
            secret_input.refs = refs;
            resolve("codex", options, &secret_input)
        };
        assert!(message(with_name("API_KEY", true)).contains("--secret API_KEY=@ENV_VAR"));
        let chat = message(with_name("API_KEY", false));
        assert!(chat.contains("chat does not accept secrets"), "{chat}");
        assert!(
            chat.contains("oop provider add --secret API_KEY=@ENV_VAR"),
            "{chat}"
        );
        assert!(with_name("AUTHOR_NAME", false).is_ok());
        assert!(with_name("BYPASS_CACHE", true).is_ok());
    }

    #[test]
    fn secret_references_accept_at_name_and_dash_and_nothing_else() {
        assert_eq!(
            parse_secret_ref("@MY_KEY"),
            Some(SecretRef::Env("MY_KEY".into()))
        );
        assert_eq!(parse_secret_ref("-"), Some(SecretRef::Stdin));
        assert_eq!(parse_secret_ref(SECRET), None);
        assert_eq!(parse_secret_ref("@"), None);
        assert_eq!(parse_secret_ref("@1BAD"), None);
    }

    #[test]
    fn a_literal_secret_is_refused_without_being_repeated() {
        let text = message(cli(&[
            "add",
            "opencode",
            "--secret",
            &format!("TOKEN={SECRET}"),
        ]));
        assert!(!text.contains(SECRET), "{text}");
    }

    #[test]
    fn sets_the_name_the_id_and_the_fields() {
        let options = AddOptions {
            id: Some("codex_work".into()),
            name: Some("Work".into()),
            sets: vec![
                ("binaryPath".into(), " /opt/codex ".into()),
                ("telemetry".into(), "on".into()),
            ],
            ..AddOptions::default()
        };
        let draft = resolve("codex", options, &input(&[], None)).unwrap();
        assert_eq!(
            (draft.id.as_str(), draft.name.as_str()),
            ("codex_work", "Work")
        );
        assert_eq!(
            draft.values.get("binaryPath"),
            Some(&Val::S("/opt/codex".into()))
        );
        assert_eq!(draft.values.get("telemetry"), Some(&Val::B(true)));
    }

    #[test]
    fn reads_a_secret_field_from_the_environment_and_never_from_the_command_line() {
        let secret_input = input(&[("ZAI_KEY", SECRET), ("EMPTY", "  ")], None);
        let draft = resolve("zai", sets(&[("apiKey", "@ZAI_KEY")]), &secret_input).unwrap();
        assert_eq!(draft.values.get("apiKey"), Some(&Val::S(SECRET.into())));
        let literal = message(resolve("zai", sets(&[("apiKey", SECRET)]), &secret_input));
        assert!(
            !literal.contains(SECRET) && literal.contains("@ENV_VAR"),
            "{literal}"
        );
    }

    #[test]
    fn reads_one_secret_from_standard_input_and_only_one() {
        let options = AddOptions {
            sets: vec![("apiKey".into(), "-".into())],
            secrets: vec![("OTHER".into(), SecretRef::Stdin)],
            ..AddOptions::default()
        };
        assert!(wants_stdin(target("zai"), &options));
        assert!(!wants_stdin(target("zai"), &AddOptions::default()));
        let piped = input(&[], Some(&format!("{SECRET}\n")));
        let once = resolve("zai", sets(&[("apiKey", "-")]), &piped).unwrap();
        assert_eq!(once.values.get("apiKey"), Some(&Val::S(SECRET.into())));
        let twice = message(resolve("zai", options, &piped));
        assert!(
            !twice.contains(SECRET) && twice.contains("only once"),
            "{twice}"
        );
    }

    #[test]
    fn says_when_the_variable_or_the_input_is_empty() {
        let env = input(&[("EMPTY", "  ")], None);
        assert!(message(resolve("zai", sets(&[("apiKey", "@NOPE")]), &env)).contains("NOPE"));
        assert!(resolve("zai", sets(&[("apiKey", "@EMPTY")]), &env).is_err());
        assert!(resolve("zai", sets(&[("apiKey", "-")]), &input(&[], Some("\n"))).is_err());
    }

    #[test]
    fn refuses_secret_fields_where_references_are_not_possible() {
        let mut chat = input(&[("ZAI_KEY", SECRET)], None);
        chat.refs = false;
        let text = message(resolve("zai", sets(&[("apiKey", "@ZAI_KEY")]), &chat));
        assert!(text.contains("masked"), "{text}");
    }

    #[test]
    fn names_the_valid_keys_for_an_unknown_one_and_the_choices_for_a_bad_select_or_switch() {
        let env = input(&[], None);
        assert!(message(resolve("codex", sets(&[("nope", "x")]), &env)).contains("binaryPath"));
        let select = message(resolve(
            "antigravity",
            sets(&[("authMethod", "magic")]),
            &env,
        ));
        assert!(select.contains("oauth-personal"), "{select}");
        let draft = resolve(
            "antigravity",
            sets(&[("authMethod", "GEMINI-API-KEY")]),
            &env,
        )
        .unwrap();
        assert_eq!(
            draft.values.get("authMethod"),
            Some(&Val::S("gemini-api-key".into()))
        );
        assert!(resolve("codex", sets(&[("telemetry", "maybe")]), &env).is_err());
    }

    #[test]
    fn moves_a_presets_model_with_its_service() {
        let draft = resolve(
            "preset:minimax",
            sets(&[("service", "coding")]),
            &input(&[], None),
        )
        .unwrap();
        assert_eq!(draft.target, Target::Preset(Preset::Minimax));
        assert_eq!(draft.values.get("service"), Some(&Val::S("coding".into())));
        assert_eq!(
            draft.values.get("model"),
            Some(&Val::S("MiniMax-M3.1-Flash".into()))
        );
    }

    #[test]
    fn keeps_variables_apart() {
        let env = input(&[("ZAI_KEY", SECRET)], None);
        let options = AddOptions {
            env: vec![("LOG_LEVEL".into(), "debug".into())],
            secrets: vec![("PROXY_PASS".into(), SecretRef::Env("ZAI_KEY".into()))],
            ..AddOptions::default()
        };
        let draft = resolve("codex", options, &env).unwrap();
        assert_eq!(
            draft.env,
            [
                EnvEntry {
                    name: "LOG_LEVEL".into(),
                    value: "debug".into(),
                    sensitive: false
                },
                EnvEntry {
                    name: "PROXY_PASS".into(),
                    value: SECRET.into(),
                    sensitive: true
                },
            ]
        );
        let named = AddOptions {
            env: vec![("API_KEY".into(), SECRET.into())],
            ..AddOptions::default()
        };
        assert!(!message(resolve("codex", named, &env)).contains(SECRET));
        let bad = AddOptions {
            env: vec![("1BAD".into(), "x".into())],
            ..AddOptions::default()
        };
        assert!(resolve("codex", bad, &env).is_err());
        let twice = AddOptions {
            env: vec![("A".into(), "1".into()), ("A".into(), "2".into())],
            ..AddOptions::default()
        };
        assert!(resolve("codex", twice, &env).is_err());
    }
}
