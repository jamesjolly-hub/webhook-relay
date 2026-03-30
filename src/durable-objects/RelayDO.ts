/**
 * RelayDO — WebSocket relay Durable Object using the Hibernation API.
 *
 * One DO instance per bin (named by bin ID).
 * Connected WebSocket clients receive broadcast messages when new events
 * are captured.  The hibernation API (ctx.acceptWebSocket) keeps the DO
 * dormant between events, avoiding the 30-second idle eviction and
 * reducing memory charges.
 *
 * DO state (KV namespace) stores events — RelayDO only manages
 * live WebSocket connections and coordinates broadcast.
 */

import type { DurableObject } from "cloudflare:workers";

export interface BroadcastPayload {
  type: "event" | "ping" | "close";
  binId?: string;
  eventId?: string;
  capturedAt?: string;
  method?: string;
  path?: string;
  headersCount?: number;
  bodyPreview?: string;
}

interface RelayEnv {
  BROADCAST_SECRET?: string;
  [key: string]: unknown;
}

export class RelayDO implements DurableObject {
  private readonly secret: string | undefined;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: RelayEnv
  ) {
    this.secret = env["BROADCAST_SECRET"] as string | undefined;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade request
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request, url);
    }

    // Internal broadcast trigger (Worker → DO)
    if (request.method === "POST" && url.pathname === "/broadcast") {
      return this.handleBroadcast(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private handleWebSocketUpgrade(request: Request, url: URL): Response {
    const binId = url.searchParams.get("binId") ?? "unknown";
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernation API — tag the socket so we can broadcast to all bin subscribers
    this.ctx.acceptWebSocket(server, [`bin:${binId}`]);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    // Validate internal shared secret — reject unauthenticated callers
    if (this.secret) {
      const authHeader = request.headers.get("Authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== this.secret) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const payload = (await request.json()) as BroadcastPayload;
    const binId = payload.binId ?? "";

    if (!binId) {
      return Response.json({ error: "binId is required" }, { status: 400 });
    }

    const sockets = this.ctx.getWebSockets(`bin:${binId}`);
    const message = JSON.stringify(payload);
    let sent = 0;

    for (const ws of sockets) {
      try {
        ws.send(message);
        sent++;
      } catch {
        // Socket may have closed between getWebSockets() and send()
      }
    }

    return Response.json({ sent, subscribers: sockets.length });
  }

  // ---------------------------------------------------------------------------
  // WebSocket lifecycle handlers (Hibernation API)
  // ---------------------------------------------------------------------------

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Echo pings back; ignore other client messages
    try {
      const parsed = JSON.parse(typeof message === "string" ? message : "") as { type?: string };
      if (parsed.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      // Not JSON — ignore
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    // Hibernation API handles cleanup automatically; log if needed
    void ws;
    void code;
    void reason;
    void wasClean;
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    void ws;
    void error;
  }
}
