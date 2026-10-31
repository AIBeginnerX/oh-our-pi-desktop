import type { OrchestrationShellSnapshot, ServerConfig, ServerSettings } from "@t3tools/contracts";

import type { KeyEvent } from "../input/keys.ts";
import type { RegionFrame } from "../render/liveRegion.ts";
import { railNote, railRow, type Rail } from "../render/rail.ts";
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
  /** A finished step into the scrollback: `Provider  codex_work 추가됨`. */
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
    const models = row.models === null ? "" : ` · 모델 ${row.models}`;
    const details = [row.name, row.driver, row.isDefault ? "기본" : "", row.message ?? ""].filter(
      (part) => part !== "",
    );
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
          ? { ok: false, reason: "서버 설정을 아직 받지 못했습니다." }
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
      this.deps.notify("서버에 연결된 뒤에 쓸 수 있습니다.");
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
          ? [rail.style.theme.dim("등록된 Provider 가 없습니다.")]
          : [
              ...listBody(rows, rail, width),
              rail.style.theme.dim("/provider add 추가 • /provider remove <id> 삭제"),
            ],
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
          "추가하지 않음 (--dry-run)",
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
        this.deps.notify("지울 수 있는 Provider 가 없습니다. 기본 인스턴스는 지울 수 없습니다.");
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
      this.sayPlan(check.plan, "삭제하지 않음 (--dry-run)");
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
      this.failed("서버와 연결이 끊겨 있습니다. 연결된 뒤 다시 시도하세요.");
      return;
    }
    this.busy = true;
    this.banner = "추가하는 중…";
    this.deps.changed();
    const result = await this.deps.patch((current) => addPatch(current, draft.id, built.instance));
    this.busy = false;
    this.banner = null;
    if (!result.ok) {
      this.failed(
        `추가 실패: ${redactSecrets(result.message, secrets)}${result.rejected ? "" : " (서버에 닿았는지 확실하지 않습니다. /provider 로 확인하세요)"}`,
      );
      this.deps.changed();
      return;
    }
    if (!result.changed) {
      this.failed(`'${draft.id}' 는 방금 다른 곳에서 만들어졌습니다. 다른 ID 를 쓰세요.`);
      this.deps.changed();
      return;
    }
    this.view = null;
    this.deps.record("Provider", `${draft.id} 추가됨 (${targetLabel(draft.target)})`);
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
      this.failed("서버와 연결이 끊겨 있습니다. 연결된 뒤 다시 시도하세요.");
      return;
    }
    // The plan was made before the confirmation; the impact line below is read again from the
    // settings and threads as they are now.
    this.busy = true;
    this.banner = "삭제하는 중…";
    this.deps.changed();
    const result = await this.deps.patch((current) => removePatch(current, id));
    this.busy = false;
    this.banner = null;
    if (!result.ok) {
      this.failed(
        `삭제 실패: ${result.message}${result.rejected ? "" : " (서버에 닿았는지 확실하지 않습니다. /provider 로 확인하세요)"}`,
      );
      this.deps.changed();
      return;
    }
    this.view = null;
    if (!result.changed) {
      this.deps.notify(`'${id}' 는 이미 없습니다.`);
    } else {
      this.deps.record("Provider", `${id} 삭제됨`);
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
          this.deps.say([
            this.deps
              .rail()
              .style.theme.dim(
                "  이 Provider 의 모델을 가리키던 선택이 남아 있습니다. /model 에서 다른 모델로 바꾸세요.",
              ),
          ]);
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
      this.deps.say([
        this.deps
          .rail()
          .style.theme.dim("  상태를 새로 읽지 못했습니다. 잠시 뒤 /provider 로 확인하세요."),
      ]);
    }
  }
}
