import { releaseNotesFor, type ReleaseNoteVersion } from "@t3tools/shared/releaseNotes";
import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { OOP_VERSION } from "../branding";
import { useLocalStorage } from "../hooks/useLocalStorage";

/** Holds the app version whose launch notice the user has closed. */
export const WHATS_NEW_NOTICE_SEEN_KEY = "oop:whats-new-seen";

/** Holds the app version whose Settings → What's new page the user has opened. */
export const WHATS_NEW_PAGE_SEEN_KEY = "oop:whats-new-page-seen";

/**
 * Release notes are unseen while this version has notes and the stored version differs, so
 * every update brings the launch notice and the Settings dot back once.
 */
export function hasUnseenReleaseNotes(input: {
  readonly version: string;
  readonly notes: ReleaseNoteVersion | undefined;
  readonly seenVersion: string | null;
}): boolean {
  return input.notes !== undefined && input.seenVersion !== input.version;
}

export function readWhatsNewNoticeSeenVersion(): string | null {
  try {
    return window.localStorage.getItem(WHATS_NEW_NOTICE_SEEN_KEY);
  } catch {
    // Without storage the notice simply shows on every launch.
    return null;
  }
}

export function markWhatsNewNoticeSeen(version: string): void {
  try {
    window.localStorage.setItem(WHATS_NEW_NOTICE_SEEN_KEY, version);
  } catch {
    // The notice returns next launch, which is the safe failure.
  }
}

const PageSeenVersion = Schema.NullOr(Schema.String);

/**
 * Whether Settings → What's new still has unread notes for this version, which the settings
 * navigation marks with a dot. Opening the page marks them read.
 */
export function useWhatsNewPageUnseen(): readonly [unseen: boolean, markSeen: () => void] {
  const [seenVersion, setSeenVersion] = useLocalStorage(
    WHATS_NEW_PAGE_SEEN_KEY,
    null,
    PageSeenVersion,
  );
  const markSeen = useCallback(() => setSeenVersion(OOP_VERSION), [setSeenVersion]);
  const unseen = hasUnseenReleaseNotes({
    version: OOP_VERSION,
    notes: releaseNotesFor(OOP_VERSION),
    seenVersion,
  });
  return [unseen, markSeen] as const;
}
