import { describe, expect, it } from "vite-plus/test";

import { discoverServer, parseRuntimeAnnouncement } from "./discovery.ts";

const announced = JSON.stringify({
  version: 1,
  pid: 4242,
  port: 3773,
  origin: "http://127.0.0.1:3773",
  startedAt: "2026-10-30T00:00:00.000Z",
  ignored: "not read",
});

const probeOk = async () => ({ environmentId: "env-1", label: "내 Mac" });

describe("parseRuntimeAnnouncement", () => {
  it("keeps only the pid and origin", () => {
    expect(parseRuntimeAnnouncement(announced)).toEqual({
      pid: 4242,
      origin: "http://127.0.0.1:3773",
    });
  });

  it("marks only the terminal's own server, from a literal true", () => {
    const own = (daemon: unknown) =>
      parseRuntimeAnnouncement(JSON.stringify({ pid: 1, origin: "http://127.0.0.1:1", daemon }));
    expect(own(true)).toEqual({ pid: 1, origin: "http://127.0.0.1:1", daemon: true });
    expect(own(false)).toEqual({ pid: 1, origin: "http://127.0.0.1:1" });
    expect(own("true")).toEqual({ pid: 1, origin: "http://127.0.0.1:1" });
  });

  it("rejects malformed content and non-http origins", () => {
    expect(parseRuntimeAnnouncement("not json")).toBeNull();
    expect(parseRuntimeAnnouncement('{"pid":0,"origin":"http://x"}')).toBeNull();
    expect(parseRuntimeAnnouncement('{"pid":1,"origin":"file:///etc/passwd"}')).toBeNull();
    expect(parseRuntimeAnnouncement('{"pid":1}')).toBeNull();
  });
});

describe("discoverServer", () => {
  const deps = { readFile: async () => announced, isAlive: () => true, probe: probeOk };

  it("finds a live server that answers", async () => {
    expect(await discoverServer("/x/server-runtime.json", deps)).toEqual({
      kind: "found",
      pid: 4242,
      origin: "http://127.0.0.1:3773",
      environmentId: "env-1",
      label: "내 Mac",
    });
  });

  it("carries the terminal's own server mark to the result", async () => {
    const own = JSON.stringify({ pid: 4242, origin: "http://127.0.0.1:3773", daemon: true });
    expect(await discoverServer("/x", { ...deps, readFile: async () => own })).toMatchObject({
      kind: "found",
      daemon: true,
    });
  });

  it("reports a missing or unreadable file without probing", async () => {
    let probed = false;
    const result = await discoverServer("/x", {
      ...deps,
      readFile: async () => {
        throw new Error("ENOENT");
      },
      probe: async () => {
        probed = true;
        return null;
      },
    });
    expect(result.kind).toBe("missing");
    expect(probed).toBe(false);
    expect((await discoverServer("/x", { ...deps, readFile: async () => "{}" })).kind).toBe(
      "missing",
    );
  });

  it("calls a dead process stale rather than trying its port", async () => {
    let probed = false;
    const result = await discoverServer("/x", {
      ...deps,
      isAlive: () => false,
      probe: async () => {
        probed = true;
        return null;
      },
    });
    expect(result.kind).toBe("stale");
    expect(probed).toBe(false);
  });

  it("reports a live process that does not answer as unreachable", async () => {
    expect((await discoverServer("/x", { ...deps, probe: async () => null })).kind).toBe(
      "unreachable",
    );
    expect(
      (
        await discoverServer("/x", {
          ...deps,
          probe: async () => {
            throw new Error("ECONNREFUSED");
          },
        })
      ).kind,
    ).toBe("unreachable");
  });
});
