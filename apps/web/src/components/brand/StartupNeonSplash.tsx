import { useEffect, useState } from "react";

import { OoPMascot } from "./OoPMascot";

const LETTER_STAGGER_MS = 55;

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
 */
export function NeonSignSplash(props: {
  readonly headline: string;
  readonly tagline: string;
  readonly shownKey: string;
}) {
  const [visible, setVisible] = useState(
    () =>
      !shownThisLaunch.has(props.shownKey) &&
      window.sessionStorage.getItem(props.shownKey) === null,
  );

  useEffect(() => {
    shownThisLaunch.add(props.shownKey);
    window.sessionStorage.setItem(props.shownKey, "1");
  }, [props.shownKey]);

  if (!visible) return null;
  return (
    <div
      aria-hidden
      className="oop-neon-splash fixed inset-0 z-50 flex items-center justify-center p-6"
      onClick={() => setVisible(false)}
      onAnimationEnd={(event) => {
        if (event.animationName === "oop-splash-out") setVisible(false);
      }}
    >
      <div className="oop-neon-frame flex max-w-full flex-col items-center gap-3 rounded-3xl px-8 py-7 font-mono sm:px-12">
        <OoPMascot className="oop-neon-icon size-16" />
        <p className="text-5xl font-bold tracking-widest sm:text-6xl">
          <NeonLetters text={props.headline} offset={0} />
        </p>
        <p className="text-center text-base tracking-widest sm:text-xl">
          <NeonLetters text={props.tagline} offset={props.headline.length} />
        </p>
      </div>
    </div>
  );
}

export function StartupNeonSplash() {
  return (
    <NeonSignSplash
      headline="OOP"
      tagline="Development AI Agents"
      shownKey="oop:startup-neon-shown"
    />
  );
}

/** Shown when a browser, such as a phone, finishes connecting to this OOP server. */
export function ConnectedNeonSplash() {
  return <NeonSignSplash headline="OOP" tagline="Connected" shownKey="oop:connected-neon-shown" />;
}
