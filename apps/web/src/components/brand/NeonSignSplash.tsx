import { useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { OoPMascot } from "./OoPMascot";
import { useLaunchSplash } from "./useLaunchSplash";
import { WhatsNewNotice } from "./WhatsNewNotice";

const LETTER_STAGGER_MS = 14;

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
 * A monochrome neon sign that flickers on letter by letter, once per launch for its key.
 * When this version has release notes the user has not seen, the sign holds with a
 * "What's new" card under it until the card is closed, then fades.
 */
function NeonSignSplash(props: {
  readonly headline: string;
  readonly tagline: string;
  readonly shownKey: string;
  readonly onSeeAllUpdates: () => void;
}) {
  const { visible, notes, noticeOpen, hide, closeNotice } = useLaunchSplash(props.shownKey);

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
        if (event.animationName === "oop-splash-out") hide();
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
          <WhatsNewNotice notes={notes} onSeeAll={props.onSeeAllUpdates} onClose={closeNotice} />
        ) : null}
      </div>
    </div>
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
