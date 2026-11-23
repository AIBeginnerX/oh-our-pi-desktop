import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineMinimapPosition {
  readonly id: string;
  readonly rowIndex: number;
  assistantRowIndex: number | null;
}

interface TimelineMinimapPreview {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): ReadonlyArray<TimelineMinimapPosition> {
  const items: TimelineMinimapPosition[] = [];
  let current: TimelineMinimapPosition | undefined;
  for (const [rowIndex, row] of rows.entries()) {
    if (row.kind !== "message") continue;
    if (row.message.role === "user") {
      current = { id: row.id, rowIndex, assistantRowIndex: null };
      items.push(current);
    } else if (current && row.message.role === "assistant") {
      current.assistantRowIndex = rowIndex;
    }
  }
  return items;
}

function compactMinimapPreview(text: string | null) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

export function createTimelineMinimapPreviewStore() {
  let rows: ReadonlyArray<MessagesTimelineRow> = [];
  const listeners = new Set<() => void>();
  const textAt = (index: number | null) => {
    const row = index === null ? undefined : rows[index];
    return row?.kind === "message" ? row.message.text : null;
  };
  return {
    setRows(next: ReadonlyArray<MessagesTimelineRow>) {
      if (rows === next) return;
      rows = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshotFor(position: TimelineMinimapPosition) {
      let lastUser: string | null = null;
      let lastAssistant: string | null = null;
      let snapshot: TimelineMinimapPreview | undefined;
      return () => {
        const user = textAt(position.rowIndex);
        const assistant = textAt(position.assistantRowIndex);
        if (!snapshot || user !== lastUser || assistant !== lastAssistant) {
          lastUser = user;
          lastAssistant = assistant;
          snapshot = {
            id: position.id,
            rowIndex: position.rowIndex,
            userText: compactMinimapPreview(user),
            assistantText: compactMinimapPreview(assistant),
          };
        }
        return snapshot;
      };
    },
  };
}

export type TimelineMinimapPreviewStore = ReturnType<typeof createTimelineMinimapPreviewStore>;
