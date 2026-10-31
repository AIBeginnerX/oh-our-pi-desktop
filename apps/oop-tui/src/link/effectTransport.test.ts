import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { exchangePairingToken, makeEffectTransport } from "./effectTransport.ts";
import { pairFailureMessage } from "./pair.ts";

describe("a refused connection", () => {
  // A server one protocol version ahead of this client.
  const descriptor = {
    environmentId: "env-1",
    label: "새 서버",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "9.9.9",
    orchestrationProtocolVersion: 99,
    capabilities: {},
  };
  const listener = NodeHttp.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(descriptor));
  });
  let origin = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(listener.address() as NodeNet.AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => listener.close(resolve)));

  it("carries the connection layer's reason along with the explanation", async () => {
    const transport = makeEffectTransport({
      httpBaseUrl: origin,
      bearerToken: "secret",
      identity: { label: "oop test", os: "Linux", appVersion: "0.0.0" },
      locateOrigin: undefined,
    });
    await expect(transport.open()).rejects.toMatchObject({
      kind: "blocked",
      reason: "unsupported",
      message: expect.stringContaining("새 서버"),
    });
  });

  it("tells oop pair to update, because the link was never looked at", async () => {
    const cause = await exchangePairingToken({
      httpBaseUrl: origin,
      credential: "one-time",
      identity: { label: "oop test", os: "Linux", appVersion: "0.0.0" },
    }).catch((failure: unknown) => failure);
    expect(pairFailureMessage(cause)).toContain("업데이트하세요");
  });
});
