// @effect-diagnostics globalDate:off
export const SCHEDULED_PROMPT_LATE_LIMIT_MS = 60 * 60 * 1000;

export function nextScheduledPromptAt(nowMillis: number, hour: number, minute: number): number {
  const now = new Date(nowMillis);
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const today = new Date(year, month, day, hour, minute).getTime();
  return today > nowMillis ? today : new Date(year, month, day + 1, hour, minute).getTime();
}

/**
 * The local date and time of one run, such as "2026-11-16T09:15". It names the run's thread and
 * commands, so the same time on the same day runs once and a time edited later that day runs again.
 */
export function scheduledPromptOccurrence(millis: number): string {
  const date = new Date(millis);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
