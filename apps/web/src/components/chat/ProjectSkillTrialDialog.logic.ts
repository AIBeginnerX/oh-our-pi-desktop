import type {
  ComposerContextId,
  EnvironmentId,
  MessageId,
  OrchestrationMessageContext,
  ProjectId,
  ProjectSkillContent,
  ProjectSkillDetail,
  ProjectSkillMode,
  ProjectSkillVersionRef,
  ThreadId,
} from "@t3tools/contracts";
import { renderProjectSkillBlock, SelectedChecksRunInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isTaggedError, sameProjectSkillVersionRef } from "../settings/ProjectSkillsSection.logic";

/**
 * Pure decisions for the skill-trial send dialog. The trial rides a normal
 * user turn: the exact selected version's managed block plus the task text,
 * with one generic-label `project-skill` record carrying `{ref, mode:"trial"}`
 * — never a client authority stamp, which only the server writes at
 * admission. Every rejection sentence here is fixed local copy; server causes
 * and submitted content are never echoed back, and command acceptance is
 * never presented as provider delivery or task success.
 */

/** The thread a trial is frozen to at open; the dialog never retargets it. */
export interface FrozenTrialScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

/** Same scope-key shape as the candidate dialog's: a change remounts clean. */
export const trialScopeKey = (scope: FrozenTrialScope): string =>
  JSON.stringify([scope.environmentId, scope.projectId, scope.threadId]);

type ProjectSkillsCapabilityConfig =
  | {
      readonly environment: {
        readonly capabilities: {
          readonly projectSkills?: {
            readonly trial?: unknown;
            readonly use?: unknown;
            readonly manage?: unknown;
            readonly lifecycle?: unknown;
          };
        };
      };
    }
  | null
  | undefined;

/** Version-skew safe: absent or non-boolean trial flag means unsupported. */
export function trialCapabilityOf(config: ProjectSkillsCapabilityConfig): boolean {
  return config?.environment.capabilities.projectSkills?.trial === true;
}

/** Version-skew safe: absent or non-boolean use flag means unavailable. */
export function useCapabilityOf(config: ProjectSkillsCapabilityConfig): boolean {
  return config?.environment.capabilities.projectSkills?.use === true;
}

export function projectSkillSendCapabilityOf(
  config: ProjectSkillsCapabilityConfig,
  mode: ProjectSkillSendMode,
): boolean {
  return mode === "trial" ? trialCapabilityOf(config) : useCapabilityOf(config);
}

export type ProjectSkillSendMode = ProjectSkillMode;

const decodeSelectedScriptIds = Schema.decodeUnknownOption(SelectedChecksRunInput.fields.scriptIds);

/** Nonempty, unique, bounded script ids frozen at submit — same validator as selected-check runs. */
export function freezeSelectedScriptIds(ids: ReadonlyArray<string>): ReadonlyArray<string> | null {
  const validated = Option.getOrNull(decodeSelectedScriptIds(ids));
  return validated === null ? null : [...validated];
}

export interface FrozenUseScriptBinding {
  readonly id: string;
  readonly command: string;
}

/** Immutable ordered ids plus command pins captured at submit from the resolved project list. */
export function freezeUseScriptBindings(
  ids: ReadonlyArray<string>,
  scripts: ReadonlyArray<{ readonly id: string; readonly command: string }>,
): ReadonlyArray<FrozenUseScriptBinding> | null {
  const frozenIds = freezeSelectedScriptIds(ids);
  if (frozenIds === null) return null;
  const byId = new Map(scripts.map((script) => [script.id, script]));
  const bindings: FrozenUseScriptBinding[] = [];
  for (const id of frozenIds) {
    const script = byId.get(id);
    if (script === undefined) return null;
    bindings.push({ id: script.id, command: script.command });
  }
  return bindings;
}

export function frozenUseScriptBindingsStillValid(
  frozen: ReadonlyArray<FrozenUseScriptBinding>,
  scripts: ReadonlyArray<{ readonly id: string; readonly command: string }>,
): boolean {
  const byId = new Map(scripts.map((script) => [script.id, script]));
  return frozen.every((binding) => byId.get(binding.id)?.command === binding.command);
}

export function activeVersionRefFromDetail(
  detail: ProjectSkillDetail,
): ProjectSkillVersionRef | null {
  const active = detail.versions.find((view) => view.version.state === "active");
  return active?.version.ref ?? null;
}

/** The one generic record label; it carries no skill or user content. */
export const PROJECT_SKILL_TRIAL_RECORD_LABEL = "Project skill trial";
export const PROJECT_SKILL_USE_RECORD_LABEL = "Project skill use";

export interface TrialSendDraft {
  /** The exact rendered trial block, then the task. */
  readonly text: string;
  /** One managed record; the server writes the admission stamp itself. */
  readonly context: OrchestrationMessageContext;
}

/**
 * The full send body for one frozen ref: the canonical trial block verbatim,
 * a blank line, then the trimmed task. Null when the task is blank — the
 * block never rides alone and the task is never silently trimmed away.
 */
export function buildTrialSendDraft(input: {
  readonly ref: ProjectSkillVersionRef;
  readonly content: ProjectSkillContent;
  readonly task: string;
  readonly contextId: ComposerContextId;
  readonly mode?: ProjectSkillSendMode;
  readonly selectedScriptIds?: ReadonlyArray<string>;
}): TrialSendDraft | null {
  const mode = input.mode ?? "trial";
  const task = input.task.trim();
  if (task === "") return null;
  const text = `${renderProjectSkillBlock({
    ref: input.ref,
    content: input.content,
    mode,
  })}\n\n${task}`;
  const payload =
    mode === "use"
      ? (() => {
          const selectedScriptIds = freezeSelectedScriptIds(input.selectedScriptIds ?? []);
          if (selectedScriptIds === null) return null;
          return {
            ref: { ...input.ref },
            mode: "use" as const,
            selectedScriptIds,
          };
        })()
      : { ref: { ...input.ref }, mode: "trial" as const };
  if (payload === null) return null;
  const record = {
    version: 1 as const,
    contextId: input.contextId,
    kind: "project-skill" as const,
    label: mode === "use" ? PROJECT_SKILL_USE_RECORD_LABEL : PROJECT_SKILL_TRIAL_RECORD_LABEL,
    payload,
  };
  return { text, context: { version: 1, records: [record] } };
}

/** The registry-fresh observations every submit gate re-reads. */
export interface TrialFreshObservations {
  readonly capability: boolean;
  /** Null when the thread shell is gone — deleted, or another environment. */
  readonly shell: { readonly projectId: ProjectId; readonly createdAt: string } | null;
  /** Settled detail for the selected skill, identity-checked by the reader. */
  readonly detail: ProjectSkillDetail | null;
}

/**
 * The sync submit gate over fresh observations, in the order the user can act
 * on it. The frozen ref must still be a version of this exact detail — a
 * refresh that no longer carries it (renumbered or rehashed) never falls back
 * to another version. Null means the send may proceed to confirmation.
 */
export function trialScopeProblem(input: {
  readonly mode?: ProjectSkillSendMode;
  readonly observations: TrialFreshObservations;
  readonly scope: FrozenTrialScope;
  readonly frozenRef: ProjectSkillVersionRef;
  /** When set, the thread shell must still be the same incarnation (e.g. createdAt). */
  readonly boundShellCreatedAt?: string;
  readonly frozenScriptBindings?: ReadonlyArray<FrozenUseScriptBinding>;
  readonly scripts?: ReadonlyArray<{ readonly id: string; readonly command: string }>;
}): string | null {
  const {
    mode = "trial",
    observations,
    scope,
    frozenRef,
    boundShellCreatedAt,
    frozenScriptBindings,
    scripts,
  } = input;
  if (!observations.capability) {
    return mode === "use" ? USE_UNSUPPORTED_COPY : TRIAL_UNSUPPORTED_COPY;
  }
  if (
    observations.shell === null ||
    observations.shell.projectId !== scope.projectId ||
    frozenRef.projectId !== scope.projectId
  ) {
    return TRIAL_THREAD_UNAVAILABLE_COPY;
  }
  if (boundShellCreatedAt !== undefined && observations.shell.createdAt !== boundShellCreatedAt) {
    return TRIAL_THREAD_UNAVAILABLE_COPY;
  }
  if (observations.detail === null) return TRIAL_DETAIL_FAILED_COPY;
  if (observations.detail.projectId !== scope.projectId) return TRIAL_THREAD_UNAVAILABLE_COPY;
  const version = observations.detail.versions.find((view) =>
    sameProjectSkillVersionRef(view.version.ref, frozenRef),
  );
  if (version === undefined) {
    return mode === "use" ? USE_VERSION_GONE_COPY : TRIAL_VERSION_GONE_COPY;
  }
  if (mode === "trial" && version.version.state !== "candidate") return TRIAL_VERSION_GONE_COPY;
  if (mode === "use" && version.version.state !== "active") return USE_VERSION_GONE_COPY;
  if (
    mode === "use" &&
    frozenScriptBindings !== undefined &&
    scripts !== undefined &&
    !frozenUseScriptBindingsStillValid(frozenScriptBindings, scripts)
  ) {
    return USE_SCRIPTS_CHANGED_COPY;
  }
  return null;
}

export type TrialSendFailureKind = "authorization" | "rejected" | "unconfirmed";

/** Fixed local copy for a failed send; nothing server-side passes through. */
export function classifyTrialSendFailure(cause: unknown): TrialSendFailureKind {
  if (isTaggedError(cause, "EnvironmentAuthorizationError")) return "authorization";
  return "unconfirmed";
}

export function trialSendFailureCopy(kind: TrialSendFailureKind): string {
  if (kind === "authorization") return TRIAL_AUTHORIZATION_COPY;
  if (kind === "rejected") return TRIAL_SEND_REJECTED_COPY;
  return TRIAL_SEND_UNCONFIRMED_COPY;
}

/** @deprecated Use classifyTrialSendFailure + trialSendFailureCopy */
export function trialSendOutcomeCopy(cause: unknown): string {
  return trialSendFailureCopy(classifyTrialSendFailure(cause));
}

/** Identity captured immediately before startTurn; compared after every await. */
export interface TrialSendRequestIdentity {
  readonly stamp: {
    readonly entry: unknown;
    readonly prepared: unknown;
    readonly generation: number;
  };
  readonly scope: FrozenTrialScope;
  readonly frozenRef: ProjectSkillVersionRef;
  readonly shellCreatedAt: string;
  readonly messageId: MessageId;
}

export function sameTrialConnectionStamp(
  a: TrialSendRequestIdentity["stamp"],
  b: TrialSendRequestIdentity["stamp"] | null,
): boolean {
  return (
    b !== null && a.entry === b.entry && a.prepared === b.prepared && a.generation === b.generation
  );
}

export function trialSendStillCurrent(input: {
  readonly mode?: ProjectSkillSendMode;
  readonly identity: TrialSendRequestIdentity;
  readonly stamp: TrialSendRequestIdentity["stamp"] | null;
  readonly observations: TrialFreshObservations;
  readonly frozenRef: ProjectSkillVersionRef;
  readonly frozenScriptBindings?: ReadonlyArray<FrozenUseScriptBinding>;
  readonly scripts?: ReadonlyArray<{ readonly id: string; readonly command: string }>;
}): boolean {
  const {
    mode = "trial",
    identity,
    stamp,
    observations,
    frozenRef,
    frozenScriptBindings,
    scripts,
  } = input;
  if (!sameTrialConnectionStamp(identity.stamp, stamp)) return false;
  if (
    trialScopeProblem({
      mode,
      observations,
      scope: identity.scope,
      frozenRef,
      ...(frozenScriptBindings !== undefined ? { frozenScriptBindings } : {}),
      ...(scripts !== undefined ? { scripts } : {}),
    }) !== null
  ) {
    return false;
  }
  const shell = observations.shell;
  if (shell === null || shell.createdAt !== identity.shellCreatedAt) return false;
  if (!sameProjectSkillVersionRef(frozenRef, identity.frozenRef)) return false;
  return true;
}

export const TRIAL_DIALOG_TITLE = "스킬 시험";
export const TRIAL_DIALOG_NOTICE =
  "선택한 버전의 절차 블록과 과제를 이 스레드에 한 메시지로 보냅니다. 접수는 전달 확인이 아니며, 시험 결과는 기록에서 확인하세요.";
export const TRIAL_UNSUPPORTED_COPY = "이 서버는 스킬 시험을 지원하지 않습니다.";
export const TRIAL_ACCESS_PENDING_COPY = "이 환경에 대한 권한을 확인하는 중입니다.";
export const TRIAL_AUTHORIZATION_COPY = "이 세션은 스킬 시험을 보낼 수 없습니다.";
export const TRIAL_CONFIRM_FAILED_COPY = "연결 상태를 지금 확인할 수 없습니다. 다시 시도해 주세요.";
export const TRIAL_THREAD_UNAVAILABLE_COPY =
  "이 스레드에서 시험을 보낼 수 없습니다. 스레드를 다시 열어 주세요.";
export const TRIAL_VERSION_GONE_COPY = "선택한 버전이 서버에서 변경되었습니다. 다시 선택해 주세요.";
export const TRIAL_TASK_INVALID_COPY = "시험 과제를 입력해 주세요.";
export const TRIAL_SEND_REJECTED_COPY = "서버가 이 시험 전송을 거절했습니다.";
export const TRIAL_SEND_UNCONFIRMED_COPY =
  "전송 결과를 확인할 수 없습니다. 스레드와 시험 기록을 확인한 뒤, 필요하면 새 시험을 시작하세요. 같은 시험은 여기서 다시 보낼 수 없습니다.";
/** @deprecated Prefer trialSendFailureCopy */
export const TRIAL_SEND_FAILED_COPY = TRIAL_SEND_REJECTED_COPY;
export const TRIAL_REFRESH_DATA_LABEL = "다시 불러오기";
export const TRIAL_ACCEPTED_TOAST = "시험 전송이 접수되었습니다";
export const TRIAL_LIST_EMPTY_COPY = "저장된 스킬 후보가 없습니다. 먼저 후보를 저장하세요.";
export const TRIAL_LIST_FAILED_COPY = "스킬 목록을 불러오지 못했습니다. 다시 시도해 주세요.";
export const TRIAL_DETAIL_PENDING_COPY = "버전 정보를 불러오는 중…";
export const TRIAL_DETAIL_FAILED_COPY = "버전 정보를 불러오지 못했습니다. 다시 시도해 주세요.";
export const TRIAL_SKILL_LABEL = "스킬";
export const TRIAL_VERSION_LABEL = "버전";
export const TRIAL_TASK_LABEL = "시험 과제";
export const TRIAL_SUBMIT_LABEL = "시험 보내기";
export const TRIAL_CANCEL_LABEL = "취소";

export const USE_DIALOG_TITLE = "이번 요청에 사용";
export const USE_DIALOG_NOTICE =
  "활성 버전의 절차 블록과 과제를 이 스레드에 한 메시지로 보냅니다. 접수는 전달 확인이 아니며, 서버가 경로와 적격성을 확인합니다.";
export const USE_UNSUPPORTED_COPY = "이 서버는 스킬 사용 전송을 지원하지 않습니다.";
export const USE_AUTHORIZATION_COPY = "이 세션은 스킬 사용을 보낼 수 없습니다.";
export const USE_VERSION_GONE_COPY =
  "선택한 활성 버전이 서버에서 변경되었습니다. 다시 선택해 주세요.";
export const USE_SCRIPTS_LABEL = "프로젝트 스크립트";
export const USE_SCRIPTS_INVALID_COPY = "실행할 스크립트를 하나 이상 선택해 주세요.";
export const USE_SCRIPTS_CHANGED_COPY =
  "선택한 스크립트가 프로젝트에서 변경되었습니다. 다시 선택해 주세요.";
export const USE_SUBMIT_LABEL = "보내기";
export const USE_ACCEPTED_TOAST = "사용 전송이 접수되었습니다";
