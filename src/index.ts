/**
 * webhook-relay — Island 5
 *
 * Bin management + webhook capture + KV storage + live WebSocket tail
 * via Durable Objects Hibernation API.
 *
 * Routes:
 *   POST   /bins                        — create bin
 *   DELETE /bins/:binId                 — delete bin + events
 *   GET    /bins/:binId                 — HTML inspector UI
 *   ANY    /bins/:binId/capture         — capture incoming webhook event
 *   GET    /bins/:binId/events          — list events (JSON)
 *   GET    /bins/:binId/events/:eventId — get single event
 *   POST   /bins/:binId/replay/:eventId — replay event to target URL
 *   GET    /bins/:binId/tail            — WebSocket upgrade for live tail
 */

import { RelayDO } from "./durable-objects/RelayDO";

export { RelayDO };

export interface Env {
  RELAY_STORE: KVNamespace;
  RELAY_DO: DurableObjectNamespace;
  BIN_TTL_SECONDS: string;
  MAX_EVENTS_PER_BIN: string;
  /** Shared secret for Worker→DO broadcast calls. Set via `wrangler secret put BROADCAST_SECRET`. */
  BROADCAST_SECRET?: string;
}

interface BinMeta {
  id: string;
  createdAt: string;
  expiresAt: string;
  eventCount: number;
}

interface CapturedEvent {
  id: string;
  binId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;        // raw body (string or base64)
  bodyEncoding: "utf8" | "base64";
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// KV key helpers
// ---------------------------------------------------------------------------

const binMetaKey  = (binId: string)                => `bin:${binId}:meta`;
const eventKey    = (binId: string, eventId: string) => `bin:${binId}:event:${eventId}`;
const eventListKey = (binId: string)               => `bin:${binId}:events`;

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // POST /bins
    if (request.method === "POST" && parts[0] === "bins" && parts.length === 1) {
      return handleCreateBin(request, env);
    }

    // DELETE /bins/:binId
    if (request.method === "DELETE" && parts[0] === "bins" && parts.length === 2) {
      return handleDeleteBin(parts[1], env);
    }

    // GET /bins/:binId/tail — WebSocket live tail (proxy to DO)
    if (
      request.method === "GET" &&
      parts[0] === "bins" &&
      parts[1] &&
      parts[2] === "tail"
    ) {
      return handleTail(parts[1], request, env);
    }

    // GET /bins/:binId/events/:eventId
    if (
      request.method === "GET" &&
      parts[0] === "bins" &&
      parts[1] &&
      parts[2] === "events" &&
      parts[3]
    ) {
      return handleGetEvent(parts[1], parts[3], env);
    }

    // GET /bins/:binId/events
    if (
      request.method === "GET" &&
      parts[0] === "bins" &&
      parts[1] &&
      parts[2] === "events"
    ) {
      return handleListEvents(parts[1], env);
    }

    // POST /bins/:binId/replay/:eventId
    if (
      request.method === "POST" &&
      parts[0] === "bins" &&
      parts[1] &&
      parts[2] === "replay" &&
      parts[3]
    ) {
      return handleReplay(parts[1], parts[3], request, env);
    }

    // GET /bins/:binId — HTML inspector
    if (request.method === "GET" && parts[0] === "bins" && parts.length === 2) {
      return handleInspectorUI(parts[1], env);
    }

    // ANY /bins/:binId/capture — capture incoming webhook
    if (parts[0] === "bins" && parts[1] && parts[2] === "capture") {
      return handleCapture(parts[1], request, env);
    }

    // GET /bins/:binId/live — spec alias for WebSocket tail
    if (
      request.method === "GET" &&
      parts[0] === "bins" &&
      parts[1] &&
      parts[2] === "live"
    ) {
      return handleTail(parts[1], request, env);
    }

    // GET /bins/:binId/requests — spec alias for events list
    if (
      request.method === "GET" &&
      parts[0] === "bins" &&
      parts[1] &&
      parts[2] === "requests"
    ) {
      return handleListEvents(parts[1], env);
    }

    // GET /hook/:binId/live — spec alias for WebSocket tail
    if (
      request.method === "GET" &&
      parts[0] === "hook" &&
      parts[1] &&
      parts[2] === "live"
    ) {
      return handleTail(parts[1], request, env);
    }

    // ANY /hook/:binId — spec alias for capture
    if (parts[0] === "hook" && parts[1] && !parts[2]) {
      return handleCapture(parts[1], request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCreateBin(request: Request, env: Env): Promise<Response> {
  const binId = crypto.randomUUID().split("-")[0]; // short 8-char id
  const ttlSeconds = parseInt(env.BIN_TTL_SECONDS ?? "604800", 10);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  const meta: BinMeta = {
    id: binId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    eventCount: 0,
  };

  await env.RELAY_STORE.put(binMetaKey(binId), JSON.stringify(meta), {
    expirationTtl: ttlSeconds,
  });
  await env.RELAY_STORE.put(eventListKey(binId), JSON.stringify([]), {
    expirationTtl: ttlSeconds,
  });

  // Construct the fully-qualified hook URL the caller can use as a webhook target
  const origin = new URL(request.url).origin;
  const hookUrl = `${origin}/hook/${binId}`;

  return Response.json({ binId, hookUrl, ...meta }, { status: 201 });
}

async function handleDeleteBin(binId: string, env: Env): Promise<Response> {
  const meta = await getBinMeta(binId, env);
  if (!meta) return Response.json({ error: "Bin not found" }, { status: 404 });

  // Delete all event keys
  const eventIds = await getEventIds(binId, env);
  await Promise.all(eventIds.map((id) => env.RELAY_STORE.delete(eventKey(binId, id))));
  await env.RELAY_STORE.delete(eventListKey(binId));
  await env.RELAY_STORE.delete(binMetaKey(binId));

  return new Response(null, { status: 204 });
}

async function handleCapture(binId: string, request: Request, env: Env): Promise<Response> {
  const meta = await getBinMeta(binId, env);
  if (!meta) return Response.json({ error: "Bin not found" }, { status: 404 });

  const maxEvents = parseInt(env.MAX_EVENTS_PER_BIN ?? "500", 10);
  if (meta.eventCount >= maxEvents) {
    return Response.json({ error: "Bin event limit reached" }, { status: 429 });
  }

  const eventId = crypto.randomUUID();
  const capturedAt = new Date().toISOString();
  const url = new URL(request.url);

  // Capture headers
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Capture body — Workers runtime does not have Node.js Buffer; use Web APIs
  const rawBody = await request.arrayBuffer();
  let body: string;
  let bodyEncoding: "utf8" | "base64";
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    bodyEncoding = "utf8";
  } catch {
    // Binary body: encode as base64 using Web API
    const bytes = new Uint8Array(rawBody);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    body = btoa(binary);
    bodyEncoding = "base64";
  }

  const event: CapturedEvent = {
    id: eventId,
    binId,
    method: request.method,
    path: url.pathname + url.search,
    headers,
    body,
    bodyEncoding,
    capturedAt,
  };

  const ttlSeconds = parseInt(env.BIN_TTL_SECONDS ?? "604800", 10);

  // Store event in KV
  // NOTE: KV has no atomic read-modify-write. Concurrent captures for the same bin may
  // cause lost event-list entries under high contention. For production use at scale,
  // move event-list management into the RelayDO (single-writer guarantee). For a personal
  // webhook inspector this eventual-consistency tradeoff is acceptable and documented.
  await env.RELAY_STORE.put(eventKey(binId, eventId), JSON.stringify(event), {
    expirationTtl: ttlSeconds,
  });

  // Update event list
  const eventIds = await getEventIds(binId, env);
  eventIds.unshift(eventId);
  await env.RELAY_STORE.put(eventListKey(binId), JSON.stringify(eventIds.slice(0, maxEvents)), {
    expirationTtl: ttlSeconds,
  });

  // Update bin meta event count
  meta.eventCount = eventIds.length;
  await env.RELAY_STORE.put(binMetaKey(binId), JSON.stringify(meta), {
    expirationTtl: ttlSeconds,
  });

  // Broadcast to WebSocket subscribers via DO
  const doId = env.RELAY_DO.idFromName(binId);
  const stub = env.RELAY_DO.get(doId);
  const broadcastUrl = new URL("https://relay-do.internal/broadcast");
  const broadcastHeaders: HeadersInit = { "Content-Type": "application/json" };
  if (env.BROADCAST_SECRET) {
    broadcastHeaders["Authorization"] = `Bearer ${env.BROADCAST_SECRET}`;
  }
  await stub.fetch(broadcastUrl.toString(), {
    method: "POST",
    headers: broadcastHeaders,
    body: JSON.stringify({
      type: "event",
      binId,
      eventId,
      capturedAt,
      method: event.method,
      path: event.path,
      headersCount: Object.keys(headers).length,
      bodyPreview: body.slice(0, 200),
    }),
  });

  return Response.json({ eventId, capturedAt }, { status: 201 });
}

async function handleListEvents(binId: string, env: Env): Promise<Response> {
  const meta = await getBinMeta(binId, env);
  if (!meta) return Response.json({ error: "Bin not found" }, { status: 404 });

  const eventIds = await getEventIds(binId, env);
  const events: CapturedEvent[] = [];

  for (const id of eventIds.slice(0, 100)) {
    const raw = await env.RELAY_STORE.get(eventKey(binId, id));
    if (raw) {
      events.push(JSON.parse(raw) as CapturedEvent);
    }
  }

  return Response.json({ binId, events, total: eventIds.length });
}

async function handleGetEvent(binId: string, eventId: string, env: Env): Promise<Response> {
  const raw = await env.RELAY_STORE.get(eventKey(binId, eventId));
  if (!raw) return Response.json({ error: "Event not found" }, { status: 404 });
  return Response.json(JSON.parse(raw) as CapturedEvent);
}

async function handleReplay(
  binId: string,
  eventId: string,
  request: Request,
  env: Env
): Promise<Response> {
  const raw = await env.RELAY_STORE.get(eventKey(binId, eventId));
  if (!raw) return Response.json({ error: "Event not found" }, { status: 404 });

  const event = JSON.parse(raw) as CapturedEvent;

  // Target URL from request body (required for replay)
  const body = await request.json().catch(() => ({})) as { targetUrl?: string };
  if (!body.targetUrl) {
    return Response.json({ error: "'targetUrl' required in request body" }, { status: 400 });
  }

  // Reconstruct the original request body — Workers-native base64 decode
  let replayBody: BodyInit | undefined;
  if (event.body) {
    if (event.bodyEncoding === "base64") {
      const binaryString = atob(event.body);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      replayBody = bytes;
    } else {
      replayBody = event.body;
    }
  }

  // Filter hop-by-hop headers
  const hopByHop = new Set(["host", "connection", "transfer-encoding", "upgrade", "keep-alive"]);
  const replayHeaders: HeadersInit = {};
  for (const [key, value] of Object.entries(event.headers)) {
    if (!hopByHop.has(key.toLowerCase())) {
      replayHeaders[key] = value;
    }
  }

  let replayResponse: Response;
  try {
    replayResponse = await fetch(body.targetUrl, {
      method: event.method,
      headers: replayHeaders,
      body: replayBody,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Network error (DNS failure, connection refused, timeout, etc.)
    const errorMsg = err instanceof Error ? err.message : "Network error during replay";
    return Response.json(
      { eventId, targetUrl: body.targetUrl, error: errorMsg, replayOk: false },
      { status: 502 }
    );
  }

  return Response.json({
    eventId,
    targetUrl: body.targetUrl,
    replayStatusCode: replayResponse.status,
    replayOk: replayResponse.ok,
  });
}

async function handleTail(binId: string, request: Request, env: Env): Promise<Response> {
  // Proxy the WebSocket upgrade to the RelayDO for this bin
  const doId = env.RELAY_DO.idFromName(binId);
  const stub = env.RELAY_DO.get(doId);

  const doUrl = new URL(request.url);
  doUrl.hostname = "relay-do.internal";
  doUrl.pathname = "/ws";
  doUrl.searchParams.set("binId", binId);

  return stub.fetch(
    new Request(doUrl.toString(), {
      method: "GET",
      headers: request.headers,
    })
  );
}

async function handleInspectorUI(binId: string, env: Env): Promise<Response> {
  const meta = await getBinMeta(binId, env);
  if (!meta) {
    return new Response("<h1>Bin not found</h1>", {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
  }

  const safeBinId = escapeHtml(binId);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Bin ${safeBinId} — Webhook Relay</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #1e293b; }
    h1 { font-size: 1.4rem; }
    .meta { color: #64748b; font-size: 0.9rem; margin-bottom: 1.5rem; }
    #events { list-style: none; padding: 0; }
    #events li { background: #f8fafc; border: 1px solid #e2e8f0; padding: 0.75rem 1rem; margin-bottom: 0.5rem; border-radius: 0.4rem; font-family: monospace; font-size: 0.85rem; }
    #ws-status { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 999px; font-size: 0.8rem; background: #fef2f2; color: #dc2626; }
    #ws-status.connected { background: #f0fdf4; color: #16a34a; }
    .capture-url { background: #f1f5f9; padding: 0.5rem 0.75rem; border-radius: 0.3rem; font-family: monospace; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Bin: ${safeBinId}</h1>
  <div class="meta">
    Created: ${escapeHtml(meta.createdAt)} · Expires: ${escapeHtml(meta.expiresAt)} · Events: <span id="count">${meta.eventCount}</span>
  </div>
  <p>Capture URL: <span class="capture-url">${"<!-- injected by js -->"}</span></p>
  <p>Live tail: <span id="ws-status">Disconnected</span></p>
  <ul id="events"><li>Loading events...</li></ul>

  <script>
    const binId = ${JSON.stringify(binId)};
    const origin = location.origin;
    document.querySelector('.capture-url').textContent = origin + '/bins/' + binId + '/capture';

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
    async function loadEvents() {
      const res = await fetch('/bins/' + binId + '/events');
      const data = await res.json();
      document.getElementById('count').textContent = data.total;
      const ul = document.getElementById('events');
      if (data.events.length === 0) {
        ul.innerHTML = '<li>No events yet. Send a request to the capture URL.</li>';
        return;
      }
      ul.innerHTML = data.events.map(e =>
        '<li>[' + escHtml(e.capturedAt) + '] ' + escHtml(e.method) + ' ' + escHtml(e.path) + ' (' + escHtml(e.id) + ')</li>'
      ).join('');
    }

    // WebSocket live tail
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/bins/' + binId + '/tail');
    const statusEl = document.getElementById('ws-status');

    ws.onopen = () => { statusEl.textContent = 'Connected'; statusEl.classList.add('connected'); };
    ws.onclose = () => { statusEl.textContent = 'Disconnected'; statusEl.classList.remove('connected'); };
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'event') {
        loadEvents();
      }
    };

    loadEvents();
    setInterval(loadEvents, 10000);  // refresh every 10s as fallback
  </script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

async function getBinMeta(binId: string, env: Env): Promise<BinMeta | null> {
  const raw = await env.RELAY_STORE.get(binMetaKey(binId));
  return raw ? (JSON.parse(raw) as BinMeta) : null;
}

async function getEventIds(binId: string, env: Env): Promise<string[]> {
  const raw = await env.RELAY_STORE.get(eventListKey(binId));
  return raw ? (JSON.parse(raw) as string[]) : [];
}
