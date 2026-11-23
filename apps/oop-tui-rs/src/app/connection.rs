//! Computer switching, subscriptions, and communication with the server.

use super::{
    Active, App, DISPATCH_RPC, Msg, SHELL_RETRY_MIN, SHELL_RPC, THREAD_RPC, TURN_WINDOW,
    dispatch_notice, json,
};
use crate::i18n::tr;
use crate::link::Target;
use crate::panels_common::s;
use crate::state::{Conversation, Shell};
use crate::wire::{RpcStream, StreamMsg};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;
use tokio::time::Instant;

impl App {
    /// Which computer the session talks to, for the tests of the picker.
    #[cfg(test)]
    pub fn link_target(&self) -> Target {
        self.target.borrow().clone()
    }

    /// What the link needs to reach another computer: the target it reconnects on, and the nudge
    /// that drops the live session so the reconnect starts at once (`link::supervise`).
    pub fn link_control(
        &self,
    ) -> (
        tokio::sync::watch::Sender<Target>,
        std::sync::Arc<tokio::sync::Notify>,
    ) {
        (self.target.clone(), self.switch.clone())
    }

    /// The picker's answer: the link drops the session and comes back on `target`, whose projects
    /// screen opens when it is connected. An unchanged choice does nothing.
    pub fn use_computer(&mut self, target: Target) {
        if *self.target.borrow() == target {
            return;
        }
        self.notice = Some(s("Switching computer…", "컴퓨터를 전환하는 중…").to_string());
        self.abort_shell();
        self.target.send_replace(target);
        self.switch.notify_one();
    }

    /// The last session's view of a computer is not the next one's: the conversation, the project
    /// list, everything drafted and every pending question go, and the new computer's project
    /// list opens as soon as its snapshot arrives.
    pub(super) fn reset_for_computer(&mut self) {
        crate::cmd_memory::leave_edit(self);
        self.leave_thread();
        self.recent.clear();
        self.drafts.clear();
        self.attachments = Default::default();
        self.side_settings.clear();
        self.visited.clear();
        self.answered.clear();
        self.cwd_project = None;
        self.draft_project = None;
        self.adding = None;
        self.auto_selected = false;
        self.threadops = Default::default();
        self.shell = Shell::default();
        self.conv = Conversation::default();
        self.active = Active::None;
        self.selected = 0;
        self.scroll.set(0);
        self.input.take(false);
        self.notice = None;
        crate::lists::open_projects(self);
    }

    // --- subscriptions ----------------------------------------------------------------------

    pub(super) fn abort_thread(&mut self) {
        if let Some(task) = self.thread_task.take() {
            task.abort();
        }
    }

    pub(super) fn abort_streams(&mut self) {
        self.abort_thread();
        self.abort_shell();
        if let Some(task) = self.config_task.take() {
            task.abort();
        }
    }

    pub(super) fn clear_shell_retry_notice(&mut self) {
        if let Some(reason) = self.shell_retry_notice.take()
            && self.notice.as_ref() == Some(&reason)
        {
            self.notice = None;
        }
    }

    pub(super) fn abort_shell(&mut self) {
        if let Some(task) = self.shell_task.take() {
            task.abort();
        }
        self.shell_epoch += 1;
        self.shell_retry_at = None;
        self.clear_shell_retry_notice();
        self.shell_backoff = SHELL_RETRY_MIN;
    }

    /// Follows the server's config events for the rest of the session, so the crew line, the model
    /// lists and the goals stay current when settings change (here or in another client).
    pub(super) fn subscribe_config(&mut self) {
        if let Some(task) = self.config_task.take() {
            task.abort();
        }
        let Some(rpc) = self.rpc.clone() else { return };
        let stream = rpc.stream(crate::config_fold::CONFIG_STREAM, json!({}));
        self.config_task = Some(forward(stream, self.tx.clone(), |message| match message {
            StreamMsg::Item(event) => Msg::Ext(Box::new(move |app| app.apply_config_event(&event))),
            // The socket's own end is what the link watches; a stream that ends alone just stops
            // updating until the next connect.
            StreamMsg::End(_) => Msg::Ext(Box::new(|_| {})),
        }));
    }

    /// Folds one config event into `config`.
    pub fn apply_config_event(&mut self, event: &Value) {
        crate::config_fold::fold(&mut self.config, event);
    }

    pub(super) fn subscribe_shell(&mut self) {
        if self.shell_task.is_some() {
            return;
        }
        let Some(rpc) = self.rpc.as_ref().filter(|rpc| !rpc.is_closed()) else {
            return;
        };
        let mut payload = if self.shell.loaded {
            json!({"afterSequence": self.shell.sequence})
        } else {
            json!({})
        };
        if self.config["shellResumeCompletionMarker"] == true {
            payload["requestCompletionMarker"] = json!(true);
        }
        let stream = rpc.stream(SHELL_RPC, payload);
        self.shell_started = Instant::now();
        self.shell_epoch += 1;
        let epoch = self.shell_epoch;
        self.shell_task = Some(forward(stream, self.tx.clone(), move |m| {
            Msg::Ext(Box::new(move |app| {
                // An aborted stream can still have a message waiting in the app's queue.
                if app.shell_epoch == epoch {
                    app.react(match m {
                        StreamMsg::Item(item) => Msg::Shell(item),
                        StreamMsg::End(reason) => Msg::ShellEnd(reason),
                    });
                }
            }))
        }));
    }

    /// Opens a thread's stream. A thread already on screen resumes after the last event applied;
    /// a new one opens on its latest turns (the older ones are read as they are scrolled to).
    pub(super) fn subscribe_thread(&mut self, id: &str) {
        self.abort_thread();
        // The usage line is this thread's, not the last one's, and is asked for afresh.
        crate::usage_footer::opened(self, id);
        let Some(rpc) = self.rpc.clone() else { return };
        let mut payload = json!({"threadId": id, "threadDeletion": true});
        let flags = [
            ("reasoningMessages", "reasoningMessages"),
            ("threadResumeCompletionMarker", "requestCompletionMarker"),
        ];
        for (offered, field) in flags {
            if self.config[offered] == Value::Bool(true) {
                payload[field] = Value::Bool(true);
            }
        }
        if let (true, Some(sequence)) = (
            self.conv.loaded && self.conv.thread_id == id,
            self.conv.sequence,
        ) {
            payload["afterSequence"] = json!(sequence);
        } else if self.config["threadSnapshotPagination"] == Value::Bool(true) {
            payload["turnLimit"] = json!(TURN_WINDOW);
        }
        let stream = rpc.stream(THREAD_RPC, payload);
        let thread_id = id.to_string();
        self.thread_task = Some(forward(stream, self.tx.clone(), move |m| match m {
            StreamMsg::Item(item) => Msg::Thread {
                id: thread_id.clone(),
                item,
            },
            StreamMsg::End(reason) => Msg::ThreadEnd {
                id: thread_id.clone(),
                reason,
            },
        }));
    }

    /// Reads the page of turns before the oldest one held, over HTTP.
    pub(crate) fn request_older(&mut self) {
        let (Some(id), Some(cursor), Some(origin), Some(bearer)) = (
            self.thread_id(),
            self.conv.older_cursor.clone(),
            self.origin.clone(),
            self.bearer.clone(),
        ) else {
            return;
        };
        if !self.conv.has_more || self.conv.loading_older {
            return;
        }
        self.conv.loading_older = true;
        self.conv.revision += 1;
        let tx = self.tx.clone();
        // On another computer the environment's HTTP answers behind the gateway path of the host.
        let prefix = self.remote.as_ref().map_or(String::new(), |r| {
            crate::gateway::environment_prefix(&r.environment_id)
        });
        tokio::spawn(async move {
            let path = format!(
                "{prefix}/api/orchestration/threads/{id}?reasoningMessages=true&turnLimit={TURN_WINDOW}&beforeCursor={}",
                crate::http::form_encode(&cursor)
            );
            let headers = [("Authorization", format!("Bearer {bearer}"))];
            let result = crate::http::request(
                "GET",
                &origin,
                &path,
                &headers,
                None,
                std::time::Duration::from_secs(20),
            )
            .await
            .and_then(|answer| {
                if answer.status == 200 {
                    answer.json()
                } else {
                    Err(format!("the server answered {}", answer.status))
                }
            });
            let _ = tx.send(Msg::Older { id, result });
        });
    }

    pub(crate) fn dispatch(
        &mut self,
        command: Value,
        open: Option<String>,
        answered: Option<String>,
    ) -> bool {
        #[cfg(test)]
        self.log.push(command.clone());
        let sent = (command["type"] == "thread.turn.start")
            .then(|| command["message"]["messageId"].as_str().map(str::to_string))
            .flatten();
        let Some(reply) = self
            .rpc
            .as_ref()
            .and_then(|rpc| rpc.start_call(DISPATCH_RPC, command).ok())
        else {
            if let Some(request) = answered {
                self.answered.remove(&request);
            }
            self.notice = Some(tr("notice.offline").into());
            return false;
        };
        let open = open.map(|id| {
            // Another submission from the same draft supersedes this reply's claim on the view.
            self.thread_view_epoch += 1;
            (id, self.thread_view_epoch)
        });
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = reply.await.map(|_| ()).map_err(dispatch_notice);
            let _ = tx.send(Msg::Dispatched {
                result,
                open,
                answered,
                sent,
            });
        });
        true
    }
}

/// Forwards one subscription's items into the app's message queue. Aborting the task drops the
/// stream, which tells the server to stop.
fn forward(
    mut stream: RpcStream,
    tx: UnboundedSender<Msg>,
    wrap: impl Fn(StreamMsg) -> Msg + Send + 'static,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(message) = stream.rx.recv().await {
            let end = matches!(message, StreamMsg::End(_));
            if tx.send(wrap(message)).is_err() || end {
                break;
            }
        }
    })
}
