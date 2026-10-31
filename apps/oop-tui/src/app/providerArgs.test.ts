import { describe, expect, it } from "vite-plus/test";

import { SECRET } from "../testing/providerFixtures.ts";
import {
  collectFlags,
  parseProviderSlash,
  parseSecretRef,
  resolveAdd,
  resolveProviderRequest,
  splitWords,
  wantsStdin,
  type AddOptions,
  type ProviderRequest,
} from "./providerArgs.ts";
import { parseTarget, type Target } from "./providerSpec.ts";

const target = (word: string): Target => {
  const found = parseTarget(word);
  if (found === null) throw new Error(`no target ${word}`);
  return found;
};

const cli = (...argv: string[]) => {
  const collected = collectFlags(argv);
  if (!collected.ok) return collected;
  return resolveProviderRequest(collected.value.positional, collected.value.flags, "cli");
};

const ok = <T>(result: { ok: true; value: T } | { ok: false; message: string }): T => {
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

const add = (request: ProviderRequest) => {
  if (request.kind !== "add") throw new Error("not add");
  return request;
};

const emptyOptions: AddOptions = {
  id: null,
  name: null,
  sets: [],
  env: [],
  secrets: [],
  yes: false,
  dryRun: false,
};

describe("splitWords", () => {
  it("splits on spaces and keeps quoted words whole", () => {
    expect(ok(splitWords(`add codex --name "My Work" --id 'a b'`))).toEqual([
      "add",
      "codex",
      "--name",
      "My Work",
      "--id",
      "a b",
    ]);
    expect(ok(splitWords(`  a   b `))).toEqual(["a", "b"]);
    expect(ok(splitWords(`--name ""`))).toEqual(["--name", ""]);
  });

  it("refuses an open quote", () => {
    expect(splitWords(`add "x`)).toEqual({ ok: false, message: "따옴표가 닫히지 않았습니다." });
  });
});

describe("the provider request", () => {
  it("reads list, with no verb meaning list", () => {
    expect(ok(cli())).toEqual({ kind: "list" });
    expect(ok(cli("list"))).toEqual({ kind: "list" });
    expect(cli("list", "extra")).toMatchObject({ ok: false });
    expect(cli("list", "--yes")).toMatchObject({ ok: false });
  });

  it("reads add with its flags, from the shell or from the chat alike", () => {
    const fromShell = add(
      ok(
        cli(
          "add",
          "codex",
          "--id",
          "codex_work",
          "--name",
          "Work",
          "--set",
          "binaryPath=/x",
          "--dry-run",
        ),
      ),
    );
    expect(fromShell.target).toMatchObject({ kind: "driver", driver: { value: "codex" } });
    expect(fromShell.options).toMatchObject({
      id: "codex_work",
      name: "Work",
      sets: [{ key: "binaryPath", value: "/x" }],
      dryRun: true,
      yes: false,
    });
    const fromChat = add(
      ok(
        parseProviderSlash(`add codex --id codex_work --name "Work" --set binaryPath=/x --dry-run`),
      ),
    );
    expect(fromChat.options).toEqual(fromShell.options);
  });

  it("takes -y and --yes alike, and = after a flag", () => {
    expect(add(ok(cli("add", "codex", "-y"))).options.yes).toBe(true);
    expect(add(ok(cli("add", "codex", "--yes"))).options.yes).toBe(true);
    expect(add(ok(cli("add", "codex", "--id=x"))).options.id).toBe("x");
  });

  it("allows add with no kind only where nothing else is given", () => {
    expect(add(ok(cli("add"))).target).toBeNull();
    expect(cli("add", "--id", "x")).toMatchObject({ ok: false });
    expect(cli("add", "--dry-run")).toMatchObject({ ok: false });
  });

  it("names the kinds when one is unknown", () => {
    const result = cli("add", "nope");
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain("codex");
    expect(JSON.stringify(result)).toContain("preset:minimax");
  });

  it("reads remove with its id, and needs the id in the shell", () => {
    expect(ok(cli("remove", "work", "-y", "--dry-run"))).toEqual({
      kind: "remove",
      id: "work",
      yes: true,
      dryRun: true,
    });
    expect(cli("remove")).toMatchObject({ ok: false });
    expect(cli("remove", "a", "b")).toMatchObject({ ok: false });
    expect(cli("remove", "a", "--id", "x")).toMatchObject({ ok: false });
  });

  it("lets the chat's remove leave out the id, which opens a list", () => {
    expect(ok(parseProviderSlash("remove"))).toEqual({
      kind: "remove",
      id: null,
      yes: false,
      dryRun: false,
    });
    expect(ok(parseProviderSlash("remove work --dry-run"))).toMatchObject({ dryRun: true });
  });

  it("keeps secrets and confirmation skipping out of the chat", () => {
    for (const text of ["add zai --secret KEY=@VAR", "add codex -y", "remove work --yes"]) {
      expect(parseProviderSlash(text)).toMatchObject({ ok: false });
    }
  });

  it("refuses an unknown verb and an unknown flag", () => {
    expect(parseProviderSlash("frob")).toMatchObject({ ok: false });
    expect(parseProviderSlash("add codex --bogus")).toMatchObject({ ok: false });
    expect(cli("add", "codex", "--set", "noequals")).toMatchObject({ ok: false });
    expect(cli("add", "codex", "--env", "A")).toMatchObject({ ok: false });
  });
});

describe("a complaint about the user's own words", () => {
  const text = (result: { ok: boolean; message?: string }) =>
    result.ok ? "" : (result.message ?? "");

  it("names a well-formed word that is unknown, and only the part before the equals sign", () => {
    expect(text(cli("add", "nope"))).toContain("알 수 없는 종류: nope");
    expect(text(cli("add", "codex", "--bogus=" + SECRET))).toContain("알 수 없는 옵션: --bogus");
    expect(text(cli("add", "codex", "--bogus=" + SECRET))).not.toContain(SECRET);
    expect(text(cli("frob"))).toContain("알 수 없는 하위 명령: frob");
  });

  it("says the form is wrong, without the content, for a word that does not look like a name", () => {
    const word = `${SECRET}-and-more-letters`;
    for (const result of [cli("add", word), cli(word), cli("add", "codex", `-${word}`)]) {
      expect(text(result)).toContain("형식이 잘못됐습니다");
      expect(text(result)).not.toContain(SECRET.slice(0, 6));
    }
    // A run of digits is the body of a key, short as it is.
    expect(text(cli("add", "x1234567"))).toContain("형식이 잘못됐습니다");
    expect(text(cli("add", "x1234567"))).not.toContain("1234");
  });

  it("does the same for a settings key that is not one, and still lists the ones that are", () => {
    const fields = (key: string) =>
      text(
        resolveAdd(
          target("codex"),
          { ...emptyOptions, sets: [{ key, value: "x" }] },
          { env: {}, stdin: null },
        ),
      );
    expect(fields("colour")).toContain("알 수 없는 설정 키: colour");
    expect(fields("colour")).toContain("binaryPath");
    expect(fields(SECRET)).toContain("설정 키의 형식이 잘못됐습니다");
    expect(fields(SECRET)).not.toContain(SECRET);
    expect(fields(SECRET)).toContain("binaryPath");
  });

  it("does not repeat an environment name that is not shaped like one", () => {
    const named = (name: string) =>
      text(
        resolveAdd(
          target("codex"),
          { ...emptyOptions, env: [{ name, value: "x" }] },
          { env: {}, stdin: null },
        ),
      );
    expect(named(`${SECRET}.x`)).toContain("형식이 잘못됐습니다");
    expect(named(`${SECRET}.x`)).not.toContain(SECRET);
    expect(named("1BAD")).toContain("형식이 잘못됐습니다");
    expect(named("A".repeat(200))).not.toContain("AAAAAAAAAAAA");
  });
});

describe("an environment variable whose name looks like a secret", () => {
  const withName = (name: string, refs?: false) =>
    resolveAdd(
      target("codex"),
      { ...emptyOptions, env: [{ name, value: "x" }] },
      { env: {}, stdin: null, ...(refs === false ? { refs } : {}) },
    );

  it("points to --secret in the shell", () => {
    const result = withName("API_KEY");
    expect(result.ok ? "" : result.message).toContain("--secret API_KEY=@환경변수");
  });

  it("points to the shell command in the chat, which has no --secret, instead of a dead end", () => {
    const result = withName("API_KEY", false);
    const message = result.ok ? "" : result.message;
    expect(message).toContain("채팅에서는 받지 않습니다");
    expect(message).toContain("oop provider add --secret API_KEY=@환경변수");
  });

  it("lets a harmless name that only starts like auth through", () => {
    expect(withName("AUTHOR_NAME", false).ok).toBe(true);
    expect(withName("BYPASS_CACHE").ok).toBe(true);
  });
});

describe("secret references", () => {
  it("accept @NAME and -, and nothing else", () => {
    expect(parseSecretRef("@MY_KEY")).toEqual({ kind: "env", variable: "MY_KEY" });
    expect(parseSecretRef("-")).toEqual({ kind: "stdin" });
    expect(parseSecretRef(SECRET)).toBeNull();
    expect(parseSecretRef("@")).toBeNull();
    expect(parseSecretRef("@1BAD")).toBeNull();
  });

  it("are the only way --secret takes a value, and a literal is refused without being repeated", () => {
    const result = cli("add", "opencode", "--secret", `TOKEN=${SECRET}`);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("filling in a draft from the options", () => {
  const input = { env: { ZAI_KEY: SECRET, EMPTY: "  " }, stdin: null };

  it("sets the name, the id and the fields", () => {
    const draft = ok(
      resolveAdd(
        target("codex"),
        {
          ...emptyOptions,
          id: "codex_work",
          name: "Work",
          sets: [
            { key: "binaryPath", value: " /opt/codex " },
            { key: "telemetry", value: "on" },
          ],
        },
        input,
      ),
    );
    expect(draft).toMatchObject({
      id: "codex_work",
      name: "Work",
      values: { binaryPath: "/opt/codex", telemetry: true },
    });
  });

  it("reads a secret field from the environment and never from the command line", () => {
    const draft = ok(
      resolveAdd(
        target("zai"),
        { ...emptyOptions, sets: [{ key: "apiKey", value: "@ZAI_KEY" }] },
        input,
      ),
    );
    expect(draft.values.apiKey).toBe(SECRET);
    const literal = resolveAdd(
      target("zai"),
      { ...emptyOptions, sets: [{ key: "apiKey", value: SECRET }] },
      input,
    );
    expect(literal.ok).toBe(false);
    expect(JSON.stringify(literal)).not.toContain(SECRET);
    expect(JSON.stringify(literal)).toContain("@환경변수");
  });

  it("reads one secret from standard input, and only one", () => {
    const options: AddOptions = {
      ...emptyOptions,
      sets: [{ key: "apiKey", value: "-" }],
      secrets: [{ name: "OTHER", ref: { kind: "stdin" } }],
    };
    expect(wantsStdin(target("zai"), options)).toBe(true);
    expect(wantsStdin(target("zai"), emptyOptions)).toBe(false);
    const once = resolveAdd(
      target("zai"),
      { ...emptyOptions, sets: [{ key: "apiKey", value: "-" }] },
      { env: {}, stdin: `${SECRET}\n` },
    );
    expect(ok(once).values.apiKey).toBe(SECRET);
    const twice = resolveAdd(target("zai"), options, { env: {}, stdin: `${SECRET}\n` });
    expect(twice).toMatchObject({ ok: false });
    expect(JSON.stringify(twice)).not.toContain(SECRET);
  });

  it("says when the variable or the input is empty", () => {
    const unset = resolveAdd(
      target("zai"),
      { ...emptyOptions, sets: [{ key: "apiKey", value: "@NOPE" }] },
      input,
    );
    expect(unset).toMatchObject({ ok: false });
    expect(JSON.stringify(unset)).toContain("NOPE");
    expect(
      resolveAdd(
        target("zai"),
        { ...emptyOptions, sets: [{ key: "apiKey", value: "@EMPTY" }] },
        input,
      ),
    ).toMatchObject({ ok: false });
    expect(
      resolveAdd(
        target("zai"),
        { ...emptyOptions, sets: [{ key: "apiKey", value: "-" }] },
        { env: {}, stdin: "\n" },
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses secret fields where references are not possible, as in the chat", () => {
    const result = resolveAdd(
      target("zai"),
      { ...emptyOptions, sets: [{ key: "apiKey", value: "@ZAI_KEY" }] },
      { ...input, refs: false },
    );
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain("입력 화면");
  });

  it("names the valid keys for an unknown one, and the choices for a bad select or switch", () => {
    const unknown = resolveAdd(
      target("codex"),
      { ...emptyOptions, sets: [{ key: "nope", value: "x" }] },
      input,
    );
    expect(JSON.stringify(unknown)).toContain("binaryPath");
    const select = resolveAdd(
      target("antigravity"),
      { ...emptyOptions, sets: [{ key: "authMethod", value: "magic" }] },
      input,
    );
    expect(JSON.stringify(select)).toContain("oauth-personal");
    expect(
      ok(
        resolveAdd(
          target("antigravity"),
          { ...emptyOptions, sets: [{ key: "authMethod", value: "GEMINI-API-KEY" }] },
          input,
        ),
      ).values.authMethod,
    ).toBe("gemini-api-key");
    expect(
      resolveAdd(
        target("codex"),
        { ...emptyOptions, sets: [{ key: "telemetry", value: "maybe" }] },
        input,
      ),
    ).toMatchObject({ ok: false });
  });

  it("moves a preset's model with its service", () => {
    const draft = ok(
      resolveAdd(
        target("preset:minimax"),
        { ...emptyOptions, sets: [{ key: "service", value: "coding" }] },
        input,
      ),
    );
    expect(draft.values.service).toBe("coding");
  });

  it("keeps variables apart: names checked, secret-looking names sent to --secret, duplicates refused", () => {
    const withEnv = ok(
      resolveAdd(
        target("codex"),
        {
          ...emptyOptions,
          env: [{ name: "LOG_LEVEL", value: "debug" }],
          secrets: [{ name: "PROXY_PASS", ref: { kind: "env", variable: "ZAI_KEY" } }],
        },
        input,
      ),
    );
    expect(withEnv.env).toEqual([
      { name: "LOG_LEVEL", value: "debug", sensitive: false },
      { name: "PROXY_PASS", value: SECRET, sensitive: true },
    ]);
    const secretName = resolveAdd(
      target("codex"),
      { ...emptyOptions, env: [{ name: "API_KEY", value: SECRET }] },
      input,
    );
    expect(secretName).toMatchObject({ ok: false });
    expect(JSON.stringify(secretName)).not.toContain(SECRET);
    expect(
      resolveAdd(target("codex"), { ...emptyOptions, env: [{ name: "1BAD", value: "x" }] }, input),
    ).toMatchObject({ ok: false });
    expect(
      resolveAdd(
        target("codex"),
        {
          ...emptyOptions,
          env: [
            { name: "A", value: "1" },
            { name: "A", value: "2" },
          ],
        },
        input,
      ),
    ).toMatchObject({ ok: false });
  });
});
