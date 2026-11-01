import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GrokSettings,
  MiniMaxCodeSettings,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceEnvironmentVariableName,
  TrimmedNonEmptyString,
  ZCodeSettings,
  type ProviderInstanceConfig,
  type ProviderSettingsFormControl,
  type ProviderSettingsFormOption,
} from "@t3tools/contracts";
import {
  createPresetProviderInstance,
  PROVIDER_PRESETS,
  type ProviderPresetId,
  type ProviderPresetService,
} from "@t3tools/client-runtime/provider-presets";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { t, type MessageKey } from "../i18n/index.ts";
import { sanitizeForTerminal } from "../text/width.ts";

// ---- drivers ----------------------------------------------------------------------------------

type SettingsSchema = { readonly fields: Readonly<Record<string, Schema.Top>> } & Schema.Top;

/** A provider the user can add, in the order the desktop app lists them. */
export interface DriverEntry {
  readonly value: string;
  readonly label: string;
  /** The desktop app marks these as early access. */
  readonly earlyAccess: boolean;
  readonly schema: SettingsSchema;
}

export const DRIVERS: ReadonlyArray<DriverEntry> = [
  { value: "codex", label: "Codex", earlyAccess: false, schema: CodexSettings },
  { value: "claudeAgent", label: "Claude", earlyAccess: false, schema: ClaudeSettings },
  { value: "cursor", label: "Cursor", earlyAccess: true, schema: CursorSettings },
  { value: "grok", label: "Grok", earlyAccess: true, schema: GrokSettings },
  { value: "opencode", label: "OpenCode", earlyAccess: false, schema: OpenCodeSettings },
  { value: "antigravity", label: "Antigravity", earlyAccess: false, schema: AntigravitySettings },
  { value: "minimax", label: "MiniMax Code", earlyAccess: true, schema: MiniMaxCodeSettings },
  { value: "zcode", label: "ZCode", earlyAccess: true, schema: ZCodeSettings },
];

/**
 * An instance whose id is the name of a driver is that driver's built-in default. It cannot be
 * removed, and a new instance may not take the id.
 */
export const isDefaultInstanceId = (id: string): boolean =>
  DRIVERS.some((driver) => driver.value === id);

export const driverLabel = (driver: string): string =>
  DRIVERS.find((entry) => entry.value === driver)?.label ?? driver;

// ---- what can be added ------------------------------------------------------------------------

/** Something to pick in the add wizard: a driver, or a ready-made OpenCode setup for a service. */
export type Target =
  | { readonly kind: "driver"; readonly driver: DriverEntry }
  | { readonly kind: "preset"; readonly preset: ProviderPresetId };

export const PRESET_IDS: ReadonlyArray<ProviderPresetId> = ["zai", "minimax"];

export const TARGETS: ReadonlyArray<Target> = [
  ...DRIVERS.map((driver): Target => ({ kind: "driver", driver })),
  ...PRESET_IDS.map((preset): Target => ({ kind: "preset", preset })),
];

export const targetLabel = (target: Target): string =>
  target.kind === "driver" ? target.driver.label : PROVIDER_PRESETS[target.preset].label;

/** The word that names the target on a command line. `minimax` is the driver; the preset has a prefix. */
export const targetWord = (target: Target): string =>
  target.kind === "driver" ? target.driver.value : `preset:${target.preset}`;

/** The driver kind the instance will have: a preset is an OpenCode instance. */
export const targetDriver = (target: Target): string =>
  target.kind === "driver" ? target.driver.value : "opencode";

const sameTarget = (left: Target, right: Target): boolean => targetWord(left) === targetWord(right);

export const targetIndex = (target: Target): number =>
  TARGETS.findIndex((candidate) => sameTarget(candidate, target));

/** Every word `parseTarget` takes, for the message that says what was meant. */
export const targetWords = (): string =>
  [
    ...DRIVERS.map((driver) => driver.value),
    ...PRESET_IDS.map((preset) => (preset === "zai" ? "zai" : `preset:${preset}`)),
  ].join(" | ");

/** The target a command-line word names; null when it names none. */
export const parseTarget = (word: string): Target | null => {
  const wanted = word.trim().toLowerCase();
  if (wanted === "") return null;
  if (wanted === "claude") return TARGETS[1] ?? null;
  const driver = DRIVERS.find((entry) => entry.value.toLowerCase() === wanted);
  if (driver !== undefined) return { kind: "driver", driver };
  const presetWord = wanted.startsWith("preset:") ? wanted.slice("preset:".length) : wanted;
  const preset = PRESET_IDS.find((id) => id === presetWord);
  return preset === undefined ? null : { kind: "preset", preset };
};

// ---- the fields of a target -------------------------------------------------------------------

export interface FieldModel {
  readonly key: string;
  readonly control: Exclude<ProviderSettingsFormControl, "textarea">;
  readonly label: string;
  readonly placeholder?: string;
  readonly options?: ReadonlyArray<ProviderSettingsFormOption>;
  /** The value of a switch the server uses when nothing is set. */
  readonly defaultBoolean?: boolean;
  /** The instance cannot be added without it. */
  readonly required?: boolean;
}

/** Our own names for the fields the schemas name in English; an unlisted field keeps its own title. */
const FIELD_LABELS: Readonly<Record<string, MessageKey>> = {
  binaryPath: "providers.field.binaryPath",
  homePath: "providers.field.homePath",
  shadowHomePath: "providers.field.shadowHomePath",
  launchArgs: "providers.field.launchArgs",
  telemetry: "providers.field.telemetry",
  authMethod: "providers.field.authMethod",
  apiKey: "providers.field.apiKey",
  gcpProject: "providers.field.gcpProject",
  gcpLocation: "providers.field.gcpLocation",
  serverUrl: "providers.field.serverUrl",
  serverPassword: "providers.field.serverPassword",
  apiEndpoint: "providers.field.apiEndpoint",
  bridgePath: "providers.field.bridgePath",
  autoCompactWindow: "providers.field.autoCompactWindow",
  claudeAiConnectors: "providers.field.claudeAiConnectors",
};

const labelOf = (key: string, title: unknown): string => {
  const known = FIELD_LABELS[key];
  return known !== undefined ? t(known) : typeof title === "string" ? title : key;
};

const annotationsOf = (field: Schema.Top) =>
  Schema.resolveAnnotationsKey(field) ?? Schema.resolveAnnotations(field);

const booleanDefault = (field: Schema.Top): boolean | undefined => {
  const decoded = Schema.decodeUnknownOption(field as Schema.Decoder<unknown>)(undefined);
  return Option.isSome(decoded) && typeof decoded.value === "boolean" ? decoded.value : undefined;
};

/** The fields the desktop app's form shows for a driver, in its order. */
export const driverFields = (driver: DriverEntry): ReadonlyArray<FieldModel> => {
  const order = Schema.resolveAnnotations(driver.schema)?.providerSettingsFormSchema?.order ?? [];
  const rank = (key: string, index: number) => {
    const position = order.indexOf(key);
    return position === -1 ? order.length + index : position;
  };
  return Object.keys(driver.schema.fields)
    .map((key, index) => ({ key, index }))
    .toSorted((left, right) => rank(left.key, left.index) - rank(right.key, right.index))
    .flatMap(({ key }): FieldModel[] => {
      const field = driver.schema.fields[key];
      if (field === undefined) return [];
      const form = annotationsOf(field)?.providerSettingsForm ?? {};
      if (form.hidden) return [];
      const title = annotationsOf(field)?.title;
      const control = form.control === "textarea" ? "text" : (form.control ?? "text");
      return [
        {
          key,
          control,
          label: labelOf(key, title),
          ...(form.placeholder === undefined ? {} : { placeholder: form.placeholder }),
          ...(control === "select" && form.options ? { options: form.options } : {}),
          ...(control === "switch" ? { defaultBoolean: booleanDefault(field) ?? false } : {}),
        },
      ];
    });
};

/** What the form asks for a preset: the key, the service, the model and where OpenCode is. */
export const presetFields = (preset: ProviderPresetId): ReadonlyArray<FieldModel> => {
  const entry = PROVIDER_PRESETS[preset];
  return [
    { key: "apiKey", control: "password", label: t("providers.field.apiKey"), required: true },
    {
      key: "service",
      control: "select",
      label: t("providers.spec.service"),
      options: entry.services.map((service) => ({ value: service.value, label: service.label })),
    },
    { key: "model", control: "text", label: t("providers.spec.model") },
    {
      key: "binaryPath",
      control: "text",
      label: t("providers.spec.openCodePath"),
      placeholder: "opencode",
    },
  ];
};

export const targetFields = (target: Target): ReadonlyArray<FieldModel> =>
  target.kind === "driver" ? driverFields(target.driver) : presetFields(target.preset);

const presetService = (preset: ProviderPresetId, service: string | boolean | undefined) => {
  const entry = PROVIDER_PRESETS[preset];
  return (
    entry.services.find((candidate) => candidate.value === service) ??
    entry.services.find((candidate) => candidate.value === entry.defaultService) ??
    entry.services[0]
  );
};

/** The values a new draft starts with: a preset's default service and model, as the desktop app fills them. */
export const initialValues = (target: Target): Record<string, string | boolean> => {
  if (target.kind === "driver") return {};
  const service = presetService(target.preset, undefined);
  return {
    service: PROVIDER_PRESETS[target.preset].defaultService,
    model: service?.defaultModel ?? "",
  };
};

/**
 * `values` with one field changed. Picking another service of a preset moves the model along if it
 * was still the first service's default, as in the desktop app.
 */
export const withValue = (
  target: Target,
  values: Readonly<Record<string, string | boolean>>,
  key: string,
  value: string | boolean | null,
): Record<string, string | boolean> => {
  const next: Record<string, string | boolean> = { ...values };
  if (value === null) delete next[key];
  else next[key] = value;
  if (target.kind === "preset" && key === "service" && typeof value === "string") {
    const before = presetService(target.preset, values.service)?.defaultModel;
    const after = presetService(target.preset, value)?.defaultModel;
    if (after !== undefined && (values.model === undefined || values.model === before)) {
      next.model = after;
    }
  }
  return next;
};

// ---- ids and names ----------------------------------------------------------------------------

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/u;
const ENVIRONMENT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;
const INSTANCE_ID_MAX = 64;
const ENVIRONMENT_NAME_MAX = 128;

/** Why `id` cannot name a new instance, as a sentence; null when it can. `taken` holds every id in use. */
export const validateInstanceId = (id: string, taken: ReadonlySet<string>): string | null => {
  if (id.length === 0) return t("providers.spec.idRequired");
  if (id.length > INSTANCE_ID_MAX) return t("providers.spec.idTooLong", { max: INSTANCE_ID_MAX });
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return t("providers.spec.idShape");
  }
  if (isDefaultInstanceId(id)) return t("providers.spec.idBuiltIn", { id });
  if (taken.has(id)) return t("providers.cmd.idTaken", { id });
  return null;
};

/** Whether `id` is shaped like an instance id; what is not is never repeated back in a complaint. */
export const isInstanceIdShape = (id: string): boolean =>
  id.length > 0 && id.length <= INSTANCE_ID_MAX && INSTANCE_ID_PATTERN.test(id);

/**
 * Why `name` cannot be the name of an environment variable; null when it can. The name is not
 * repeated: a value typed where a name belongs would otherwise be printed.
 */
export const validateEnvironmentName = (name: string): string | null => {
  if (name.length === 0) return t("providers.spec.envNameRequired");
  if (name.length > ENVIRONMENT_NAME_MAX) {
    return t("providers.spec.envNameTooLong", { max: ENVIRONMENT_NAME_MAX });
  }
  if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
    return t("providers.spec.envNameShape");
  }
  return null;
};

/** Parts of a name: split at `_`, `-`, `.` and where a lower-case letter or digit meets a capital. */
const nameParts = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .split(/[^A-Za-z0-9]+/u)
    .map((part) => part.toLowerCase())
    .filter((part) => part !== "");

/** Words that only mean a credential as a whole part of a name: `AUTH_URL` does, `AUTHOR_NAME` does not. */
const SECRET_PARTS: ReadonlySet<string> = new Set([
  "auth",
  "authorization",
  "authentication",
  "pass",
  "passwd",
  "password",
  "passphrase",
]);

/**
 * A name that looks like it holds a credential, which belongs in `--secret`, not on the command
 * line. `key`, `token`, `secret`, `password`, `passwd`, `pwd`, `bearer`, `cred`, `cookie` and
 * `private` count anywhere in the name (`PGPASSWORD` is a credential); `auth` and `pass` as a whole
 * part or at the end of the name (`BASICAUTH`, `SMTPPASS`), so `AUTHOR_NAME` and `BYPASS_CACHE` pass.
 * Still on the side of caution: a harmless name that is sent through `--secret` costs a flag, a
 * missed credential costs the credential.
 */
export const looksSecret = (name: string): boolean =>
  /(?:key|token|secret|passw|pwd|bearer|cred|cookie|private)/iu.test(name) ||
  /(?:auth|(?<!by|com)pass)$/iu.test(name) ||
  nameParts(name).some((part) => SECRET_PARTS.has(part));

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);

/**
 * The id a name suggests, as the desktop app makes it (`codex_work`); a preset with no name suggests
 * its own id. Empty when there is nothing to make one from.
 */
export const suggestInstanceId = (target: Target, name: string): string => {
  const slug = slugify(name);
  if (target.kind === "preset") {
    return slug === "" ? PROVIDER_PRESETS[target.preset].suggestedInstanceId : `opencode_${slug}`;
  }
  return slug === "" ? "" : `${target.driver.value}_${slug}`;
};

// ---- the draft and the instance it becomes ----------------------------------------------------

/** A variable the instance's process gets. A sensitive one is kept by the server in its secret store. */
export interface EnvEntry {
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
}

/** An instance as the user has filled it in so far. Secrets are in `values` and `env`; never print it whole. */
export interface AddDraft {
  readonly target: Target;
  readonly name: string;
  readonly id: string;
  /** The id was typed by the user, so a change of name no longer changes it. */
  readonly idTouched: boolean;
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly env: ReadonlyArray<EnvEntry>;
}

export const newDraft = (target: Target): AddDraft => ({
  target,
  name: "",
  id: suggestInstanceId(target, ""),
  idTouched: false,
  values: initialValues(target),
  env: [],
});

/** The draft with a new name; the id follows it until the user has typed an id of their own. */
export const withName = (draft: AddDraft, name: string): AddDraft => ({
  ...draft,
  name,
  ...(draft.idTouched ? {} : { id: suggestInstanceId(draft.target, name) }),
});

export const withId = (draft: AddDraft, id: string): AddDraft =>
  id === ""
    ? { ...draft, id: suggestInstanceId(draft.target, draft.name), idTouched: false }
    : { ...draft, id, idTouched: true };

/** What is still missing before the draft can be added, as a sentence; null when nothing is. */
export const draftProblem = (draft: AddDraft, taken: ReadonlySet<string>): string | null => {
  const idProblem = validateInstanceId(draft.id, taken);
  if (idProblem !== null) return idProblem;
  for (const field of targetFields(draft.target)) {
    if (field.required === true && secretOf(draft, field.key) === "") {
      return t("providers.spec.fieldRequired", { label: field.label });
    }
  }
  return null;
};

const secretOf = (draft: AddDraft, key: string): string => {
  const value = draft.values[key];
  return typeof value === "string" ? value.trim() : "";
};

/** Every value in the draft that must not be printed: the password fields and the sensitive variables. */
export const draftSecrets = (draft: AddDraft): string[] => [
  ...targetFields(draft.target)
    .filter((field) => field.control === "password")
    .map((field) => secretOf(draft, field.key)),
  ...draft.env.filter((entry) => entry.sensitive).map((entry) => entry.value.trim()),
];

/**
 * The instance the draft describes, the way the desktop app's wizard builds it: a driver instance
 * carries the fields that were changed from their defaults, a preset is made by the shared preset
 * builder. Throws the builder's message when a preset value is not acceptable.
 */
export const buildInstance = (draft: AddDraft): ProviderInstanceConfig => {
  const name = draft.name.trim();
  const displayName = name === "" ? {} : { displayName: TrimmedNonEmptyString.make(name) };
  const extra = draft.env.map((entry) => ({
    name: ProviderInstanceEnvironmentVariableName.make(entry.name),
    value: entry.value,
    sensitive: entry.sensitive,
  }));
  const { target } = draft;
  if (target.kind === "preset") {
    const model = typeof draft.values.model === "string" ? draft.values.model.trim() : "";
    const binaryPath =
      typeof draft.values.binaryPath === "string" ? draft.values.binaryPath.trim() : "";
    const service = draft.values.service;
    const made = createPresetProviderInstance({
      presetId: target.preset,
      ...(service === "api" || service === "coding"
        ? { service: service satisfies ProviderPresetService }
        : {}),
      apiKey: secretOf(draft, "apiKey"),
      ...(model === "" ? {} : { model }),
      ...(binaryPath === "" ? {} : { binaryPath }),
    });
    const taken = new Set((made.environment ?? []).map((entry) => entry.name));
    const clash = extra.find((entry) => taken.has(entry.name));
    if (clash !== undefined) throw new Error(t("providers.spec.presetFixes", { name: clash.name }));
    return {
      ...made,
      ...displayName,
      environment: [...(made.environment ?? []), ...extra],
    };
  }
  const config: Record<string, unknown> = {};
  for (const field of driverFields(target.driver)) {
    const value = draft.values[field.key];
    if (value === undefined) continue;
    if (typeof value === "boolean") {
      if (value !== field.defaultBoolean) config[field.key] = value;
    } else if (value.trim() !== "") {
      config[field.key] = value.trim();
    }
  }
  // A new Codex instance uses the Codex that is already installed; the desktop app's wizard does too.
  if (target.driver.value === "codex") config.setupMode = "existing";
  return {
    driver: ProviderDriverKind.make(target.driver.value),
    enabled: true,
    ...displayName,
    ...(Object.keys(config).length === 0 ? {} : { config }),
    ...(extra.length === 0 ? {} : { environment: extra }),
  };
};

// ---- showing it ------------------------------------------------------------------------------

/** Word for a value that is set but not shown. */
export const secretSet = (): string => t("providers.spec.secretSet");

const SHOWN_LIMIT = 60;

const shown = (value: string): string => {
  const one = sanitizeForTerminal(value).replace(/\s+/gu, " ").trim();
  return one.length > SHOWN_LIMIT ? `${one.slice(0, SHOWN_LIMIT - 1)}…` : one;
};

export interface SummaryRow {
  readonly label: string;
  readonly value: string;
}

/**
 * What adding the draft would write, as rows safe to print: a secret is said to be set and nothing
 * more, and the generated OpenCode config of a preset is not spelled out.
 */
export const summarize = (draft: AddDraft): ReadonlyArray<SummaryRow> => {
  const { target } = draft;
  const fields = targetFields(target);
  const rows: SummaryRow[] = [
    { label: "ID", value: shown(draft.id) },
    {
      label: t("providers.cmd.colName"),
      value:
        draft.name.trim() === ""
          ? t("providers.spec.defaultName", { name: targetLabel(target) })
          : shown(draft.name),
    },
    { label: t("providers.cmd.colKind"), value: targetLabel(target) },
  ];
  for (const field of fields) {
    const value = draft.values[field.key];
    if (value === undefined) continue;
    if (field.control === "password") {
      if (secretOf(draft, field.key) !== "") rows.push({ label: field.label, value: secretSet() });
    } else if (typeof value === "boolean") {
      rows.push({
        label: field.label,
        value: value ? t("providers.cmd.on") : t("providers.cmd.off"),
      });
    } else if (value.trim() !== "") {
      const option = field.options?.find((candidate) => candidate.value === value);
      rows.push({ label: field.label, value: shown(option?.label ?? value) });
    }
  }
  for (const entry of draft.env) {
    rows.push({
      label: t("providers.spec.envLabel", { name: entry.name }),
      value: entry.sensitive ? secretSet() : shown(entry.value),
    });
  }
  return rows;
};

/** A line for what the user still has to do by hand once the instance exists, or null. */
export const afterAddAdvice = (draft: AddDraft): string | null => {
  const { target } = draft;
  if (target.kind === "preset") {
    return t("providers.spec.adviceOpenCode", { label: PROVIDER_PRESETS[target.preset].label });
  }
  const method = draft.values.authMethod;
  if (
    target.driver.value === "antigravity" &&
    (method === undefined || method.toString().startsWith("oauth"))
  ) {
    return t("providers.spec.adviceGoogle");
  }
  if (target.driver.value === "codex" || target.driver.value === "claudeAgent") {
    return t("providers.spec.adviceLogin");
  }
  return null;
};

/** `text` with every secret in it replaced, for a message that came back from the server. */
export const redactSecrets = (text: string, secrets: Iterable<string>): string => {
  let out = text;
  const known = [...secrets].filter((secret) => secret.length >= 3);
  for (const secret of known.toSorted((left, right) => right.length - left.length)) {
    out = out.split(secret).join("****");
  }
  return out;
};
