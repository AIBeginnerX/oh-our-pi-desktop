//! Composer submission, turn preferences, and sending.

use super::{Active, App, json};
use crate::commands::{self, Bootstrap, Ctx, Turn};
use crate::i18n::tr;
use crate::settings;
use crate::state::{Choice, first_usable_model, model_name, usable_models, with_option};
use crate::text::new_id;
use serde_json::Value;

impl App {
    pub(super) fn pick_model(&mut self, instance_id: &str, model: &str) {
        let selection = json!({"instanceId": instance_id, "model": model});
        settings::write_last_model(&self.last_model_path, &selection);
        self.notice = Some(format!(
            "{}: {}",
            tr("notice.model"),
            model_name(&selection)
        ));
        self.model_override = Some(selection);
    }

    pub(super) fn pick_effort(&mut self, descriptor_id: &str, value: &str) {
        let Some(model) = self.current_model() else {
            return;
        };
        let selection = with_option(&model, descriptor_id, value);
        settings::write_last_model(&self.last_model_path, &selection);
        self.notice = Some(format!("{}: {value}", tr("notice.effort")));
        self.model_override = Some(selection);
    }

    pub(super) fn set_runtime_mode(&mut self, mode: &str) {
        if self.thread_id().is_some()
            && mode != self.conv.thread.runtime_mode
            && let Some(refusal) = crate::cmd_goal::mode_refusal(self, "session.c.whatPermission")
        {
            self.notice = Some(refusal);
            return;
        }
        let label = tr(&format!("mode.{mode}"));
        self.notice = Some(format!("{}: {label}", tr("notice.mode")));
        match self.thread_id() {
            Some(id) => {
                let command = commands::runtime_mode_set(&Ctx::fresh(), &id, mode);
                self.runtime_intent = Some(mode.to_string());
                self.dispatch(command, None, None);
            }
            None => self.draft_runtime_mode = mode.to_string(),
        }
    }

    pub(super) fn set_interaction_mode(&mut self, mode: &str) {
        if self.thread_id().is_some()
            && mode != self.conv.thread.interaction_mode
            && let Some(refusal) = crate::cmd_goal::mode_refusal(self, "session.c.whatWorkMode")
        {
            self.notice = Some(refusal);
            return;
        }
        self.notice = Some(
            tr(if mode == "plan" {
                "notice.planOn"
            } else {
                "notice.planOff"
            })
            .into(),
        );
        match self.thread_id() {
            Some(id) => {
                let command = commands::interaction_mode_set(&Ctx::fresh(), &id, mode);
                self.interaction_intent = Some(mode.to_string());
                self.dispatch(command, None, None);
            }
            None => self.draft_interaction_mode = mode.to_string(),
        }
    }

    pub(super) fn interrupt(&mut self) {
        let Some(id) = self.thread_id() else {
            self.notice = Some(tr("notice.nothingRunning").into());
            return;
        };
        let turn = self.conv.session().and_then(|s| s.active_turn_id.clone());
        self.notice = Some(tr("notice.stopping").into());
        self.notifier.stop_requested(&id);
        let command = commands::turn_interrupt(&Ctx::fresh(), &id, turn.as_deref());
        self.dispatch(command, None, None);
    }

    // --- sending ----------------------------------------------------------------------------

    /// What a new thread in `project_id` runs on: the last model picked (when this server still
    /// has it), else the project's default, else the first usable provider's default.
    pub(super) fn model_for(&self, project_id: &str) -> Option<Value> {
        if let Some(selection) = settings::read_last_model(&self.last_model_path)
            && usable_models(&self.config).iter().any(|m| {
                selection["instanceId"] == m.instance_id.as_str()
                    && selection["model"] == m.slug.as_str()
            })
        {
            return Some(selection);
        }
        let project = self.shell.projects.iter().find(|p| p.id == project_id)?;
        if let Some(selection) = project
            .default_model_selection
            .clone()
            .filter(|s| !s.is_null())
        {
            return Some(selection);
        }
        first_usable_model(&self.config)
            .map(|Choice { instance_id, model }| json!({"instanceId": instance_id, "model": model}))
    }

    pub(crate) fn has_connection(&self) -> bool {
        self.rpc.as_ref().is_some_and(|rpc| !rpc.is_closed())
    }

    pub(crate) fn submit(&mut self) {
        if self.memory_edit.is_some() {
            if !self.has_connection() {
                self.notice = Some(tr("notice.offline").into());
                return;
            }
            crate::cmd_memory::save_edit(self);
            return;
        }
        let text = self.input.text();
        let mut trimmed = text.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        let word = trimmed.split_whitespace().next().unwrap_or_default();
        if word.starts_with('/') && self.input.starts_with_slash() && !word[1..].contains('/') {
            let argument = trimmed[word.len()..].trim().to_string();
            let name = word[1..].to_lowercase();
            if !self.has_connection() && self.slash_needs_connection(&name, &argument) {
                self.notice = Some(tr("notice.offline").into());
                return;
            }
            if self.run_slash(&name, &argument) {
                self.input.take(name != "btw");
                return;
            }
            // Not ours: an installed provider skill goes out as the `$name` mention the composer
            // inserts, which each provider turns into its own invocation.
            let Some(name) = self.provider_skill(&word[1..]) else {
                self.notice = Some(tr("notice.unknownCommand").into());
                return;
            };
            trimmed = format!("${name} {argument}").trim_end().to_string();
        }
        let has_attachments = crate::cmd_attach::line(self).is_some();
        if has_attachments && !self.has_connection() {
            self.notice = Some(tr("notice.offline").into());
            return;
        }
        if has_attachments && self.conv.busy() {
            self.notice = Some(
                crate::panels_common::s(
                    "Wait for the current turn before sending attachments.",
                    "현재 작업이 끝난 뒤 첨부를 전송하세요.",
                )
                .into(),
            );
            return;
        }
        match &self.active {
            Active::None => self.notice = Some(tr("notice.pickFirst").into()),
            Active::Thread(_) if self.conv.busy() => {
                if !self.has_connection() {
                    self.notice = Some(tr("notice.offline").into());
                    return;
                }
                self.queue.push_back(trimmed);
                self.input.take(true);
                self.notice = Some(tr("notice.queued").into());
            }
            _ => {
                if self.send(&trimmed) {
                    self.input.take(true);
                }
            }
        }
    }

    /// Commands that use the open connection. Local pickers and draft-only edits work offline.
    fn slash_needs_connection(&self, name: &str, argument: &str) -> bool {
        let in_thread = matches!(self.active, Active::Thread(_));
        match name {
            "btw" => crate::cmd_btw::question_target(self, argument).is_ok(),
            "goal" => !matches!(self.active, Active::None) && !argument.is_empty(),
            "autofix" => in_thread && matches!(argument, "on" | "off"),
            "mode" => in_thread && commands::parse_runtime_mode(argument).is_some(),
            "plan" | "default" | "implement" | "continue" | "diff" | "undo" | "history" => {
                in_thread
            }
            "memory" => matches!(argument, "" | "saved" | "analyse"),
            "skills" => {
                let mut words = argument.split_whitespace();
                matches!(
                    (words.next(), words.next(), words.next()),
                    (None, ..) | (Some("install"), Some(_), None)
                )
            }
            "crew" => {
                let mut words = argument.split_whitespace();
                match words.next().map(str::to_lowercase).as_deref() {
                    Some("scorecard" | "stop" | "default") => true,
                    Some("on" | "off" | "reset") => in_thread,
                    Some("preset") => in_thread && words.next().is_some(),
                    Some("model") => in_thread && words.nth(1).is_some(),
                    _ => false,
                }
            }
            _ => false,
        }
    }

    /// The name of the provider skill a typed `/word` calls, if some provider lists it as enabled
    /// and invocable by the user.
    pub(super) fn provider_skill(&self, word: &str) -> Option<String> {
        let model = self.current_model();
        let current = model.as_ref().and_then(|m| m["instanceId"].as_str());
        let providers = self.config["providers"].as_array()?;
        providers
            .iter()
            .filter(|p| p["instanceId"].as_str() == current)
            .chain(
                providers
                    .iter()
                    .filter(|p| p["instanceId"].as_str() != current),
            )
            .flat_map(|p| p["skills"].as_array().into_iter().flatten())
            .filter(|k| k["enabled"].as_bool().unwrap_or(true) && k["userInvocable"] != false)
            .filter_map(|k| k["name"].as_str())
            .find(|name| name.eq_ignore_ascii_case(word))
            .map(str::to_string)
    }

    /// Builds and sends one user message to the open thread or, from a draft, starts the thread.
    pub(crate) fn send(&mut self, text: &str) -> bool {
        if crate::cmd_attach::before_send(self, text) {
            return false;
        }
        if let Some(refusal) = crate::cmd_history::sending_blocked(self) {
            self.notice = Some(refusal);
            return false;
        }
        let runtime_mode = self.runtime_mode();
        let interaction_mode = self.interaction_mode();
        let message_id = new_id();
        let ctx = Ctx::fresh();
        let mut command = match self.active.clone() {
            Active::None => {
                self.notice = Some(tr("notice.pickFirst").into());
                return false;
            }
            Active::Draft(project_id) => {
                let Some(model) = self
                    .model_override
                    .clone()
                    .or_else(|| self.model_for(&project_id))
                else {
                    self.notice = Some(tr("notice.noProvider").into());
                    return false;
                };
                let thread_id = self.draft_id.clone().unwrap_or_else(new_id);
                let crew = self.draft_crew.clone();
                let mut command = commands::turn_start(
                    &ctx,
                    &Turn {
                        thread_id: &thread_id,
                        message_id: &message_id,
                        text,
                        model: Some(&model),
                        runtime_mode: &runtime_mode,
                        interaction_mode: &interaction_mode,
                        bootstrap: Some(Bootstrap {
                            project_id: &project_id,
                            crew: crew.as_ref(),
                        }),
                    },
                );
                command["message"]["attachments"] = json!(self.attachments.ready);
                self.notice = None;
                if !self.dispatch(command, Some(thread_id), None) {
                    return false;
                }
                self.draft_id = None;
                return true;
            }
            Active::Thread(thread_id) => commands::turn_start(
                &ctx,
                &Turn {
                    thread_id: &thread_id,
                    message_id: &message_id,
                    text,
                    model: self.model_override.as_ref(),
                    runtime_mode: &runtime_mode,
                    interaction_mode: &interaction_mode,
                    bootstrap: None,
                },
            ),
        };
        command["message"]["attachments"] = json!(self.attachments.ready);
        self.notice = None;
        if !self.dispatch(command, None, None) {
            return false;
        }
        self.scroll.set(0);
        self.sent = Some((message_id, self.tick));
        true
    }

    /// A request was sent and its message has not come back yet: no work of it exists, and the
    /// work before it is not this one's.
    pub fn request_pending(&self) -> bool {
        self.sent
            .as_ref()
            .is_some_and(|(id, _)| !self.conv.thread.messages.iter().any(|m| &m.id == id))
    }
}
