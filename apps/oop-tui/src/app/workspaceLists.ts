import type { ServerProvider } from "@t3tools/contracts";

/** How long a failed lookup waits before the next render may try it again. */
const RETRY_AFTER_MS = 10_000;
/** An answer with no list for the folder is asked again less and less often, up to this pause. */
const EMPTY_RETRY_MAX_MS = 300_000;

type Entry =
  | { readonly state: "loading"; readonly empties: number }
  | { readonly state: "done" }
  | { readonly state: "failed"; readonly retryAt: number; readonly empties: number }
  | { readonly state: "empty"; readonly retryAt: number; readonly empties: number };

/**
 * The commands and skills a provider finds in one working folder (a project's own `.claude/commands`,
 * say) are listed by the server only after it was asked for that folder, as the desktop app does when
 * a conversation opens or its provider changes. `ensure` asks once per provider and folder; a failed
 * ask is tried again after a pause, the next time something is drawn. A list the server lost (it
 * keeps them in memory, so a restart drops them) is asked for again, and so is an answer that came
 * without one, at a growing pause. Until the answer is in, `pending` says the list may be incomplete.
 */
export class WorkspaceLists {
  private readonly entries = new Map<string, Entry>();
  private readonly refresh: (input: { instanceId: string; cwd: string }) => Promise<unknown>;
  private readonly now: () => number;
  private readonly changed: () => void;

  constructor(deps: {
    readonly refresh: (input: { instanceId: string; cwd: string }) => Promise<unknown>;
    readonly now: () => number;
    /** The answer (or the failure) arrived; what is drawn from the list is drawn again. */
    readonly changed: () => void;
  }) {
    this.refresh = deps.refresh;
    this.now = deps.now;
    this.changed = deps.changed;
  }

  private static key(provider: ServerProvider, cwd: string): string {
    return `${provider.instanceId}\u0000${cwd}`;
  }

  private static listed(provider: ServerProvider, cwd: string): boolean {
    return provider.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd) === true;
  }

  /** Asks the server for the folder's list unless it has it, or the same ask is out or just failed. */
  ensure(provider: ServerProvider | null, cwd: string | null): void {
    if (provider === null || cwd === null || !provider.enabled) return;
    if (WorkspaceLists.listed(provider, cwd)) {
      this.entries.set(WorkspaceLists.key(provider, cwd), { state: "done" });
      return;
    }
    const key = WorkspaceLists.key(provider, cwd);
    const entry = this.entries.get(key);
    if (entry?.state === "loading") return;
    if ((entry?.state === "failed" || entry?.state === "empty") && this.now() < entry.retryAt) {
      return;
    }
    const empties = entry?.state === "failed" || entry?.state === "empty" ? entry.empties : 0;
    this.entries.set(key, { state: "loading", empties });
    const settle = (next: Entry) => {
      this.entries.set(key, next);
      this.changed();
    };
    this.refresh({ instanceId: provider.instanceId, cwd }).then(
      () =>
        // The list arrives with the provider update, and the next `ensure` marks it done.
        settle({
          state: "empty",
          retryAt: this.now() + Math.min(RETRY_AFTER_MS * 6 ** empties, EMPTY_RETRY_MAX_MS),
          empties: empties + 1,
        }),
      () => settle({ state: "failed", retryAt: this.now() + RETRY_AFTER_MS, empties }),
    );
  }

  /** The folder's own list is not in yet (asked for, or the ask failed): a word missing from it may just be late. */
  pending(provider: ServerProvider | null, cwd: string | null): boolean {
    if (provider === null || cwd === null || WorkspaceLists.listed(provider, cwd)) return false;
    const entry = this.entries.get(WorkspaceLists.key(provider, cwd));
    return entry?.state === "loading" || entry?.state === "failed";
  }
}
