import { describe, expect, it } from "vite-plus/test";

import type { KeyEvent } from "../input/keys.ts";
import { makeStyle } from "../render/style.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "../render/symbols.ts";
import { stringWidth, stripAnsi } from "../text/width.ts";
import { makeProject, makeSnapshot, makeThreadShell } from "../testing/fixtures.ts";
import {
  configWith,
  key,
  paste,
  savedPreset,
  SECRET,
  serverProvider,
  settingsWith,
  text,
} from "../testing/providerFixtures.ts";
import { planRemove, providerRows, takenIds } from "./providerPlan.ts";
import {
  openDraftView,
  openPickView,
  openRemovePick,
  openRemoveView,
  providerFrame,
  providerKey,
  type ProviderContext,
  type ProviderEffect,
  type ProviderView,
} from "./providerScreen.ts";
import { newDraft, parseTarget, withId, withValue } from "./providerSpec.ts";

const settings = settingsWith({
  codex: { driver: "codex", enabled: true },
  opencode_zai: savedPreset,
  codex_work: { driver: "codex" },
});
const config = configWith(settings, [
  serverProvider("codex"),
  serverProvider("opencode_zai"),
  serverProvider("codex_work"),
]);
const shell = makeSnapshot(
  [makeProject()],
  [makeThreadShell({ id: "a", modelSelection: { instanceId: "opencode_zai", model: "m" } })],
);
const context: ProviderContext = {
  taken: takenIds(config, settings),
  rows: providerRows(config, settings),
  checkRemove: (id) => planRemove({ id, settings, shell }),
};

interface Run {
  view: ProviderView | null;
  effects: ProviderEffect[];
  notices: string[];
}

/** Presses keys one after another, keeping the last view and every effect and notice. */
const press = (start: ProviderView, ...events: KeyEvent[]): Run => {
  const run: Run = { view: start, effects: [], notices: [] };
  for (const event of events) {
    if (run.view === null) break;
    const result = providerKey(run.view, context, event);
    run.view = result.view;
    if (result.effect.kind !== "none") run.effects.push(result.effect);
    if (result.notice !== undefined) run.notices.push(result.notice);
  }
  return run;
};

const frameOf = (view: ProviderView, columns = 61, symbols = UNICODE_SYMBOLS) =>
  providerFrame(view, context, {
    columns,
    rows: 24,
    style: makeStyle(false),
    symbols,
    banner: null,
    tone: "warning",
  }).lines.map(stripAnsi);

const type = (value: string): KeyEvent[] => [text(value)];
const enter = key("enter");
const escape = key("escape");

describe("choosing what to add", () => {
  it("lists every driver and both presets, numbered", () => {
    const rows = frameOf(openPickView()).join("\n");
    for (const label of ["Codex", "Claude", "OpenCode", "MiniMax Code", "Z.AI", "MiniMax"]) {
      expect(rows).toContain(label);
    }
    expect(rows).toContain("1  Codex");
    expect(rows).toContain("Early Access");
  });

  it("opens the form of the kind picked, by Enter or by number, and goes back with Esc", () => {
    const run = press(openPickView(), key("down"), enter);
    expect(run.view).toMatchObject({
      kind: "form",
      fromPick: true,
      draft: { target: { kind: "driver" } },
    });
    const byNumber = press(openPickView(), text("5"), enter);
    expect(byNumber.view).toMatchObject({
      kind: "form",
      draft: { target: { driver: { value: "opencode" } } },
    });
    expect(press(openPickView(), enter, escape).view).toEqual(openPickView());
    expect(press(openPickView(), escape).view).toBeNull();
    expect(press(openPickView(), text("q")).view).toBeNull();
  });

  it("keeps the pointer in range", () => {
    const run = press(openPickView(), ...Array.from({ length: 30 }, () => key("down")));
    expect(run.view).toMatchObject({ kind: "pick", selected: 9 });
    expect(press(openPickView(), key("up")).view).toMatchObject({ selected: 0 });
  });
});

describe("the add form", () => {
  const form = (word: string) => {
    const view = press(openPickView(), enter).view;
    if (view?.kind !== "form") throw new Error("no form");
    return { ...view, draft: newDraft(parseTarget(word)!) } satisfies ProviderView;
  };

  it("takes a name, derives the id from it, and starts on the row that needs something", () => {
    const start = openDraftView(newDraft(parseTarget("codex")!), context, true);
    // Row 1 is the id, which a driver cannot do without.
    expect(start).toMatchObject({ kind: "form", selected: 1 });
    const named = press({ ...start, selected: 0 } as ProviderView, enter, ...type("Work"), enter);
    expect(named.view).toMatchObject({ kind: "form", draft: { name: "Work", id: "codex_work" } });
  });

  it("checks an id while it is typed: shape, built-in names and ids in use", () => {
    const base = { ...form("codex"), selected: 1 } as ProviderView;
    for (const [id, word] of [
      ["1x", "영문자로 시작"],
      ["codex", "기본 인스턴스"],
      ["codex_work", "이미 있는"],
    ] as const) {
      const run = press(base, enter, ...type(id), enter);
      expect(run.view?.kind).toBe("edit");
      expect(run.notices.join()).toContain(word);
    }
    const good = press(base, enter, ...type("mine"), enter);
    expect(good.view).toMatchObject({ kind: "form", draft: { id: "mine", idTouched: true } });
  });

  it("will not go on while something is missing, and says what", () => {
    const run = press(
      openDraftView(newDraft(parseTarget("codex")!), context),
      ...Array.from({ length: 8 }, () => key("down")),
      enter,
    );
    expect(run.view?.kind).toBe("form");
    expect(run.notices.join()).toContain("ID");
  });

  it("toggles a switch with Enter and picks a select from a list", () => {
    const codex = { ...form("codex"), selected: 6 } as ProviderView;
    const rows = frameOf(codex).join("\n");
    expect(rows).toContain("사용 통계 전송");
    const toggled = press(codex, enter);
    expect(toggled.view).toMatchObject({ kind: "form", draft: { values: { telemetry: true } } });
    const anti = { ...form("antigravity"), selected: 2 } as ProviderView;
    const chosen = press(anti, enter, key("down"), enter);
    expect(chosen.view).toMatchObject({
      kind: "form",
      draft: { values: { authMethod: "oauth-business" } },
    });
    expect(press(anti, enter, escape).view).toMatchObject({ kind: "form", selected: 2 });
  });

  it("clears a text field by sending it empty", () => {
    const withPath = { ...form("codex"), selected: 2 } as ProviderView;
    const set = press(withPath, enter, ...type("/opt/codex"), enter);
    expect(set.view).toMatchObject({ draft: { values: { binaryPath: "/opt/codex" } } });
    const cleared = press(set.view!, enter, { type: "ctrl", letter: "u" }, enter);
    expect((cleared.view as { draft: { values: object } }).draft.values).not.toHaveProperty(
      "binaryPath",
    );
  });
});

describe("a secret field", () => {
  const preset = () => {
    const view = openDraftView(
      withId(newDraft(parseTarget("zai")!), "opencode_zai2"),
      context,
      true,
    );
    if (view.kind !== "form") throw new Error("no form");
    return view;
  };

  it("starts on the key, because the preset cannot be added without it", () => {
    expect(preset().selected).toBe(2);
  });

  it("is typed and pasted without showing, and is kept whole in the draft", () => {
    const editing = press(preset(), enter, ...type("test-"), {
      ...paste(`value-1234\nsecond line`),
    });
    const screen = frameOf(editing.view!).join("\n");
    expect(screen).not.toContain("test-");
    expect(screen).not.toContain("value");
    expect(screen).toContain("•");
    const done = press(editing.view!, enter);
    const draft = (done.view as { draft: { values: Record<string, string> } }).draft;
    // A pasted line break is dropped, not kept as part of the secret.
    expect(draft.values.apiKey).toBe("test-value-1234second line");
  });

  it("is drawn with * when the terminal has no Unicode, and never in the clear", () => {
    const editing = press(preset(), enter, ...type(SECRET)).view!;
    const ascii = frameOf(editing, 61, ASCII_SYMBOLS).join("\n");
    expect(ascii).toContain("*".repeat(SECRET.length));
    expect(ascii).not.toContain(SECRET);
  });

  it("shows only that it is set afterwards, in the form and in the review", () => {
    const filled = press(preset(), enter, ...type(SECRET), enter);
    const screens = [frameOf(filled.view!).join("\n")];
    const review = press(filled.view!, ...Array.from({ length: 5 }, () => key("down")), enter);
    expect(review.view?.kind).toBe("review");
    screens.push(frameOf(review.view!).join("\n"));
    for (const screen of screens) {
      expect(screen).not.toContain(SECRET);
      expect(screen).toContain("설정됨");
    }
  });

  it("keeps the old value when the field is sent empty, and Esc leaves it as it was", () => {
    const filled = press(preset(), enter, ...type(SECRET), enter);
    const again = press(filled.view!, enter, enter);
    expect((again.view as { draft: { values: Record<string, string> } }).draft.values.apiKey).toBe(
      SECRET,
    );
    const escaped = press(filled.view!, enter, ...type("other"), escape);
    expect(
      (escaped.view as { draft: { values: Record<string, string> } }).draft.values.apiKey,
    ).toBe(SECRET);
  });
});

describe("the review", () => {
  const complete = () =>
    openDraftView(
      {
        ...withId(newDraft(parseTarget("zai")!), "opencode_zai2"),
        values: withValue(
          parseTarget("zai")!,
          { service: "api", model: "glm-5.3" },
          "apiKey",
          SECRET,
        ),
      },
      context,
    );

  it("opens straight away for a draft that has everything", () => {
    expect(complete().kind).toBe("review");
  });

  it("adds on Enter and goes back on the second choice or Esc", () => {
    const submitted = press(complete(), enter);
    expect(submitted.effects).toEqual([expect.objectContaining({ kind: "submit" })]);
    expect(press(complete(), key("down"), enter).view?.kind).toBe("form");
    expect(press(complete(), escape).view?.kind).toBe("form");
    expect(press(complete(), escape, escape).view).toBeNull();
  });

  it("checks again before it submits, because an id can be taken meanwhile", () => {
    const view = complete();
    if (view.kind !== "review") throw new Error("no review");
    const taken = { ...view, draft: { ...view.draft, id: "codex_work" } } satisfies ProviderView;
    const run = press(taken, enter);
    expect(run.effects).toEqual([]);
    expect(run.view?.kind).toBe("form");
    expect(run.notices.join()).toContain("이미 있는");
  });
});

describe("removing", () => {
  it("lists only what can be removed", () => {
    const screen = frameOf(openRemovePick()).join("\n");
    expect(screen).toContain("opencode_zai");
    expect(screen).toContain("codex_work");
    expect(screen).not.toMatch(/^.*\bcodex  Codex/mu);
  });

  it("shows the plan, and waits for yes", () => {
    const view = press(openRemovePick(), enter).view!;
    expect(view.kind).toBe("remove");
    const screen = frameOf(view).join("\n");
    expect(screen).toContain("스레드 1개");
    expect(screen).toContain("비밀값 1개");
    expect(screen).toContain("yes");
    const empty = press(view, enter);
    expect(empty.effects).toEqual([]);
    expect(empty.notices.join()).toContain("yes");
    const wrong = press(view, ...type("y"), enter);
    expect(wrong.effects).toEqual([]);
  });

  it("removes on yes in any case, and leaves on Esc without removing", () => {
    const view = press(openRemovePick(), enter).view!;
    expect(press(view, ...type(" YES "), enter).effects).toEqual([
      { kind: "remove", id: "opencode_zai" },
    ]);
    const escaped = press(view, ...type("yes"), escape);
    expect(escaped.effects).toEqual([]);
    expect(escaped.view).toEqual(openRemovePick());
  });

  it("tells a refusal at the list instead of opening a plan", () => {
    const ctx: ProviderContext = {
      ...context,
      checkRemove: () => ({ ok: false, reason: "지울 수 없습니다" }),
    };
    const result = providerKey({ kind: "pickRemove", selected: 0 }, ctx, enter);
    expect(result.view?.kind).toBe("pickRemove");
    expect(result.notice).toBe("지울 수 없습니다");
  });

  it("opens its plan directly for a removal named on the command line", () => {
    const check = context.checkRemove("codex_work");
    if (!check.ok) throw new Error(check.reason);
    expect(press(openRemoveView(check.plan), escape).view).toBeNull();
  });

  it("says so when nothing can be removed", () => {
    const ctx: ProviderContext = { ...context, rows: context.rows.filter((row) => row.isDefault) };
    const screen = providerFrame(openRemovePick(), ctx, {
      columns: 61,
      rows: 24,
      style: makeStyle(false),
      symbols: UNICODE_SYMBOLS,
      banner: null,
      tone: "warning",
    })
      .lines.map(stripAnsi)
      .join("\n");
    expect(screen).toContain("지울 수 있는 Provider 가 없습니다");
  });
});

describe("the frames", () => {
  const views = (): ProviderView[] => {
    const preset = openDraftView(
      withId(newDraft(parseTarget("zai")!), "opencode_zai2"),
      context,
      true,
    );
    const removal = context.checkRemove("opencode_zai");
    if (!removal.ok) throw new Error(removal.reason);
    return [
      openPickView(),
      preset,
      press(preset, enter).view!,
      press(
        preset,
        ...Array.from({ length: 1 }, () => key("up")),
        key("down"),
        key("down"),
        key("down"),
        enter,
      ).view!,
      openRemovePick(),
      openRemoveView(removal.plan),
    ];
  };

  it("fit a 40 column terminal", () => {
    for (const view of views()) {
      for (const line of frameOf(view, 40)) {
        expect([line, stringWidth(line)]).toEqual([line, Math.min(stringWidth(line), 39)]);
      }
    }
  });

  it("use only ASCII marks when asked to, apart from the text itself", () => {
    for (const view of views()) {
      const screen = frameOf(view, 61, ASCII_SYMBOLS).join("\n");
      expect(screen).not.toMatch(/[◆●○│└┌─]/u);
    }
  });
});
