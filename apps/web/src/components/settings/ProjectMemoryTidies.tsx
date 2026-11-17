import type { EnvironmentId, ProjectId, ProjectMemoryTidySuggestion } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomRefresh } from "@effect/atom-react";
import { useState } from "react";
import { useT } from "../../i18n";
import { projectMemory } from "../../state/projectMemory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function ProjectMemoryTidies({
  environmentId,
  projectId,
  writeLock,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly writeLock: string | null;
}) {
  const t = useT();
  const target = { environmentId, input: { projectId } };
  const atom = projectMemory.tidies(target);
  const query = useEnvironmentQuery(atom);
  const refresh = useAtomRefresh(atom);
  const revalidate = useAtomCommand(projectMemory.revalidate, { reportFailure: false });
  const apply = useAtomCommand(projectMemory.applyTidy, { reportFailure: false });
  const dismiss = useAtomCommand(projectMemory.dismissTidy, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const decide = async (item: ProjectMemoryTidySuggestion, applying: boolean) => {
    if (busy || writeLock !== null) return;
    setBusy(true);
    try {
      const result = await (applying ? apply : dismiss)({
        environmentId,
        input: { projectId, tidyId: item.tidyId },
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: applying ? t("Tidy-up applied") : t("Suggestion dismissed"),
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        const stale =
          typeof cause === "object" &&
          cause !== null &&
          "reason" in cause &&
          cause.reason === "tidy-stale";
        toastManager.add({
          type: "error",
          title: stale
            ? t(
                "These memories changed since this tidy-up was suggested. Review the refreshed memories.",
              )
            : t("The memory request failed."),
        });
        if (stale) {
          refresh();
          await revalidate(target);
        }
      }
    } finally {
      setBusy(false);
    }
  };
  if (query.error !== null)
    return (
      <p role="alert">
        {t("The memory request failed.")}{" "}
        <Button size="xs" variant="ghost" onClick={refresh}>
          {t("Retry")}
        </Button>
      </p>
    );
  const items = query.data?.items ?? [];
  if (query.isPending || items.length === 0) return null;
  const actions = { merge: t("Merge"), update: t("Update"), delete: t("Delete") };
  return (
    <div className="flex min-w-0 flex-col gap-2 pb-2">
      <h3 className="text-sm font-medium">{t("Suggested tidy-ups")}</h3>
      <ul className="flex min-w-0 flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.tidyId}
            className="flex min-w-0 flex-col gap-2 rounded-md border border-border px-3 py-2"
          >
            <div className="flex flex-wrap gap-1">
              <Badge variant="outline" size="sm">
                {actions[item.action]}
              </Badge>
              {item.dreamed ? (
                <Badge variant="outline" size="sm">
                  {t("Dreaming")}
                </Badge>
              ) : null}
            </div>
            <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {item.reason}
            </p>
            {item.memories.map((memory, index) => (
              <details key={memory.memoryId} className="min-w-0 text-sm">
                <summary className="break-words">
                  {memory.title}
                  {item.action === "merge" && index === 0 ? ` · ${t("Kept after merge")}` : ""}
                </summary>
                <p className="whitespace-pre-wrap break-words text-xs">{memory.body}</p>
              </details>
            ))}
            {item.action !== "delete" ? (
              <div className="min-w-0 rounded-md border border-border px-2 py-1">
                <p className="text-xs text-muted-foreground">{t("Suggested replacement")}</p>
                <p className="whitespace-pre-wrap break-words text-sm font-medium">{item.title}</p>
                <p className="whitespace-pre-wrap break-words text-sm">{item.body}</p>
              </div>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || writeLock !== null}
                title={writeLock ?? undefined}
                onClick={() => void decide(item, false)}
              >
                {t("Dismiss")}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || writeLock !== null}
                title={writeLock ?? undefined}
                onClick={() => void decide(item, true)}
              >
                {t("Apply")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
