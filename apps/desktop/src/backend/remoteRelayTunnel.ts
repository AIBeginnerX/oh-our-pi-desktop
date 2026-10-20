// @effect-diagnostics nodeBuiltinImport:off - The tunnel relays raw HTTP and WebSocket traffic to the loopback backend.
// @effect-diagnostics globalTimers:off - Keepalive and reconnect timers live with the socket callbacks they serve.
import * as NodeHttp from "node:http";

import {
  OOP_RELAY_CONNECT_PATH,
  OOP_RELAY_PING,
  OOP_RELAY_PROTOCOL,
  OOP_RELAY_SECRET_PROTOCOL_PREFIX,
  OopRelayFrameKind,
  chunkOopRelayPayload,
  decodeOopRelayFrame,
  decodeOopRelayJson,
  decodeOopRelayText,
  encodeOopRelayFrame,
  encodeOopRelayJsonFrame,
  encodeOopRelayText,
  isOopRelayForwardableHeader,
  type OopRelayFrame,
  type OopRelayRequestHead,
  type OopRelaySocketClose,
  type OopRelaySocketOpen,
} from "@t3tools/shared/oopRelayFrames";

const PING_INTERVAL_MS = 30_000;
const RETRY_DELAY_MIN_MS = 1_000;
const RETRY_DELAY_MAX_MS = 30_000;

export type RelaySocketFactory = (url: string, protocols: ReadonlyArray<string>) => WebSocket;

interface BackendSocket {
  readonly socket: WebSocket;
  readonly queued: Array<string | ArrayBuffer>;
}

export function relayConnectUrl(relayUrl: string): string {
  const url = new URL(OOP_RELAY_CONNECT_PATH, relayUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

function toNodeHeaders(headers: OopRelayRequestHead["headers"]): NodeHttp.OutgoingHttpHeaders {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (!isOopRelayForwardableHeader(name)) continue;
    const key = name.toLowerCase();
    const existing = result[key];
    result[key] =
      existing === undefined ? value : `${existing}${key === "cookie" ? "; " : ", "}${value}`;
  }
  return result;
}

function rawHeaderPairs(rawHeaders: ReadonlyArray<string>): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    pairs.push([rawHeaders[index] ?? "", rawHeaders[index + 1] ?? ""]);
  }
  return pairs;
}

// Node's WebSocket (undici) accepts handshake headers that the DOM typing omits; the backend
// authenticates browser WebSockets by the phone's cookie, so it has to be replayed.
const BackendWebSocket = WebSocket as unknown as new (
  url: string,
  init: { readonly protocols: string[]; readonly headers: Record<string, string> },
) => WebSocket;

const closableCode = (code: number) =>
  code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;

/**
 * Holds one outbound WebSocket to the Cloudflare relay and serves the phone requests it carries
 * against the local backend. Because the desktop dials out, no router port has to be opened.
 * Reconnects with backoff until stopped.
 */
export function startRemoteRelayTunnel(input: {
  readonly relayUrl: string;
  readonly secret: string;
  readonly backendPort: () => number;
  readonly onConnectedChange: (connected: boolean) => void;
  readonly createSocket?: RelaySocketFactory;
}): { readonly stop: () => void } {
  const createSocket: RelaySocketFactory =
    input.createSocket ?? ((url, protocols) => new WebSocket(url, [...protocols]));
  const requests = new Map<number, NodeHttp.ClientRequest>();
  const backendSockets = new Map<number, BackendSocket>();
  let relay: WebSocket | undefined;
  let stopped = false;
  let retryDelay = RETRY_DELAY_MIN_MS;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const sendToRelay = (frame: Uint8Array<ArrayBuffer>) => {
    if (relay?.readyState === WebSocket.OPEN) relay.send(frame);
  };

  const dropStreams = () => {
    for (const request of requests.values()) request.destroy();
    requests.clear();
    for (const { socket } of backendSockets.values()) socket.close();
    backendSockets.clear();
  };

  const forwardRequest = (id: number, head: OopRelayRequestHead) => {
    const request = NodeHttp.request({
      host: "127.0.0.1",
      port: input.backendPort(),
      method: head.method,
      path: head.path,
      headers: toNodeHeaders(head.headers),
    });
    requests.set(id, request);
    request.on("response", (response) => {
      sendToRelay(
        encodeOopRelayJsonFrame(OopRelayFrameKind.responseHead, id, {
          status: response.statusCode ?? 502,
          headers: rawHeaderPairs(response.rawHeaders),
        }),
      );
      response.on("data", (chunk: Buffer) => {
        for (const part of chunkOopRelayPayload(chunk)) {
          sendToRelay(encodeOopRelayFrame(OopRelayFrameKind.responseBody, id, part));
        }
      });
      response.on("end", () => {
        requests.delete(id);
        sendToRelay(encodeOopRelayFrame(OopRelayFrameKind.responseEnd, id));
      });
    });
    request.on("error", (error) => {
      if (!requests.delete(id)) return;
      sendToRelay(
        encodeOopRelayJsonFrame(OopRelayFrameKind.responseError, id, { message: error.message }),
      );
    });
  };

  const openBackendSocket = (id: number, open: OopRelaySocketOpen) => {
    const socket = new BackendWebSocket(`ws://127.0.0.1:${input.backendPort()}${open.path}`, {
      protocols: [...open.protocols],
      headers: Object.fromEntries(open.headers),
    });
    socket.binaryType = "arraybuffer";
    const entry: BackendSocket = { socket, queued: [] };
    backendSockets.set(id, entry);
    socket.addEventListener("open", () => {
      for (const message of entry.queued.splice(0)) socket.send(message);
    });
    socket.addEventListener("message", (event) => {
      sendToRelay(
        typeof event.data === "string"
          ? encodeOopRelayFrame(OopRelayFrameKind.socketText, id, encodeOopRelayText(event.data))
          : encodeOopRelayFrame(
              OopRelayFrameKind.socketBinary,
              id,
              new Uint8Array(event.data as ArrayBuffer),
            ),
      );
    });
    socket.addEventListener("close", (event) => {
      if (backendSockets.get(id)?.socket !== socket) return;
      backendSockets.delete(id);
      sendToRelay(
        encodeOopRelayJsonFrame(OopRelayFrameKind.socketClose, id, {
          code: event.code,
          reason: event.reason,
        }),
      );
    });
  };

  const sendToBackendSocket = (id: number, message: string | ArrayBuffer) => {
    const entry = backendSockets.get(id);
    if (!entry) return;
    if (entry.socket.readyState === WebSocket.OPEN) entry.socket.send(message);
    else entry.queued.push(message);
  };

  const handleFrame = (frame: OopRelayFrame) => {
    switch (frame.kind) {
      case OopRelayFrameKind.requestHead:
        forwardRequest(frame.id, decodeOopRelayJson<OopRelayRequestHead>(frame.payload));
        return;
      case OopRelayFrameKind.requestBody:
        requests.get(frame.id)?.write(frame.payload);
        return;
      case OopRelayFrameKind.requestEnd:
        requests.get(frame.id)?.end();
        return;
      case OopRelayFrameKind.socketOpen:
        openBackendSocket(frame.id, decodeOopRelayJson<OopRelaySocketOpen>(frame.payload));
        return;
      case OopRelayFrameKind.socketText:
        sendToBackendSocket(frame.id, decodeOopRelayText(frame.payload));
        return;
      case OopRelayFrameKind.socketBinary:
        sendToBackendSocket(frame.id, frame.payload.slice().buffer);
        return;
      case OopRelayFrameKind.socketClose: {
        const entry = backendSockets.get(frame.id);
        backendSockets.delete(frame.id);
        const { code, reason } = decodeOopRelayJson<OopRelaySocketClose>(frame.payload);
        entry?.socket.close(closableCode(code), reason);
        return;
      }
    }
  };

  const connect = () => {
    const socket = createSocket(relayConnectUrl(input.relayUrl), [
      OOP_RELAY_PROTOCOL,
      `${OOP_RELAY_SECRET_PROTOCOL_PREFIX}${input.secret}`,
    ]);
    relay = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      retryDelay = RETRY_DELAY_MIN_MS;
      input.onConnectedChange(true);
      pingTimer = setInterval(() => socket.send(OOP_RELAY_PING), PING_INTERVAL_MS);
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string")
        handleFrame(decodeOopRelayFrame(event.data as ArrayBuffer));
    });
    socket.addEventListener("close", () => {
      if (relay !== socket) return;
      relay = undefined;
      clearInterval(pingTimer);
      dropStreams();
      input.onConnectedChange(false);
      if (stopped) return;
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_DELAY_MAX_MS);
    });
  };

  connect();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      relay?.close();
      dropStreams();
    },
  };
}
