//! OOP Crew role resolution for the header and the Agents panel: a port of `resolveCrew` and
//! `recommendCrew` in packages/shared/src/crew.ts and of `crewRolesOf` in the TypeScript terminal's
//! controller. A role is whatever the user pinned for it, else what the preset picks from the models
//! this environment can run right now. The crew is shown only when it is on for the thread and the
//! thread's own model can use the crew tools.

use crate::flow::CrewRoleModel;
use serde_json::Value;

pub const ROLES: [&str; 3] = ["worker", "expert", "auditor"];

/// Brains that receive OOP's crew tools; a copy of the server's `CREW_BRAIN_DRIVERS`.
const BRAIN_DRIVERS: [&str; 3] = ["claudeAgent", "codex", "antigravity"];

#[derive(Clone, Debug, PartialEq)]
pub struct ModelOption {
    pub instance_id: String,
    pub model: String,
    pub label: String,
    /// The provider's display name, else its driver.
    pub provider_label: String,
    pub driver: String,
    /// 1 fast and cheap, 2 balanced, 3 strongest.
    pub tier: u8,
    pub is_default: bool,
}

fn tier_of(slug: &str, name: &str) -> u8 {
    let text = format!("{slug} {name}").to_lowercase();
    const FAST: [&str; 11] = [
        "mini", "nano", "haiku", "flash", "lite", "fast", "luna", "small", "instant", "spark",
        "turbo",
    ];
    if FAST.iter().any(|w| text.contains(w)) {
        return 1;
    }
    let words = |w: &str| {
        text.split(|c: char| !c.is_alphanumeric())
            .any(|part| part == w)
    };
    if ["opus", "max", "ultra", "o3", "pro"]
        .iter()
        .any(|w| words(w))
        || text.contains("opus")
        || text.contains("max")
        || text.contains("ultra")
        || text.contains("-high")
        || text.contains("gpt-6")
        || text.contains("gpt6")
    {
        return 3;
    }
    2
}

/// Models a crew role can use: ready, signed-in providers only, legacy models left out.
pub fn model_options(config: &Value) -> Vec<ModelOption> {
    let mut out = Vec::new();
    for provider in config["providers"].as_array().into_iter().flatten() {
        let usable = provider["enabled"].as_bool() == Some(true)
            && provider["installed"].as_bool() == Some(true)
            && provider["availability"].as_str() != Some("unavailable")
            && matches!(provider["status"].as_str(), Some("ready" | "warning"))
            && provider["auth"]["status"].as_str() != Some("unauthenticated");
        if !usable {
            continue;
        }
        let instance_id = provider["instanceId"].as_str().unwrap_or_default();
        let driver = provider["driver"].as_str().unwrap_or_default();
        for model in provider["models"].as_array().into_iter().flatten() {
            if model["isLegacy"].as_bool() == Some(true) {
                continue;
            }
            let slug = model["slug"].as_str().unwrap_or_default();
            let name = model["name"].as_str().unwrap_or(slug);
            let label = model["shortName"].as_str().unwrap_or(name);
            out.push(ModelOption {
                instance_id: instance_id.to_string(),
                model: slug.to_string(),
                label: label.to_string(),
                provider_label: provider["displayName"]
                    .as_str()
                    .unwrap_or(driver)
                    .to_string(),
                driver: driver.to_string(),
                tier: tier_of(slug, name),
                is_default: model["isDefault"].as_bool() == Some(true),
            });
        }
    }
    out
}

pub type Brain<'a> = Option<(&'a str, &'a str)>;

fn same(option: &ModelOption, other: Brain) -> bool {
    other.is_some_and(|(instance, model)| option.instance_id == instance && option.model == model)
}

struct Want<'a> {
    tiers: [u8; 3],
    other_than: Brain<'a>,
    provider_of: Brain<'a>,
    avoid: Vec<Brain<'a>>,
}

fn driver_of<'a>(options: &'a [ModelOption], selection: Brain) -> Option<&'a str> {
    let (instance, _) = selection?;
    options
        .iter()
        .find(|o| o.instance_id == instance)
        .map(|o| o.driver.as_str())
}

fn pick(options: &[ModelOption], want: &Want) -> Option<usize> {
    let other = driver_of(options, want.other_than);
    let same_driver = driver_of(options, want.provider_of);
    let score = |o: &ModelOption| -> i32 {
        let tier = want
            .tiers
            .iter()
            .position(|t| *t == o.tier)
            .map_or(100, |rank| rank as i32 * 10);
        tier + if other.is_some_and(|d| d == o.driver) {
            8
        } else {
            0
        } + if same_driver.is_some_and(|d| d != o.driver) {
            2
        } else {
            0
        } + if want.avoid.iter().any(|a| same(o, *a)) {
            6
        } else {
            0
        } + if o.is_default { 0 } else { 1 }
    };
    // A stable sort by score: the first of equals wins, as in the TypeScript.
    let mut best: Option<(usize, i32)> = None;
    for (index, option) in options.iter().enumerate() {
        let s = score(option);
        if best.is_none_or(|(_, b)| s < b) {
            best = Some((index, s));
        }
    }
    best.map(|(i, _)| i)
}

fn selection_of(option: Option<usize>, options: &[ModelOption]) -> Brain<'_> {
    option.map(|i| (options[i].instance_id.as_str(), options[i].model.as_str()))
}

/// What a preset puts in each role, given the brain the thread already runs.
fn recommend(options: &[ModelOption], brain: Brain, preset: &str) -> [Option<usize>; 3] {
    let tiers = |a, b, c| [a, b, c];
    let (worker_tiers, expert_tiers, auditor_tiers, expert_avoids_brain) = match preset {
        "speed" => (tiers(1, 2, 3), tiers(2, 3, 1), tiers(1, 2, 3), false),
        "quality" => (tiers(2, 3, 1), tiers(3, 2, 1), tiers(3, 2, 1), false),
        "budget" => (tiers(1, 2, 3), tiers(1, 2, 3), tiers(1, 2, 3), false),
        _ => (tiers(1, 2, 3), tiers(3, 2, 1), tiers(3, 2, 1), true),
    };
    let worker = pick(
        options,
        &Want {
            tiers: worker_tiers,
            other_than: None,
            provider_of: brain,
            avoid: vec![],
        },
    );
    let mut avoid = vec![selection_of(worker, options)];
    if expert_avoids_brain {
        avoid.push(brain);
    }
    let expert = pick(
        options,
        &Want {
            tiers: expert_tiers,
            other_than: None,
            provider_of: None,
            avoid,
        },
    );
    let auditor = pick(
        options,
        &Want {
            tiers: auditor_tiers,
            other_than: brain,
            provider_of: None,
            avoid: vec![brain],
        },
    );
    [worker, expert, auditor]
}

fn pin<'a>(
    settings: &'a Value,
    role: &str,
    thread: Option<&'a Value>,
) -> Option<(&'a str, &'a str)> {
    // A thread's pin (null means Auto) over the defaults' pin.
    let pinned = thread
        .and_then(|t| t["pinned"].as_object())
        .and_then(|p| p.get(role))
        .or_else(|| settings["pinned"].get(role))?;
    Some((pinned["instanceId"].as_str()?, pinned["model"].as_str()?))
}

pub struct Resolved {
    pub enabled: bool,
    pub preset: String,
    pub roles: [Option<ModelOption>; 3],
    /// The roles a model was pinned for (and still can run) rather than left to the preset.
    pub pinned: [bool; 3],
}

/// What the preset alone would put in each role, which Auto stands for.
pub fn auto_picks(config: &Value, brain: Brain, preset: &str) -> [Option<ModelOption>; 3] {
    let options = model_options(config);
    recommend(&options, brain, preset).map(|pick| pick.map(|i| options[i].clone()))
}

/// The crew a thread runs with: its override over the defaults, then pins over the preset.
pub fn resolve(config: &Value, thread_id: Option<&str>, brain: Brain) -> Resolved {
    let settings = &config["settings"]["crew"];
    let thread = thread_id.and_then(|id| settings["threads"].get(id));
    let enabled = thread
        .and_then(|t| t["enabled"].as_bool())
        .or_else(|| settings["enabled"].as_bool())
        .unwrap_or(false);
    let preset = thread
        .and_then(|t| t["preset"].as_str())
        .or_else(|| settings["preset"].as_str())
        .unwrap_or("recommended");
    let options = model_options(config);
    let recommended = recommend(&options, brain, preset);
    let mut roles: [Option<ModelOption>; 3] = [None, None, None];
    let mut pinned_roles = [false; 3];
    for (slot, role) in ROLES.iter().enumerate() {
        let pinned = pin(settings, role, thread).and_then(|(instance, model)| {
            options
                .iter()
                .find(|o| o.instance_id == instance && o.model == model)
        });
        pinned_roles[slot] = pinned.is_some();
        roles[slot] = pinned
            .or_else(|| recommended[slot].map(|i| &options[i]))
            .cloned();
    }
    Resolved {
        enabled,
        preset: preset.to_string(),
        roles,
        pinned: pinned_roles,
    }
}

/// Why the thread's model cannot use the crew; `false` when it can. A thread with no model yet is
/// not blamed.
pub fn brain_cannot(config: &Value, brain: Brain) -> bool {
    let Some((instance, _)) = brain else {
        return true;
    };
    config["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["instanceId"].as_str() == Some(instance))
        .and_then(|p| p["driver"].as_str())
        .is_none_or(|driver| !BRAIN_DRIVERS.contains(&driver))
}

/// The crew's roles with their models for the thread on screen: `None` when the crew is off for it
/// or cannot run on its model. `on_thread` is false on the lists (no thread to blame).
pub fn roles_of(
    config: &Value,
    thread_id: Option<&str>,
    brain: Brain,
    on_thread: bool,
) -> Option<Vec<CrewRoleModel>> {
    if config.is_null() {
        return None;
    }
    if on_thread && brain_cannot(config, brain) {
        return None;
    }
    let crew = resolve(config, thread_id, brain);
    crew.enabled.then(|| {
        ROLES
            .iter()
            .zip(crew.roles)
            .map(|(role, option)| CrewRoleModel {
                role,
                model: option.map(|o| o.label),
            })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(crew: Value) -> Value {
        let model = |slug: &str, name: &str, default: bool| json!({"slug": slug, "name": name, "isDefault": default});
        json!({"settings": {"crew": crew}, "providers": [
            {"instanceId": "claude", "driver": "claudeAgent", "displayName": "Claude", "enabled": true,
             "installed": true, "status": "ready", "auth": {"status": "authenticated"},
             "models": [model("claude-haiku-5-5", "Haiku 5.5", false), model("claude-sonnet-5-5", "Sonnet 5.5", true),
                        model("claude-opus-5-5", "Opus 5.5", false)]},
            {"instanceId": "codex", "driver": "codex", "displayName": "Codex", "enabled": true,
             "installed": true, "status": "ready", "auth": {"status": "authenticated"},
             "models": [model("gpt-5", "GPT-5", true), model("gpt-5-mini", "GPT-5 mini", false)]},
            {"instanceId": "off", "driver": "grok", "enabled": false, "installed": true, "status": "ready",
             "auth": {"status": "authenticated"}, "models": [model("grok", "Grok", true)]}
        ]})
    }

    #[test]
    fn tiers_follow_the_model_names() {
        assert_eq!(tier_of("claude-haiku-5-5", "Haiku"), 1);
        assert_eq!(tier_of("claude-opus-5-5", "Opus 5.5"), 3);
        assert_eq!(tier_of("claude-sonnet-5-5", "Sonnet 5.5"), 2);
        assert_eq!(tier_of("gpt-5-mini", "GPT-5 mini"), 1);
    }

    #[test]
    fn only_ready_signed_in_providers_offer_models() {
        let options = model_options(&config(json!({})));
        assert_eq!(options.len(), 5);
        assert!(options.iter().all(|o| o.instance_id != "off"));
    }

    #[test]
    fn the_crew_is_off_by_default_and_shows_roles_when_on() {
        let brain = Some(("claude", "claude-sonnet-5-5"));
        assert!(roles_of(&config(json!({})), Some("t1"), brain, true).is_none());
        let on = config(json!({"enabled": true, "preset": "recommended"}));
        let roles = roles_of(&on, Some("t1"), brain, true).unwrap();
        assert_eq!(
            roles.iter().map(|r| r.role).collect::<Vec<_>>(),
            ["worker", "expert", "auditor"]
        );
        // the worker is the fast model of the brain's own provider, the expert and the auditor
        // the strongest one (the other provider's only wins when it is a tier above, as in the
        // TypeScript scoring: a same-provider penalty of 8 is less than a tier step of 10)
        assert_eq!(roles[0].model.as_deref(), Some("Haiku 5.5"));
        assert_eq!(roles[1].model.as_deref(), Some("Opus 5.5"));
        assert_eq!(roles[2].model.as_deref(), Some("Opus 5.5"));
    }

    #[test]
    fn a_thread_override_and_pins_win() {
        let cfg = config(json!({
            "enabled": false,
            "pinned": {"worker": {"instanceId": "codex", "model": "gpt-5-mini"}},
            "threads": {"t1": {"enabled": true, "pinned": {"expert": {"instanceId": "claude", "model": "claude-opus-5-5"}}}}
        }));
        let brain = Some(("claude", "claude-sonnet-5-5"));
        assert!(roles_of(&cfg, Some("t2"), brain, true).is_none());
        let roles = roles_of(&cfg, Some("t1"), brain, true).unwrap();
        assert_eq!(roles[0].model.as_deref(), Some("GPT-5 mini"));
        assert_eq!(roles[1].model.as_deref(), Some("Opus 5.5"));
        // a null pin in the thread puts a default pin back on Auto
        let cfg = config(json!({
            "enabled": true,
            "pinned": {"worker": {"instanceId": "codex", "model": "gpt-5-mini"}},
            "threads": {"t1": {"pinned": {"worker": null}}}
        }));
        let roles = roles_of(&cfg, Some("t1"), brain, true).unwrap();
        assert_eq!(roles[0].model.as_deref(), Some("Haiku 5.5"));
    }

    #[test]
    fn a_brain_that_cannot_use_the_crew_hides_it() {
        let cfg = config(json!({"enabled": true}));
        assert!(roles_of(&cfg, None, Some(("off", "grok")), true).is_none());
        assert!(roles_of(&cfg, None, None, true).is_none());
        // on the lists there is no thread to blame
        assert!(roles_of(&cfg, None, None, false).is_some());
        assert!(roles_of(&Value::Null, None, None, false).is_none());
    }
}
