import type { RuntimeMode } from "@t3tools/contracts";

import {
  echoWord,
  resolveProviderRequest,
  type ProviderRequest,
  type RawFlag,
} from "./app/providerArgs.ts";
import { t } from "./i18n/index.ts";
import type { ConfigAction } from "./settings.ts";

export type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | {
      readonly kind: "pair";
      readonly target: string;
      readonly server: string | null;
      readonly home: string | null;
    }
  | {
      readonly kind: "run";
      readonly continueLast: boolean;
      readonly server: string | null;
      readonly home: string | null;
      readonly runtimeMode: RuntimeMode | null;
      /** The message from `oop "..."`, sent as soon as the conversation is open. */
      readonly prompt: string | null;
    }
  | { readonly kind: "config"; readonly config: ConfigAction }
  | { readonly kind: "doctor"; readonly home: string | null }
  | { readonly kind: "stop"; readonly home: string | null }
  | {
      readonly kind: "update";
      readonly server: string | null;
      readonly home: string | null;
    }
  | {
      readonly kind: "provider";
      readonly request: ProviderRequest;
      readonly server: string | null;
      readonly home: string | null;
    }
  | { readonly kind: "error"; readonly message: string };

/** The words that start a command of their own; any other first word is the start of a message. */
const COMMAND_WORDS = new Set(["pair", "config", "doctor", "stop", "update", "provider"]);

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/** The help text in the current language. */
export const helpText = (): string => t("cli.help");

export const parseArgs = (argv: ReadonlyArray<string>): CliCommand => {
  let continueLast = false;
  let server: string | null = null;
  let home: string | null = null;
  let runtimeMode: RuntimeMode | null = null;
  const positional: string[] = [];
  const providerFlags: RawFlag[] = [];
  // After `--` every word is taken as it is, dashes included. `--` before any word makes the
  // whole line a message (`oop -- stop`); after a command's name it only protects the words behind it.
  let literal = false;
  let messageFirst = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (literal) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      messageFirst = positional.length === 0;
      continue;
    }
    const inline =
      arg.startsWith("--") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : null;
    const name = inline !== null ? arg.slice(0, arg.indexOf("=")) : arg;
    const value = (): string | null => {
      if (inline !== null) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) return null;
      index += 1;
      return next;
    };
    switch (name) {
      case "-h":
      case "--help":
        return { kind: "help" };
      case "-v":
      case "--version":
        return { kind: "version" };
      case "-c":
      case "--continue":
        continueLast = true;
        break;
      case "--server": {
        const next = value();
        if (next === null) return { kind: "error", message: t("cli.err.serverNeedsAddress") };
        server = next;
        break;
      }
      case "--home": {
        const next = value();
        if (next === null) return { kind: "error", message: t("cli.err.homeNeedsPath") };
        home = next;
        break;
      }
      case "--mode": {
        const next = value();
        const mode = RUNTIME_MODES.find((candidate) => candidate === next);
        if (mode === undefined) {
          return {
            kind: "error",
            message: t("cli.err.modeValues", { modes: RUNTIME_MODES.join(" | ") }),
          };
        }
        runtimeMode = mode;
        break;
      }
      case "-y":
      case "--yes":
        providerFlags.push({ name: "--yes", value: null });
        break;
      case "--dry-run":
        providerFlags.push({ name: "--dry-run", value: null });
        break;
      case "--id":
      case "--name":
      case "--set":
      case "--env":
      case "--secret": {
        const next = value();
        if (next === null) return { kind: "error", message: t("cli.err.needsValue", { name }) };
        providerFlags.push({ name, value: next });
        break;
      }
      default:
        if (arg.startsWith("-") && arg.length > 1) {
          return {
            kind: "error",
            message: t("cli.err.unknownOption", { name: String(echoWord(arg)) }),
          };
        }
        positional.push(arg);
    }
  }

  const [command, ...rest] = positional;
  if (providerFlags.length > 0 && command !== "provider") {
    return {
      kind: "error",
      message: t("cli.err.unknownOption", { name: providerFlags[0]?.name ?? "" }),
    };
  }
  if (command === undefined) {
    return { kind: "run", continueLast, server, home, runtimeMode, prompt: null };
  }
  if (messageFirst || !COMMAND_WORDS.has(command)) {
    const prompt = positional.join(" ").trim();
    if (prompt === "") return { kind: "error", message: t("cli.err.emptyPrompt") };
    // A lone word that looks like a command name is most likely a mistyped command, not a message.
    if (!messageFirst && positional.length === 1 && /^[A-Za-z][\w-]*$/u.test(prompt)) {
      return {
        kind: "error",
        message: t("cli.err.unknownCommand", { word: String(echoWord(prompt)) }),
      };
    }
    return { kind: "run", continueLast, server, home, runtimeMode, prompt };
  }
  if (command === "pair") {
    const target = rest.join("").trim();
    if (target === "") return { kind: "error", message: t("cli.err.pairNeedsTarget") };
    return { kind: "pair", target, server, home };
  }
  if (command === "config") {
    const [action, key, value, ...extra] = rest;
    if (extra.length === 0) {
      if (action === undefined) return { kind: "config", config: { action: "list" } };
      if (action === "path" && key === undefined) {
        return { kind: "config", config: { action: "path" } };
      }
      if (action === "get" && key !== undefined && value === undefined) {
        return { kind: "config", config: { action: "get", key } };
      }
      if (action === "set" && key !== undefined && value !== undefined) {
        return { kind: "config", config: { action: "set", key, value } };
      }
    }
    return {
      kind: "error",
      message: t("cli.err.usageConfig"),
    };
  }
  if (command === "doctor") {
    return rest.length === 0
      ? { kind: "doctor", home }
      : { kind: "error", message: t("cli.err.usageDoctor") };
  }
  if (command === "stop") {
    return rest.length === 0
      ? { kind: "stop", home }
      : { kind: "error", message: t("cli.err.usageStop") };
  }
  if (command === "update") {
    return rest.length === 0
      ? { kind: "update", server, home }
      : { kind: "error", message: t("cli.err.usageUpdate") };
  }
  // The last command word: `provider`.
  const request = resolveProviderRequest(rest, providerFlags, "cli");
  return request.ok
    ? { kind: "provider", request: request.value, server, home }
    : { kind: "error", message: request.message };
};
