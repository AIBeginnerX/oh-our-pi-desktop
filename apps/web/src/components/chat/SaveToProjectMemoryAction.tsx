import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { useAtomValue } from "@effect/atom-react";
import { BookMarkedIcon } from "lucide-react";
import { useState } from "react";

import { useThread } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { ProjectMemoryEditorDialog } from "../settings/ProjectMemorySection";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The explicit "save to project memory" action on a user message. Hidden on
 * servers without the memory capability, and its `message` origin is verified
 * by the server against the thread's project. The message text only seeds the
 * editor's transient draft; nothing is stored until the user saves.
 */
export function SaveToProjectMemoryAction({
  environmentId,
  threadId,
  messageId,
  text,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly messageId: MessageId;
  readonly text: string;
}) {
  const [open, setOpen] = useState(false);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const manage = config?.environment.capabilities.projectMemory?.manage === true;
  const thread = useThread(manage && threadId !== null ? { environmentId, threadId } : null);
  const projectId = thread?.projectId ?? null;

  if (!manage || threadId === null || projectId === null || text.trim() === "") return null;
  // Context chips render as their labels in plain text; a memory of this
  // message stores that prose, not chip payloads.
  const body = replaceComposerContextReferences(text, (reference) => reference.label);

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Save to project memory"
              onClick={() => setOpen(true)}
            />
          }
        >
          <BookMarkedIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Save to project memory</TooltipPopup>
      </Tooltip>
      {open ? (
        <ProjectMemoryEditorDialog
          open
          environmentId={environmentId}
          projectId={projectId}
          origin={{ type: "message", threadId, messageId }}
          draft={{
            title: suggestedTitle(body),
            body,
            kind: "fact",
            validUntilIso: null,
          }}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

/** First line of the text, clipped — the suggested title for a saved message. */
function suggestedTitle(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
