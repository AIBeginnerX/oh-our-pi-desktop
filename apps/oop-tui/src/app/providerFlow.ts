import type { OrchestrationShellSnapshot, ServerConfig, ServerSettings } from "@t3tools/contracts";

import type { KeyEvent } from "../input/keys.ts";
import type { RegionFrame } from "../render/liveRegion.ts";
import { railNote, railRow, type Rail } from "../render/rail.ts";
import { t } from "../i18n/index.ts";
import { truncateStyled } from "../text/wrap.ts";
import { sanitizeForTerminal } from "../text/width.ts";
import type { PatchBuilder, PatchResult } from "./settingsPatch.ts";
import { parseProviderSlash, resolveAdd, type ProviderRequest } from "./providerArgs.ts";
import {
  addPatch,
  planLines,
  planRemove,
  previewPayload,
  providerRows,
  removePatch,
  takenIds,
  tryBuild,
  type ProviderRow,
  type RemovePlan,
} from "./providerPlan.ts";
import {
  openDraftView,
  openPickView,
  openRemovePick,
  openRemoveView,
  providerFrame,
  providerKey,
  type ProviderContext,
  type ProviderEffect,
  type ProviderFrameEnv,
  type ProviderView,
} from "./providerScreen.ts";
import {
  afterAddAdvice,
  draftProblem,
  draftSecrets,
  redactSecrets,
  targetLabel,
  type AddDraft,
} from "./providerSpec.ts";

/** What the flow needs from the controller; everything is read when used, so it is never stale. */
export interface ProviderFlowDeps {
  readonly config: () => ServerConfig | null;
  readonly shell: () => OrchestrationShellSnapshot | null;
  readonly online: () => boolean;
  readonly patch: (build: PatchBuilder) => Promise<PatchResult>;
  readonly refresh: (input?: { readonly instanceId?: string }) => Promise<unknown>;
  readonly rail: () => Rail;
  readonly width: () => number;
  /** Lines into the scrollback. */
  readonly say: (lines: ReadonlyArray<string>) => void;
  /** A finished step into the scrollback: `Provider  codex_work added`. */
  readonly record: (label: string, value: string) => void;
  /** A failure into the scrollback. */
  readonly error: (text: string) => void;
  /** A one-line notice above the composer. */
  readonly notify: (text: string) => void;
  /** The screen changed after an async step. */
  readonly changed: () => void;
}

/** One provider as a note row: the id and state, then what is worth knowing, dim. */
const listBody = (rows: ReadonlyArray<ProviderRow>, rail: Rail, width: number): string[] => {
  const { theme } = rail.style;
  const inner = Math.max(8, width - 6);
  return rows.flatMap((row) => {
    const paint =
      row.tone === "ok"
        ? theme.success
        : row.tone === "warn"
          ? theme.warning
          : row.tone === "bad"
            ? theme.error
            : theme.dim;
    const models =
      row.models === null ? "" : ` · ${t("providers.flow.modelsShort", { count: row.models })}`;
    const details = [
      row.name,
      row.driver,
      row.isDefault ? t("providers.cmd.default") : "",
      row.message ?? "",
    ].filter((part) => part !== "");
    return [
      truncateStyled(`${theme.text(row.id)}  ${paint(row.status)}${theme.dim(models)}`, inner),
      truncateStyled(`  ${theme.dim(details.join(" · "))}`, inner),
    ];
  });
};

/**
 * `/provider`: lists the providers, and opens the screens that add one and remove one. It holds the
 * open view; the controller routes keys and frames to it while it is open. Settings changes are
 * built from the newest settings (a patch replaces the whole `providerInstances` record), and the
 * other instances in it pass through untouched, so no secret of theirs is lost.
 */
export class ProviderFlow {
  private view: ProviderView | null = null;
  private busy = false;
  /** What the last key or the last async step wants said above the screen, until the next key. */
  private banner: string | null = null;

  private readonly deps: ProviderFlowDeps;

  constructor(deps: ProviderFlowDeps) {
    this.deps = deps;
  }

  isOpen(): boolean {
    return this.view !== null;
  }

  /** The warning to draw above the open screen; null when there is none. */
  message(): string | null {
    return this.banner;
  }

  close(): void {
    this.view = null;
    this.banner = null;
  }

  private settings(): ServerSettings | null {
    return this.deps.config()?.settings ?? null;
  }

  private context(): ProviderContext {
    const config = this.deps.config();
    const settings = this.settings();
    return {
      taken: takenIds(config, settings),
      rows: providerRows(config, settings),
      checkRemove: (id) =>
        settings === null
          ? { ok: false, reason: t("providers.flow.noSettings") }
          : planRemove({ id, settings, shell: this.deps.shell() }),
    };
  }

  // ---- the slash command ------------------------------------------------------------------

  /** `/provider ...`: `text` is everything after the command name. */
  run(text: string): void {
    const parsed = parseProviderSlash(text);
    if (!parsed.ok) {
      this.deps.notify(parsed.message);
      return;
    }
    const request = parsed.value;
    if (this.deps.config() === null) {
      this.deps.notify(t("providers.flow.needsServer"));
      return;
    }
    this.banner = null;
    if (request.kind === "list") {
      this.list();
      return;
    }
    if (request.kind === "add") {
      this.startAdd(request);
      return;
    }
    this.startRemove(request.id, request.dryRun);
  }

  private list(): void {
    const rows = providerRows(this.deps.config(), this.settings());
    const rail = this.deps.rail();
    const width = this.deps.width();
    this.deps.say(
      railNote(
        rail,
        "Provider",
        rows.length === 0
          ? [rail.style.theme.dim(t("providers.cmd.none"))]
          : [...listBody(rows, rail, width), rail.style.theme.dim(t("providers.flow.listHint"))],
        width,
      ),
    );
  }

  private startAdd(request: Extract<ProviderRequest, { kind: "add" }>): void {
    const context = this.context();
    if (request.target === null) {
      this.view = openPickView();
      return;
    }
    const draft = resolveAdd(request.target, request.options, {
      refs: false,
      env: {},
      stdin: null,
    });
    if (!draft.ok) {
      this.deps.notify(draft.message);
      return;
    }
    if (request.options.dryRun) {
      const problem = draftProblem(draft.value, context.taken);
      if (problem !== null) {
        this.deps.notify(problem);
        return;
      }
      const built = tryBuild(draft.value);
      if (!built.ok) {
        this.deps.notify(built.message);
        return;
      }
      const rail = this.deps.rail();
      this.deps.say(
        railNote(
          rail,
          t("providers.flow.notAdded"),
          previewPayload(draft.value, built.instance)
            .split("\n")
            .map((line) => rail.style.theme.dim(sanitizeForTerminal(line))),
          this.deps.width(),
        ),
      );
      return;
    }
    this.view = openDraftView(draft.value, context);
  }

  private startRemove(id: string | null, dryRun: boolean): void {
    const context = this.context();
    if (id === null) {
      if (context.rows.every((row) => row.isDefault)) {
        this.deps.notify(t("providers.flow.nothingRemovable"));
        return;
      }
      this.view = openRemovePick();
      return;
    }
    const check = context.checkRemove(id);
    if (!check.ok) {
      this.deps.error(check.reason);
      return;
    }
    if (dryRun) {
      this.sayPlan(check.plan, t("providers.flow.notRemoved"));
      return;
    }
    this.view = openRemoveView(check.plan);
  }

  private sayPlan(plan: RemovePlan, title: string): void {
    const rail = this.deps.rail();
    this.deps.say(
      railNote(
        rail,
        title,
        planLines(plan).map((line) => rail.style.theme.text(sanitizeForTerminal(line))),
        this.deps.width(),
      ),
    );
  }

  // ---- keys and frames --------------------------------------------------------------------

  /** One key while the screen is open. Keys are ignored while a change is on its way to the server. */
  key(event: KeyEvent): void {
    const view = this.view;
    if (view === null || this.busy) return;
    this.banner = null;
    const result = providerKey(view, this.context(), event);
    this.view = result.view;
    if (result.notice !== undefined) this.banner = result.notice;
    if (result.effect.kind !== "none") this.carryOut(result.effect);
  }

  frame(env: ProviderFrameEnv): RegionFrame {
    const view = this.view;
    if (view === null) return { lines: [], cursor: null };
    return providerFrame(view, this.context(), env);
  }

  private carryOut(effect: ProviderEffect): void {
    if (effect.kind === "submit") void this.submit(effect.draft);
    else if (effect.kind === "remove") void this.remove(effect.id);
  }

  // ---- changes ----------------------------------------------------------------------------

  /** A failure at the screen when it is open, else in the scrollback. */
  private failed(message: string): void {
    if (this.view === null) this.deps.error(message);
    else this.banner = message;
  }

  private async submit(draft: AddDraft): Promise<void> {
    const secrets = draftSecrets(draft);
    const built = tryBuild(draft);
    if (!built.ok) {
      this.failed(built.message);
      return;
    }
    if (!this.deps.online()) {
      this.failed(t("providers.flow.offline"));
      return;
    }
    this.busy = true;
    this.banner = t("providers.flow.adding");
    this.deps.changed();
    const result = await this.deps.patch((current) => addPatch(current, draft.id, built.instance));
    this.busy = false;
    this.banner = null;
    if (!result.ok) {
      this.failed(
        `${t("providers.flow.addFailed", { reason: redactSecrets(result.message, secrets) })}${result.rejected ? "" : ` ${t("providers.flow.unsure")}`}`,
      );
      this.deps.changed();
      return;
    }
    if (!result.changed) {
      this.failed(t("providers.flow.idRace", { id: draft.id }));
      this.deps.changed();
      return;
    }
    this.view = null;
    this.deps.record(
      "Provider",
      t("providers.flow.added", { id: draft.id, kind: targetLabel(draft.target) }),
    );
    const advice = afterAddAdvice(draft);
    if (advice !== null) {
      const rail = this.deps.rail();
      this.deps.say([railRow(rail, rail.style.theme.dim(advice))]);
    }
    await this.refreshAfter({ instanceId: draft.id });
    this.deps.changed();
  }

  private async remove(id: string): Promise<void> {
    if (!this.deps.online()) {
      this.failed(t("providers.flow.offline"));
      return;
    }
    // The plan was made before the confirmation; the impact line below is read again from the
    // settings and threads as they are now.
    this.busy = true;
    this.banner = t("providers.flow.removing");
    this.deps.changed();
    const result = await this.deps.patch((current) => removePatch(current, id));
    this.busy = false;
    this.banner = null;
    if (!result.ok) {
      this.failed(
        `${t("providers.flow.removeFailed", { reason: result.message })}${result.rejected ? "" : ` ${t("providers.flow.unsure")}`}`,
      );
      this.deps.changed();
      return;
    }
    this.view = null;
    if (!result.changed) {
      this.deps.notify(t("providers.cmd.alreadyGone", { id }));
    } else {
      this.deps.record("Provider", t("providers.flow.removed", { id }));
      const check = planRemove({
        id,
        settings: result.before,
        shell: this.deps.shell(),
      });
      if (check.ok) {
        const { plan } = check;
        const left =
          plan.threads.total + plan.crewPins + plan.projects + (plan.textGeneration ? 1 : 0);
        if (left > 0) {
          this.deps.say([this.deps.rail().style.theme.dim(t("providers.flow.staleSelections"))]);
        }
      }
    }
    await this.refreshAfter();
    this.deps.changed();
  }

  /** Asks the server to look at the providers again; a failure only means the list is a moment old. */
  private async refreshAfter(input?: { readonly instanceId?: string }): Promise<void> {
    try {
      await this.deps.refresh(input);
    } catch {
      this.deps.say([this.deps.rail().style.theme.dim(t("providers.flow.refreshFailed"))]);
    }
  }
}
