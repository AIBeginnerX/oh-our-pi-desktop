import { useEffect, useRef, useState } from "react";

import { OOP_VERSION } from "../../branding";
import { cn } from "../../lib/utils";
import {
  STARTUP_INTRO_SETTLED_AT,
  createStartupIntroScene,
  drawStartupIntro,
} from "./startupIntroFrame";
import { useLaunchSplash } from "./useLaunchSplash";
import { WhatsNewNotice } from "./WhatsNewNotice";

// How long the finished lockup stays before the app shows through.
const LOCKUP_HOLD_SECONDS = 0.2;
// Without motion there is only the lockup, so it stays long enough to read.
const STILL_HOLD_SECONDS = 0.8;
// A frame that took longer than this, such as the first one while the app boots, advances
// the motion by this much instead of skipping its opening beat.
const LONGEST_STEP_SECONDS = 0.1;
// With a "What's new" card the motion plays in the upper part of the window, above the card.
const CENTER_WITH_NOTICE = 0.27;
// Matches the `duration-300` fade on the wrapper.
const FADE_OUT_MS = 300;

/**
 * The desktop startup motion: a line becomes the OOP letters, agents gather around them, and
 * the wordmark lands with its tagline. It plays once per launch, lets clicks and keys through
 * to the app, and any click or key cuts it short. It mounts outside the router tree, so the
 * caller supplies how to reach the "What's new" settings page.
 */
export function StartupIntro(props: { readonly onSeeAllUpdates: () => void }) {
  const { visible, notes, noticeOpen, hide, closeNotice } =
    useLaunchSplash("oop:startup-intro-shown");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [finished, setFinished] = useState(false);
  const hasNotes = notes !== undefined;

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      setFinished(true);
      return;
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const leaveAt = still ? STILL_HOLD_SECONDS : STARTUP_INTRO_SETTLED_AT + LOCKUP_HOLD_SECONDS;
    const sans = getComputedStyle(document.body).fontFamily;
    const mono = getComputedStyle(canvas).fontFamily;

    const layOut = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const ratio = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      return createStartupIntroScene({
        width,
        height,
        centerY: height * (hasNotes ? CENTER_WITH_NOTICE : 0.5),
        tagline: "Development AI Agents",
        version: OOP_VERSION,
        sans,
        mono,
        measure: (text, font) => {
          context.font = font;
          return context.measureText(text).width;
        },
      });
    };

    let scene = layOut();
    let elapsed = 0;
    let lastFrameAt: number | undefined;
    let frame = 0;
    const paint = () =>
      drawStartupIntro(
        context,
        scene,
        still ? STARTUP_INTRO_SETTLED_AT : Math.min(elapsed, STARTUP_INTRO_SETTLED_AT),
      );
    // Finishing here, not on the next frame, so a click or a key always gets the app back.
    const skip = (event: Event) => {
      // With a card on its way the click lands on the splash; it must not take focus off the card.
      if (hasNotes && event.type === "pointerdown") event.preventDefault();
      elapsed = leaveAt;
      paint();
      finish();
    };
    // Only the motion can be skipped: once it is over, input belongs to the card or the app.
    const finish = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", skip, true);
      window.removeEventListener("keydown", skip, true);
      setFinished(true);
    };
    const step = (now: number) => {
      if (lastFrameAt !== undefined) {
        elapsed += Math.min((now - lastFrameAt) / 1000, LONGEST_STEP_SECONDS);
      }
      lastFrameAt = now;
      paint();
      if (elapsed >= leaveAt) finish();
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);

    // The window can be resized while a "What's new" card holds the finished lockup.
    const resize = () => {
      scene = layOut();
      paint();
    };
    window.addEventListener("pointerdown", skip, true);
    window.addEventListener("keydown", skip, true);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", skip, true);
      window.removeEventListener("keydown", skip, true);
      window.removeEventListener("resize", resize);
    };
  }, [visible, hasNotes]);

  // A timer, not `transitionend`: a theme change turns transitions off, and then none ends.
  const leaving = finished && !noticeOpen;
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(hide, FADE_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, hide]);

  if (!visible) return null;
  const noticeShown = finished && notes !== undefined && noticeOpen;
  return (
    <div
      // The card needs the pointer and the keyboard; without one the motion lets both through.
      aria-hidden={noticeOpen ? undefined : true}
      className={cn(
        "fixed inset-0 z-50 bg-black transition-opacity duration-300 ease-in",
        !noticeOpen && "pointer-events-none",
        leaving && "opacity-0",
      )}
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full font-mono" />
      {noticeShown ? (
        <div className="absolute inset-x-0 top-[47%] bottom-0 flex items-start justify-center overflow-y-auto p-6">
          <WhatsNewNotice notes={notes} onSeeAll={props.onSeeAllUpdates} onClose={closeNotice} />
        </div>
      ) : null}
    </div>
  );
}
