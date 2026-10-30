import releaseNotesJson from "./releaseNotes.json" with { type: "json" };

/** Interface languages a highlight may be translated into; `en` is required and the fallback. */
export type ReleaseNoteLanguage = "en" | "ko" | "ja" | "zh-CN" | "es";

export interface ReleaseNoteHighlight {
  readonly en: string;
  readonly ko?: string;
  readonly ja?: string;
  readonly "zh-CN"?: string;
  readonly es?: string;
}

export interface ReleaseNoteVersion {
  readonly version: string;
  /** ISO calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  readonly highlights: ReadonlyArray<ReleaseNoteHighlight>;
}

/** User-facing release notes, newest first. The source file is checked by `releaseNotes.test.ts`. */
export const releaseNotes: ReadonlyArray<ReleaseNoteVersion> = releaseNotesJson.versions;

/** Orders dotted numeric versions such as `0.0.121`; a missing or non-numeric part counts as 0. */
export function compareReleaseVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function releaseNotesFor(version: string): ReleaseNoteVersion | undefined {
  return releaseNotes.find((entry) => entry.version === version);
}

/** The highlight in `language`, or its English text when that translation is missing. */
export function localizedHighlight(
  highlight: ReleaseNoteHighlight,
  language: ReleaseNoteLanguage,
): string {
  return highlight[language]?.trim() || highlight.en;
}
