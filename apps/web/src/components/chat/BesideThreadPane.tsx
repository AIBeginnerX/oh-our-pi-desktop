import { useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react";
import { useNavigate } from "@tanstack/react-router";
import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { isCrewThreadTitle } from "@t3tools/shared/crew";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { memo, useMemo, useState } from "react";

import { useT } from "~/i18n";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  deriveTimelineEntriesWithState,
  deriveWorkLogEntries,
  type TimelineEntriesProjection,
  type TimelineEntry,
} from "~/session-logic";
import { useThreadShell, useThreadStatus } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { environmentThreadDetails, environmentThreadShells } from "~/state/threads";
import { buildThreadRouteParams } from "~/threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const transcriptKey = (item: TimelineEntry) => item.id;
const threadKey = (item: Pick<EnvironmentThreadShell, "id">) => item.id;

const transcriptWorkAtom = Atom.family((key: string) => {
  const target = parseScopedThreadKey(key);
  return Atom.make((get) => {
    if (!target) return [];
    // The transcript shows answer messages directly instead of folding them into work cards.
    return deriveWorkLogEntries(get(environmentThreadDetails.activitiesAtom(target))).map(
      ({ questionAnswer: _answer, ...entry }) => entry,
    );
  }).pipe(Atom.setIdleTTL(0));
});

const transcriptAtom = Atom.family((key: string) => {
  const target = parseScopedThreadKey(key);
  return Atom.make((get): TimelineEntriesProjection | null => {
    if (!target) return null;
    const messages = get(environmentThreadDetails.messagesAtom(target));
    const previous = Option.getOrNull(get.self<TimelineEntriesProjection>());
    return deriveTimelineEntriesWithState(
      messages.filter((message) => message.role === "user" || message.role === "assistant"),
      [],
      get(transcriptWorkAtom(key)),
      previous,
    );
  }).pipe(Atom.setIdleTTL(0));
});

const selectTranscriptRows = (transcript: TimelineEntriesProjection | null) => transcript?.entries;
const FOLLOW_TRANSCRIPT_END = { on: { dataChange: true, itemLayout: true, layout: true } };

function PaneNotice({ children }: { children: string }) {
  return (
    <p className="px-3 py-2 text-sm text-muted-foreground" role="status">
      {children}
    </p>
  );
}

function ThreadPicker({
  hostRef,
  displayedThreadKey,
  onSelect,
}: {
  hostRef: ScopedThreadRef;
  displayedThreadKey: string;
  onSelect: (ref: ScopedThreadRef) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const threads = useAtomValue(
    environmentThreadShells.environmentThreadsAtom(hostRef.environmentId),
  );
  const needle = query.trim().toLocaleLowerCase();
  const recent = useMemo(
    () =>
      threads
        .filter(
          (thread) =>
            thread.id !== hostRef.threadId &&
            scopedThreadKey(scopeThreadRef(hostRef.environmentId, thread.id)) !==
              displayedThreadKey &&
            thread.archivedAt === null &&
            thread.parentThreadId == null &&
            !isCrewThreadTitle(thread.title) &&
            thread.title.toLocaleLowerCase().includes(needle),
        )
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [threads, displayedThreadKey, hostRef.environmentId, hostRef.threadId, needle],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 py-2">
        <Input
          type="search"
          size="sm"
          value={query}
          aria-label={t("Filter recent chats")}
          placeholder={t("Filter recent chats")}
          onValueChange={setQuery}
        />
      </div>
      {recent.length > 0 ? (
        <div className="min-h-0 flex-1">
          <LegendList
            className="h-full overscroll-y-contain"
            data={recent}
            estimatedItemSize={36}
            keyExtractor={threadKey}
            renderItem={({ item }) => (
              <div className="px-2">
                <button
                  type="button"
                  className="w-full cursor-pointer truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none"
                  onClick={() => onSelect(scopeThreadRef(hostRef.environmentId, item.id))}
                >
                  {item.title}
                </button>
              </div>
            )}
          />
        </div>
      ) : (
        <PaneNotice>{t("No matching chats")}</PaneNotice>
      )}
    </div>
  );
}

function ThreadTranscript({ target }: { target: ScopedThreadRef }) {
  const t = useT();
  const rows = useAtomValue(transcriptAtom(scopedThreadKey(target)), selectTranscriptRows);
  const status = useThreadStatus(target);
  const error = useAtomValue(environmentThreadDetails.errorAtom(target));
  const phase = useEnvironment(target.environmentId)?.connection.phase;
  const cannotConnect = phase === "offline" || phase === "error" || phase === "unsupported";

  if (status === "deleted" || error || (!rows?.length && cannotConnect)) {
    return <PaneNotice>{t("This chat is unavailable")}</PaneNotice>;
  }
  if (!rows?.length) {
    return (
      <PaneNotice>
        {status === "live" || status === "cached" ? t("No messages yet") : t("Loading chat…")}
      </PaneNotice>
    );
  }

  return (
    <div className="min-h-0 flex-1">
      <LegendList
        className="h-full overflow-x-hidden overscroll-y-contain"
        data={rows}
        keyExtractor={transcriptKey}
        estimatedItemSize={64}
        initialScrollAtEnd
        maintainScrollAtEnd={FOLLOW_TRANSCRIPT_END}
        maintainVisibleContentPosition
        renderItem={({ item }) => {
          if (item.kind === "work") {
            return (
              <p className="truncate px-3 py-1 text-xs text-muted-foreground">{item.entry.label}</p>
            );
          }
          if (item.kind !== "message") return null;
          return (
            <div className="space-y-1 px-3 py-2 text-sm">
              <p className="font-medium">
                {item.message.role === "user" ? t("User") : t("Assistant")}
              </p>
              {item.message.role === "assistant" ? (
                <ChatMarkdown
                  messageRole="assistant"
                  text={item.message.text}
                  cwd={undefined}
                  environmentId={target.environmentId}
                  isStreaming={Boolean(item.message.streaming)}
                />
              ) : (
                <p className="whitespace-pre-wrap break-words">{item.message.text}</p>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}

export const BesideThreadPane = memo(function BesideThreadPane({
  hostRef,
  displayedThreadKey,
  target,
}: {
  hostRef: ScopedThreadRef;
  displayedThreadKey: string;
  target: ScopedThreadRef | null;
}) {
  const t = useT();
  const navigate = useNavigate();
  const openChat = useRightPanelStore((state) => state.openChat);
  const [switching, setSwitching] = useState(false);
  const targetKey = target ? scopedThreadKey(target) : null;
  const isSameThread =
    targetKey !== null &&
    (targetKey === scopedThreadKey(hostRef) || targetKey === displayedThreadKey);
  const targetShell = useThreadShell(isSameThread ? null : target);
  const unavailable =
    target !== null && !isSameThread && (!targetShell || targetShell.archivedAt !== null);
  const showPicker = !target || switching || isSameThread || unavailable;

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t("Chat beside")}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="min-w-0 flex-1 break-words text-sm font-medium">
          {targetShell?.title ?? t("Chat beside")}
        </h2>
        {target && !isSameThread && !unavailable ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setSwitching(!switching)}>
              {switching ? t("Cancel") : t("Switch chat")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(target),
                })
              }
            >
              {t("Open")}
            </Button>
          </>
        ) : null}
        {target ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSwitching(false);
              openChat(hostRef, null);
            }}
          >
            {t("Clear selection")}
          </Button>
        ) : null}
      </header>
      {isSameThread ? <PaneNotice>{t("This chat is open on the left")}</PaneNotice> : null}
      {unavailable ? <PaneNotice>{t("This chat is unavailable")}</PaneNotice> : null}
      {showPicker ? (
        <ThreadPicker
          hostRef={hostRef}
          displayedThreadKey={displayedThreadKey}
          onSelect={(ref) => {
            openChat(hostRef, ref);
            setSwitching(false);
          }}
        />
      ) : (
        <ThreadTranscript key={targetKey} target={target} />
      )}
    </section>
  );
});
