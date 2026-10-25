/**
 * Reading an imported thread's title out of what the user actually asked.
 *
 * Both CLIs prepend harness-injected text to the first user message of a
 * transcript: Codex sends `<recommended_plugins>`, `<INSTRUCTIONS>` and
 * `<environment_context>` blocks, Claude Code sends an
 * `<environment_context>` block plus a "conversation history" caveat wrapper.
 * None of it was typed by the user, so a title taken from it names a plugin
 * list rather than a conversation.
 *
 * The real request is the first text outside those blocks. When a transcript
 * carries none — a preamble-only first message, which is what a session whose
 * user has not typed yet looks like — the caller keeps its own fallback.
 *
 * @module project/AgentSessionUserRequest
 */

/** Sidebar titles are single-line and bounded; matches the importer's own cap. */
const TITLE_MAX_LENGTH = 100;

/**
 * Blocks the harnesses inject. Their contents are harness text, never a
 * request.
 *
 * Unknown tags stay in the text. A prompt that legitimately contains markup is
 * more plausible than a harness inventing a new wrapper, and a wrong title is
 * recoverable where a missing request is not.
 */
const INJECTED_BLOCK_TAGS: ReadonlySet<string> = new Set([
  "Category_Context",
  "command-args",
  "command-message",
  "command-name",
  "environment_context",
  "INSTRUCTIONS",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "memory_notice",
  // OOP's crew brief, prepended to each lead turn while the crew is on (crewLogic.crewBrief).
  "oop_crew",
  "recalled-memory",
  "recommended_plugins",
  "scheduled-task",
  "skills_instructions",
  "system-reminder",
  "task-notification",
  "user_instructions",
]);

/**
 * Sentences that frame the injected text. Claude Code writes them as one run
 * with no trailing newline, and the transcript labels carry them inside
 * `<conversation_history>`.
 */
const INJECTED_WRAPPER_SENTENCES: ReadonlyArray<string> = [
  "The above is the conversation history so far, provided as context.",
  'Respond as the assistant to the user message below only. Never emit "USER:" or "ASSISTANT:" labels or continue the transcript.',
];

/**
 * Wrappers that hold turns rather than harness text. Claude Code's
 * `<conversation_history>` replays the conversation so far, so the last thing
 * inside it can be the user's own message. Only the container's own tags are
 * dropped; dropping its content would lose the only request in the transcript.
 */
const INJECTED_CONTAINER_TAGS: ReadonlySet<string> = new Set(["conversation_history"]);

/**
 * Task wrappers a delegating harness puts around a child run's notices
 * (`<scheduled-task>`, `<…-task>`): the whole family is harness text.
 */
const INJECTED_TASK_TAG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-task$/;

/**
 * Openings a delegating harness writes as the first real request of a run it
 * spawned. The user never typed these, and a thread whose request is one of
 * them is a delegated task transcript rather than a conversation the user had.
 *
 * The crew roles match `crewLogic.delegatePrompt`, which opens with the
 * lowercased role label; the launcher matches the harness that starts its
 * children with an optional quoted name and an optional trailing period.
 * Matching the text only: `entrypoint` and `promptSource` are identical on a
 * delegated run and on a conversation a user drives through the SDK. A
 * harness that names its child run (`You are running as an <harness> <kind>-task
 * child`) is matched by shape, whichever harness wrote it.
 */
const DELEGATION_PREAMBLE_PATTERN = /^You are running as an? [\w.-]+ [\w.-]+-task child\b/;
const DELEGATION_PREAMBLE_PREFIXES: ReadonlyArray<string> = [
  "You are the worker on an OOP crew.",
  "You are the expert on an OOP crew.",
  "You are the auditor on an OOP crew.",
];

/** Speaker labels a transcript uses around each turn. */
const INJECTED_ROLE_LABELS: ReadonlyArray<string> = ["USER:", "ASSISTANT:", "SYSTEM:"];

/** Heading the agent harness prepends before the shared instruction blocks. */
const INJECTED_HEADING_PATTERN = /^#\s*AGENTS\.md instructions\b[^\n]*\n?/i;

/**
 * Every message with the harness's own markup cut out of it. A known block is
 * dropped whole (an unclosed one runs to the end of the message: an
 * unterminated wrapper has no reliable end, and a truncated request is better
 * than a title taken from harness text), the transcript container keeps its
 * content, and markup nobody recognises stays exactly as the user wrote it.
 */
function textOutsideHarnessMarkup(text: string): string {
  const kept: Array<string> = [];
  let runStart = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "<") {
      index += 1;
      continue;
    }
    const opening = /^<(\/?)([A-Za-z][A-Za-z0-9_.-]*)\b[^>]*>/.exec(text.slice(index));
    if (opening === null) {
      index += 1;
      continue;
    }
    const tag = opening[2] ?? "";
    const isClosing = opening[1] === "/";
    const isContainer = INJECTED_CONTAINER_TAGS.has(tag);
    // Markup nobody recognises is the user's own text, both tags included;
    // only the harness's own tags, and the blocks they wrap, are cut.
    if (!isContainer && !INJECTED_BLOCK_TAGS.has(tag) && !INJECTED_TASK_TAG_PATTERN.test(tag)) {
      index += opening[0].length;
      continue;
    }
    // Flush the text in front of the tag first: dropping the run from here
    // would lose the request whenever a placeholder tag follows it.
    if (index > runStart) kept.push(text.slice(runStart, index));
    index += opening[0].length;
    runStart = index;
    if (isContainer || isClosing) continue;
    const closingIndex = text.indexOf(`</${tag}>`, index);
    index = closingIndex === -1 ? text.length : closingIndex + tag.length + 3;
    runStart = index;
  }
  kept.push(text.slice(runStart));
  return kept.join("");
}

/** Drop the wrapper sentences, role labels, and headings a message can start with. */
function stripWrappers(text: string): string {
  let remainder = text.trimStart();
  let stripped = true;
  while (stripped) {
    stripped = false;
    const heading = INJECTED_HEADING_PATTERN.exec(remainder);
    if (heading !== null) {
      remainder = remainder.slice(heading[0].length).trimStart();
      stripped = true;
      continue;
    }
    for (const label of INJECTED_ROLE_LABELS) {
      if (!remainder.startsWith(label)) continue;
      const lineEnd = remainder.indexOf("\n");
      remainder = (lineEnd === -1 ? "" : remainder.slice(lineEnd + 1)).trimStart();
      stripped = true;
      break;
    }
    if (stripped) continue;
    for (const sentence of INJECTED_WRAPPER_SENTENCES) {
      if (!remainder.startsWith(sentence)) continue;
      remainder = remainder.slice(sentence.length).trimStart();
      stripped = true;
      break;
    }
  }
  return remainder;
}

/**
 * The user's own first request in one message, or null when the message holds
 * nothing but harness text. Uncapped, because both the title and the
 * delegation check read it.
 */
export function firstRealUserRequest(text: string): string | null {
  const firstLine = stripWrappers(textOutsideHarnessMarkup(text))
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  return firstLine !== undefined && firstLine.length > 0 ? firstLine : null;
}

/** The earliest user message that holds a real request, across messages. */
export function deriveFirstUserRequest(texts: Iterable<string>): string | null {
  for (const text of texts) {
    const request = firstRealUserRequest(text);
    if (request !== null) return request;
  }
  return null;
}

/** Sidebar form of a request: one line, bounded. */
export function threadTitleFromRequest(request: string): string {
  return request.trim().slice(0, TITLE_MAX_LENGTH).trim();
}

/**
 * The title for an imported thread, taken from the earliest user message that
 * holds a real request. Null when no message does, so the caller can keep its
 * own fallback rather than importing the harness text.
 */
export function deriveThreadTitleFromUserTexts(texts: Iterable<string>): string | null {
  const request = deriveFirstUserRequest(texts);
  return request === null ? null : threadTitleFromRequest(request);
}

/**
 * Whether a session's first real request is a delegation harness's own
 * opening rather than something the user asked.
 */
export function isDelegationPreambleRequest(request: string): boolean {
  const text = request.trim();
  return (
    DELEGATION_PREAMBLE_PATTERN.test(text) ||
    DELEGATION_PREAMBLE_PREFIXES.some(
      (prefix) => text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}.`),
    )
  );
}

/**
 * `Imported Codex session · 2026-09-30`, the title a session with no request
 * to name it by gets. A new import and the repair of an earlier one must agree:
 * a session the user never typed into reads the same either way.
 */
export function importedSessionFallbackTitle(
  providerInstanceId: string,
  createdAt: string,
): string {
  const instance = providerInstanceId.toLowerCase();
  const source = instance.startsWith("claude")
    ? "Claude"
    : instance.startsWith("codex")
      ? "Codex"
      : "agent";
  return `Imported ${source} session · ${createdAt.slice(0, 10)}`;
}

/**
 * Whether a stored title is harness preamble instead of a request. Used to
 * repair threads imported before titles were derived from the real request.
 */
export function isInjectedPreambleTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.startsWith("<") || INJECTED_HEADING_PATTERN.test(trimmed);
}
