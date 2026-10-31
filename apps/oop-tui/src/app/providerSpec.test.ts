import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_PRESETS } from "@t3tools/client-runtime/provider-presets";

import { SECRET } from "../testing/providerFixtures.ts";
import {
  afterAddAdvice,
  buildInstance,
  DRIVERS,
  draftProblem,
  draftSecrets,
  driverFields,
  initialValues,
  isDefaultInstanceId,
  looksSecret,
  newDraft,
  parseTarget,
  redactSecrets,
  summarize,
  suggestInstanceId,
  TARGETS,
  validateEnvironmentName,
  validateInstanceId,
  withId,
  withName,
  withValue,
  type Target,
} from "./providerSpec.ts";

const target = (word: string): Target => {
  const found = parseTarget(word);
  if (found === null) throw new Error(`no target ${word}`);
  return found;
};

describe("targets", () => {
  it("names every driver of the desktop app and both presets", () => {
    expect(DRIVERS.map((driver) => driver.value)).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "opencode",
      "antigravity",
      "minimax",
      "zcode",
    ]);
    expect(TARGETS).toHaveLength(10);
  });

  it("reads a driver in any case, claude as claudeAgent, and a preset with or without its prefix", () => {
    expect(target("CODEX")).toMatchObject({ kind: "driver", driver: { value: "codex" } });
    expect(target("claude")).toMatchObject({ kind: "driver", driver: { value: "claudeAgent" } });
    expect(target("claudeagent")).toMatchObject({
      kind: "driver",
      driver: { value: "claudeAgent" },
    });
    expect(target("zai")).toEqual({ kind: "preset", preset: "zai" });
    expect(target("preset:zai")).toEqual({ kind: "preset", preset: "zai" });
    expect(target("preset:minimax")).toEqual({ kind: "preset", preset: "minimax" });
    expect(parseTarget("nope")).toBeNull();
    expect(parseTarget("")).toBeNull();
  });

  it("keeps the MiniMax Code driver and the MiniMax preset apart", () => {
    expect(target("minimax")).toMatchObject({ kind: "driver", driver: { value: "minimax" } });
    expect(target("preset:minimax").kind).toBe("preset");
  });
});

describe("the fields of a driver", () => {
  it("come from the contracts, so a field the desktop app adds appears here too", () => {
    const keys = (word: string) =>
      driverFields(
        (() => {
          const found = target(word);
          if (found.kind !== "driver") throw new Error("not a driver");
          return found.driver;
        })(),
      ).map((field) => field.key);
    expect(keys("codex")).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
      "telemetry",
    ]);
    expect(keys("opencode")).toEqual(["binaryPath", "serverUrl", "serverPassword"]);
    expect(keys("antigravity")).toContain("apiKey");
    expect(keys("antigravity")[0]).toBe("authMethod");
  });

  it("mark the secret ones as passwords and give a switch its default", () => {
    const opencode = target("opencode");
    const antigravity = target("antigravity");
    const claude = target("claude");
    if (opencode.kind !== "driver" || antigravity.kind !== "driver" || claude.kind !== "driver") {
      throw new Error("not drivers");
    }
    expect(
      driverFields(opencode.driver).find((field) => field.key === "serverPassword")?.control,
    ).toBe("password");
    expect(driverFields(antigravity.driver).find((field) => field.key === "apiKey")?.control).toBe(
      "password",
    );
    expect(driverFields(claude.driver).find((field) => field.key === "telemetry")).toMatchObject({
      control: "switch",
      defaultBoolean: true,
    });
  });
});

describe("validating an id", () => {
  const none = new Set<string>();

  it("accepts a plain id and refuses an empty, odd or too long one", () => {
    expect(validateInstanceId("codex_work", none)).toBeNull();
    expect(validateInstanceId("", none)).toContain("필요");
    expect(validateInstanceId("1abc", none)).toContain("영문자로 시작");
    expect(validateInstanceId("a b", none)).toContain("영문자로 시작");
    expect(validateInstanceId("a".repeat(65), none)).toContain("64자");
    expect(validateInstanceId("a".repeat(64), none)).toBeNull();
  });

  it("refuses an id that is taken", () => {
    expect(validateInstanceId("work", new Set(["work"]))).toContain("이미 있는");
  });

  it("refuses the id of a built-in instance, which the desktop app would let through", () => {
    for (const driver of DRIVERS) {
      expect(validateInstanceId(driver.value, none)).toContain("기본 인스턴스");
      expect(isDefaultInstanceId(driver.value)).toBe(true);
    }
    expect(isDefaultInstanceId("codex_work")).toBe(false);
  });
});

describe("environment names", () => {
  it("follow the contract's pattern and length", () => {
    expect(validateEnvironmentName("MY_VAR_1")).toBeNull();
    expect(validateEnvironmentName("_x")).toBeNull();
    expect(validateEnvironmentName("1X")).toContain("영문자나 '_'");
    expect(validateEnvironmentName("A-B")).toContain("영문자나 '_'");
    expect(validateEnvironmentName("")).toContain("필요");
    expect(validateEnvironmentName("A".repeat(129))).toContain("128자");
  });

  it("flag a name that holds a credential", () => {
    for (const name of [
      "API_KEY",
      "github_token",
      "DB_PASSWORD",
      "MY_SECRET",
      "AWS_CREDENTIALS",
      "DB_PASS",
      "MYSQL_PASSWD",
      "DB_PWD",
      "PROXY_AUTH",
      "AUTHORIZATION",
      "BEARER",
      "HTTP_CRED",
      "SESSION_COOKIE",
      "PRIVATE_KEY_PATH",
    ]) {
      expect(looksSecret(name)).toBe(true);
    }
    expect(looksSecret("LOG_LEVEL")).toBe(false);
  });

  it("takes auth and pass as whole parts of a name, not as the start of another word", () => {
    for (const name of [
      "AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "authorName",
      "BYPASS_CACHE",
      "COMPASS_DIR",
      "PASSENGER_COUNT",
    ]) {
      expect(looksSecret(name), name).toBe(false);
    }
    for (const name of [
      "AUTH",
      "AUTH_URL",
      "proxyAuth",
      "http-auth",
      "MY_PASS",
      "userPassword",
      "APIKEY",
      "PGPASSWORD",
      "MYSQLPASSWORD",
      "SMTPPASS",
      "BASICAUTH",
      "HTTPAUTH",
    ]) {
      expect(looksSecret(name), name).toBe(true);
    }
  });
});

describe("a draft's id and name", () => {
  it("follows the name until the user types an id of their own", () => {
    let draft = newDraft(target("codex"));
    expect(draft.id).toBe("");
    draft = withName(draft, "Work Account");
    expect(draft.id).toBe("codex_work_account");
    draft = withId(draft, "mine");
    draft = withName(draft, "Other");
    expect(draft.id).toBe("mine");
    draft = withId(draft, "");
    expect(draft.id).toBe("codex_other");
  });

  it("suggests the preset's own id when it has no name, and nothing for a driver", () => {
    expect(suggestInstanceId(target("zai"), "")).toBe("opencode_zai");
    expect(suggestInstanceId(target("codex"), "")).toBe("");
    expect(suggestInstanceId(target("codex"), "  한글  ")).toBe("");
    expect(suggestInstanceId(target("codex"), "a--b")).toBe("codex_a_b");
  });
});

describe("presets", () => {
  it("start on the default service and its model, and move the model with the service", () => {
    const minimax = target("preset:minimax");
    const [api, coding] = PROVIDER_PRESETS.minimax.services;
    const values = initialValues(minimax);
    expect(values).toEqual({ service: "api", model: api?.defaultModel });
    const moved = withValue(minimax, values, "service", "coding");
    expect(moved).toEqual({ service: "coding", model: coding?.defaultModel });
    // A model the user typed stays when the service changes.
    const typed = withValue(minimax, { ...values, model: "my-model" }, "service", "coding");
    expect(typed.model).toBe("my-model");
  });

  it("need an API key before they can be added", () => {
    const draft = withId(newDraft(target("zai")), "opencode_zai");
    expect(draftProblem(draft, new Set())).toContain("API 키");
    const filled = { ...draft, values: withValue(draft.target, draft.values, "apiKey", SECRET) };
    expect(draftProblem(filled, new Set())).toBeNull();
  });
});

describe("building the instance", () => {
  it("makes a driver instance the way the desktop app does, with only what was changed", () => {
    const draft = withName(newDraft(target("codex")), "Work");
    expect(buildInstance(draft)).toEqual({
      driver: "codex",
      enabled: true,
      displayName: "Work",
      config: { setupMode: "existing" },
    });
    const custom = {
      ...draft,
      values: { binaryPath: " /opt/codex ", homePath: "", telemetry: true },
    };
    expect(buildInstance(custom).config).toEqual({
      binaryPath: "/opt/codex",
      telemetry: true,
      setupMode: "existing",
    });
  });

  it("leaves out a switch that was left at its default", () => {
    const draft = { ...newDraft(target("claude")), values: { telemetry: true } };
    expect(buildInstance(draft).config).toBeUndefined();
  });

  it("makes a preset instance with the key as a sensitive variable, not in the config", () => {
    const draft = {
      ...withId(newDraft(target("zai")), "opencode_zai"),
      values: { service: "api", model: "glm-5.3", apiKey: SECRET },
    };
    const instance = buildInstance(draft);
    expect(instance.driver).toBe("opencode");
    expect(instance.environment?.find((entry) => entry.sensitive)).toMatchObject({
      name: "OOP_ZAI_API_KEY",
      value: SECRET,
    });
    expect(JSON.stringify(instance.config)).not.toContain(SECRET);
    expect(
      instance.environment?.find((entry) => entry.name === "OPENCODE_CONFIG_CONTENT")?.value,
    ).not.toContain(SECRET);
  });

  it("uses the name given for a preset, and appends extra variables", () => {
    const draft = {
      ...withId(withName(newDraft(target("zai")), "Mine"), "opencode_mine"),
      values: { service: "api", model: "glm-5.3", apiKey: SECRET },
      env: [{ name: "LOG_LEVEL", value: "debug", sensitive: false }],
    };
    const instance = buildInstance(draft);
    expect(instance.displayName).toBe("Mine");
    expect(instance.environment?.at(-1)).toEqual({
      name: "LOG_LEVEL",
      value: "debug",
      sensitive: false,
    });
  });

  it("refuses a variable the preset already sets", () => {
    const draft = {
      ...newDraft(target("zai")),
      values: { service: "api", model: "glm-5.3", apiKey: SECRET },
      env: [{ name: "OOP_ZAI_API_KEY", value: "x", sensitive: true }],
    };
    expect(() => buildInstance(draft)).toThrow("OOP_ZAI_API_KEY");
  });
});

describe("showing a draft", () => {
  const preset = {
    ...withId(newDraft(target("zai")), "opencode_zai"),
    values: { service: "api", model: "glm-5.3", apiKey: SECRET },
    env: [
      { name: "LOG_LEVEL", value: "debug", sensitive: false },
      { name: "EXTRA", value: `${SECRET}-env`, sensitive: true },
    ],
  };

  it("says a secret is set and never what it is", () => {
    const rows = summarize(preset);
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(SECRET);
    expect(rows.find((row) => row.label === "API 키")?.value).toContain("설정됨");
    expect(rows.find((row) => row.label === "환경 변수 EXTRA")?.value).toContain("설정됨");
    expect(rows.find((row) => row.label === "환경 변수 LOG_LEVEL")?.value).toBe("debug");
  });

  it("lists the secrets to hide, for redacting what the server says", () => {
    expect(draftSecrets(preset).filter((secret) => secret !== "")).toEqual([
      SECRET,
      `${SECRET}-env`,
    ]);
  });

  it("redacts the longest secret first and ignores one too short to be one", () => {
    expect(redactSecrets(`bad ${SECRET}-env and ${SECRET}`, [SECRET, `${SECRET}-env`])).toBe(
      "bad **** and ****",
    );
    expect(redactSecrets("ab is fine", ["ab"])).toBe("ab is fine");
  });

  it("points to the app for a login that needs a browser", () => {
    expect(afterAddAdvice(newDraft(target("antigravity")))).toContain("설정 > Providers");
    expect(afterAddAdvice(newDraft(target("zai")))).toContain("OpenCode 1.14.19");
    expect(afterAddAdvice(newDraft(target("grok")))).toBeNull();
  });
});
