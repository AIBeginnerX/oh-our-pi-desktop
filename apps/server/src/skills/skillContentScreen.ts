/**
 * Content screen for new project-skill candidates. Pure policy: it maps skill
 * content to the fixed rejection reasons from `ProjectSkillScreenReason` and
 * returns nothing else — in particular it never echoes the inspected text,
 * mirroring the rule in `../memory/sensitiveText.ts`.
 *
 * The screen applies only to skill content a user is about to save. It does
 * not enforce anything on composer free text, existing provider skills, or
 * the memory write path.
 *
 * `native-skill-token` is deliberately name-agnostic: it rejects tokens
 * matching the current Claude dispatch grammar, even `$HOME` or `€deploy`.
 * Like the other detectors this is best-effort screening — rejecting a token
 * closes one known reinterpretation path but does not prove a provider will
 * never read the text as an instruction. Every other detector is kept narrow
 * so ordinary procedures ("vp test run …", project-relative paths, a `/name`
 * that starts a later line, mixed Korean/English text) pass untouched.
 *
 * @module skills/skillContentScreen
 */
import type { ProjectSkillContent, ProjectSkillScreenReason } from "@t3tools/contracts";

import { looksLikeSensitiveText } from "../memory/sensitiveText.ts";

/** Fixed enum order of `ProjectSkillScreenReason`; results come back in this order. */
const SCREEN_REASON_ORDER: ReadonlyArray<ProjectSkillScreenReason> = [
  "sensitive",
  "personal-path",
  "verifier-change",
  "permission-escalation",
  "instruction-injection",
  "native-skill-token",
  "block-delimiter",
];

const CONTENT_FIELDS = [
  "title",
  "purpose",
  "appliesWhen",
  "doesNotApplyWhen",
  "procedure",
  "successCheck",
] as const;

/**
 * Exact copy of `SKILL_MENTION_PATTERN` from
 * `../provider/Drivers/ClaudeSkillDispatch.ts` — the grammar that turns a
 * `$name`/`€name` mention into Claude Code's native skill invocation. Used
 * with `matchAll` only: the `g` flag makes `.test` stateful.
 */
const NATIVE_SKILL_TOKEN_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

/** Machine-specific home directories and private server state. */
const PERSONAL_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  // macOS and Linux absolute home directories with a user segment.
  /\/Users\/[^/\s]+\//,
  /\/home\/[^/\s]+\//,
  // Windows profile roots.
  /C:\\Users\\/,
  // SSH material under the user's home.
  /~\/\.ssh\b/,
  // T3 Code private server state; real user data lives here.
  /\.t3\/userdata/,
];

/** Directives that weaken or tamper with verification. */
const VERIFIER_CHANGE_PATTERNS: ReadonlyArray<RegExp> = [
  // English skip/disable/bypass directives aimed at verification.
  /\b(?:skip|disable|bypass)\s+(?:the\s+|all\s+|these\s+|those\s+|any\s+|your\s+|its\s+)?(?:pre[- ]?commit\s+|post[- ]?commit\s+)?(?:tests?|checks?|verifications?|verify|validation|lint)\b/i,
  // The git commit flag that skips hooks.
  /--no-verify/,
  // English edit directives aimed at the verifier's own inputs.
  /\b(?:edit|modify|change|update|rewrite|remove|delete)\b[^.\n]{0,60}\b(?:check\s+scripts?|selected[- ]checks?|t3\.json)\b/i,
  // Korean: 검사/테스트/검증/체크 (을/를/은/이/도) + 건너뛰/생략/스킵/우회/비활성(화)/끄/꺼/해제.
  /(?:검사|테스트|검증|체크)\s*(?:를|을|은|이|도)?\s*(?:건너뛰|생략|스킵|우회|비활성|끄|꺼|해제)/,
  // Korean edit directives aimed at check scripts or t3.json.
  /(?:검사|체크)\s*스크립트(?:를|을|도)?\s*(?:수정|변경|삭제|편집|고침)/,
  /t3\.json(?:을|를|도)?\s*(?:수정|변경|삭제|편집|고침)/,
];

/** Directives that raise the agent's authority or drop its guardrails. */
const PERMISSION_ESCALATION_PATTERNS: ReadonlyArray<RegExp> = [
  // Claude Code's unrestricted-mode flag.
  /--dangerously-skip-permissions/,
  // Root execution: "sudo apt install", Korean "sudo로 설치". \b rejects "pseudo".
  /\bsudo\b/,
  // World-writable permissions.
  /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\b/,
  // English approval/prompt/sandbox suppression.
  /\b(?:disable|skip|bypass|turn\s+off)\s+(?:the\s+|all\s+|your\s+)?(?:permission\s+prompts?|permission\s+checks?|approval\s+prompts?|approvals?|sandbox(?:ing)?|permission\s+mode)\b/i,
  // Korean: 승인/권한/샌드박스/허가 (프롬프트/확인/모드) 끄기·비활성·해제·우회·생략.
  /(?:승인|권한|샌드박스|허가)\s*(?:프롬프트|확인|모드)?\s*(?:를|을|이|도)?\s*(?:끄|꺼|비활성|해제|우회|생략|건너뛰)/,
];

/** Prompt-injection phrasing that discards prior instructions. */
const INSTRUCTION_INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  // English "ignore (all) previous instructions" phrasing.
  /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|earlier|above|preceding)\b[^.\n]{0,20}\b(?:instructions?|directions?|rules?)\b/i,
  // Korean: (이전/위/앞선/기존) 지시·지침·명령 무시/잊기/버리기.
  /(?:이전|기존|위|앞선|앞의|지금까지의)(?:의)?\s*(?:지시|지침|명령)(?:를|은|이|도)?\s*(?:무시|잊|버려|따르지)/,
];

/** Markers only the server's own block renderer may emit. */
const BLOCK_DELIMITERS: ReadonlyArray<string> = [
  "<oop-project-skill",
  "</oop-project-skill",
  "<t3_context",
  "<context",
];

const matchesAny = (patterns: ReadonlyArray<RegExp>, text: string): boolean =>
  patterns.some((pattern) => pattern.test(text));

const hasNativeSkillToken = (text: string): boolean =>
  [...text.matchAll(NATIVE_SKILL_TOKEN_PATTERN)].length > 0;

/**
 * Screen one piece of new project-skill content. Returns the rejection
 * reasons, deduplicated, in the fixed enum order — and nothing else. A
 * partial review-draft seed is screened over the fields it has: an absent
 * field is skipped, never screened as an invented empty string.
 */
export function screenProjectSkillContent(
  skill: Readonly<Partial<ProjectSkillContent>>,
): ReadonlyArray<ProjectSkillScreenReason> {
  const reasons = new Set<ProjectSkillScreenReason>();
  for (const field of CONTENT_FIELDS) {
    const text = skill[field];
    if (text === undefined) continue;
    if (looksLikeSensitiveText(text)) reasons.add("sensitive");
    if (matchesAny(PERSONAL_PATH_PATTERNS, text)) reasons.add("personal-path");
    if (matchesAny(VERIFIER_CHANGE_PATTERNS, text)) reasons.add("verifier-change");
    if (matchesAny(PERMISSION_ESCALATION_PATTERNS, text)) reasons.add("permission-escalation");
    if (matchesAny(INSTRUCTION_INJECTION_PATTERNS, text)) reasons.add("instruction-injection");
    if (hasNativeSkillToken(text)) reasons.add("native-skill-token");
    if (BLOCK_DELIMITERS.some((delimiter) => text.includes(delimiter))) {
      reasons.add("block-delimiter");
    }
  }
  return SCREEN_REASON_ORDER.filter((reason) => reasons.has(reason));
}
