import type { CommandId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ContinuationEvidence =
  | { readonly kind: "returned"; readonly turnId: TurnId }
  | { readonly kind: "revoked" }
  | { readonly kind: "unverified" }
  | { readonly kind: "held"; readonly commandId: CommandId };

export interface ContinuationToken {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /** ProviderService took stop/interrupt, a later reserve replaced this token,
   *  or startup abandoned a late memory-hold cleanup. */
  revoked: boolean;
  /** Engine: stop-requested or interrupt-requested committed. */
  canceled: boolean;
  /** Engine: thread.deleted committed. */
  deleted: boolean;
  /** Engine: activeTurnIds of running session-sets committed while this token was current. Not event provenance. */
  readonly seen: Set<TurnId>;
  /** Startup writes this once; first write wins. */
  evidence: ContinuationEvidence | undefined;
}

/** Startup's late memory-hold cleanup, carried to the engine worker by reference. */
export interface ContinuationSettlement {
  /** The exact token object; unrelated to any current-token lookup. */
  readonly token: ContinuationToken;
  /** The sequence the preparation dispatch returned. */
  readonly preparationSequence: number;
  /** The preparation session.set's commandId. */
  readonly preparationCommandId: CommandId;
}

export interface RestartContinuationsShape {
  /** Revokes the thread's previous token, then installs the new one as current. */
  readonly reserve: (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  ) => ContinuationToken;
  readonly current: (threadId: ThreadId) => ContinuationToken | undefined;
  /** The single gate for A entry, adapter entry, and every A binding write. */
  readonly isLive: (token: ContinuationToken) => boolean;
  /** Always revokes the current token, evidence or not.
   *  wasUnfinished = a token existed with no evidence or only a held marker
   *  (provider entry not yet reached), ignoring canceled/deleted/revoked. */
  readonly revokeAnyHeld: (threadId: ThreadId) => { readonly wasUnfinished: boolean };
  /** Records only while the token is current and no evidence was recorded yet. */
  readonly record: (token: ContinuationToken, evidence: ContinuationEvidence) => void;
  /** Removes only the exact current object; engine worker only. */
  readonly retire: (token: ContinuationToken) => void;
}

export class RestartContinuations extends Context.Service<
  RestartContinuations,
  RestartContinuationsShape
>()("t3/restartContinuations") {}

export const layer = Layer.effect(
  RestartContinuations,
  Effect.sync(() => {
    const currentByThread = new Map<ThreadId, ContinuationToken>();

    const reserve = (
      threadId: ThreadId,
      providerInstanceId: ProviderInstanceId,
    ): ContinuationToken => {
      const previous = currentByThread.get(threadId);
      if (previous !== undefined) previous.revoked = true;
      const token: ContinuationToken = {
        threadId,
        providerInstanceId,
        revoked: false,
        canceled: false,
        deleted: false,
        seen: new Set(),
        evidence: undefined,
      };
      currentByThread.set(threadId, token);
      return token;
    };

    const current = (threadId: ThreadId): ContinuationToken | undefined =>
      currentByThread.get(threadId);

    const isLive = (token: ContinuationToken): boolean =>
      currentByThread.get(token.threadId) === token &&
      !token.revoked &&
      !token.canceled &&
      !token.deleted;

    const revokeAnyHeld = (threadId: ThreadId): { readonly wasUnfinished: boolean } => {
      const token = currentByThread.get(threadId);
      // A held token still means "never reached provider entry" even after it
      // went terminal, so the interrupt-to-stop promotion keeps applying.
      const wasUnfinished =
        token !== undefined && (token.evidence === undefined || token.evidence.kind === "held");
      if (token !== undefined) token.revoked = true;
      return { wasUnfinished };
    };

    const record = (token: ContinuationToken, evidence: ContinuationEvidence): void => {
      if (currentByThread.get(token.threadId) !== token || token.evidence !== undefined) return;
      token.evidence = evidence;
    };

    const retire = (token: ContinuationToken): void => {
      if (currentByThread.get(token.threadId) === token) currentByThread.delete(token.threadId);
    };

    return RestartContinuations.of({ reserve, current, isLive, revokeAnyHeld, record, retire });
  }),
);
