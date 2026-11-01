import type {
  OrchestrationShellSnapshot,
  ServerConfig,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";

import { t } from "../i18n/index.ts";
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
    row.enabled ? t("providers.cmd.on") : t("providers.cmd.off"),
    row.status,
    row.models === null ? "-" : String(row.models),
    row.isDefault ? t("providers.cmd.default") : "",
    row.message === null ? "" : truncateStyled(row.message, MESSAGE_LIMIT),
  ]);
  const header = [
    "ID",
    t("providers.cmd.colName"),
    t("providers.cmd.colKind"),
    t("providers.cmd.colEnabled"),
    t("providers.cmd.colStatus"),
    t("providers.cmd.colModels"),
    t("providers.cmd.colDefault"),
    t("providers.cmd.colNote"),
  ];
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
    deps.out(t("providers.cmd.none"));
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
        `${t("providers.cmd.status", { status: row.status })}${row.models === null ? "" : ` · ${t("providers.cmd.modelCount", { count: row.models })}`}${row.message === null ? "" : ` · ${row.message}`}`,
      );
    }
  } catch {
    deps.err(t("providers.cmd.refreshFailed"));
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
    return fail(deps, t("providers.cmd.kindNeeded"), 2);
  }
  const wait = await deps.waitReady({ shell: false });
  if (wait !== null) return fail(deps, wait);
  let context: ProviderContext;
  try {
    context = await contextOf(deps);
  } catch (cause) {
    return fail(
      deps,
      t("providers.cmd.settingsReadFailed", {
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
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
      return fail(deps, t("providers.cmd.stdinPipeOnly"), 2);
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
    deps.err(t("providers.cmd.cancelled"));
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
    deps.out(t("providers.cmd.dryRunAdd"));
    for (const line of previewPayload(draft, built.instance).split("\n")) deps.out(line);
    return 0;
  }
  if (!confirmed && !options.yes) {
    if (!deps.interactive || stdinConsumed) return fail(deps, t("providers.cmd.confirmNeeded"));
    const answer = await deps.ask(t("providers.cmd.askAdd"));
    if (answer === null || !/^y(es)?$/iu.test(answer.trim())) {
      deps.err(t("providers.cmd.cancelled"));
      return 1;
    }
  }

  const patch = createSettingsPatcher(deps.link);
  const result = await patch((current) => addPatch(current, draft.id, built.instance));
  if (!result.ok) {
    return fail(
      deps,
      `${t("providers.cmd.addFailed", { reason: redactSecrets(result.message, secrets) })}${result.rejected ? "" : ` ${t("providers.cmd.unsure")}`}`,
    );
  }
  if (!result.changed) return fail(deps, t("providers.cmd.idTaken", { id: draft.id }));
  deps.out(t("providers.cmd.added", { id: draft.id, kind: targetLabel(draft.target) }));
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
  if (id === null) return fail(deps, t("providers.cmd.removeNeedsId"), 2);
  const wait = await deps.waitReady({ shell: true });
  if (wait !== null) return fail(deps, wait);
  let settings: ServerSettings;
  try {
    settings = await deps.link.getSettings();
  } catch (cause) {
    return fail(
      deps,
      t("providers.cmd.settingsReadFailed", {
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }
  const check = planRemove({ id, settings, shell: deps.link.shell });
  if (!check.ok) return fail(deps, check.reason);
  for (const line of planLines(check.plan)) deps.out(line);
  if (request.dryRun) {
    deps.out(t("providers.cmd.dryRunRemove"));
    return 0;
  }
  if (!request.yes) {
    if (!deps.interactive) return fail(deps, t("providers.cmd.confirmNeeded"));
    const answer = await deps.ask(t("providers.cmd.askRemove"));
    if (answer === null || !isYes(answer)) {
      deps.err(t("providers.cmd.cancelled"));
      return 1;
    }
  }
  const patch = createSettingsPatcher(deps.link);
  const result = await patch((current) => removePatch(current, id));
  if (!result.ok) {
    return fail(
      deps,
      `${t("providers.cmd.removeFailed", { reason: result.message })}${result.rejected ? "" : ` ${t("providers.cmd.unsure")}`}`,
    );
  }
  if (!result.changed) return fail(deps, t("providers.cmd.alreadyGone", { id }));
  deps.out(t("providers.cmd.removed", { id }));
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
