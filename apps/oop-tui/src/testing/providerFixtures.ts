import type { ServerConfig, ServerSettings } from "@t3tools/contracts";

import type { KeyEvent, KeyName } from "../input/keys.ts";
import { makeConfig } from "./fixtures.ts";

/** A stand-in for an API key. Plain on purpose: it only has to be recognised where it must not appear. */
export const SECRET = "test-value-1234";

export const text = (value: string): KeyEvent => ({ type: "text", text: value });
export const paste = (value: string): KeyEvent => ({ type: "paste", text: value });
export const key = (name: KeyName): KeyEvent => ({
  type: "key",
  name,
  ctrl: false,
  alt: false,
  shift: false,
});

/** A provider as the server reports it. */
export const serverProvider = (instanceId: string, over: Record<string, unknown> = {}) => ({
  instanceId,
  driver: instanceId.split("_")[0] ?? instanceId,
  displayName: instanceId,
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: [{ slug: "m1", name: "M1", isCustom: false, capabilities: null }],
  ...over,
});

/** The server's settings, redacted the way the server sends them: a secret has no value, only a marker. */
export const settingsWith = (
  providerInstances: Record<string, unknown>,
  over: Record<string, unknown> = {},
): ServerSettings =>
  ({
    threadGoals: {},
    crew: { enabled: false, preset: "recommended", pinned: {}, threads: {} },
    providerInstances,
    ...over,
  }) as unknown as ServerSettings;

/** An OpenCode instance that holds a secret the client must never see again. */
export const savedPreset = {
  driver: "opencode",
  displayName: "Z.AI",
  enabled: true,
  config: { enabled: true, binaryPath: "opencode", serverUrl: "", customModels: ["zai/glm-5.3"] },
  environment: [
    { name: "OOP_ZAI_API_KEY", value: "", sensitive: true, valueRedacted: true },
    { name: "T3CODE_OPENCODE_PROVIDER_ID", value: "zai", sensitive: false },
  ],
};

export const configWith = (
  settings: ServerSettings,
  providers: ReadonlyArray<Record<string, unknown>> = [serverProvider("codex")],
): ServerConfig => makeConfig({ providers, settings });

/** One entry of a record keyed by provider instance ids (a plain property read does not type-check on a branded key). */
export const entryOf = <T>(record: Readonly<Record<string, T>>, id: string): T | undefined =>
  Object.hasOwn(record, id) ? record[id] : undefined;
