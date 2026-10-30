import { localizedHighlight, type ReleaseNoteVersion } from "@t3tools/shared/releaseNotes";
import { useEffect, useRef } from "react";

import { OOP_VERSION } from "../../branding";
import { useT } from "../../i18n";
import { useUiLanguage } from "../../state/menuLanguage";
import { Button } from "../ui/button";

const FOCUSABLE = "button:not([disabled])";

/**
 * The launch card under the neon sign. It owns focus while open: Escape closes it and Tab
 * cycles inside it, because the splash covers the whole app. Any way of closing it counts as seen.
 */
export function WhatsNewNotice(props: {
  readonly notes: ReleaseNoteVersion;
  readonly onClose: () => void;
  readonly onSeeAll: () => void;
}) {
  const t = useT();
  const language = useUiLanguage();
  const cardRef = useRef<HTMLDivElement>(null);
  const { onClose } = props;

  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const leaving = event.shiftKey ? active === first || active === card : active === last;
      if (leaving || !card.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="whats-new-title"
      tabIndex={-1}
      className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-border bg-background p-5 text-left text-foreground shadow-lg outline-none"
    >
      <h2 id="whats-new-title" className="text-base font-semibold">
        {t("What's new in OOP {version}", { version: OOP_VERSION })}
      </h2>
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
        {props.notes.highlights.map((highlight) => (
          <li key={highlight.en}>{localizedHighlight(highlight, language)}</li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => {
            props.onSeeAll();
            props.onClose();
          }}
        >
          {t("See all updates")}
        </Button>
        <Button onClick={props.onClose}>{t("Close")}</Button>
      </div>
    </div>
  );
}
