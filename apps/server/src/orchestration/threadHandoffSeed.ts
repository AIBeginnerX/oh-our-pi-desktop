import type { OrchestrationThread } from "@t3tools/contracts";

/**
 * The note a "continue in new thread" starts from. Built from facts the server already holds,
 * with no model call: the same thread always yields the same text, which clients place in the
 * composer as an editable draft.
 */
export const THREAD_HANDOFF_SEED_MAX_CHARS = 2_000;

const TITLE_MAX = 120;
const GOAL_MAX = 400;
const LAST_RESULT_MAX = 700;
const FILES_MAX = 20;
const FILE_PATH_MAX = 120;
const OPEN_ITEMS_MAX = 8;
const OPEN_ITEM_MAX = 140;

const PLAN_UPDATED_ACTIVITY = "turn.plan.updated";

const CLOSING_LINE =
  "Read files by path in the workspace instead of asking me to paste their content.";

type ThreadFacts = Pick<
  OrchestrationThread,
  "id" | "title" | "messages" | "checkpoints" | "activities"
>;

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Newest first, so a long thread's recent edits survive the cap. Each path appears once. */
function changedFiles(checkpoints: ThreadFacts["checkpoints"]): ReadonlyArray<string> {
  const ordered = checkpoints
    .filter((checkpoint) => checkpoint.status === "ready")
    .toSorted((a, b) => b.checkpointTurnCount - a.checkpointTurnCount);
  const paths = new Set<string>();
  for (const checkpoint of ordered) {
    for (const file of checkpoint.files) {
      paths.add(excerpt(file.path, FILE_PATH_MAX));
      if (paths.size >= FILES_MAX) return [...paths];
    }
  }
  return [...paths];
}

/** The unfinished steps of the thread's most recent plan or todo list. */
function openItems(activities: ThreadFacts["activities"]): ReadonlyArray<string> {
  let latest: ThreadFacts["activities"][number] | null = null;
  for (const activity of activities) {
    if (activity.kind !== PLAN_UPDATED_ACTIVITY) continue;
    if (
      latest === null ||
      (typeof activity.sequence === "number" && typeof latest.sequence === "number"
        ? activity.sequence >= latest.sequence
        : activity.createdAt >= latest.createdAt)
    ) {
      latest = activity;
    }
  }
  const raw = (latest?.payload as { readonly plan?: unknown } | null | undefined)?.plan;
  if (!Array.isArray(raw)) return [];
  const items: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { step, status } = entry as { readonly step?: unknown; readonly status?: unknown };
    if (typeof step === "string" && step.trim() !== "" && status !== "completed") {
      items.push(excerpt(step, OPEN_ITEM_MAX));
    }
  }
  return items.slice(0, OPEN_ITEMS_MAX);
}

export function buildThreadHandoffSeed(input: {
  readonly thread: ThreadFacts;
  /** The thread's goal text when it has one; otherwise its first user message stands in. */
  readonly goalText: string | null;
}): string {
  const { thread } = input;
  const firstUser = thread.messages.find(
    (message) => message.role === "user" && message.text.trim() !== "",
  );
  const lastAssistant = thread.messages.findLast(
    (message) => message.role === "assistant" && message.text.trim() !== "",
  );
  const goal =
    input.goalText !== null && input.goalText.trim() !== "" ? input.goalText : firstUser?.text;
  const files = [...changedFiles(thread.checkpoints)];
  const items = openItems(thread.activities);

  const compose = () =>
    [
      `Continuing from thread "${excerpt(thread.title, TITLE_MAX)}" (id: ${thread.id})`,
      ...(goal ? [`Goal: ${excerpt(goal, GOAL_MAX)}`] : []),
      ...(lastAssistant ? [`Last result: ${excerpt(lastAssistant.text, LAST_RESULT_MAX)}`] : []),
      ...(files.length > 0
        ? [["Changed files:", ...files.map((path) => `- ${path}`)].join("\n")]
        : []),
      ...(items.length > 0
        ? [["Open items:", ...items.map((item) => `- ${item}`)].join("\n")]
        : []),
      CLOSING_LINE,
    ].join("\n\n");
  // Long paths give way first: they are the only list the reader can rebuild from the workspace.
  let seed = compose();
  while (seed.length > THREAD_HANDOFF_SEED_MAX_CHARS && files.length > 0) {
    files.pop();
    seed = compose();
  }
  // The remaining sections are individually capped; the slice only guards their sum.
  return seed.length <= THREAD_HANDOFF_SEED_MAX_CHARS
    ? seed
    : `${seed.slice(0, THREAD_HANDOFF_SEED_MAX_CHARS - 1)}…`;
}
