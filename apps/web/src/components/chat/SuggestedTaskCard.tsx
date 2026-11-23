import type { ScopedProjectRef } from "@t3tools/contracts";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useT } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function SuggestedTaskCard({
  title,
  prompt,
  projectRef,
}: {
  title: string;
  prompt: string;
  projectRef: ScopedProjectRef;
}) {
  const t = useT();
  const newThread = useNewThreadHandler();
  const [expanded, setExpanded] = useState(false);
  const [opening, setOpening] = useState(false);

  const openDraft = async () => {
    setOpening(true);
    try {
      const opened = await newThread(projectRef);
      if (opened) useComposerDraftStore.getState().setPrompt(opened.draftId, prompt);
    } catch {
      toastManager.add({ type: "error", title: t("Could not open the draft") });
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="max-w-xl space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-sm font-medium break-words">{title}</p>
      <p
        className={cn(
          "text-sm break-words whitespace-pre-wrap text-muted-foreground",
          !expanded && "line-clamp-3",
        )}
      >
        {prompt}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={opening} onClick={() => void openDraft()}>
          {t("Open in new thread")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t("Collapse") : t("Expand prompt")}
        </Button>
      </div>
    </div>
  );
}
