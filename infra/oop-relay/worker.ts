import { DurableObject } from "cloudflare:workers";

import {
  OOP_RELAY_CONNECT_PATH,
  OOP_RELAY_PING,
  OOP_RELAY_PONG,
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
  isOopRelaySocketHeader,
  type OopRelayResponseHead,
  type OopRelaySocketClose,
} from "../../packages/shared/src/oopRelayFrames.ts";

interface Env {
  readonly RELAY: DurableObjectNamespace<OopRelay>;
  readonly OOP_RELAY_SECRET: string;
}

const DESKTOP_TAG = "desktop";
const RESPONSE_HEAD_TIMEOUT_MS = 30_000;
const phoneTag = (id: number) => `phone:${id}`;

interface PendingResponse {
  readonly resolveHead: (head: OopRelayResponseHead) => void;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  headReceived: boolean;
}

function randomStreamId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

function offlineResponse(): Response {
  return new Response("This OOP desktop is offline. Start OOP on the computer and try again.", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" },
  });
}

/** One relay per deployment: a personal OOP desktop and the phones it has paired. */
export class OopRelay extends DurableObject<Env> {
  private readonly pending = new Map<number, PendingResponse>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answers the desktop keepalive without waking a hibernated object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(OOP_RELAY_PING, OOP_RELAY_PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === OOP_RELAY_CONNECT_PATH) return this.acceptDesktop(request);
    const desktop = this.desktop();
    if (!desktop) return offlineResponse();
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.openPhoneSocket(request, url, desktop);
    }
    return this.forwardRequest(request, url, desktop);
  }

  private desktop(): WebSocket | undefined {
    return this.ctx.getWebSockets(DESKTOP_TAG)[0];
  }

  private async acceptDesktop(request: Request): Promise<Response> {
    const offered = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim());
    const secret = offered
      .find((value) => value.startsWith(OOP_RELAY_SECRET_PROTOCOL_PREFIX))
      ?.slice(OOP_RELAY_SECRET_PROTOCOL_PREFIX.length);
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      !offered.includes(OOP_RELAY_PROTOCOL) ||
      secret === undefined ||
      !(await secretsMatch(secret, this.env.OOP_RELAY_SECRET))
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    // A reconnecting desktop replaces the previous connection and everything tunnelled over it.
    for (const socket of this.ctx.getWebSockets()) socket.close(1012, "Desktop reconnected");
    this.failPending("Desktop reconnected");

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [DESKTOP_TAG]);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": OOP_RELAY_PROTOCOL },
    });
  }

  private openPhoneSocket(request: Request, url: URL, desktop: WebSocket): Response {
    const id = randomStreamId();
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [phoneTag(id)]);
    desktop.send(
      encodeOopRelayJsonFrame(OopRelayFrameKind.socketOpen, id, {
        path: `${url.pathname}${url.search}`,
        protocols,
        headers: [...request.headers].filter(([name]) => isOopRelaySocketHeader(name)),
      }),
    );
    const firstProtocol = protocols[0];
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      ...(firstProtocol ? { headers: { "sec-websocket-protocol": firstProtocol } } : {}),
    });
  }

  private async forwardRequest(request: Request, url: URL, desktop: WebSocket): Promise<Response> {
    const id = randomStreamId();
    let resolveHead!: (head: OopRelayResponseHead) => void;
    const head = new Promise<OopRelayResponseHead>((resolve) => {
      resolveHead = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.pending.set(id, { resolveHead, controller, headReceived: false });
      },
      cancel: () => {
        this.pending.delete(id);
      },
    });

    const headers = [...request.headers].filter(
      // The relay re-compresses for the phone, so ask the backend for identity bytes.
      ([name]) => isOopRelayForwardableHeader(name) && name.toLowerCase() !== "accept-encoding",
    );
    desktop.send(
      encodeOopRelayJsonFrame(OopRelayFrameKind.requestHead, id, {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
      }),
    );
    if (request.body) {
      const reader = request.body.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        for (const part of chunkOopRelayPayload(chunk.value)) {
          desktop.send(encodeOopRelayFrame(OopRelayFrameKind.requestBody, id, part));
        }
      }
    }
    desktop.send(encodeOopRelayFrame(OopRelayFrameKind.requestEnd, id));

    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), RESPONSE_HEAD_TIMEOUT_MS),
    );
    const responseHead = await Promise.race([head, timeout]);
    if (responseHead === null) {
      this.pending.delete(id);
      return new Response("The OOP desktop did not answer in time.", { status: 504 });
    }
    const responseHeaders = new Headers();
    for (const [name, value] of responseHead.headers) {
      if (isOopRelayForwardableHeader(name)) responseHeaders.append(name, value);
    }
    const nullBody =
      [101, 204, 205, 304].includes(responseHead.status) || request.method === "HEAD";
    return new Response(nullBody ? null : body, {
      status: responseHead.status,
      headers: responseHeaders,
    });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const desktop = this.desktop();
    if (socket === desktop) {
      if (typeof message === "string") return;
      this.handleDesktopFrame(message);
      return;
    }
    const id = this.phoneId(socket);
    if (id === undefined || !desktop) return;
    desktop.send(
      typeof message === "string"
        ? encodeOopRelayFrame(OopRelayFrameKind.socketText, id, encodeOopRelayText(message))
        : encodeOopRelayFrame(OopRelayFrameKind.socketBinary, id, new Uint8Array(message)),
    );
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    this.closeQuietly(socket, code, reason);
    if (this.ctx.getTags(socket).includes(DESKTOP_TAG)) {
      this.failPending("Desktop disconnected");
      for (const phone of this.ctx.getWebSockets())
        this.closeQuietly(phone, 1012, "Desktop offline");
      return;
    }
    const id = this.phoneId(socket);
    const desktop = this.desktop();
    if (id !== undefined && desktop) {
      desktop.send(encodeOopRelayJsonFrame(OopRelayFrameKind.socketClose, id, { code, reason }));
    }
  }

  override webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket, 1011, "Relay socket error");
  }

  private handleDesktopFrame(message: ArrayBuffer): void {
    const frame = decodeOopRelayFrame(message);
    switch (frame.kind) {
      case OopRelayFrameKind.responseHead: {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        pending.headReceived = true;
        pending.resolveHead(decodeOopRelayJson<OopRelayResponseHead>(frame.payload));
        return;
      }
      case OopRelayFrameKind.responseBody:
        this.pending.get(frame.id)?.controller.enqueue(frame.payload.slice());
        return;
      case OopRelayFrameKind.responseEnd:
        this.pending.get(frame.id)?.controller.close();
        this.pending.delete(frame.id);
        return;
      case OopRelayFrameKind.responseError: {
        const pending = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        if (!pending) return;
        if (pending.headReceived) pending.controller.error(new Error("Desktop request failed"));
        else pending.resolveHead({ status: 502, headers: [] });
        return;
      }
      case OopRelayFrameKind.socketText:
        this.phone(frame.id)?.send(decodeOopRelayText(frame.payload));
        return;
      case OopRelayFrameKind.socketBinary:
        this.phone(frame.id)?.send(frame.payload.slice());
        return;
      case OopRelayFrameKind.socketClose: {
        const phone = this.phone(frame.id);
        if (!phone) return;
        const { code, reason } = decodeOopRelayJson<OopRelaySocketClose>(frame.payload);
        this.closeQuietly(phone, code, reason);
        return;
      }
    }
  }

  private phone(id: number): WebSocket | undefined {
    return this.ctx.getWebSockets(phoneTag(id))[0];
  }

  private phoneId(socket: WebSocket): number | undefined {
    const tag = this.ctx.getTags(socket).find((value) => value.startsWith("phone:"));
    return tag === undefined ? undefined : Number(tag.slice("phone:".length));
  }

  private failPending(reason: string): void {
    for (const pending of this.pending.values()) {
      if (pending.headReceived) pending.controller.error(new Error(reason));
      else pending.resolveHead({ status: 502, headers: [] });
    }
    this.pending.clear();
  }

  // Close codes from the far side may be reserved (1005/1006) and rejected by `close`.
  private closeQuietly(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(
        code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000,
        reason,
      );
    } catch {
      // The socket is already closed.
    }
  }
}

async function secretsMatch(offered: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(offered)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.RELAY.get(env.RELAY.idFromName("desktop")).fetch(request);
  },
} satisfies ExportedHandler<Env>;
