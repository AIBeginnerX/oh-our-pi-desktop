import {
  PLAN_IMPLEMENTATION_PROMPT_PREFIX,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "@t3tools/client-runtime/thread-plan";
import type {
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

import { CREW_AUDIT_SKIPPED_ACTIVITY, THREAD_GOAL_ACTIVITY } from "@t3tools/shared/threadGoal";

import { auditSkippedText, crewStatusWord, followUpText, roleName } from "../render/crewBoard.ts";
import { MarkdownStream } from "../render/markdown.ts";
import { RAIL_COLUMNS, railDone, railGap, railRow, type Rail } from "../render/rail.ts";
import { userBubble } from "../render/userBubble.ts";
import type { Style } from "../render/style.ts";
import { type Symbols, UNICODE_SYMBOLS } from "../render/symbols.ts";
import { asRecord, firstLine, toolLines } from "../render/toolLine.ts";
import { sanitizeForTerminal } from "../text/width.ts";
import { truncateStyled, wrapStyled } from "../text/wrap.ts";
import { t } from "../i18n/index.ts";

interface MessageProgress {
  /** Characters of `text` already handed to the Markdown stream (always ends at a line start). */
  offset: number;
  readonly markdown: MarkdownStream;
  done: boolean;
}

export interface TranscriptSync {
  /** Finished lines, written once into the scrollback. */
  readonly commit: ReadonlyArray<string>;
  /** The unfinished tail of the message being streamed; shown in the live region only. */
  readonly partial: ReadonlyArray<string>;
}

export interface TranscriptOptions {
  readonly width: number;
  readonly style: Style;
  /** How many recent messages to print when a thread is opened. */
  readonly historyMessages: number;
  /** The glyphs to draw with; Unicode when not given. */
  readonly symbols?: Symbols;
}

/** `push(...rows)` throws a RangeError past ~120k rows, which a very long message reaches. */
const appendRows = (target: string[], rows: ReadonlyArray<string>): void => {
  for (const row of rows) target.push(row);
};

const formatTokens = (count: number): string =>
  count < 1000 ? String(count) : `${(count / 1000).toFixed(1).replace(/\.0$/u, "")}k`;

/** What a block of the transcript is, which decides whether a bare `│` separates it from the last. */
type BlockKind = "user" | "reply" | "tool" | "event";

const isRun = (kind: BlockKind | null): boolean => kind === "tool" || kind === "event";

/**
 * Turns thread state into terminal lines exactly once, hung off a left rail: a user message is a
 * `◇` step, a reply, a tool result and a one-line event are rows under it, and a bare `│` separates
 * blocks (tools and events that follow one another stay together). A message streams in as growing
 * text; only complete lines are committed, so a long thread is never reprinted and a delta costs one
 * line of Markdown work. A tool becomes a line (and a result line) when it finishes; its progress
 * while running belongs to the live work row. The first block is preceded by a `│`, so whoever prints
 * the rail's opening row does not add one.
 */
export class TranscriptPrinter {
  private readonly messages = new Map<string, MessageProgress>();
  private readonly seenActivities = new Set<string>();
  private readonly seenPlans = new Set<string>();
  /** When each running tool started, so its finish can say how long it took. */
  private readonly toolStarts = new Map<string, number>();
  private primed = false;
  /** Whether the last row written was a bare `│`; the next block needs one before it unless it was. */
  private lastGap = false;
  private lastKind: BlockKind | null = null;
  private lastReplyId: string | null = null;
  private skipped = 0;

  private readonly options: TranscriptOptions;
  private readonly symbols: Symbols;
  private readonly rail: Rail;

  constructor(options: TranscriptOptions) {
    this.options = options;
    this.symbols = options.symbols ?? UNICODE_SYMBOLS;
    this.rail = { style: options.style, symbols: this.symbols };
  }

  /** Columns a row of text has to itself, after the rail. */
  private get textWidth(): number {
    return Math.max(1, this.options.width - RAIL_COLUMNS);
  }

  /** Visible messages the opening skipped as older than the window it prints; 0 until the first sync. */
  get skippedMessages(): number {
    return this.skipped;
  }

  /**
   * `more` says the server holds turns older than the thread given: the first sync then adds that
   * to the note about what it left out.
   */
  sync(thread: OrchestrationThread, more = false): TranscriptSync {
    const commit: string[] = [];
    let partial: {
      readonly id: string;
      readonly rows: ReadonlyArray<string>;
      readonly gap: boolean;
    } | null = null;
    const { style } = this.options;

    const visibleMessages = thread.messages.filter((message) => message.role !== "reasoning");
    let firstMessageIndex = 0;
    let cutoff = "";
    if (!this.primed) {
      firstMessageIndex = Math.max(0, visibleMessages.length - this.options.historyMessages);
      const first = visibleMessages[firstMessageIndex];
      cutoff = first?.createdAt ?? "";
      this.skipped = firstMessageIndex;
      if (firstMessageIndex > 0 || more) {
        const count =
          firstMessageIndex === 0
            ? t("render.transcript.earlierSome")
            : t(more ? "render.transcript.earlierCountMore" : "render.transcript.earlierCount", {
                count: firstMessageIndex,
              });
        const note = style.theme.dim(t("render.transcript.historyNote", { count }));
        this.take(
          commit,
          "event",
          wrapStyled(note, this.textWidth).map((row) => railRow(this.rail, row)),
        );
      }
      // Everything older than the printed window is treated as seen.
      for (let index = 0; index < firstMessageIndex; index += 1) {
        const message = visibleMessages[index] as OrchestrationMessage;
        this.messages.set(message.id, this.newProgress(message.text.length, true));
      }
      for (const activity of thread.activities) {
        if (cutoff !== "" && activity.createdAt < cutoff) {
          this.seenActivities.add(activity.id);
          this.noteToolStart(activity);
        }
      }
      for (const plan of thread.proposedPlans) {
        if (cutoff !== "" && plan.createdAt < cutoff) this.seenPlans.add(plan.id);
      }
      this.primed = true;
    }

    type Entry =
      | { readonly at: string; readonly kind: "message"; readonly message: OrchestrationMessage }
      | {
          readonly at: string;
          readonly kind: "activity";
          readonly activity: OrchestrationThreadActivity;
        }
      | { readonly at: string; readonly kind: "plan"; readonly plan: OrchestrationProposedPlan };
    const entries: Entry[] = [];
    for (let index = firstMessageIndex; index < visibleMessages.length; index += 1) {
      const message = visibleMessages[index] as OrchestrationMessage;
      const progress = this.messages.get(message.id);
      if (progress?.done === true && progress.offset >= message.text.length) continue;
      entries.push({ at: message.createdAt, kind: "message", message });
    }
    for (const activity of thread.activities) {
      if (this.seenActivities.has(activity.id)) continue;
      entries.push({ at: activity.createdAt, kind: "activity", activity });
    }
    // A plan the agent proposed is written once, where it was first proposed: after the reply it ends,
    // before the message that builds it (building it later stamps the plan updated).
    for (const plan of thread.proposedPlans) {
      if (!this.seenPlans.has(plan.id)) entries.push({ at: plan.createdAt, kind: "plan", plan });
    }
    entries.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));

    for (const entry of entries) {
      if (entry.kind === "plan") {
        this.seenPlans.add(entry.plan.id);
        const { rows, literal } = this.planRows(entry.plan);
        this.take(commit, "reply", rows, `plan:${entry.plan.id}`, literal);
        continue;
      }
      if (entry.kind === "activity") {
        this.seenActivities.add(entry.activity.id);
        const { kind, rows } = this.activityBlock(entry.activity);
        this.take(commit, kind, rows);
        continue;
      }
      const result = this.messageLines(entry.message, commit);
      if (result !== null) partial = result;
    }
    // The tail's own `│` is decided last, once everything committed this time is known.
    const tail =
      partial === null
        ? []
        : [
            ...((partial.gap || !this.continues(partial.id)) && !this.lastGap
              ? [railGap(this.rail)]
              : []),
            ...partial.rows,
          ];
    return { commit, partial: tail };
  }

  private newProgress(offset: number, done: boolean): MessageProgress {
    return {
      offset,
      done,
      markdown: new MarkdownStream({
        width: this.options.width,
        style: this.options.style,
        symbols: this.symbols,
        railed: true,
      }),
    };
  }

  /** Whether the reply with this id is the block written last, so its next row needs no `│` before it. */
  private continues(id: string): boolean {
    return this.lastKind === "reply" && this.lastReplyId === id;
  }

  /**
   * Appends a block's rows to `commit`, with a bare `│` before them unless the last row already is
   * one or both blocks are tool or event lines, which stay together. A `│` that would double up is
   * dropped. `literal` names the rows (by index) that are code or diff text: they are never taken
   * for a `│`, whatever characters they hold, and are written as they are.
   */
  private take(
    commit: string[],
    kind: BlockKind,
    rows: ReadonlyArray<string>,
    replyId: string | null = null,
    literal: ReadonlySet<number> = new Set(),
  ): void {
    if (rows.length === 0) return;
    const gap = railGap(this.rail);
    const continuing = kind === "reply" && replyId !== null && this.continues(replyId);
    if (!continuing && !(isRun(kind) && isRun(this.lastKind)) && !this.lastGap) {
      commit.push(gap);
      this.lastGap = true;
    }
    rows.forEach((row, index) => {
      const isGap = row === gap && !literal.has(index);
      if (isGap && this.lastGap) return;
      commit.push(row);
      this.lastGap = isGap;
    });
    this.lastKind = kind;
    this.lastReplyId = kind === "reply" ? replyId : null;
  }

  /**
   * A proposed plan: its title, its Markdown, and how to build it. Rows of a code block are named
   * in `literal`, as for a reply. A plan that was built already carries no hint.
   */
  private planRows(plan: OrchestrationProposedPlan): {
    readonly rows: string[];
    readonly literal: Set<number>;
  } {
    const { theme } = this.options.style;
    const markdown = new MarkdownStream({
      width: this.options.width,
      style: this.options.style,
      symbols: this.symbols,
      railed: true,
    });
    const title = proposedPlanTitle(plan.planMarkdown);
    const rows = [
      railDone(
        this.rail,
        truncateStyled(
          `${theme.text.bold(t("render.transcript.plan"))}${title === null ? "" : theme.dim(` · ${sanitizeForTerminal(title)}`)}`,
          this.textWidth,
        ),
      ),
      railGap(this.rail),
    ];
    const literal = new Set<number>();
    for (const line of sanitizeForTerminal(stripDisplayedPlanMarkdown(plan.planMarkdown)).split(
      "\n",
    )) {
      const inCode = markdown.inCode;
      const pushed = markdown.pushLine(line);
      const opened = !inCode && markdown.inCode;
      pushed.forEach((_, index) => {
        if (inCode || (opened && index === pushed.length - 1)) literal.add(rows.length + index);
      });
      appendRows(rows, pushed);
    }
    const inCode = markdown.inCode;
    const closing = markdown.finish();
    if (inCode) closing.forEach((_, index) => literal.add(rows.length + index));
    appendRows(rows, closing);
    if (plan.implementedAt === null) {
      rows.push(
        railGap(this.rail),
        ...wrapStyled(theme.dim(t("render.transcript.implementHint")), this.textWidth).map((row) =>
          railRow(this.rail, row),
        ),
      );
    }
    return { rows, literal };
  }

  private userRows(text: string): string[] {
    const { style } = this.options;
    // The message that builds a plan repeats the plan, which was written above when it was proposed.
    if (text.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX)) {
      const title = proposedPlanTitle(text.slice(PLAN_IMPLEMENTATION_PROMPT_PREFIX.length));
      return [
        railDone(
          this.rail,
          truncateStyled(
            style.bold(
              `${t("render.transcript.implementing")}${title === null ? "" : ` · ${sanitizeForTerminal(title)}`}`,
            ),
            this.textWidth,
          ),
        ),
      ];
    }
    // Against the right edge, in the theme's user tint: the agent's text stays on the rail.
    return userBubble(this.rail, sanitizeForTerminal(text), this.options.width);
  }

  private messageLines(
    message: OrchestrationMessage,
    commit: string[],
  ): { readonly id: string; readonly rows: ReadonlyArray<string>; readonly gap: boolean } | null {
    const { style } = this.options;
    let progress = this.messages.get(message.id);
    if (!progress) {
      progress = this.newProgress(0, false);
      this.messages.set(message.id, progress);
    }

    if (message.role === "user") {
      if (!progress.done) {
        progress.done = true;
        progress.offset = message.text.length;
        this.take(commit, "user", this.userRows(message.text));
      }
      return null;
    }

    if (message.role === "system") {
      if (!progress.done) {
        progress.done = true;
        progress.offset = message.text.length;
        const rows = sanitizeForTerminal(message.text)
          .split("\n")
          .flatMap((line) => wrapStyled(style.theme.dim(line), this.textWidth))
          .map((row) => railRow(this.rail, row));
        this.take(commit, "event", rows);
      }
      return null;
    }

    // assistant
    const text = message.text;
    if (progress.offset > text.length) progress.offset = text.length;
    const streaming = message.streaming;
    const cut = streaming ? text.lastIndexOf("\n") + 1 : text.length;
    if (cut > progress.offset) {
      // Cleaned before it is split into lines: a stray carriage return would otherwise add a row.
      const chunk = sanitizeForTerminal(text.slice(progress.offset, cut)).replace(/\n$/u, "");
      const rows: string[] = [];
      const literal = new Set<number>();
      for (const line of chunk.split("\n")) {
        const inCode = progress.markdown.inCode;
        const pushed = progress.markdown.pushLine(line);
        // Inside a fence every row is code; the line that opens one ends with its language row.
        const opened = !inCode && progress.markdown.inCode;
        pushed.forEach((_, index) => {
          if (inCode || (opened && index === pushed.length - 1)) literal.add(rows.length + index);
        });
        appendRows(rows, pushed);
      }
      this.take(commit, "reply", rows, message.id, literal);
      progress.offset = cut;
    }
    if (!streaming && !progress.done) {
      // Whatever closes a fence that is still open is code too.
      const inCode = progress.markdown.inCode;
      const rows = progress.markdown.finish();
      this.take(commit, "reply", rows, message.id, new Set(inCode ? rows.keys() : []));
      progress.done = true;
      return null;
    }
    if (!streaming) return null;

    const tail = sanitizeForTerminal(text.slice(progress.offset));
    if (tail === "") return null;
    // Code is not on the rail, so the part of a code block still being typed is not either.
    const rows = tail
      .split("\n")
      .flatMap((line) =>
        progress.markdown.inCode
          ? wrapStyled(line, this.options.width)
          : wrapStyled(line, this.textWidth).map((row) => railRow(this.rail, row)),
      );
    return { id: message.id, rows, gap: progress.markdown.gapDue };
  }

  private noteToolStart(activity: OrchestrationThreadActivity): void {
    if (activity.kind !== "tool.started") return;
    const id = asRecord(activity.payload).toolCallId;
    const at = Date.parse(activity.createdAt);
    if (typeof id === "string" && Number.isFinite(at)) this.toolStarts.set(id, at);
  }

  /** How long a finished tool ran, from its start activity; null when that was never seen. */
  private takeElapsed(activity: OrchestrationThreadActivity): number | null {
    const id = asRecord(activity.payload).toolCallId;
    if (typeof id !== "string") return null;
    const started = this.toolStarts.get(id);
    this.toolStarts.delete(id);
    const finished = Date.parse(activity.createdAt);
    return started !== undefined && Number.isFinite(finished) ? finished - started : null;
  }

  /** A notice, led by `mark` in the colour of its kind in the place of the rail's own mark. */
  private noticeRows(paint: (text: string) => string, mark: string, text: string): string[] {
    return wrapStyled(paint(text), this.textWidth).map((row, index) =>
      index === 0 ? `${paint(mark)}  ${row}` : railRow(this.rail, row),
    );
  }

  /**
   * One line for a crew task starting, switching model or ending, and for an audit left out or a
   * follow-up sent; null for any other activity. Other agents' tasks are shown only while they run.
   */
  private crewRows(
    activity: OrchestrationThreadActivity,
    payload: Record<string, unknown>,
  ): string[] | null {
    const { theme } = this.options.style;
    // Wrapped, not cut: the model and the name of the task are what these lines are for.
    const dim = (text: string) =>
      wrapStyled(theme.dim(text), this.textWidth).map((row) => railRow(this.rail, row));
    if (activity.kind === CREW_AUDIT_SKIPPED_ACTIVITY) {
      return dim(auditSkippedText(payload.changedFiles));
    }
    if (activity.kind === "crew.follow-up") return dim(followUpText(payload.reason));
    const taskKinds = ["task.started", "task.progress", "task.completed"];
    if (!taskKinds.includes(activity.kind) || typeof payload.crewRole !== "string") return null;
    const who = `crew ${roleName(payload.crewRole)}`;
    const title = firstLine(payload.title);
    const model = firstLine(payload.model);
    const subject = `${title === "" ? "" : ` · ${title}`}${model === "" ? "" : ` (${model})`}`;
    if (activity.kind !== "task.completed") {
      return dim(
        `${who} ${
          activity.kind === "task.started"
            ? t("render.transcript.taskStarted")
            : t("render.transcript.taskModel")
        }${subject}`,
      );
    }
    const status = payload.status;
    const line = `${who} ${crewStatusWord(status) ?? t("render.transcript.taskEnded")}${subject}`;
    if (status === "completed") {
      return wrapStyled(theme.success(line), this.textWidth).map((row, index) =>
        index === 0 ? railDone(this.rail, row) : railRow(this.rail, row),
      );
    }
    return this.noticeRows(
      status === "failed" ? theme.error : theme.warning,
      status === "failed" ? this.symbols.cross : this.symbols.warning,
      line,
    );
  }

  private activityBlock(activity: OrchestrationThreadActivity): {
    readonly kind: BlockKind;
    readonly rows: string[];
  } {
    const { style, width } = this.options;
    const { theme } = style;
    const payload = asRecord(activity.payload);
    const detail = firstLine(payload.detail) || firstLine(payload.message);
    const described = `${firstLine(activity.summary)}${detail ? ` - ${detail}` : ""}`;

    if (activity.kind === "tool.started") {
      this.noteToolStart(activity);
      return { kind: "tool", rows: [] };
    }
    if (activity.kind === "tool.completed" || activity.kind === "tool.denied") {
      const rows = toolLines(activity, this.takeElapsed(activity), {
        width,
        style,
        symbols: this.symbols,
      });
      return { kind: "tool", rows };
    }
    if (activity.kind === "runtime.error") {
      return {
        kind: "event",
        rows: this.noticeRows(theme.error.bold, this.symbols.cross, described),
      };
    }
    if (activity.kind === "runtime.warning") {
      return {
        kind: "event",
        rows: this.noticeRows(theme.warning, this.symbols.warning, described),
      };
    }
    if (activity.kind === "context-compaction") {
      const before = payload.beforeTokens;
      const after = payload.afterTokens;
      const tokens =
        typeof before === "number" && typeof after === "number"
          ? t("render.transcript.compactionTokens", {
              before: formatTokens(before),
              after: formatTokens(after),
            })
          : "";
      return {
        kind: "event",
        rows: [
          railDone(
            this.rail,
            truncateStyled(
              theme.info(t("render.transcript.compaction", { tokens })),
              this.textWidth,
            ),
          ),
        ],
      };
    }
    // How a goal ended is one line; the server decides it, this only says so.
    if (activity.kind === THREAD_GOAL_ACTIVITY.met) {
      return {
        kind: "event",
        rows: [
          railDone(
            this.rail,
            truncateStyled(theme.success(t("render.transcript.goalMet")), this.textWidth),
          ),
        ],
      };
    }
    if (activity.kind === THREAD_GOAL_ACTIVITY.blocked) {
      const reason = firstLine(payload.reason);
      return {
        kind: "event",
        rows: this.noticeRows(
          theme.warning,
          this.symbols.warning,
          t("render.transcript.goalBlocked", { reason: reason === "" ? "" : `: ${reason}` }),
        ),
      };
    }
    if (activity.kind === THREAD_GOAL_ACTIVITY.exhausted) {
      return {
        kind: "event",
        rows: this.noticeRows(
          theme.warning,
          this.symbols.warning,
          t("render.transcript.goalExhausted"),
        ),
      };
    }
    // The crew's tasks: a line when one starts and one when it ends, and what the crew did about the turn.
    const crew = this.crewRows(activity, payload);
    if (crew !== null) return { kind: "event", rows: crew };
    // Failed turn starts, interrupts and replies are recorded only as error-toned activities.
    if (activity.tone === "error") {
      return {
        kind: "event",
        rows: this.noticeRows(theme.error.bold, this.symbols.cross, described),
      };
    }
    return { kind: "event", rows: [] };
  }
}
