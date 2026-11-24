import { releaseNotesFor } from "@t3tools/shared/releaseNotes";
import { useCallback, useEffect, useState } from "react";

import { OOP_VERSION } from "../../branding";
import {
  hasUnseenReleaseNotes,
  markWhatsNewNoticeSeen,
  readWhatsNewNoticeSeenVersion,
} from "../../lib/whatsNew";

// Once per app launch: a renderer reload in the same session keeps the session flag.
const shownThisLaunch = new Set<string>();

/**
 * What every launch splash shares: it plays once per launch for its key, and when this
 * version has release notes the user has not seen, it holds a "What's new" card until the
 * card is closed. Closing the card counts as seen.
 */
export function useLaunchSplash(shownKey: string) {
  const [visible, setVisible] = useState(
    () => !shownThisLaunch.has(shownKey) && window.sessionStorage.getItem(shownKey) === null,
  );
  const [notes] = useState(() => {
    const notes = releaseNotesFor(OOP_VERSION);
    return visible &&
      hasUnseenReleaseNotes({
        version: OOP_VERSION,
        notes,
        seenVersion: readWhatsNewNoticeSeenVersion(),
      })
      ? notes
      : undefined;
  });
  const [noticeOpen, setNoticeOpen] = useState(notes !== undefined);

  useEffect(() => {
    shownThisLaunch.add(shownKey);
    window.sessionStorage.setItem(shownKey, "1");
  }, [shownKey]);

  const hide = useCallback(() => setVisible(false), []);
  return {
    visible,
    notes,
    noticeOpen,
    hide,
    closeNotice: () => {
      markWhatsNewNoticeSeen(OOP_VERSION);
      setNoticeOpen(false);
    },
  };
}
