// @effect-diagnostics nodeBuiltinImport:off - A real loopback HTTP backend is the boundary under test.
import * as NodeHttp from "node:http";

import {
  OopRelayFrameKind,
  decodeOopRelayFrame,
  decodeOopRelayJson,
  decodeOopRelayText,
  encodeOopRelayFrame,
  encodeOopRelayJsonFrame,
  encodeOopRelayText,
  type OopRelayFrame,
  type OopRelayResponseHead,
} from "@t3tools/shared/oopRelayFrames";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { startRemoteRelayTunnel } from "./remoteRelayTunnel.ts";

class FakeRelaySocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  binaryType = "blob";
  readonly frames: Array<OopRelayFrame> = [];
  private readonly frameListeners = new Set<(frame: OopRelayFrame) => void>();

  send(data: string | Uint8Array) {
    if (typeof data === "string") return;
    const frame = decodeOopRelayFrame(data);
    this.frames.push(frame);
    for (const listener of this.frameListeners) listener(frame);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  deliver(frame: Uint8Array) {
    this.dispatchEvent(new MessageEvent("message", { data: frame.slice().buffer }));
  }

  nextFrame(kind: OopRelayFrameKind, id: number): Promise<OopRelayFrame> {
    return new Promise((resolve) => {
      const listener = (frame: OopRelayFrame) => {
        if (frame.kind !== kind || frame.id !== id) return;
        this.frameListeners.delete(listener);
        resolve(frame);
      };
      this.frameListeners.add(listener);
    });
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function startBackend() {
  const backend = NodeHttp.createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("set-cookie", ["a=1", "b=2"]);
      response.end(
        JSON.stringify({
          method: request.method,
          url: request.url,
          host: request.headers.host,
          cookie: request.headers.cookie,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => backend.close());
  const address = backend.address();
  if (address === null || typeof address === "string") throw new Error("backend not listening");
  return address.port;
}

function startTunnel(backendPort: number) {
  const relay = new FakeRelaySocket();
  const dialed: Array<{ url: string; protocols: ReadonlyArray<string> }> = [];
  const tunnel = startRemoteRelayTunnel({
    relayUrl: "https://oop-relay.example.workers.dev",
    secret: "s3cret",
    backendPort: () => backendPort,
    onConnectedChange: () => {},
    createSocket: (url, protocols) => {
      dialed.push({ url, protocols });
      return relay as unknown as WebSocket;
    },
  });
  cleanups.push(tunnel.stop);
  relay.open();
  return { relay, dialed };
}

describe("startRemoteRelayTunnel", () => {
  it("dials the relay with its secret in the WebSocket subprotocol", async () => {
    const { dialed } = startTunnel(await startBackend());
    expect(dialed).toEqual([
      {
        url: "wss://oop-relay.example.workers.dev/_oop/connect",
        protocols: ["oop-relay.v1", "oop-secret.s3cret"],
      },
    ]);
  });

  it("serves a tunnelled phone request against the local backend", async () => {
    const { relay } = startTunnel(await startBackend());
    const id = 42;
    const head = relay.nextFrame(OopRelayFrameKind.responseHead, id);
    const end = relay.nextFrame(OopRelayFrameKind.responseEnd, id);

    relay.deliver(
      encodeOopRelayJsonFrame(OopRelayFrameKind.requestHead, id, {
        method: "POST",
        path: "/api/auth/session?x=1",
        headers: [
          ["Host", "oop-relay.example.workers.dev"],
          ["Cookie", "session=abc"],
          ["Connection", "keep-alive"],
        ],
      }),
    );
    relay.deliver(
      encodeOopRelayFrame(OopRelayFrameKind.requestBody, id, encodeOopRelayText("hello")),
    );
    relay.deliver(encodeOopRelayFrame(OopRelayFrameKind.requestEnd, id));

    const responseHead = decodeOopRelayJson<OopRelayResponseHead>((await head).payload);
    await end;
    const body = relay.frames
      .filter((frame) => frame.kind === OopRelayFrameKind.responseBody && frame.id === id)
      .map((frame) => decodeOopRelayText(frame.payload))
      .join("");

    expect(responseHead.status).toBe(200);
    expect(responseHead.headers.filter(([name]) => name.toLowerCase() === "set-cookie")).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
    expect(JSON.parse(body)).toEqual({
      method: "POST",
      url: "/api/auth/session?x=1",
      host: "oop-relay.example.workers.dev",
      cookie: "session=abc",
      body: "hello",
    });
  });

  it("replays the phone's cookie on the backend WebSocket handshake", async () => {
    const backend = NodeHttp.createServer();
    const upgrade = new Promise<{
      readonly url: string | undefined;
      readonly cookie: string | undefined;
      readonly origin: string | undefined;
    }>((resolve) => {
      backend.on("upgrade", (request, socket) => {
        resolve({
          url: request.url,
          cookie: request.headers.cookie,
          origin: request.headers.origin,
        });
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => backend.close());
    const address = backend.address();
    if (address === null || typeof address === "string") throw new Error("backend not listening");

    const { relay } = startTunnel(address.port);
    relay.deliver(
      encodeOopRelayJsonFrame(OopRelayFrameKind.socketOpen, 9, {
        path: "/ws?clientSurface=web",
        protocols: [],
        headers: [
          ["Cookie", "t3_session=abc"],
          ["Origin", "https://oop-relay.example.workers.dev"],
        ],
      }),
    );

    const headers = await upgrade;
    expect(headers.url).toBe("/ws?clientSurface=web");
    expect(headers.cookie).toBe("t3_session=abc");
    expect(headers.origin).toBe("https://oop-relay.example.workers.dev");
  });

  it("reports a backend that cannot be reached instead of leaving the phone waiting", async () => {
    const { relay } = startTunnel(1);
    const error = relay.nextFrame(OopRelayFrameKind.responseError, 7);
    relay.deliver(
      encodeOopRelayJsonFrame(OopRelayFrameKind.requestHead, 7, {
        method: "GET",
        path: "/",
        headers: [],
      }),
    );
    relay.deliver(encodeOopRelayFrame(OopRelayFrameKind.requestEnd, 7));
    expect((await error).kind).toBe(OopRelayFrameKind.responseError);
  });
});
