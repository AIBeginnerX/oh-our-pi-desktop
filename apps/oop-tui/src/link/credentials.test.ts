import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { hostPlatform } from "../host.ts";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  CredentialFileError,
  CredentialStore,
  parseCredentialFile,
  type StoredCredential,
} from "./credentials.ts";

const LOOPBACK = "http://127.0.0.1:3773";
const LAN = "http://192.168.0.5:3773";

const credential = (over: Partial<StoredCredential> = {}): StoredCredential => ({
  environmentId: "env-1",
  label: "내 Mac",
  httpBaseUrl: "http://127.0.0.1:3773/",
  token: "secret-token",
  savedAt: "2026-10-30T00:00:00.000Z",
  ...over,
});

let directory: string;
beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-cred-"));
});
afterEach(async () => {
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

describe("CredentialStore", () => {
  it("round-trips a credential per environment", async () => {
    const store = new CredentialStore(NodePath.join(directory, "cfg", "credentials.json"));
    await store.save(credential());
    await store.save(credential({ environmentId: "env-2", token: "other" }));
    expect((await store.find("env-1", LOOPBACK))?.token).toBe("secret-token");
    expect((await store.find("env-2", LOOPBACK))?.token).toBe("other");
    expect(await store.find("missing", LOOPBACK)).toBeNull();
  });

  it("keeps a loopback and a LAN address of one server apart, each with its own token", async () => {
    const file = NodePath.join(directory, "credentials.json");
    const store = new CredentialStore(file);
    await store.save(credential());
    await store.save(credential({ httpBaseUrl: `${LAN}/`, token: "lan-token" }));
    await store.save(credential({ httpBaseUrl: `${LOOPBACK}/`, token: "loopback-again" }));
    expect((await store.find("env-1", LAN))?.token).toBe("lan-token");
    expect((await store.find("env-1", LOOPBACK))?.token).toBe("loopback-again");
    const { environments } = parseCredentialFile(await NodeFSP.readFile(file, "utf8"));
    expect(Object.keys(environments)).toHaveLength(2);
  });

  it("replaces a loopback entry saved under another port instead of adding one", async () => {
    const store = new CredentialStore(NodePath.join(directory, "credentials.json"));
    await store.save(credential({ httpBaseUrl: "http://127.0.0.1:3773/", token: "old" }));
    await store.save(credential({ httpBaseUrl: "http://localhost:41000/", token: "new" }));
    expect((await store.find("env-1", "http://127.0.0.1:5555"))?.token).toBe("new");
    const text = await NodeFSP.readFile(NodePath.join(directory, "credentials.json"), "utf8");
    expect(Object.keys(parseCredentialFile(text).environments)).toHaveLength(1);
    expect(text).not.toContain('"old"');
  });

  it("reads a file written with the bare environment id as key, and saving the same address drops that entry", async () => {
    const file = NodePath.join(directory, "credentials.json");
    await NodeFSP.writeFile(
      file,
      JSON.stringify({ version: 1, environments: { "env-1": credential({ token: "legacy" }) } }),
      { mode: 0o600 },
    );
    const store = new CredentialStore(file);
    expect((await store.find("env-1", "http://127.0.0.1:9999"))?.token).toBe("legacy");
    await store.save(credential({ token: "fresh" }));
    const { environments } = parseCredentialFile(await NodeFSP.readFile(file, "utf8"));
    expect(Object.values(environments).map((entry) => entry.token)).toEqual(["fresh"]);
    expect(Object.keys(environments)).not.toContain("env-1");
  });

  it("keeps a legacy entry of another address when saving a new one", async () => {
    const file = NodePath.join(directory, "credentials.json");
    await NodeFSP.writeFile(
      file,
      JSON.stringify({
        version: 1,
        environments: { "env-1": credential({ httpBaseUrl: LAN, token: "legacy-lan" }) },
      }),
      { mode: 0o600 },
    );
    const store = new CredentialStore(file);
    await store.save(credential({ token: "loopback" }));
    expect((await store.find("env-1", LAN))?.token).toBe("legacy-lan");
    expect((await store.find("env-1", LOOPBACK))?.token).toBe("loopback");
  });

  it("keeps two LAN addresses with the same environment id apart", async () => {
    const store = new CredentialStore(NodePath.join(directory, "credentials.json"));
    await store.save(credential({ httpBaseUrl: "http://192.168.0.5:3773/", token: "a" }));
    await store.save(credential({ httpBaseUrl: "http://192.168.0.9:3773/", token: "b" }));
    expect((await store.find("env-1", "http://192.168.0.5:3773"))?.token).toBe("a");
    expect((await store.find("env-1", "http://192.168.0.9:3773"))?.token).toBe("b");
    expect(await store.find("env-1", "http://192.168.0.7:3773")).toBeNull();
    expect(await store.savedAddress("env-1")).toContain("192.168.0.");
    expect(await store.savedAddress("missing")).toBeNull();
  });

  it.skipIf(hostPlatform() === "win32")("keeps the file readable by its owner only", async () => {
    const file = NodePath.join(directory, "cfg", "credentials.json");
    await new CredentialStore(file).save(credential());
    expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
    expect((await NodeFSP.stat(NodePath.dirname(file))).mode & 0o777).toBe(0o700);
  });

  it.skipIf(hostPlatform() === "win32")("tightens a file that was left too open", async () => {
    const file = NodePath.join(directory, "credentials.json");
    await NodeFSP.writeFile(file, '{"version":1,"environments":{}}', { mode: 0o644 });
    await new CredentialStore(file).save(credential());
    expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(hostPlatform() === "win32")("tightens a loose file just by reading it", async () => {
    const file = NodePath.join(directory, "credentials.json");
    await new CredentialStore(file).save(credential());
    await NodeFSP.chmod(file, 0o644);
    expect((await new CredentialStore(file).find("env-1", LOOPBACK))?.token).toBe("secret-token");
    expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind", async () => {
    await new CredentialStore(NodePath.join(directory, "credentials.json")).save(credential());
    expect(await NodeFSP.readdir(directory)).toEqual(["credentials.json"]);
  });

  it("refuses to overwrite a damaged file and says where it is", async () => {
    const file = NodePath.join(directory, "credentials.json");
    await NodeFSP.writeFile(file, "{broken", { mode: 0o600 });
    const store = new CredentialStore(file);
    await expect(store.find("env-1", LOOPBACK)).rejects.toBeInstanceOf(CredentialFileError);
    await expect(store.save(credential())).rejects.toThrow(file);
    expect(await NodeFSP.readFile(file, "utf8")).toBe("{broken");
    expect(await NodeFSP.readdir(directory)).toEqual(["credentials.json"]);
  });

  it("can be checked before a one-time pairing token is spent", async () => {
    const file = NodePath.join(directory, "credentials.json");
    const store = new CredentialStore(file);
    await expect(store.verify()).resolves.toBeUndefined();
    await NodeFSP.writeFile(file, "[]");
    await expect(store.verify()).rejects.toBeInstanceOf(CredentialFileError);
  });

  it("starts fresh when there is no file yet", async () => {
    const store = new CredentialStore(NodePath.join(directory, "none", "credentials.json"));
    expect(await store.find("env-1", LOOPBACK)).toBeNull();
  });

  it.skipIf(hostPlatform() === "win32")(
    "never writes through a symlink planted at a guessable temporary name",
    async () => {
      const victim = NodePath.join(directory, "victim.txt");
      await NodeFSP.writeFile(victim, "untouched");
      const file = NodePath.join(directory, "credentials.json");
      for (const guess of [`${file}.${process.pid}.tmp`, `${file}.tmp`]) {
        await NodeFSP.symlink(victim, guess);
      }
      await new CredentialStore(file).save(credential());
      expect(await NodeFSP.readFile(victim, "utf8")).toBe("untouched");
      expect((await new CredentialStore(file).find("env-1", LOOPBACK))?.token).toBe("secret-token");
    },
  );

  it.skipIf(hostPlatform() === "win32")("tightens a directory that was left too open", async () => {
    const cfg = NodePath.join(directory, "cfg");
    await NodeFSP.mkdir(cfg);
    await NodeFSP.chmod(cfg, 0o777);
    await new CredentialStore(NodePath.join(cfg, "credentials.json")).save(credential());
    expect((await NodeFSP.stat(cfg)).mode & 0o777).toBe(0o700);
  });
});

describe("parseCredentialFile", () => {
  it("drops entries that lack a token but keeps valid ones", () => {
    const text = JSON.stringify({
      version: 1,
      environments: { good: credential(), bad: { ...credential(), token: "" }, worse: 5 },
    });
    expect(Object.keys(parseCredentialFile(text).environments)).toEqual(["good"]);
  });
});
