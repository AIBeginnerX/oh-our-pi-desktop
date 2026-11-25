import {
  type AuthMcpApprovalDecision,
  type AuthMcpApprovalDetails,
  AuthMcpApprovalError,
  AuthMcpClientAccess,
  type AuthMcpAuthorizationRequest,
} from "@t3tools/contracts";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { EyeIcon, type LucideIcon } from "lucide-react";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "~/environments/primary/httpClient";
import { useT } from "~/i18n";
import { runPrimaryHttp } from "~/lib/runtime";
import { cn } from "~/lib/utils";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { AuthSurfaceShell } from "./AuthSurfaceShell";

const accessConfig: Record<
  AuthMcpClientAccess,
  { readonly label: string; readonly description: string; readonly icon: LucideIcon }
> = {
  "read-only": {
    label: "Read only",
    description: "Read projects and threads. Cannot start, message or change anything.",
    icon: EyeIcon,
  },
  ...runtimeModeConfig,
};

const isMcpClientAccess = Schema.is(AuthMcpClientAccess);
const isApprovalError = Schema.is(AuthMcpApprovalError);
const PAIRING_CREATE_COMMAND = "oop server auth pairing create";
const HIGHLIGHT_SENTINEL = "\u0000";

/** A CLI agent's callback is a loopback address; a hosted agent's is its own server. */
function redirectsToThisComputer(redirectHost: string): boolean {
  try {
    return isLoopbackHost(new URL(`http://${redirectHost}`).hostname);
  } catch {
    return false;
  }
}

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "invalid"; readonly message: string | null }
  | { readonly status: "ready"; readonly details: AuthMcpApprovalDetails };

type Answer<A> =
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "error"; readonly message: string | null };

/**
 * Runs an approval call. The server validates the agent's request again on
 * every call and answers what the page asked for, a message to show, or a URL
 * the browser must follow (an approval, a denial, or a protocol error the
 * agent should receive).
 */
function runApproval<A>(
  call: (
    client: Context.Service.Shape<typeof PrimaryEnvironmentHttpClient>,
  ) => Effect.Effect<A | { readonly redirectTo: string }, unknown>,
): Promise<Answer<A>> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap(call),
      Effect.map((value): Answer<A> =>
        typeof value === "object" && value !== null && "redirectTo" in value
          ? { kind: "redirect", url: value.redirectTo }
          : { kind: "ok", value: value as A },
      ),
      Effect.catch((error) =>
        Effect.succeed<Answer<A>>({
          kind: "error",
          message: isApprovalError(error) ? error.message : null,
        }),
      ),
    ),
  ).catch((): Answer<A> => ({ kind: "error", message: null }));
}

function readAuthorizationRequest(): AuthMcpAuthorizationRequest {
  return Object.fromEntries(new URL(window.location.href).searchParams);
}

/**
 * Whether this browser's session may approve `access` without a pairing code.
 * A session may only grant access whose scopes it holds itself.
 */
function oneClickApproves(details: AuthMcpApprovalDetails, access: AuthMcpClientAccess) {
  return details.csrfToken !== undefined && (details.oneClickAccess ?? []).includes(access);
}

/**
 * Renders a translated sentence with a single placeholder replaced by a React
 * node, keeping each language's word order intact.
 */
function renderWithSlot(translated: string, sentinel: string, node: ReactNode): ReactNode {
  const index = translated.indexOf(sentinel);
  if (index === -1) return translated;
  return (
    <>
      {translated.slice(0, index)}
      {node}
      {translated.slice(index + sentinel.length)}
    </>
  );
}

/**
 * /connect-agent: where an outside agent's MCP sign-in lands after the server
 * checks the request. The user picks the most the agent may allow, then
 * approves with a pairing code, or in one click when this browser is already
 * signed in to the environment as an administrator.
 */
export function ConnectAgentSurface() {
  const t = useT();
  const [authorization] = useState(readAuthorizationRequest);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [access, setAccess] = useState<AuthMcpClientAccess>("read-only");
  const [pairingCode, setPairingCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void runApproval((client) => client.mcpOAuth.approval({ payload: authorization })).then(
      (answer) => {
        if (cancelled) return;
        if (answer.kind === "redirect") {
          window.location.replace(answer.url);
          return;
        }
        setLoaded(
          answer.kind === "error"
            ? { status: "invalid", message: answer.message }
            : { status: "ready", details: answer.value },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [authorization]);

  const decide = useCallback(
    async (choice: "approve" | "deny") => {
      if (loaded.status !== "ready") return;
      setPending(choice);
      setErrorMessage("");
      const { csrfToken } = loaded.details;
      const decision: AuthMcpApprovalDecision =
        choice === "deny"
          ? { _tag: "deny" }
          : csrfToken !== undefined && oneClickApproves(loaded.details, access)
            ? { _tag: "browser-session", access, csrfToken }
            : { _tag: "pairing-code", access, code: pairingCode.trim() };
      const answer = await runApproval((client) =>
        client.mcpOAuth.decision({ payload: { authorization, decision } }),
      );
      if (answer.kind === "redirect") {
        window.location.replace(answer.url);
        return;
      }
      setPending(null);
      setErrorMessage(
        answer.kind === "error"
          ? (answer.message ?? t("Could not reach this environment. Try again."))
          : t("The sign-in could not continue."),
      );
    },
    [access, authorization, loaded, pairingCode, t],
  );

  if (loaded.status === "loading") {
    return (
      <AuthSurfaceShell>
        <ConnectAgentHeading
          title={t("Checking the sign-in request")}
          description={t("One moment while this environment verifies the agent's request.")}
        />
        <div className="mt-6">
          <Spinner size="lg" tone="muted" />
        </div>
      </AuthSurfaceShell>
    );
  }

  if (loaded.status === "invalid") {
    return (
      <AuthSurfaceShell>
        <ConnectAgentHeading
          title={t("This sign-in cannot continue")}
          description={loaded.message ?? t("Could not reach this environment. Try again.")}
        />
        <p className="mt-4 text-sm text-muted-foreground">
          {t("Close this page and start the sign-in again from your agent.")}
        </p>
      </AuthSurfaceShell>
    );
  }

  const { details } = loaded;
  const oneClick = oneClickApproves(details, access);
  const canApprove = pending === null && (oneClick || pairingCode.trim().length > 0);

  return (
    <AuthSurfaceShell>
      <ConnectAgentHeading
        title={t("Connect {clientName}", { clientName: details.clientName })}
        description={renderWithSlot(
          t("This agent wants to use the threads in every project on {host}.", {
            host: HIGHLIGHT_SENTINEL,
          }),
          HIGHLIGHT_SENTINEL,
          <span className="font-medium text-foreground">{details.environmentHost}</span>,
        )}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {redirectsToThisComputer(details.redirectHost)
          ? t(
              "The name is chosen by the agent. Approval returns to {host} on the computer that opened this page. Only approve a sign-in you just started.",
              { host: details.redirectHost },
            )
          : renderWithSlot(
              t(
                "The name is chosen by the agent. Approval gives access to whoever runs {host}. Only approve a sign-in you just started there.",
                { host: HIGHLIGHT_SENTINEL },
              ),
              HIGHLIGHT_SENTINEL,
              <span className="font-medium text-foreground">{details.redirectHost}</span>,
            )}
      </p>

      <form
        className="mt-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canApprove) void decide("approve");
        }}
      >
        <div className="space-y-2">
          <span id="connect-agent-access-label" className="text-sm font-medium">
            {t("What it may do")}
          </span>
          <RadioGroup
            aria-labelledby="connect-agent-access-label"
            value={access}
            onValueChange={(value) => {
              if (isMcpClientAccess(value)) setAccess(value);
            }}
          >
            {AuthMcpClientAccess.literals.map((option) => (
              <AccessOption key={option} access={option} selected={option === access} />
            ))}
          </RadioGroup>
          <p className="text-xs text-muted-foreground">
            {t(
              "Beyond read only, it can start and message threads, answer their approval requests and questions, and stop their running turns. None of them can run with more than the mode you pick.",
            )}
          </p>
        </div>

        {oneClick ? null : (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="connect-agent-pairing-code">
              {t("Pairing code")}
            </label>
            <Input
              id="connect-agent-pairing-code"
              autoCapitalize="none"
              autoComplete="one-time-code"
              autoCorrect="off"
              disabled={pending !== null}
              nativeInput
              onChange={(event) => setPairingCode(event.currentTarget.value)}
              placeholder={t("Paste a one-time pairing code")}
              spellCheck={false}
              value={pairingCode}
            />
            <p className="text-xs text-muted-foreground">
              {renderWithSlot(
                t("Create one in Settings \u2192 Connections, or run {command} on this machine.", {
                  command: HIGHLIGHT_SENTINEL,
                }),
                HIGHLIGHT_SENTINEL,
                <code>{PAIRING_CREATE_COMMAND}</code>,
              )}
            </p>
          </div>
        )}

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={!canApprove} type="submit">
            {pending === "approve" ? t("Approving\u2026") : t("Approve")}
          </Button>
          <Button
            disabled={pending !== null}
            onClick={() => void decide("deny")}
            type="button"
            variant="outline"
          >
            {pending === "deny" ? t("Denying\u2026") : t("Deny")}
          </Button>
        </div>
      </form>
    </AuthSurfaceShell>
  );
}

function ConnectAgentHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  const t = useT();
  return (
    <>
      <p className="text-3xs font-semibold tracking-widest text-primary uppercase">
        {t("Agent sign-in")}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

function AccessOption({
  access,
  selected,
}: {
  readonly access: AuthMcpClientAccess;
  readonly selected: boolean;
}) {
  const t = useT();
  const { label, description, icon: Icon } = accessConfig[access];
  return (
    <RadioPrimitive.Root
      value={access}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary bg-background ring-2 ring-primary/25 dark:border-transparent dark:bg-primary/10 dark:ring-1 dark:ring-primary/30"
          : "border-border bg-background hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          selected ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{t(label)}</span>
        <span className="block text-xs text-muted-foreground">{t(description)}</span>
      </span>
    </RadioPrimitive.Root>
  );
}
