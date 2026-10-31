import type {
  OrchestrationShellSnapshot,
  ServerConfig,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";

import { padEndVisible, truncateStyled } from "../text/wrap.ts";
import { sanitizeForTerminal, stringWidth } from "../text/width.ts";
import { resolveAdd, wantsStdin, type ProviderRequest } from "./providerArgs.ts";
import {
  addPatch,
  planLines,
  planRemove,
  previewPayload,
  providerRows,
  removePatch,
  rowOfProvider,
  takenIds,
  tryBuild,
  type ProviderRow,
} from "./providerPlan.ts";
import { isYes, type ProviderContext } from "./providerScreen.ts";
import {
  afterAddAdvice,
  draftProblem,
  draftSecrets,
  redactSecrets,
  summarize,
  targetLabel,
  type AddDraft,
} from "./providerSpec.ts";
import { createSettingsPatcher, type SettingsLink } from "./settingsPatch.ts";

/** The slice of the link the shell command uses. */
export interface ProviderCliLink extends SettingsLink {
  readonly config: ServerConfig | null;
  readonly shell: OrchestrationShellSnapshot | null;
  readonly refreshProviders: (input?: {
    readonly instanceId?: string;
  }) => Promise<ReadonlyArray<ServerProvider>>;
}

export interface ProviderCommandDeps {
  readonly link: ProviderCliLink;
  /**
   * Waits until the server has answered (and, for `shell`, sent the thread list). Resolves with a
   * message when it cannot be reached in time, else null.
   */
  readonly waitReady: (need: { readonly shell: boolean }) => Promise<string | null>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Standard input and output are a terminal, so a question can be asked. */
  readonly interactive: boolean;
  /** Standard input is a terminal: reading it to the end would wait for the user with no prompt. */
  readonly stdinIsTerminal: boolean;
  /** All of standard input; only called when a secret is to come from it. */
  readonly readStdin: () => Promise<string>;
  /** Asks one line on the terminal; null when the input ended. */
  readonly ask: (question: string) => Promise<string | null>;
  /** The add screens, started from `start` (null: from the list of kinds); null when the user left. */
  readonly wizard: (start: AddDraft | null, context: ProviderContext) => Promise<AddDraft | null>;
  readonly columns: number;
}

const fail = (deps: ProviderCommandDeps, message: string, code = 1): number => {
  deps.err(`error: ${sanitizeForTerminal(message)}`);
  return code;
};

// ---- list -------------------------------------------------------------------------------------

const MESSAGE_LIMIT = 60;

/** The table of `oop provider list`, one line per provider. */
export const listTable = (rows: ReadonlyArray<ProviderRow>): string[] => {
  const cells = rows.map((row) => [
    row.id,
    row.name,
    row.driver,
    row.enabled ? "켜짐" : "꺼짐",
    row.status,
    row.models === null ? "-" : String(row.models),
    row.isDefault ? "기본" : "",
    row.message === null ? "" : truncateStyled(row.message, MESSAGE_LIMIT),
  ]);
  const header = ["ID", "이름", "종류", "사용", "상태", "모델", "기본", "메모"];
  const all = [header, ...cells];
  const widths = header.map((_, column) =>
    Math.max(...all.map((row) => stringWidth(row[column] ?? ""))),
  );
  return all.map((row) =>
    row
      .map((cell, column) => padEndVisible(cell, widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  );
};

const runList = async (deps: ProviderCommandDeps): Promise<number> => {
  const wait = await deps.waitReady({ shell: false });
  if (wait !== null) return fail(deps, wait);
  const settings = await deps.link.getSettings().catch(() => null);
  const rows = providerRows(deps.link.config, settings ?? deps.link.config?.settings ?? null);
  if (rows.length === 0) {
    deps.out("등록된 Provider 가 없습니다.");
    return 0;
  }
  for (const line of listTable(rows)) deps.out(line);
  return 0;
};

// ---- applying ---------------------------------------------------------------------------------

/** Asks the server to look at the providers again; says what the new one turned out to be. */
const refreshAndReport = async (
  deps: ProviderCommandDeps,
  instanceId: string | null,
): Promise<void> => {
  try {
    const providers = await deps.link.refreshProviders(
      instanceId === null ? undefined : { instanceId },
    );
    const found = providers.find((provider) => provider.instanceId === instanceId);
    if (found !== undefined) {
      const row = rowOfProvider(found);
      deps.out(
        `상태: ${row.status}${row.models === null ? "" : ` · 모델 ${row.models}개`}${row.message === null ? "" : ` · ${row.message}`}`,
      );
    }
  } catch {
    deps.err("상태를 새로 읽지 못했습니다. 잠시 뒤 oop provider list 로 확인하세요.");
  }
};

const contextOf = async (deps: ProviderCommandDeps): Promise<ProviderContext> => {
  const settings = await deps.link.getSettings();
  const config = deps.link.config;
  return {
    taken: takenIds(config, settings),
    rows: providerRows(config, settings),
    checkRemove: (id) => planRemove({ id, settings, shell: deps.link.shell }),
  };
};

const runAdd = async (
  deps: ProviderCommandDeps,
  request: Extract<ProviderRequest, { kind: "add" }>,
): Promise<number> => {
  const { options } = request;
  if (request.target === null && !deps.interactive) {
    return fail(deps, "종류를 지정하세요. 예: oop provider add opencode --id my_opencode", 2);
  }
  const wait = await deps.waitReady({ shell: false });
  if (wait !== null) return fail(deps, wait);
  let context: ProviderContext;
  try {
    context = await contextOf(deps);
  } catch (cause) {
    return fail(
      deps,
      `설정을 읽지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  let draft: AddDraft | null;
  let confirmed = false;
  // Standard input was read to its end for a secret, so no question can be answered afterwards.
  let stdinConsumed = false;
  if (request.target === null) {
    draft = await deps.wizard(null, context);
    confirmed = draft !== null;
  } else {
    const fromStdin = wantsStdin(request.target, options);
    if (fromStdin && deps.stdinIsTerminal) {
      return fail(
        deps,
        "표준입력(-)은 파이프로 넘길 때만 쓸 수 있습니다. 예: pbpaste | oop provider add zai --set apiKey=- -y. 환경 변수(--set apiKey=@변수명)를 쓰거나, --set 없이 실행해 입력 화면에서 가려서 입력하세요.",
        2,
      );
    }
    const stdin = fromStdin ? await deps.readStdin() : null;
    const resolved = resolveAdd(request.target, options, { env: deps.env, stdin });
    if (!resolved.ok) return fail(deps, resolved.message);
    draft = resolved.value;
    stdinConsumed = fromStdin;
    // Something is missing (an id, a key): on a terminal the screens ask for it; in a script it is an error.
    const problem = draftProblem(draft, context.taken);
    if (problem !== null) {
      if (!deps.interactive || options.dryRun || stdinConsumed) return fail(deps, problem);
      draft = await deps.wizard(draft, context);
      confirmed = draft !== null;
    }
  }
  if (draft === null) {
    deps.err("취소했습니다.");
    return 1;
  }

  const secrets = draftSecrets(draft);
  const problem = draftProblem(draft, context.taken);
  if (problem !== null) return fail(deps, problem);
  const built = tryBuild(draft);
  if (!built.ok) return fail(deps, built.message);

  for (const row of summarize(draft)) deps.out(`${padEndVisible(row.label, 14)} ${row.value}`);
  if (options.dryRun) {
    deps.out("");
    deps.out("--dry-run: 아래 내용을 보냅니다. 비밀값은 가려져 있습니다.");
    for (const line of previewPayload(draft, built.instance).split("\n")) deps.out(line);
    return 0;
  }
  if (!confirmed && !options.yes) {
    if (!deps.interactive || stdinConsumed)
      return fail(deps, "확인이 필요합니다. 터미널에서 실행하거나 -y 를 붙이세요.");
    const answer = await deps.ask("추가할까요? [y/N] ");
    if (answer === null || !/^y(es)?$/iu.test(answer.trim())) {
      deps.err("취소했습니다.");
      return 1;
    }
  }

  const patch = createSettingsPatcher(deps.link);
  const result = await patch((current) => addPatch(current, draft.id, built.instance));
  if (!result.ok) {
    return fail(
      deps,
      `추가하지 못했습니다: ${redactSecrets(result.message, secrets)}${result.rejected ? "" : " (서버에 닿았는지 확실하지 않습니다. oop provider list 로 확인하세요)"}`,
    );
  }
  if (!result.changed) return fail(deps, `'${draft.id}' 는 이미 있는 ID 입니다.`);
  deps.out(`추가했습니다: ${draft.id} (${targetLabel(draft.target)})`);
  const advice = afterAddAdvice(draft);
  if (advice !== null) deps.out(advice);
  await refreshAndReport(deps, draft.id);
  return 0;
};

const runRemove = async (
  deps: ProviderCommandDeps,
  request: Extract<ProviderRequest, { kind: "remove" }>,
): Promise<number> => {
  const id = request.id;
  if (id === null)
    return fail(deps, "삭제할 ID 가 필요합니다. 사용법: oop provider remove <id>", 2);
  const wait = await deps.waitReady({ shell: true });
  if (wait !== null) return fail(deps, wait);
  let settings: ServerSettings;
  try {
    settings = await deps.link.getSettings();
  } catch (cause) {
    return fail(
      deps,
      `설정을 읽지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const check = planRemove({ id, settings, shell: deps.link.shell });
  if (!check.ok) return fail(deps, check.reason);
  for (const line of planLines(check.plan)) deps.out(line);
  if (request.dryRun) {
    deps.out("--dry-run: 삭제하지 않았습니다.");
    return 0;
  }
  if (!request.yes) {
    if (!deps.interactive)
      return fail(deps, "확인이 필요합니다. 터미널에서 실행하거나 -y 를 붙이세요.");
    const answer = await deps.ask("삭제하려면 yes 를 입력하세요: ");
    if (answer === null || !isYes(answer)) {
      deps.err("취소했습니다.");
      return 1;
    }
  }
  const patch = createSettingsPatcher(deps.link);
  const result = await patch((current) => removePatch(current, id));
  if (!result.ok) {
    return fail(
      deps,
      `삭제하지 못했습니다: ${result.message}${result.rejected ? "" : " (서버에 닿았는지 확실하지 않습니다. oop provider list 로 확인하세요)"}`,
    );
  }
  if (!result.changed) return fail(deps, `'${id}' 는 이미 없습니다.`);
  deps.out(`삭제했습니다: ${id}`);
  await refreshAndReport(deps, null);
  return 0;
};

/** `oop provider ...`. Returns the exit code: 0 done, 1 failed or cancelled, 2 used wrongly. */
export const runProviderCommand = async (
  request: ProviderRequest,
  deps: ProviderCommandDeps,
): Promise<number> => {
  switch (request.kind) {
    case "list":
      return runList(deps);
    case "add":
      return runAdd(deps, request);
    case "remove":
      return runRemove(deps, request);
  }
};
