/**
 * Wire format between the OOP desktop and its Cloudflare relay. The desktop holds one outbound
 * WebSocket to the relay; every phone HTTP request and WebSocket travels over it as binary frames
 * of `[kind: u8][stream id: u32 big-endian][payload]`. Text messages are reserved for keepalive.
 */
export const OOP_RELAY_CONNECT_PATH = "/_oop/connect";
export const OOP_RELAY_PROTOCOL = "oop-relay.v1";
/** Sec-WebSocket-Protocol prefix that carries the shared secret on the desktop's connection. */
export const OOP_RELAY_SECRET_PROTOCOL_PREFIX = "oop-secret.";
export const OOP_RELAY_PING = "ping";
export const OOP_RELAY_PONG = "pong";
/** Cloudflare caps WebSocket messages at 1 MiB; bodies are split well below that. */
export const OOP_RELAY_MAX_CHUNK_BYTES = 256 * 1024;

export const OopRelayFrameKind = {
  requestHead: 1,
  requestBody: 2,
  requestEnd: 3,
  responseHead: 4,
  responseBody: 5,
  responseEnd: 6,
  responseError: 7,
  socketOpen: 8,
  socketText: 9,
  socketBinary: 10,
  socketClose: 11,
} as const;
export type OopRelayFrameKind = (typeof OopRelayFrameKind)[keyof typeof OopRelayFrameKind];

export type OopRelayHeaders = ReadonlyArray<readonly [string, string]>;

export interface OopRelayRequestHead {
  readonly method: string;
  readonly path: string;
  readonly headers: OopRelayHeaders;
}

export interface OopRelayResponseHead {
  readonly status: number;
  readonly headers: OopRelayHeaders;
}

export interface OopRelaySocketOpen {
  readonly path: string;
  readonly protocols: ReadonlyArray<string>;
  /** The phone's upgrade headers; the backend authenticates browser WebSockets by cookie. */
  readonly headers: OopRelayHeaders;
}

export interface OopRelaySocketClose {
  readonly code: number;
  readonly reason: string;
}

export interface OopRelayFrame {
  readonly kind: OopRelayFrameKind;
  readonly id: number;
  readonly payload: Uint8Array;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeOopRelayFrame(
  kind: OopRelayFrameKind,
  id: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(5 + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, id);
  frame.set(payload, 5);
  return frame;
}

export function encodeOopRelayJsonFrame(
  kind: OopRelayFrameKind,
  id: number,
  value: unknown,
): Uint8Array<ArrayBuffer> {
  return encodeOopRelayFrame(kind, id, textEncoder.encode(JSON.stringify(value)));
}

export function decodeOopRelayFrame(data: ArrayBuffer | Uint8Array): OopRelayFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    kind: view.getUint8(0) as OopRelayFrameKind,
    id: view.getUint32(1),
    payload: bytes.subarray(5),
  };
}

export function decodeOopRelayJson<T>(payload: Uint8Array): T {
  return JSON.parse(textDecoder.decode(payload)) as T;
}

export function decodeOopRelayText(payload: Uint8Array): string {
  return textDecoder.decode(payload);
}

export function encodeOopRelayText(text: string): Uint8Array {
  return textEncoder.encode(text);
}

export function* chunkOopRelayPayload(payload: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < payload.byteLength; offset += OOP_RELAY_MAX_CHUNK_BYTES) {
    yield payload.subarray(offset, offset + OOP_RELAY_MAX_CHUNK_BYTES);
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

/** Drops headers that describe a single hop, which each side re-derives for its own connection. */
export function isOopRelayForwardableHeader(name: string): boolean {
  return !HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}

/** Upgrade headers worth replaying on the desktop's own WebSocket handshake to the backend. */
export function isOopRelaySocketHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    isOopRelayForwardableHeader(lower) && lower !== "host" && !lower.startsWith("sec-websocket-")
  );
}
