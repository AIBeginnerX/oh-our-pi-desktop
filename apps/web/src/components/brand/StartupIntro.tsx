import { useEffect, useRef, useState } from "react";

import { OOP_VERSION } from "../../branding";
import { cn } from "../../lib/utils";
import {
  DOT_COUNT,
  DOT_STRIDE,
  FALLBACK_HOME_RECT,
  HOME_START,
  STARTUP_INTRO_SETTLED_AT,
  createStartupIntroScene,
  evaluateStartupIntroFrame,
  type Rect,
  type StartupIntroScene,
} from "./startupIntroFrame";
import {
  PAPER_RGB,
  createStartupIntroRenderer,
  rasterizeWordmarkLockup,
  resolveRgbColor,
  type RgbColor,
} from "./startupIntroRenderer";
import { useLaunchSplash } from "./useLaunchSplash";
import { WhatsNewNotice } from "./WhatsNewNotice";

// Without motion there is only the finished lockup, so it stays long enough to read.
const STILL_HOLD_SECONDS = 0.8;
// A frame that took longer than this, such as the first one while the app boots, advances
// the motion by this much instead of skipping its opening beat.
const LONGEST_STEP_SECONDS = 0.1;
// With a "What's new" card the motion plays in the upper part of the window, above the card.
const CENTER_WITH_NOTICE = 0.27;
// Matches the `duration-300` fade on the wrapper used for skip and reduced-motion exits.
const FADE_OUT_MS = 300;
const HOME_SELECTOR = "[data-startup-intro-home]";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function readHomeTarget(): { readonly rect: Rect; readonly color: RgbColor } {
  const element = document.querySelector<HTMLElement>(HOME_SELECTOR);
  if (!element) {
    return {
      rect: FALLBACK_HOME_RECT,
      color: resolveRgbColor(getComputedStyle(document.body).color, PAPER_RGB),
    };
  }
  const box = element.getBoundingClientRect();
  const rect: Rect =
    box.width > 0 && box.height > 0
      ? { x: box.left, y: box.top, width: box.width, height: box.height }
      : FALLBACK_HOME_RECT;
  return {
    rect,
    color: resolveRgbColor(getComputedStyle(element).color, PAPER_RGB),
  };
}

function rectsMatch(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/**
 * The desktop startup motion: a large breathing Fibonacci sphere shrinks and writes "OOP AI",
 * dissolves into full-body Oopi who dances and leaps over the letters, tucks its body away to
 * leave only the head lockup, and flies home into the sidebar brand. Plays once per launch, skips
 * on pointer or key input, and holds above the "What's new" card when unseen release notes exist.
 * It mounts outside the router tree, so the caller supplies how to reach the "What's new" settings
 * page.
 */
export function StartupIntro(props: { readonly onSeeAllUpdates: () => void }) {
  const { visible, notes, noticeOpen, hide, closeNotice } =
    useLaunchSplash("oop:startup-intro-shown");
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const taglineRef = useRef<HTMLDivElement>(null);
  const resumeHomeRef = useRef<(() => void) | null>(null);
  const hasNotes = notes !== undefined;
  const [lockupReached, setLockupReached] = useState(() => hasNotes && prefersReducedMotion());
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const host = canvasHostRef.current;
    if (!host) {
      hide();
      return;
    }
    // The canvas lives as long as this effect: releasing its GL context on cleanup is final, so
    // a remount (React StrictMode in dev) needs a fresh canvas to play at all.
    const canvas = document.createElement("canvas");
    canvas.className = "size-full";
    host.append(canvas);
    const renderer = createStartupIntroRenderer(canvas, DOT_COUNT);
    if (!renderer) {
      canvas.remove();
      if (!hasNotes) {
        hide();
        return;
      }
      // No WebGL2 means no motion, but unseen release notes still get their card.
      resumeHomeRef.current = () => setLeaving(true);
      // oxlint-disable-next-line react/set-state-in-effect -- Whether WebGL2 exists is only known once the canvas is asked for it.
      setLockupReached(true);
      return () => {
        resumeHomeRef.current = null;
      };
    }

    const measureCanvas = document.createElement("canvas");
    const measureCtx = measureCanvas.getContext("2d");
    const measureText = (text: string, font: string) => {
      if (!measureCtx) return text.length * 50;
      measureCtx.font = font;
      return measureCtx.measureText(text).width;
    };

    const still = prefersReducedMotion();
    const dotBuffer = new Float32Array(DOT_COUNT * DOT_STRIDE);
    const mixedRgb: [number, number, number] = [PAPER_RGB[0], PAPER_RGB[1], PAPER_RGB[2]];

    let disposed = false;
    let frameId = 0;
    let holdTimer: number | undefined;
    let lastFrameAt: number | undefined;
    let elapsed = 0;
    let homeRefreshed = false;
    let homeColor: RgbColor = PAPER_RGB;
    let phase: "intro" | "holding" | "home" | "done" = "intro";
    let lastBackdropOpacity = -1;
    let lastTaglineOpacity = -1;

    const positionTagline = (scene: StartupIntroScene) => {
      const el = taglineRef.current;
      if (!el) return;
      const top = hasNotes ? Math.min(scene.taglineY, scene.height * 0.47 - 44) : scene.taglineY;
      el.style.top = `${Math.round(top)}px`;
    };

    const layOut = (): StartupIntroScene => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      renderer.resize(width, height, window.devicePixelRatio || 1);
      const target = readHomeTarget();
      homeColor = target.color;
      const sans = getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
      const nextScene = createStartupIntroScene({
        width,
        height,
        centerY: height * (hasNotes ? CENTER_WITH_NOTICE : 0.5),
        homeRect: target.rect,
        sans,
        measureText,
        rasterizeLetters: rasterizeWordmarkLockup,
      });
      positionTagline(nextScene);
      return nextScene;
    };

    let scene = layOut();

    const paintAt = (t: number) => {
      const scalars = evaluateStartupIntroFrame(scene, t, dotBuffer);
      const mix = scalars.colorMix;
      mixedRgb[0] = PAPER_RGB[0] + (homeColor[0] - PAPER_RGB[0]) * mix;
      mixedRgb[1] = PAPER_RGB[1] + (homeColor[1] - PAPER_RGB[1]) * mix;
      mixedRgb[2] = PAPER_RGB[2] + (homeColor[2] - PAPER_RGB[2]) * mix;
      renderer.draw(dotBuffer, mixedRgb);

      if (backdropRef.current && scalars.backdropOpacity !== lastBackdropOpacity) {
        lastBackdropOpacity = scalars.backdropOpacity;
        backdropRef.current.style.opacity = String(scalars.backdropOpacity);
      }
      if (taglineRef.current && scalars.taglineOpacity !== lastTaglineOpacity) {
        lastTaglineOpacity = scalars.taglineOpacity;
        taglineRef.current.style.opacity = String(scalars.taglineOpacity);
      }
    };

    const removeSkipListeners = () => {
      window.removeEventListener("pointerdown", onSkip, true);
      window.removeEventListener("keydown", onSkip, true);
    };

    const completeHome = () => {
      if (phase === "done") return;
      phase = "done";
      cancelAnimationFrame(frameId);
      removeSkipListeners();
      renderer.dispose();
      hide();
    };

    const beginFadeOut = () => {
      if (phase === "done") return;
      phase = "done";
      cancelAnimationFrame(frameId);
      if (holdTimer !== undefined) {
        window.clearTimeout(holdTimer);
        holdTimer = undefined;
      }
      removeSkipListeners();
      setLeaving(true);
    };

    const enterCardHold = () => {
      phase = "holding";
      elapsed = HOME_START;
      cancelAnimationFrame(frameId);
      removeSkipListeners();
      paintAt(HOME_START);
      setLockupReached(true);
    };

    const refreshHomeOnce = () => {
      if (homeRefreshed) return;
      homeRefreshed = true;
      const target = readHomeTarget();
      homeColor = target.color;
      if (!rectsMatch(scene.homeRect, target.rect)) {
        scene = layOut();
      }
    };

    const onSkip = (event: Event) => {
      if (phase === "done" || phase === "holding") return;
      if (hasNotes && phase === "intro") {
        // With a card on its way the click lands on the splash; do not steal focus from the card.
        if (event.type === "pointerdown") event.preventDefault();
        enterCardHold();
        return;
      }
      if (elapsed < HOME_START && !still) {
        elapsed = HOME_START;
        paintAt(HOME_START);
      }
      beginFadeOut();
    };

    const step = (now: number) => {
      if (disposed || phase === "done" || phase === "holding") return;
      if (lastFrameAt !== undefined) {
        elapsed += Math.min((now - lastFrameAt) / 1000, LONGEST_STEP_SECONDS);
      }
      lastFrameAt = now;

      if (hasNotes && phase === "intro" && elapsed >= HOME_START) {
        enterCardHold();
        return;
      }

      if (elapsed >= HOME_START) {
        refreshHomeOnce();
      }

      paintAt(elapsed);

      if (elapsed >= STARTUP_INTRO_SETTLED_AT) {
        completeHome();
      } else {
        frameId = requestAnimationFrame(step);
      }
    };

    resumeHomeRef.current = () => {
      if (disposed || phase !== "holding") return;
      if (still) {
        beginFadeOut();
        return;
      }
      phase = "home";
      homeRefreshed = false;
      refreshHomeOnce();
      elapsed = HOME_START;
      lastFrameAt = undefined;
      window.addEventListener("pointerdown", onSkip, true);
      window.addEventListener("keydown", onSkip, true);
      paintAt(HOME_START);
      frameId = requestAnimationFrame(step);
    };

    const onResize = () => {
      if (disposed || phase === "done") return;
      scene = layOut();
      paintAt(still || phase === "holding" ? HOME_START : elapsed);
    };

    window.addEventListener("resize", onResize);

    if (still) {
      paintAt(HOME_START);
      if (hasNotes) {
        phase = "holding";
      } else {
        window.addEventListener("pointerdown", onSkip, true);
        window.addEventListener("keydown", onSkip, true);
        holdTimer = window.setTimeout(beginFadeOut, STILL_HOLD_SECONDS * 1000);
      }
    } else {
      window.addEventListener("pointerdown", onSkip, true);
      window.addEventListener("keydown", onSkip, true);
      paintAt(0);
      frameId = requestAnimationFrame(step);
    }

    if (document.fonts) {
      void document.fonts.ready.then(() => {
        if (disposed || phase === "done") return;
        scene = layOut();
        paintAt(still || phase === "holding" ? HOME_START : elapsed);
      });
    }

    return () => {
      disposed = true;
      resumeHomeRef.current = null;
      cancelAnimationFrame(frameId);
      if (holdTimer !== undefined) window.clearTimeout(holdTimer);
      removeSkipListeners();
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      canvas.remove();
    };
  }, [visible, hasNotes, hide]);

  useEffect(() => {
    if (!noticeOpen && lockupReached) {
      resumeHomeRef.current?.();
    }
  }, [noticeOpen, lockupReached]);

  // A timer, not `transitionend`: a theme change turns transitions off, and then none ends.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(hide, FADE_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, hide]);

  if (!visible) return null;
  const noticeShown = lockupReached && notes !== undefined && noticeOpen;
  return (
    <div
      // The card needs the pointer and the keyboard; without one the motion lets both through.
      aria-hidden={noticeOpen ? undefined : true}
      className={cn(
        "fixed inset-0 z-50 transition-opacity duration-300 ease-in",
        !noticeOpen && "pointer-events-none",
        leaving && "opacity-0",
      )}
    >
      <div ref={backdropRef} className="pointer-events-none absolute inset-0 bg-black" />
      <div ref={canvasHostRef} className="pointer-events-none absolute inset-0" />
      <div
        ref={taglineRef}
        style={{ opacity: 0 }}
        className="pointer-events-none absolute inset-x-0 flex flex-col items-center gap-1 text-center text-zinc-25"
      >
        <span className="text-xs font-medium tracking-widest uppercase opacity-90 sm:text-sm">
          Development AI Agents
        </span>
        <span className="font-mono text-2xs opacity-55">v{OOP_VERSION}</span>
      </div>
      {noticeShown ? (
        <div className="absolute inset-x-0 top-[47%] bottom-0 flex items-start justify-center overflow-y-auto p-6">
          <WhatsNewNotice notes={notes} onSeeAll={props.onSeeAllUpdates} onClose={closeNotice} />
        </div>
      ) : null}
    </div>
  );
}
