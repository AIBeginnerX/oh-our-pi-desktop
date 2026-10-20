import {
  RELEASE_VERIFICATION_REQUIRED_CHECKS,
  deriveReleaseVerificationState,
  type ReleaseVerificationGetResult,
} from "@t3tools/contracts";
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

const CHECK_LABELS: Record<(typeof RELEASE_VERIFICATION_REQUIRED_CHECKS)[number], string> = {
  sha256: "SHA-256",
  "image-verify": "Disk image",
  "mount-readonly": "Read-only mount",
  "app-bundle": "App bundle",
  "codesign-strict": "Strict code signature",
  "launch-smoke": "Isolated startup",
};

const STATE_LABELS = {
  none: "Not checked",
  unavailable: "Unavailable",
  failed: "Failed",
  running: "Running",
  "needs-confirmation": "Needs confirmation",
  verified: "Verified",
} as const;

function formatTime(value: string | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

export interface ReleaseVerificationPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly result: ReleaseVerificationGetResult | null;
  readonly pending: boolean;
  readonly starting: boolean;
  readonly busy: boolean;
  readonly readOnly: boolean;
  readonly error: string | null;
  readonly onRefresh: () => void;
  readonly onRun: () => void;
  readonly onCancel: () => void;
}

export function ReleaseVerificationPanel({
  open,
  onOpenChange,
  result,
  pending,
  starting,
  busy,
  readOnly,
  error,
  onRefresh,
  onRun,
  onCancel,
}: ReleaseVerificationPanelProps) {
  const derived = result ? deriveReleaseVerificationState(result) : null;
  const state = derived?.state ?? "needs-confirmation";
  const reasons = derived?.reasons ?? [];
  const attempt = result?.attempt ?? null;
  const attemptRunning = attempt?.phase === "running";
  const checkedAt = formatTime(attempt?.endedAt ?? null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>macOS build verification</DialogTitle>
          <DialogDescription>
            Checks image integrity, strict signature, and isolated startup. Does not test full
            functionality, Gatekeeper, or notarization.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium" role="status">
              {starting
                ? "Starting verification"
                : result
                  ? STATE_LABELS[state]
                  : "Status unavailable"}
            </span>
            <Button size="sm" variant="ghost" onClick={onRefresh} disabled={pending}>
              Refresh
            </Button>
          </div>
          {attempt ? (
            <div className="space-y-1 text-muted-foreground">
              <p className="break-all text-foreground">
                {attempt.artifact?.fileName ?? "Artifact not recorded"}
              </p>
              {attempt.artifact?.sha256 ? (
                <p>SHA-256: {attempt.artifact.sha256.slice(0, 12)}…</p>
              ) : null}
              <p>
                Server: {attempt.environment.environmentId} · {attempt.environment.platform}{" "}
                {attempt.environment.arch}
              </p>
              {checkedAt ? <p>Last checked: {checkedAt}</p> : null}
              {state === "verified" ? <p>File content matched when this panel refreshed.</p> : null}
            </div>
          ) : result && !starting ? (
            <p className="text-muted-foreground">No verification attempt for this thread.</p>
          ) : null}
          {reasons.length > 0 ? (
            <div>
              <p className="font-medium">Needs attention</p>
              <ul className="mt-1 list-inside list-disc space-y-1 text-muted-foreground">
                {[...new Set(reasons)].map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {attempt?.error ? <p className="text-destructive">{attempt.error}</p> : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {readOnly ? (
            <p className="text-muted-foreground">
              This connection can view results but cannot run verification.
            </p>
          ) : null}
          {attempt ? (
            <div>
              <p className="font-medium">Checks</p>
              <ul className="mt-2 divide-y divide-border rounded-md border">
                {RELEASE_VERIFICATION_REQUIRED_CHECKS.map((id) => {
                  const check = attempt.checks.find((item) => item.id === id);
                  return (
                    <li key={id} className="space-y-1 px-3 py-2">
                      <div className="flex justify-between gap-3">
                        <span>{CHECK_LABELS[id]}</span>
                        <span className="text-muted-foreground">{check?.status ?? "missing"}</span>
                      </div>
                      {check?.detail ? (
                        <p className="break-words text-muted-foreground">{check.detail}</p>
                      ) : null}
                      {check?.tail.length ? (
                        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
                          {check.tail.join("\n")}
                        </pre>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {!attemptRunning && !readOnly ? (
            <p className="text-muted-foreground">
              Running verification opens a temporary app window on the server Mac.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {attemptRunning ? (
            <Button variant="outline" size="sm" disabled={busy || readOnly} onClick={onCancel}>
              Cancel verification
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy || pending || readOnly || !result?.capability.available}
              onClick={onRun}
            >
              Verify macOS build
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
