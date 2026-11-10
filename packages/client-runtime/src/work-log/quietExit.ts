/**
 * A failed shell command that is only a query's "no" answer — a grep that found nothing, a false
 * `test`, a `kill -0` probe — reads as a failure in every tool view, though nothing broke.
 * `isQuietCommandExit` decides, conservatively: an item stays a real failure unless the exit code
 * is known to be exactly 1, the output reports no trouble, and the last command is one whose exit
 * 1 only means "no". Pure: it reads the item it is given and nothing else.
 */

interface QuietExitFacts {
  readonly output: string;
  readonly command: unknown;
}

const QUIET_PROGRAMS: ReadonlySet<string> = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "test",
  "[",
  "[[",
  "pgrep",
  "which",
  "diff",
  "cmp",
]);

const COMMAND_PREFIXES: ReadonlySet<string> = new Set(["sudo", "time", "env"]);

/** Output carrying any of these reports trouble, so an exit 1 beside them is a real failure. */
const ERROR_WORDS: ReadonlyArray<string> = [
  "error",
  "fail",
  "fatal",
  "no such file",
  "not found",
  "denied",
  "traceback",
  "panic",
  "exception",
  "enoent",
  "eacces",
  "cannot",
  "can't",
  "unable",
  "invalid",
  "refused",
  "timeout",
  "timed out",
  "abort",
  "segmentation",
  "killed",
  "blocked",
  "✗",
  "×",
  "no matches found",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Claude results carry text either as one string or as `{type: "text", text}` blocks. */
function resultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  const blocks = Array.isArray(content) ? content : null;
  if (blocks === null) return null;
  const chunks = blocks.flatMap((blockValue) => {
    const block = asRecord(blockValue);
    const text = block?.type === "text" && typeof block.text === "string" ? block.text : null;
    return text === null ? [] : [text];
  });
  return chunks.length > 0 ? chunks.join("\n") : null;
}

/**
 * The exit facts a payload must state outright: a Codex item's numeric `exitCode`, or a Claude
 * result (or raw output) whose first line is the code. Any other shape (ACP records without a code) proves
 * nothing and stays a real failure.
 */
function quietExitFacts(dataValue: unknown): QuietExitFacts | null {
  const data = asRecord(dataValue);
  if (data === null) return null;
  const item = asRecord(data.item);
  const itemExitCode = typeof item?.exitCode === "number" ? item.exitCode : undefined;
  if (itemExitCode !== undefined) {
    if (itemExitCode !== 1) return null;
    return {
      output: typeof item?.aggregatedOutput === "string" ? item.aggregatedOutput : "",
      command: item?.command,
    };
  }
  // Claude states the code as the first line of its result, under `result` or `rawOutput`.
  const content =
    resultText(asRecord(data.result)?.content) ?? resultText(asRecord(data.rawOutput)?.content);
  if (content !== null) {
    const newlineAt = content.indexOf("\n");
    const firstLine = (newlineAt === -1 ? content : content.slice(0, newlineAt)).trim();
    if (firstLine !== "Exit code 1") return null;
    return {
      output: newlineAt === -1 ? "" : content.slice(newlineAt + 1),
      command: asRecord(data.input)?.command ?? data.command,
    };
  }
  return null;
}

/** Unwraps a `/bin/zsh -lc '…'` / `bash -lc "…"` wrapper; an unterminated quote leaves it on. */
function unwrapShellWrapper(command: string): string {
  const wrapper = /^(?:(?:[\w.-]+)?\/)*(?:zsh|bash|sh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(
    command.trim(),
  );
  return wrapper === null ? command : (wrapper[2] ?? command);
}

/** Splits on newlines, `;`, `&&`, `||`, and `|` outside quotes; empty segments dropped. */
function splitCommandSegments(script: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]!;
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "\n" || character === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if (character === "|") {
      if (script[index + 1] === "|") index += 1;
      segments.push(current);
      current = "";
      continue;
    }
    if (character === "&" && script[index + 1] === "&") {
      index += 1;
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

function stripLeadingAssignments(segment: string): string {
  let current = segment.trim();
  for (;;) {
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)(?:\s+|$)/.exec(current);
    if (assignment === null) return current;
    current = current.slice(assignment[0].length).trim();
    if (current.length === 0) return current;
  }
}

function stripLeadingPrefixes(segment: string): string {
  let current = segment.trim();
  for (;;) {
    const space = current.search(/\s/);
    const first = space === -1 ? current : current.slice(0, space);
    if (!COMMAND_PREFIXES.has(first)) return current;
    current = space === -1 ? "" : current.slice(space + 1).trim();
    if (current.length === 0) return current;
  }
}

function unquote(token: string): string {
  return /^(['"]).*\1$/.test(token) ? token.slice(1, -1) : token;
}

/** Whether the last command's exit 1 can only mean "no": a query tool, probe, or quiet git check. */
function lastCommandQueries(commandValue: unknown): boolean {
  if (typeof commandValue !== "string") return false;
  const segments = splitCommandSegments(unwrapShellWrapper(commandValue));
  const last = segments.at(-1);
  if (last === undefined) return false;
  const segment = stripLeadingPrefixes(stripLeadingAssignments(last));
  if (segment.trimStart().startsWith("!")) return false;
  const tokens = segment
    .trim()
    .split(/\s+/)
    .map((token) => unquote(token));
  const program = tokens[0]?.replace(/^.*[/\\]/, "").toLowerCase();
  if (program === undefined || program.length === 0) return false;
  if (QUIET_PROGRAMS.has(program)) return true;
  switch (program) {
    case "kill":
      return tokens[1] === "-0";
    case "command":
      return tokens[1] === "-v";
    case "type":
      return true;
    case "git":
      if (tokens[1] === "grep") return true;
      return tokens[1] === "diff" && (tokens.includes("--quiet") || tokens.includes("--exit-code"));
    default:
      return false;
  }
}

export interface QuietExitCandidate {
  /** The canonical item type; only `command_execution` can be a quiet exit. */
  readonly itemType?: unknown;
  /** The runtime item status; only `failed` items are candidates. */
  readonly status?: unknown;
  /** The tool payload `data`, in its Codex (`item`) or Claude (`result`/`input`) shape. */
  readonly data?: unknown;
}

/**
 * Whether a failed command item is a quiet exit: an intended "no" to show muted as "exit 1"
 * instead of failed. Everything it cannot prove — an unknown or non-1 exit code, error words in
 * the output, a last command that mutates rather than queries — stays a real failure.
 */
export function isQuietCommandExit(candidate: QuietExitCandidate): boolean {
  if (candidate.itemType !== "command_execution" || candidate.status !== "failed") return false;
  const facts = quietExitFacts(candidate.data);
  if (facts === null) return false;
  const output = facts.output.toLowerCase();
  if (ERROR_WORDS.some((word) => output.includes(word))) return false;
  return lastCommandQueries(facts.command);
}
