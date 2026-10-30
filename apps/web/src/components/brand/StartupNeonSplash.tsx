import { releaseNotesFor } from "@t3tools/shared/releaseNotes";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { OOP_VERSION } from "../../branding";
import { cn } from "../../lib/utils";
import {
  hasUnseenReleaseNotes,
  markWhatsNewNoticeSeen,
  readWhatsNewNoticeSeenVersion,
} from "../../lib/whatsNew";
import { OoPMascot } from "./OoPMascot";
import { WhatsNewNotice } from "./WhatsNewNotice";

const LETTER_STAGGER_MS = 14;

// Once per app launch: a renderer reload in the same session keeps the session flag.
const shownThisLaunch = new Set<string>();

function NeonLetters(props: { text: string; offset: number }) {
  return Array.from(props.text, (letter, index) => {
    const order = props.offset + index;
    // Tubes do not light in a neat sweep; a fixed jitter keeps every launch identical.
    const delay = order * LETTER_STAGGER_MS + ((order * 37) % 5) * 45;
    return (
      <span
        key={order}
        className="oop-neon-letter inline-block whitespace-pre"
        style={{ animationDelay: `${delay}ms` }}
      >
        {letter}
      </span>
    );
  });
}

/**
 * A monochrome neon sign that flickers on letter by letter, once per launch for its key:
 * "OOP Development AI Agents" when the desktop app starts, "OOP Connected" when a browser connects.
 * When this version has release notes the user has not seen, the sign holds with a
 * "What's new" card under it until the card is closed, then fades.
 */
export function NeonSignSplash(props: {
  readonly headline: string;
  readonly tagline: string;
  readonly shownKey: string;
  readonly onSeeAllUpdates: () => void;
}) {
  const [visible, setVisible] = useState(
    () =>
      !shownThisLaunch.has(props.shownKey) &&
      window.sessionStorage.getItem(props.shownKey) === null,
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
    shownThisLaunch.add(props.shownKey);
    window.sessionStorage.setItem(props.shownKey, "1");
  }, [props.shownKey]);

  if (!visible) return null;
  return (
    <div
      // The card needs the pointer and the keyboard; every other splash lets both through.
      aria-hidden={noticeOpen ? undefined : true}
      data-notice={notes ? (noticeOpen ? "open" : "closed") : undefined}
      className={cn(
        "oop-neon-splash fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-6",
        !noticeOpen && "pointer-events-none",
      )}
      onAnimationEnd={(event) => {
        if (event.animationName === "oop-splash-out") setVisible(false);
      }}
    >
      <div className="flex max-w-full flex-col items-center gap-8">
        <div className="oop-neon-frame flex max-w-full flex-col items-center gap-3 rounded-3xl px-8 py-7 font-mono sm:px-12">
          <OoPMascot className="oop-neon-icon size-16" />
          <p className="text-5xl font-bold tracking-widest sm:text-6xl">
            <NeonLetters text={props.headline} offset={0} />
          </p>
          <p className="text-center text-base tracking-widest sm:text-xl">
            <NeonLetters text={props.tagline} offset={props.headline.length} />
          </p>
        </div>
        {notes && noticeOpen ? (
          <WhatsNewNotice
            notes={notes}
            onSeeAll={props.onSeeAllUpdates}
            onClose={() => {
              markWhatsNewNoticeSeen(OOP_VERSION);
              setNoticeOpen(false);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The desktop startup splash mounts outside the router tree, so the caller supplies how to
 * reach the "What's new" settings page.
 */
export function StartupNeonSplash(props: { readonly onSeeAllUpdates: () => void }) {
  return (
    <NeonSignSplash
      headline="OOP"
      tagline="Development AI Agents"
      shownKey="oop:startup-neon-shown"
      onSeeAllUpdates={props.onSeeAllUpdates}
    />
  );
}

/** Shown when a browser, such as a phone, finishes connecting to this OOP server. */
export function ConnectedNeonSplash() {
  const navigate = useNavigate();
  return (
    <NeonSignSplash
      headline="OOP"
      tagline="Connected"
      shownKey="oop:connected-neon-shown"
      onSeeAllUpdates={() => void navigate({ to: "/settings/whats-new" })}
    />
  );
}
