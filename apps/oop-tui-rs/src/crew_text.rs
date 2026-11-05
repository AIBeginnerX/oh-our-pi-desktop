//! The words of /goal and /crew, English and Korean. Originally generated from the removed
//! TypeScript terminal's tables; the generator is gone, so this file is now the source and is
//! edited directly.

use crate::panels_common::{fill, s};

/// The text for a key of the TypeScript catalogue, in the language in use.
pub fn text(key: &str) -> &'static str {
    match key {
        "providers.cmd.default" => s("default", "기본"),
        "providers.cmd.off" => s("off", "꺼짐"),
        "providers.cmd.on" => s("on", "켜짐"),
        "providers.crew.autoWords" => s("auto recommended", "auto 자동 추천 recommended"),
        "providers.crew.badBrain" => s(
            "{name} models cannot be the crew's brain. Crew works only with Claude, Codex and Antigravity models. Switch with /model.",
            "{name} 모델은 crew 의 brain 이 될 수 없습니다. Claude, Codex, Antigravity 모델에서만 crew 를 씁니다. /model 로 바꾸세요.",
        ),
        "providers.crew.noModels" => s(
            "No model is available. Check with /model.",
            "사용할 수 있는 모델이 없습니다. /model 로 확인하세요.",
        ),
        "providers.crew.noneAvailable" => s("no model available", "쓸 수 있는 모델 없음"),
        "providers.crew.preset.budget" => s("Budget", "예산"),
        "providers.crew.preset.budgetHint" => {
            s("The cheapest model that works", "되는 가장 저렴한 모델")
        }
        "providers.crew.preset.quality" => s("Quality", "품질"),
        "providers.crew.preset.qualityHint" => s(
            "The strongest model for hard work",
            "어려운 일에 가장 강한 모델",
        ),
        "providers.crew.preset.recommended" => s("OOP pick", "OOP 추천"),
        "providers.crew.preset.recommendedHint" => {
            s("A balanced team chosen by OOP", "OOP 가 고른 균형 잡힌 팀")
        }
        "providers.crew.preset.speed" => s("Speed", "속도"),
        "providers.crew.preset.speedHint" => {
            s("The fastest model everywhere", "어디서나 빠른 모델")
        }
        "providers.crew.recommended" => s(
            "Recommended: {model} · {provider}",
            "추천: {model} · {provider}",
        ),
        "providers.crew.role.auditor" => s("review changed files", "바뀐 파일 검토"),
        "providers.crew.role.expert" => s("hard implementation", "어려운 구현"),
        "providers.crew.role.worker" => s("search, edit, test", "검색·수정·테스트"),
        "providers.crew.tier.balanced" => s("balanced", "균형"),
        "providers.crew.tier.fast" => s("fast", "빠름"),
        "providers.crew.tier.strong" => s("strong", "강력"),
        "providers.crew.unknownModel" => s(
            "This model is not in the server's list, so it is unclear whether crew works with it.",
            "서버 목록에 없는 모델이라 crew 를 쓸 수 있는지 알 수 없습니다.",
        ),
        "providers.crew.waitManyApproval" => s(
            "{count} crew tasks are waiting for approval — /crew",
            "crew 작업 {count}개가 승인을 기다립니다 — /crew",
        ),
        "providers.crew.waitManyMixed" => s(
            "{count} crew tasks are waiting for approval or an answer — /crew",
            "crew 작업 {count}개가 승인·질문을 기다립니다 — /crew",
        ),
        "providers.crew.waitOneApproval" => s(
            "A crew task is waiting for approval — /crew",
            "crew 작업이 승인을 기다립니다 — /crew",
        ),
        "providers.crew.waitOneInput" => s(
            "A crew task is waiting for your answer — /crew",
            "crew 작업이 질문을 기다립니다 — /crew",
        ),
        "providers.crewScreen.autoAll" => s("Set every role model to Auto", "역할 모델 모두 Auto"),
        "providers.crewScreen.autoAllNote" => {
            s("Releases the models you picked", "직접 고른 모델을 풉니다")
        }
        "providers.crewScreen.alreadyListed" => s("already listed", "이미 목록에 있음"),
        "providers.crewScreen.cancel" => s("Cancel", "취소"),
        "providers.crewScreen.confirmStop" => s("Confirm stop", "중단 확인"),
        "providers.crewScreen.confirmStopNote" => {
            s("You can retry it later", "이후 재시도할 수 있습니다")
        }
        "providers.crewScreen.enterToOpen" => s("Enter to open", "Enter 로 열기"),
        "providers.crewScreen.fallbackAdd" => s("Add a model", "모델 추가"),
        "providers.crewScreen.fallbackAddNote" => s(
            "Enter to pick a model for the role to fall back to",
            "Enter 로 역할이 돌아갈 모델을 고릅니다",
        ),
        "providers.crewScreen.fallbackFull" => s(
            "The list is full — {max} at most",
            "목록이 가득 찼습니다 — 최대 {max}개",
        ),
        "providers.crewScreen.fallbackNone" => s("none", "없음"),
        "providers.crewScreen.fallbackNoneYet" => s(
            "No fallbacks yet. Add a model for the role to fall back to.",
            "아직 폴백이 없습니다. 역할이 돌아갈 모델을 추가하세요.",
        ),
        "providers.crewScreen.fallbackNote" => s(
            "Tried in order when the role's model fails",
            "역할 모델이 실패하면 순서대로 시도합니다",
        ),
        "providers.crewScreen.fallbackRemoveNote" => {
            s("Enter takes it out of the list", "Enter 로 목록에서 뺍니다")
        }
        "providers.crewScreen.fallbackAwayNote" => s(
            "Not available now, skipped until it is back · Enter takes it out",
            "지금은 쓸 수 없어 돌아올 때까지 건너뜁니다 · Enter 로 뺍니다",
        ),
        "providers.crewScreen.hintBack" => s("Esc back", "Esc 뒤로"),
        "providers.crewScreen.hintConfirm" => s(
            "↑/↓ move • Enter confirm • Esc cancel",
            "↑/↓ 이동 • Enter 확인 • Esc 취소",
        ),
        "providers.crewScreen.hintFallback" => s(
            "↑/↓ move • Enter remove • Esc back",
            "↑/↓ 이동 • Enter 제거 • Esc 뒤로",
        ),
        "providers.crewScreen.hintMain" => s(
            "↑/↓ move • 1-9 pick • Enter run • Esc close",
            "↑/↓ 이동 • 1-9 선택 • Enter 실행 • Esc 닫기",
        ),
        "providers.crewScreen.hintModel" => s(
            "↑/↓ move • Enter choose • Esc back",
            "↑/↓ 이동 • Enter 선택 • Esc 뒤로",
        ),
        "providers.crewScreen.hintModelClear" => s(
            "↑/↓ move • Enter choose • Esc clear search",
            "↑/↓ 이동 • Enter 선택 • Esc 검색어 지우기",
        ),
        "providers.crewScreen.hintPreset" => s(
            "↑/↓ move • 1-4 pick • Enter apply • Esc back",
            "↑/↓ 이동 • 1-4 선택 • Enter 적용 • Esc 뒤로",
        ),
        "providers.crewScreen.hintTask" => s(
            "↑/↓ move • Enter run • Esc to board",
            "↑/↓ 이동 • Enter 실행 • Esc 보드로",
        ),
        "providers.crewScreen.makeDefault" => {
            s("Use as new chat default", "새 채팅 기본값으로 사용")
        }
        "providers.crewScreen.makeDefaultNote" => s(
            "Apply these settings to new threads too",
            "지금 설정을 새 스레드에도",
        ),
        "providers.crewScreen.resetToDefault" => s("Use the default crew", "기본 Crew 사용"),
        "providers.crewScreen.resetToDefaultNote" => s(
            "Drop this thread's own crew",
            "이 스레드 전용 Crew를 지웁니다",
        ),
        "providers.crewScreen.noMatch" => s(
            "No matching model. Press Esc to clear the search.",
            "일치하는 모델이 없습니다. Esc로 검색어를 지우세요.",
        ),
        "providers.crewScreen.noTasks" => s(
            "This thread has no crew tasks yet.",
            "이 스레드에는 아직 crew 작업이 없습니다.",
        ),
        "providers.crewScreen.openSub" => s("Open sub-thread", "서브 스레드 열기"),
        "providers.crewScreen.openSubNote" => {
            s("View the task's conversation", "작업의 대화를 봅니다")
        }
        "providers.crewScreen.openSubWaitingNote" => {
            s("Answer the approval or question", "승인·질문에 답합니다")
        }
        "providers.crewScreen.preset" => s("Preset", "프리셋"),
        "providers.crewScreen.presetNote" => s(
            "Applies to {scope}. Models you picked yourself stay as they are.",
            "{scope}에 적용됩니다. 직접 고른 모델은 그대로 둡니다.",
        ),
        "providers.crewScreen.presetTitle" => s("Crew preset", "Crew 프리셋"),
        "providers.crewScreen.retry" => s("Retry", "재시도"),
        "providers.crewScreen.retryNote" => {
            s("Runs it again as a new task", "새 작업으로 다시 실행합니다")
        }
        "providers.crewScreen.roleModel" => s("{role} model", "{role} 모델"),
        "providers.crewScreen.roleFallbacks" => s("{role} fallbacks", "{role} 폴백"),
        "providers.crewScreen.roleTask" => s("{role} task", "{role} 작업"),
        "providers.crewScreen.scopeDefault" => s(
            "this thread only (still on the default crew)",
            "이 스레드에만 (아직 기본 Crew)",
        ),
        "providers.crewScreen.scopeThread" => s("this thread (own crew)", "이 스레드 (전용 Crew)"),
        "providers.crewScreen.search" => s("Search:", "검색:"),
        "providers.crewScreen.stop" => s("Stop", "중단"),
        "providers.crewScreen.stopNote" => {
            s("Stops the task where it is", "작업이 있던 곳에서 멈춥니다")
        }
        "providers.crewScreen.stopQuestion" => s("Stop this task?", "이 작업을 중단할까요?"),
        "providers.crewScreen.taskGone" => s(
            "This task is no longer on the board.",
            "이 작업은 더 이상 보드에 없습니다.",
        ),
        "providers.crewScreen.taskTitle" => s("Crew task", "Crew 작업"),
        "providers.crewScreen.toBoard" => s("Back to board", "보드로"),
        "providers.crewScreen.typeToFilter" => {
            s("{hint} · type to filter", "{hint} · 글자를 치면 걸러집니다")
        }
        "providers.crewScreen.waitApproval" => s("waiting for approval", "승인 대기"),
        "providers.crewScreen.waitInput" => s("waiting for answer", "질문 대기"),
        "providers.screen.current" => s("current", "현재"),
        "render.crew.auditSkipped" => s(
            "Audit skipped: small change, tests passed{files}",
            "감사 생략: 작은 변경이고 테스트가 통과했습니다{files}",
        ),
        "render.crew.auditSkippedFiles" => s(" (files: {count})", " (파일 {count}개)"),
        "render.crew.barWaiting" => s(
            "crew awaiting approval/answer {count}",
            "crew 승인·질문 대기 {count}",
        ),
        "render.crew.boardCount" => s("{turn} · Tasks {count}", "{turn} · 작업 {count}개"),
        "render.crew.evidence.audited" => s("Audit approved", "감사 승인"),
        "render.crew.evidence.reported" => s("Reported only", "보고만 있음"),
        "render.crew.evidence.tested" => s("Tests passed", "테스트 통과"),
        "render.crew.field.elapsed" => s("Elapsed", "경과"),
        "render.crew.field.evidence" => s("Evidence", "근거"),
        "render.crew.field.model" => s("Model", "모델"),
        "render.crew.field.proof" => s("Proof", "증명"),
        "render.crew.field.role" => s("Role", "역할"),
        "render.crew.field.status" => s("Status", "상태"),
        "render.crew.field.summary" => s("Summary", "요약"),
        "render.crew.field.task" => s("Task", "작업"),
        "render.crew.field.usage" => s("Usage", "사용량"),
        "render.crew.followUp" => s(
            "Crew results were passed to the lead as a follow-up turn",
            "crew 결과를 lead 에게 후속 턴으로 전달했습니다",
        ),
        "render.crew.followUpAudit" => s(
            "The audit asked for fixes, so a follow-up turn was sent to the lead",
            "감사가 수정을 요청해 lead 에게 후속 턴을 보냈습니다",
        ),
        "render.crew.phase.blocked" => s("Blocked", "차단됨"),
        "render.crew.phase.completed" => s("Done", "완료"),
        "render.crew.phase.failed" => s("Failed", "실패"),
        "render.crew.phase.partial" => s("Partly done", "일부 완료"),
        "render.crew.phase.running" => s("In progress", "진행 중"),
        "render.crew.phase.stopped" => s("Stopped", "중단됨"),
        "render.crew.prevTurn" => s("Earlier turn", "이전 턴"),
        "render.crew.running" => s("{count} running", "진행 {count}"),
        "render.crew.settled" => s("{count} finished", "끝남 {count}"),
        "render.crew.stoppedUnreported" => s("Stopped · no report", "중단됨 · 보고 없음"),
        "render.crew.thisTurn" => s("This turn", "이번 턴"),
        "render.crew.tokens" => s("{count} tokens", "{count} 토큰"),
        "render.crew.untitled" => s("(untitled)", "(제목 없음)"),
        "render.crew.waitApproval" => s(" · awaiting approval", " · 승인 대기"),
        "render.crew.waitInput" => s(" · awaiting answer", " · 질문 대기"),
        "session.c.allAuto" => s("All Auto", "모두 Auto"),
        "session.c.answerPendingFirst" => s(
            "Answer the pending approval or question first.",
            "대기 중인 승인이나 질문에 먼저 답하세요.",
        ),
        "session.c.connectToView" => s(
            "You can view this once the server is connected.",
            "서버와 연결된 뒤에 볼 수 있습니다.",
        ),
        "session.c.crewAlready" => s("Crew is already {state}.", "이미 Crew {state}입니다."),
        "session.c.crewBackOnly" => s(
            "In a crew task thread only /crew back works.",
            "crew 작업 스레드에서는 /crew back 만 쓸 수 있습니다.",
        ),
        "session.c.crewBackOnlyInTask" => s(
            "This only works in a crew task thread.",
            "crew 작업 스레드에서만 쓸 수 있습니다.",
        ),
        "session.c.crewDefault" => s("Crew defaults", "Crew 기본값"),
        "session.c.crewDefaultAlready" => s(
            "This thread already runs the default crew.",
            "이 스레드는 이미 기본 Crew를 씁니다.",
        ),
        "session.c.crewDefaultNote" => s(
            "This thread's settings are also used for new chats",
            "이 스레드의 설정을 새 채팅에도 씁니다",
        ),
        "session.c.crewReset" => s("Crew", "Crew"),
        "session.c.crewResetNote" => s(
            "This thread uses the default crew",
            "이 스레드는 기본 Crew를 씁니다",
        ),
        "session.c.crewModelUsage" => s(
            "Usage: /crew model <worker|expert|auditor> [model|auto]",
            "사용법: /crew model <worker|expert|auditor> [모델|auto]",
        ),
        "session.c.crewNoGoal" => s(
            "A crew task thread cannot have a goal. Return to the lead with /crew back.",
            "crew 작업 스레드에는 목표를 둘 수 없습니다. /crew back 으로 lead 로 돌아가세요.",
        ),
        "session.c.crewPlanBack" => s(
            "This is a crew task thread. Implement the plan in the lead: /crew back",
            "crew 작업 스레드입니다. 계획은 lead 에서 구현하세요: /crew back",
        ),
        "session.c.crewPreset" => s("Crew preset", "Crew 프리셋"),
        "session.c.crewRestarted" => s(
            "Restarted the {role} task",
            "{role} 작업을 다시 시작했습니다",
        ),
        "session.c.crewRetryFailed" => s(
            "Could not retry the crew task: {detail}",
            "crew 재시도 실패: {detail}",
        ),
        "session.c.crewRoleModels" => s("Crew role models", "Crew 역할 모델"),
        "session.c.crewSaveFailed" => s("Could not save the Crew settings", "Crew 설정 저장 실패"),
        "session.c.crewSendLead" => s(
            "This is a crew task thread. Send messages to the lead: /crew back",
            "crew 작업 스레드입니다. 메시지는 lead 로 보내세요: /crew back",
        ),
        "session.c.crewStopFailed" => s("Could not stop the crew task", "crew 작업 중단 실패"),
        "session.c.crewStopRequested" => s(
            "Requested to stop the {role} task",
            "{role} 작업 중단을 요청했습니다",
        ),
        "session.c.crewStopNone" => s("No crew task was running", "실행 중인 crew 작업이 없습니다"),
        "session.c.crewStopUnsupported" => s(
            "This server cannot stop crew tasks yet. Stop one from the /crew screen, or update the server.",
            "이 서버는 아직 crew 작업 중단을 지원하지 않습니다. /crew 화면에서 하나씩 중단하거나 서버를 업데이트하세요.",
        ),
        "session.c.crewStopping" => s(
            "{count} crew task(s) are still stopping",
            "crew 작업 {count}개가 아직 중단 중입니다",
        ),
        "session.c.crewStopped" => s(
            "Stopped {count} crew task(s)",
            "crew 작업 {count}개를 중단했습니다",
        ),
        "session.c.crewSubPlaceholder" => s(
            "Crew task thread · /crew back returns to the lead",
            "crew 작업 스레드 · /crew back 으로 lead 에게 돌아가기",
        ),
        "session.c.crewTask" => s("crew task", "crew 작업"),
        "session.c.crewTaskThread" => s("Crew task thread", "Crew 작업 스레드"),
        "session.c.crewTaskThreadNote" => s(
            "After answering approvals and questions, return to the lead with /crew back. Messages are not sent from here.",
            "승인·질문에 답한 뒤 /crew back 으로 lead 에게 돌아가세요. 여기서는 메시지를 보내지 않습니다.",
        ),
        "session.c.crewLogEmpty" => s(
            "The crew has not made any decisions in this thread yet.",
            "이 스레드에서 crew 가 내린 결정이 아직 없습니다.",
        ),
        "session.c.crewLogTitle" => s(
            "Crew decision log · the last {shown} of {total} rows (all rows go to the clipboard as TSV)",
            "Crew 결정 로그 · 전체 {total}행 중 최근 {shown}행 (전체는 TSV 로 클립보드에 복사)",
        ),
        "session.c.crewTasks" => s("{count} crew task(s)", "crew 작업 {count}"),
        "session.c.crewUnsupported" => s("crew unsupported", "crew 미지원"),
        "session.c.crewUsage" => s(
            "Usage: /crew [on|off|preset <{words}>|model <role> [model|auto]|default|reset|stop [id|all]|log|back]",
            "사용법: /crew [on|off|preset <{words}>|model <역할> [모델|auto]|default|reset|stop [id|all]|log|back]",
        ),
        "session.c.enterGoalText" => s("Enter the goal text.", "목표 내용을 입력하세요."),
        "session.c.goal" => s("Goal", "목표"),
        "session.c.goalClearFailed" => s("Could not clear the goal", "목표 해제 실패"),
        "session.c.goalCleared" => s("Goal cleared", "목표 해제"),
        "session.c.goalHelp" => s(
            "/goal clear remove • /goal max <count> continue limit • /goal <text> change",
            "/goal clear 해제 • /goal max <횟수> 연속 횟수 • /goal <내용> 바꾸기",
        ),
        "session.c.goalHint" => s(
            "Enter save • Shift-Enter / Ctrl-J new line • Esc cancel",
            "Enter 저장 • Shift-Enter / Ctrl-J 줄바꿈 • Esc 취소",
        ),
        "session.c.goalHoldsMode" => s(
            "The goal is continuing on its own, so you cannot change {what} right now. Clear it with /goal clear, then change it.",
            "목표가 자동으로 이어지는 중이라 {what} 지금 바꿀 수 없습니다. /goal clear 로 해제 후 바꾸세요.",
        ),
        "session.c.goalLoading" => s("Loading", "불러오는 중"),
        "session.c.goalMaxUsage" => s(
            "Usage: /goal max <count> ({min}-{max})",
            "사용법: /goal max <횟수> ({min}~{max})",
        ),
        "session.c.goalPartial" => s(
            "Earlier conversation is not loaded, so the continue count may be higher.",
            "이전 대화가 생략되어 연속 횟수는 이보다 클 수 있습니다.",
        ),
        "session.c.goalPlaceholder" => s(
            "e.g. Keep fixing until all tests pass",
            "예: 모든 테스트가 통과할 때까지 고치기",
        ),
        "session.c.goalPromptTitle" => s(
            "Enter a goal for this thread",
            "이 스레드의 목표를 입력하세요",
        ),
        "session.c.goalReasonLabel" => s("Reason", "사유"),
        "session.c.goalRecorded" => s(
            "{text} (up to {max} continues)",
            "{text} (연속 최대 {max}회)",
        ),
        "session.c.goalSaveFailed" => s("Could not save the goal", "목표 저장 실패"),
        "session.c.goalStatus" => s(
            "{state} · continued {continues}{plus}/{max}",
            "{state} · 연속 {continues}{plus}/{max}",
        ),
        "session.c.goalStatusLabel" => s("Status", "상태"),
        "session.c.leadApproval" => s(
            "The lead thread is waiting for an approval — /crew back",
            "lead 스레드가 승인을 기다립니다 — /crew back",
        ),
        "session.c.leadQuestion" => s(
            "The lead thread is waiting for an answer — /crew back",
            "lead 스레드가 질문을 기다립니다 — /crew back",
        ),
        "session.c.leadUnknown" => s(
            "The lead thread is unknown. Go there with /threads.",
            "lead 스레드를 알 수 없습니다. /threads 로 이동하세요.",
        ),
        "session.c.noGoal" => s("There is no goal set.", "설정된 목표가 없습니다."),
        "session.c.noGoalSet" => s(
            "There is no goal set. Set one with /goal <text>.",
            "설정된 목표가 없습니다. /goal <내용> 으로 정하세요.",
        ),
        "session.c.noModelNamed" => s(
            "No matching model: {query}",
            "일치하는 모델이 없습니다: {query}",
        ),
        "session.c.off" => s("off", "꺼짐"),
        "session.c.on" => s("on", "켜짐"),
        "session.c.roleModel" => s("{role} model", "{role} 모델"),
        "session.c.roleFallbacks" => s("{role} fallbacks", "{role} 폴백"),
        "session.c.threadNotFound" => s(
            "Cannot find the thread yet. Try again in a moment.",
            "스레드를 아직 찾을 수 없습니다. 잠시 뒤 다시 시도하세요.",
        ),
        "session.c.toRestore" => s("To restore: {command}", "되돌리려면: {command}"),
        "session.c.unknownPreset" => s(
            "Unknown preset: {value} ({words})",
            "알 수 없는 프리셋입니다: {value} ({words})",
        ),
        "session.c.unknownRole" => s(
            "Unknown role: {value} (worker|expert|auditor)",
            "알 수 없는 역할입니다: {value} (worker|expert|auditor)",
        ),
        "session.c.whatPermission" => s("the permission mode", "권한 모드를"),
        "session.c.whatWorkMode" => s("the work mode", "작업 방식을"),
        "session.goal.barCount" => s("Goal {n}{plus}/{max}", "목표 {n}{plus}/{max}"),
        "session.goal.barState" => s("Goal {state}", "목표 {state}"),
        "session.goal.barUnknown" => s("Goal ?/{max}", "목표 ?/{max}"),
        "session.goal.blocked" => s("blocked", "차단"),
        "session.goal.met" => s("met", "완료"),
        "session.goal.stopped" => s("stopped", "중지"),
        "session.goal.working" => s("working", "진행 중"),
        "session.slash.crew.note" => s(
            "Turn Crew on or off, role models and fallbacks, task board",
            "Crew 켜고 끄기·역할 모델과 폴백·작업 보드",
        ),
        "session.slash.crew.usage" => s(
            "[on|off|preset|model|default|reset|stop|log|back]",
            "[on|off|preset|model|default|reset|stop|log|back]",
        ),
        "session.slash.goal.note" => s("Set or view the thread goal", "스레드 목표 설정·확인"),
        "session.slash.goal.usage" => s("[text|clear|max count]", "[내용|clear|max 횟수]"),
        _ => "",
    }
}

/// `text` with its `{name}` holes filled.
pub fn text_with(key: &str, pairs: &[(&str, String)]) -> String {
    fill(text(key), pairs)
}
