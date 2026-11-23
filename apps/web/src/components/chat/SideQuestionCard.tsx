import type { SideQuestionResult } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useEffect } from "react";
import { useT } from "../../i18n";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";

export function SideQuestionCard({
  question,
  result,
  onClose,
}: {
  question: string;
  result: SideQuestionResult | null;
  onClose: () => void;
}) {
  const t = useT();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key === "Escape" &&
        !(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) &&
        !event.defaultPrevented &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <section
      aria-label={t("Side question")}
      className="mb-2 min-w-0 rounded-xl border bg-popover px-3 py-2 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="max-h-24 min-w-0 overflow-auto pt-0.5 font-medium wrap-anywhere">
          {question}
        </p>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t("Close side question")}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div role="status" className="max-h-[min(16rem,35dvh)] min-w-0 overflow-auto wrap-anywhere">
        {result?.status === "answered" ? (
          <ChatMarkdown messageRole="assistant" text={result.answer} cwd={undefined} />
        ) : (
          <p className="text-muted-foreground">
            {result ? t("Side answer unavailable.") : t("Getting a side answer…")}
          </p>
        )}
      </div>
    </section>
  );
}
