import {
  PROJECT_MEMORY_TITLE_MAX_LENGTH,
  PROJECT_MEMORY_BODY_MAX_LENGTH,
  PROJECT_MEMORY_REASON_MAX_LENGTH,
  PROJECT_MEMORY_TIDY_RUN_MAX,
  PROJECT_MEMORY_TIDY_PENDING_MAX,
  type ProjectMemory,
} from "@t3tools/contracts";
import { looksLikeSensitiveText } from "./sensitiveText.ts";

export function selectTidyMemories(
  memories: ReadonlyArray<ProjectMemory>,
  pending: ReadonlySet<string>,
) {
  let budget = 40_000;
  return [...memories]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter(
      (m) =>
        !pending.has(m.memoryId) &&
        !looksLikeSensitiveText(m.title) &&
        !looksLikeSensitiveText(m.body),
    )
    .slice(0, 60)
    .filter((m) => {
      const size =
        JSON.stringify({ kind: m.kind, title: m.title, body: m.body, expiry: m.validUntil })
          .length + 30;
      if (size > budget) return false;
      budget -= size;
      return true;
    });
}

export function buildMemoryTidyInput(memories: ReadonlyArray<ProjectMemory>) {
  return JSON.stringify(
    memories.map((m, i) => ({
      label: `M${i + 1}`,
      kind: m.kind,
      title: m.title,
      body: m.body,
      expiry: m.validUntil,
    })),
  );
}

export interface MemoryTidyResult {
  suggestions: ReadonlyArray<{
    action: "merge" | "update" | "delete";
    memories: ReadonlyArray<string>;
    title?: string;
    body?: string;
    reason: string;
  }>;
}

const validText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !looksLikeSensitiveText(value);

export function selectMemoryTidies(
  output: MemoryTidyResult,
  memories: ReadonlyArray<ProjectMemory>,
  pendingCount = 0,
) {
  const accepted: Array<{
    action: "merge" | "update" | "delete";
    memories: ReadonlyArray<ProjectMemory>;
    title?: string;
    body?: string;
    reason: string;
  }> = [];
  const used = new Set<string>();
  const labels = new Map(memories.map((m, i) => [`M${i + 1}`, m]));
  const cap = Math.min(
    PROJECT_MEMORY_TIDY_RUN_MAX,
    Math.max(0, PROJECT_MEMORY_TIDY_PENDING_MAX - pendingCount),
  );
  for (const suggestion of output.suggestions) {
    if (accepted.length >= cap) break;
    const { action, memories: refs, title, body, reason } = suggestion;
    if (
      !Array.isArray(refs) ||
      new Set(refs).size !== refs.length ||
      refs.some((r) => !labels.has(r) || used.has(r))
    )
      continue;
    if (!validText(reason, PROJECT_MEMORY_REASON_MAX_LENGTH)) continue;
    if (action === "merge" ? refs.length < 2 || refs.length > 4 : refs.length !== 1) continue;
    if (action !== "merge" && action !== "update" && action !== "delete") continue;
    if (action === "delete") {
      if (title !== undefined || body !== undefined) continue;
    } else {
      if (
        !validText(title, PROJECT_MEMORY_TITLE_MAX_LENGTH) ||
        !validText(body, PROJECT_MEMORY_BODY_MAX_LENGTH)
      )
        continue;
      const first = labels.get(refs[0]!)!;
      if (action === "update" && title === first.title && body === first.body) continue;
    }
    refs.forEach((r) => used.add(r));
    accepted.push({
      action,
      memories: refs.map((r) => labels.get(r)!),
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
      reason,
    });
  }
  return accepted;
}
