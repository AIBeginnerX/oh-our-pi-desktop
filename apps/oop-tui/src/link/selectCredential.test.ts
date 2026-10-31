import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { CredentialStore } from "./credentials.ts";
import {
  localServer,
  originsMatch,
  plainHttpWarning,
  selectCredential,
} from "./selectCredential.ts";

describe("originsMatch", () => {
  it("accepts the same origin however it is spelled", () => {
    expect(originsMatch("http://192.168.0.5:3773/", "http://192.168.0.5:3773")).toBe(true);
    expect(originsMatch("https://oop.example/", "https://OOP.example:443")).toBe(true);
  });

  it("rejects another host, port, or scheme off the loopback", () => {
    expect(originsMatch("http://192.168.0.5:3773", "http://evil.example:3773")).toBe(false);
    expect(originsMatch("http://192.168.0.5:3773", "http://192.168.0.5:3774")).toBe(false);
    expect(originsMatch("https://oop.example", "http://oop.example")).toBe(false);
  });

  it("lets the desktop app move between loopback ports", () => {
    expect(originsMatch("http://127.0.0.1:3773/", "http://127.0.0.1:41000")).toBe(true);
    expect(originsMatch("http://127.0.0.1:3773/", "http://localhost:3999")).toBe(true);
    expect(originsMatch("http://127.0.0.1:3773/", "http://[::1]:5000")).toBe(true);
  });

  it("never lets a loopback token travel to a remote host, or the reverse", () => {
    expect(originsMatch("http://127.0.0.1:3773", "http://10.0.0.5:3773")).toBe(false);
    expect(originsMatch("http://10.0.0.5:3773", "http://127.0.0.1:3773")).toBe(false);
    expect(originsMatch("http://127.0.0.1:3773", "https://127.0.0.1:3773")).toBe(false);
  });

  it("rejects what is not a URL", () => {
    expect(originsMatch("not a url", "http://127.0.0.1:3773")).toBe(false);
    expect(originsMatch("http://127.0.0.1:3773", "")).toBe(false);
  });
});

describe("plainHttpWarning", () => {
  it("warns only for http to a host that is not this machine", () => {
    expect(plainHttpWarning("http://192.168.0.5:3773")).toContain("암호화");
    expect(plainHttpWarning("http://oop.example")).toContain("암호화");
    expect(plainHttpWarning("http://127.0.0.1:3773")).toBeNull();
    expect(plainHttpWarning("http://localhost:3773")).toBeNull();
    expect(plainHttpWarning("https://oop.example")).toBeNull();
  });
});

describe("localServer", () => {
  it("accepts only an announced server on the loopback", () => {
    const origin = "http://127.0.0.1:3773";
    expect(localServer({ origin, pid: 42 })).toEqual({ origin, pid: 42 });
    expect(localServer({ origin })).toBeNull();
    expect(localServer({ origin: "http://192.168.0.5:3773", pid: 42 })).toBeNull();
  });
});

describe("selectCredential", () => {
  let directory: string;
  let store: CredentialStore;
  beforeEach(async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-select-"));
    store = new CredentialStore(NodePath.join(directory, "credentials.json"));
    await store.save({
      environmentId: "env-1",
      label: "내 Mac",
      httpBaseUrl: "http://127.0.0.1:3773/",
      token: "secret-token",
      savedAt: "2026-10-30T00:00:00.000Z",
    });
  });
  afterEach(async () => {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });

  it("hands the token over for the server it was issued by", async () => {
    const result = await selectCredential(store, {
      origin: "http://127.0.0.1:41000",
      environmentId: "env-1",
      label: "내 Mac",
    });
    expect("credential" in result && result.credential.token).toBe("secret-token");
  });

  it("refuses a --server that merely repeats the public environment id", async () => {
    const result = await selectCredential(store, {
      origin: "http://evil.example:3773",
      environmentId: "env-1",
      label: "내 Mac",
    });
    expect("error" in result).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("offers to replace a token saved under this machine's network address", async () => {
    const lanOnly = new CredentialStore(NodePath.join(directory, "lan-only.json"));
    await lanOnly.save({
      environmentId: "env-1",
      label: "내 Mac",
      httpBaseUrl: "http://192.168.0.5:3773/",
      token: "secret-token",
      savedAt: "2026-10-30T00:00:00.000Z",
    });
    const result = await selectCredential(lanOnly, {
      origin: "http://127.0.0.1:3773",
      environmentId: "env-1",
      label: "내 Mac",
    });
    expect("error" in result && result.replaceable).toBe(true);
    expect("error" in result && result.error).toContain("oop --server http://192.168.0.5:3773/");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("keeps the loopback and the LAN token of one server side by side", async () => {
    await store.save({
      environmentId: "env-1",
      label: "내 Mac",
      httpBaseUrl: "http://192.168.0.5:3773/",
      token: "lan-token",
      savedAt: "2026-10-30T01:00:00.000Z",
    });
    const tokenFor = async (origin: string) => {
      const result = await selectCredential(store, {
        origin,
        environmentId: "env-1",
        label: "내 Mac",
      });
      return "credential" in result ? result.credential.token : null;
    };
    expect(await tokenFor("http://192.168.0.5:3773")).toBe("lan-token");
    expect(await tokenFor("http://127.0.0.1:41000")).toBe("secret-token");
  });

  it("keeps two LAN addresses with the same environment id apart", async () => {
    await store.save({
      environmentId: "env-1",
      label: "복사한 홈",
      httpBaseUrl: "http://192.168.0.9:3773/",
      token: "copy-token",
      savedAt: "2026-10-30T01:00:00.000Z",
    });
    const result = await selectCredential(store, {
      origin: "http://192.168.0.7:3773",
      environmentId: "env-1",
      label: "내 Mac",
    });
    expect("error" in result && result.replaceable).toBe(true);
    expect("error" in result && result.error).toContain("oop --server http://");
    expect(JSON.stringify(result)).not.toContain("copy-token");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("says so when the server was never paired", async () => {
    const result = await selectCredential(store, {
      origin: "http://127.0.0.1:3773",
      environmentId: "env-2",
      label: "다른 서버",
    });
    expect("error" in result && result.error).toContain("oop pair");
    expect("error" in result && result.replaceable).toBe(true);
  });

  it("reports a damaged credential file instead of calling the server unpaired", async () => {
    await NodeFSP.writeFile(NodePath.join(directory, "credentials.json"), "{broken");
    const result = await selectCredential(store, {
      origin: "http://127.0.0.1:3773",
      environmentId: "env-1",
      label: "내 Mac",
    });
    expect("error" in result && result.error).toContain("손상");
    expect("error" in result && result.replaceable).toBe(false);
  });
});
