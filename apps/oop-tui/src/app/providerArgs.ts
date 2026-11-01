import {
  newDraft,
  parseTarget,
  targetFields,
  targetWords,
  validateEnvironmentName,
  withId,
  withName,
  withValue,
  looksSecret,
  type AddDraft,
  type EnvEntry,
  type Target,
} from "./providerSpec.ts";
import { t } from "../i18n/index.ts";
import { sanitizeForTerminal } from "../text/width.ts";

const NAME_SHAPE = /^[A-Za-z_-][A-Za-z0-9_.:-]*$/u;
const NAME_LIMIT = 24;

/**
 * The name in a word of the user's, to quote back in a complaint; null when the word does not look
 * like a name (too long, odd characters), so its content is not repeated. What follows `=` is
 * dropped, since a mistyped option (`--api-key=<key>`) or a key typed where a word belongs would
 * otherwise be printed, and the chat keeps what is printed.
 */
export const echoWord = (word: string): string | null => {
  const name = sanitizeForTerminal(word).split("=", 1)[0] ?? "";
  // A run of digits is the body of a key more often than part of a name.
  const looksLikeName = name.length <= NAME_LIMIT && NAME_SHAPE.test(name) && !/\d{3}/u.test(name);
  return looksLikeName ? name : null;
};

/** `Unknown <what>: <name>`, or, when the word is not shaped like a name, that its form is wrong. */
const unknownWord = (what: string, word: string): string => {
  const name = echoWord(word);
  return name === null
    ? t("providers.args.badForm", { what })
    : t("providers.args.unknownWord", { what, name });
};

/** Where the words came from: the shell command line, or the chat's slash command. */
export type ProviderMode = "cli" | "slash";

/** Flags that take a value, and flags that stand alone. `-y` is spelled `--yes` once parsed. */
export const PROVIDER_VALUE_FLAGS: ReadonlyArray<string> = [
  "--id",
  "--name",
  "--set",
  "--env",
  "--secret",
];
export const PROVIDER_SWITCH_FLAGS: ReadonlyArray<string> = ["--yes", "--dry-run"];

export interface RawFlag {
  readonly name: string;
  readonly value: string | null;
}

/** Where a secret comes from when it must stay off the command line. */
export type SecretRef =
  | { readonly kind: "env"; readonly variable: string }
  | { readonly kind: "stdin" };

export interface AddOptions {
  readonly id: string | null;
  readonly name: string | null;
  readonly sets: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly secrets: ReadonlyArray<{ readonly name: string; readonly ref: SecretRef }>;
  readonly yes: boolean;
  readonly dryRun: boolean;
}

export type ProviderRequest =
  | { readonly kind: "list" }
  | { readonly kind: "add"; readonly target: Target | null; readonly options: AddOptions }
  | {
      readonly kind: "remove";
      readonly id: string | null;
      readonly yes: boolean;
      readonly dryRun: boolean;
    };

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

const secretHint = (): string => t("providers.args.secretHint");

/** `@NAME` reads the environment, `-` reads standard input; anything else is not a reference. */
export const parseSecretRef = (text: string): SecretRef | null => {
  if (text === "-") return { kind: "stdin" };
  if (text.startsWith("@") && validateEnvironmentName(text.slice(1)) === null) {
    return { kind: "env", variable: text.slice(1) };
  }
  return null;
};

// ---- splitting a slash command's text into words ----------------------------------------------

/** Words of `text`, with single or double quotes keeping spaces inside a word. */
export const splitWords = (text: string): Parsed<string[]> => {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote !== null) return fail(t("providers.args.unclosedQuote"));
  if (started) words.push(current);
  return { ok: true, value: words };
};

/** Splits `words` into positional words and provider flags, for a command that has no other options. */
export const collectFlags = (
  words: ReadonlyArray<string>,
): Parsed<{ positional: string[]; flags: RawFlag[] }> => {
  const positional: string[] = [];
  const flags: RawFlag[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    const raw = equals === -1 ? word : word.slice(0, equals);
    const name = raw === "-y" ? "--yes" : raw;
    if (PROVIDER_SWITCH_FLAGS.includes(name)) {
      if (equals !== -1) return fail(t("providers.args.noValue", { name }));
      flags.push({ name, value: null });
    } else if (PROVIDER_VALUE_FLAGS.includes(name)) {
      let value: string | null = equals === -1 ? null : word.slice(equals + 1);
      if (value === null) {
        const next = words[index + 1];
        if (next === undefined || next.startsWith("-"))
          return fail(t("providers.args.needsValue", { name }));
        value = next;
        index += 1;
      }
      flags.push({ name, value });
    } else if (word.startsWith("-") && word.length > 1) {
      return fail(unknownWord(t("providers.args.whatOption"), word));
    } else {
      positional.push(word);
    }
  }
  return { ok: true, value: { positional, flags } };
};

// ---- turning words into a request -------------------------------------------------------------

const usage = (mode: ProviderMode): string =>
  t(mode === "cli" ? "providers.args.usageCli" : "providers.args.usageSlash");

const splitAssignment = (
  flag: string,
  text: string,
  shape: string,
): Parsed<{ key: string; value: string }> => {
  const at = text.indexOf("=");
  if (at <= 0) return fail(t("providers.args.shape", { flag, shape }));
  return { ok: true, value: { key: text.slice(0, at), value: text.slice(at + 1) } };
};

const readAddOptions = (flags: ReadonlyArray<RawFlag>, mode: ProviderMode): Parsed<AddOptions> => {
  let id: string | null = null;
  let name: string | null = null;
  let yes = false;
  let dryRun = false;
  const sets: Array<{ key: string; value: string }> = [];
  const env: Array<{ name: string; value: string }> = [];
  const secrets: Array<{ name: string; ref: SecretRef }> = [];
  for (const flag of flags) {
    const value = flag.value ?? "";
    switch (flag.name) {
      case "--id":
        id = value.trim();
        break;
      case "--name":
        name = value;
        break;
      case "--yes":
        if (mode === "slash") {
          return fail(t("providers.args.slashYesAdd"));
        }
        yes = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--set": {
        const parsed = splitAssignment("--set", value, t("providers.args.shapeKeyValue"));
        if (!parsed.ok) return parsed;
        sets.push(parsed.value);
        break;
      }
      case "--env": {
        const parsed = splitAssignment("--env", value, t("providers.args.shapeNameValue"));
        if (!parsed.ok) return parsed;
        env.push({ name: parsed.value.key, value: parsed.value.value });
        break;
      }
      case "--secret": {
        if (mode === "slash") {
          return fail(t("providers.args.slashNoSecret"));
        }
        const parsed = splitAssignment("--secret", value, t("providers.args.shapeSecret"));
        if (!parsed.ok) return parsed;
        const ref = parseSecretRef(parsed.value.value);
        if (ref === null)
          return fail(`--secret ${echoWord(parsed.value.key) ?? "…"}: ${secretHint()}`);
        secrets.push({ name: parsed.value.key, ref });
        break;
      }
    }
  }
  return { ok: true, value: { id, name, sets, env, secrets, yes, dryRun } };
};

/**
 * Reads `provider <verb> ...` into a request. `words` start at the verb; a missing verb means
 * `list`. Both the shell command and the slash command go through here, so they agree.
 */
export const resolveProviderRequest = (
  words: ReadonlyArray<string>,
  flags: ReadonlyArray<RawFlag>,
  mode: ProviderMode,
): Parsed<ProviderRequest> => {
  const [verb = "list", ...rest] = words;
  if (verb === "list") {
    if (rest.length > 0 || flags.length > 0) return fail(usage(mode));
    return { ok: true, value: { kind: "list" } };
  }
  if (verb === "add") {
    if (rest.length > 1) return fail(usage(mode));
    let target: Target | null = null;
    if (rest[0] !== undefined) {
      target = parseTarget(rest[0]);
      if (target === null) {
        return fail(`${unknownWord(t("providers.args.whatKind"), rest[0])} (${targetWords()})`);
      }
    }
    const options = readAddOptions(flags, mode);
    if (!options.ok) return options;
    const given = flags.some((flag) => flag.name !== "--dry-run" && flag.name !== "--yes");
    if (target === null && (given || options.value.dryRun || options.value.yes)) {
      return fail(t("providers.args.kindRequired", { kinds: targetWords() }));
    }
    return { ok: true, value: { kind: "add", target, options: options.value } };
  }
  if (verb === "remove") {
    if (rest.length > 1 || (rest.length === 0 && mode === "cli")) return fail(usage(mode));
    let yes = false;
    let dryRun = false;
    for (const flag of flags) {
      if (flag.name === "--yes") {
        if (mode === "slash") {
          return fail(t("providers.args.slashYesRemove"));
        }
        yes = true;
      } else if (flag.name === "--dry-run") {
        dryRun = true;
      } else {
        return fail(usage(mode));
      }
    }
    return { ok: true, value: { kind: "remove", id: rest[0] ?? null, yes, dryRun } };
  }
  return fail(`${unknownWord(t("providers.args.whatSubcommand"), verb)}. ${usage(mode)}`);
};

/** The slash command's text after `/provider`, as a request. */
export const parseProviderSlash = (text: string): Parsed<ProviderRequest> => {
  const split = splitWords(text);
  if (!split.ok) return split;
  const collected = collectFlags(split.value);
  if (!collected.ok) return collected;
  return resolveProviderRequest(collected.value.positional, collected.value.flags, "slash");
};

// ---- filling in a draft from the options ------------------------------------------------------

export interface SecretInput {
  /** False where a secret cannot be named by reference (the chat), so a secret field must be typed in. */
  readonly refs?: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Everything read from standard input, or null when none was read. */
  readonly stdin: string | null;
}

/** True when the options name standard input as a secret's source, so the caller must read it first. */
export const wantsStdin = (target: Target, options: AddOptions): boolean => {
  const passwords = new Set(
    targetFields(target)
      .filter((field) => field.control === "password")
      .map((field) => field.key),
  );
  return (
    options.secrets.some((secret) => secret.ref.kind === "stdin") ||
    options.sets.some((set) => passwords.has(set.key) && set.value === "-")
  );
};

const BOOLEAN_WORDS: ReadonlyArray<readonly [string, boolean]> = [
  ["true", true],
  ["on", true],
  ["yes", true],
  ["1", true],
  ["false", false],
  ["off", false],
  ["no", false],
  ["0", false],
];

/**
 * The draft the options describe. A secret is only ever read from a reference; naming a value
 * outright is refused without repeating it.
 */
export const resolveAdd = (
  target: Target,
  options: AddOptions,
  input: SecretInput,
): Parsed<AddDraft> => {
  let draft = newDraft(target);
  if (options.name !== null) draft = withName(draft, sanitizeForTerminal(options.name).trim());
  if (options.id !== null) draft = withId(draft, options.id);

  let stdinUsed = false;
  const read = (label: string, ref: SecretRef): Parsed<string> => {
    let text: string | undefined;
    if (ref.kind === "env") {
      text = input.env[ref.variable]?.trim();
      if (text === undefined || text === "") {
        return fail(t("providers.args.envEmpty", { label, variable: ref.variable }));
      }
    } else {
      if (stdinUsed) return fail(t("providers.args.stdinOnce"));
      stdinUsed = true;
      text = input.stdin?.replace(/\r?\n$/u, "").trim();
      if (text === undefined || text === "") return fail(t("providers.args.stdinEmpty", { label }));
    }
    return { ok: true, value: text };
  };

  const fields = targetFields(target);
  for (const set of options.sets) {
    const field = fields.find((candidate) => candidate.key === set.key);
    if (field === undefined) {
      return fail(
        `${unknownWord(t("providers.args.whatSettingKey"), set.key)}. ${t("providers.args.allowedKeys", { keys: fields.map((candidate) => candidate.key).join(", ") })}`,
      );
    }
    if (field.control === "password") {
      if (input.refs === false) {
        return fail(t("providers.args.maskedOnly", { label: field.label }));
      }
      const ref = parseSecretRef(set.value);
      if (ref === null) return fail(`--set ${field.key}: ${secretHint()}`);
      const secret = read(`--set ${field.key}`, ref);
      if (!secret.ok) return secret;
      draft = { ...draft, values: withValue(target, draft.values, field.key, secret.value) };
    } else if (field.control === "select") {
      const wanted = set.value.trim().toLowerCase();
      const option = field.options?.find((candidate) => candidate.value.toLowerCase() === wanted);
      if (option === undefined) {
        return fail(
          t("providers.args.oneOf", {
            key: field.key,
            options: (field.options ?? []).map((candidate) => candidate.value).join(" | "),
          }),
        );
      }
      draft = { ...draft, values: withValue(target, draft.values, field.key, option.value) };
    } else if (field.control === "switch") {
      const word = BOOLEAN_WORDS.find(([text]) => text === set.value.trim().toLowerCase());
      if (word === undefined) return fail(t("providers.args.trueOrFalse", { key: field.key }));
      draft = { ...draft, values: withValue(target, draft.values, field.key, word[1]) };
    } else {
      const text = sanitizeForTerminal(set.value).trim();
      draft = {
        ...draft,
        values: withValue(target, draft.values, field.key, text === "" ? null : text),
      };
    }
  }

  const env: EnvEntry[] = [];
  const addEnv = (name: string, value: string, sensitive: boolean): string | null => {
    const problem = validateEnvironmentName(name);
    if (problem !== null) return problem;
    if (env.some((entry) => entry.name === name)) {
      return t("providers.args.envTwice", {
        name: echoWord(name) ?? t("providers.args.nameFallback"),
      });
    }
    env.push({ name, value, sensitive });
    return null;
  };
  for (const entry of options.env) {
    if (looksSecret(entry.name)) {
      const shown = echoWord(entry.name);
      if (shown === null) return fail(t("providers.args.envNameBad"));
      // The chat takes no secret by reference: the way to add one is the shell command.
      return fail(
        input.refs === false
          ? t("providers.args.secretNameChat", { shown })
          : t("providers.args.secretNameCli", { shown }),
      );
    }
    const problem = addEnv(entry.name, sanitizeForTerminal(entry.value), false);
    if (problem !== null) return fail(problem);
  }
  for (const secret of options.secrets) {
    const value = read(`--secret ${secret.name}`, secret.ref);
    if (!value.ok) return value;
    const problem = addEnv(secret.name, value.value, true);
    if (problem !== null) return fail(problem);
  }
  return { ok: true, value: { ...draft, env } };
};
