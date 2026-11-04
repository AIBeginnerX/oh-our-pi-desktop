import {
  buildCrewDecisionLog,
  CREW_DECISION_COLUMNS,
  crewDecisionLogTsv,
} from "@t3tools/client-runtime/crew-decision-log";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useT } from "~/i18n";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

const COLUMN_TITLE = {
  ts: "Time",
  phase: "Phase",
  decision: "Decision",
  why: "Why",
  evidence: "Evidence",
  result: "Result",
} as const;

function downloadTsv(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "text/tab-separated-values" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking at once can abort the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * The crew's decision log as a table, computed once when the dialog opens from the activities the
 * thread holds; it does not follow a running crew, so reopen it for newer rows.
 */
export function DecisionLogDialog(props: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [rows] = useState(() => buildCrewDecisionLog(props.activities));
  const tsv = crewDecisionLogTsv(rows);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "decision log" });
  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t("Decision log")}</DialogTitle>
          <DialogDescription>
            {rows.length === 0
              ? t("The crew has not made any decisions in this thread yet.")
              : t("Since {time}. A snapshot: reopen it for newer rows.", {
                  time: new Date(rows[0]?.ts ?? "").toLocaleString(),
                })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {rows.length === 0 ? null : (
            <Table>
              <TableHeader>
                <TableRow>
                  {CREW_DECISION_COLUMNS.map((key) => (
                    <TableHead key={key}>{t(COLUMN_TITLE[key])}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    {CREW_DECISION_COLUMNS.map((key) => (
                      <TableCell key={key}>
                        {key === "ts" ? new Date(row.ts).toLocaleTimeString() : row[key]}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={rows.length === 0}
            onClick={() => copyToClipboard(tsv, undefined)}
          >
            {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {isCopied ? t("Copied") : t("Copy TSV")}
          </Button>
          <Button
            disabled={rows.length === 0}
            onClick={() => downloadTsv("crew-decision-log.tsv", tsv)}
          >
            <DownloadIcon aria-hidden />
            {t("Download .tsv")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
