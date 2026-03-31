/**
 * webhook-relay tests
 *
 * Tests bin creation, event capture, list, replay, and spec-alias routes.
 * WebSocket live tail is validated via unit-level DO test and
 * end-to-end via live wscat testing per MJ review checklist.
 */

import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const BASE = "http://webhook-relay.workers.dev";

// ---------------------------------------------------------------------------
// Bin lifecycle
// ---------------------------------------------------------------------------

describe("Bin creation", () => {
  it("POST /bins returns 201 with binId and hookUrl", async () => {
    const res = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { binId: string; createdAt: string; expiresAt: string; hookUrl: string };
    expect(typeof body.binId).toBe("string");
    expect(body.binId.length).toBeGreaterThan(0);
    expect(typeof body.createdAt).toBe("string");
    expect(typeof body.expiresAt).toBe("string");
    // Spec: POST /bins returns a unique URL like /hook/{binId}
    expect(typeof body.hookUrl).toBe("string");
    expect(body.hookUrl).toContain(`/hook/${body.binId}`);
  });
});

// ---------------------------------------------------------------------------
// Event capture (canonical)
// ---------------------------------------------------------------------------

describe("Event capture", () => {
  it("captures a POST event and returns eventId", async () => {
    // Create bin first
    const binRes = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    const { binId } = (await binRes.json()) as { binId: string };

    // Capture an event
    const captureRes = await SELF.fetch(`${BASE}/bins/${binId}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Custom-Header": "hello" },
      body: JSON.stringify({ foo: "bar", action: "test" }),
    });
    expect(captureRes.status).toBe(201);
    const body = (await captureRes.json()) as { eventId: string; capturedAt: string };
    expect(typeof body.eventId).toBe("string");
    expect(typeof body.capturedAt).toBe("string");
  });

  it("stored event appears in GET /bins/:id/events", async () => {
    const binRes = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    const { binId } = (await binRes.json()) as { binId: string };

    // Capture two events
    await SELF.fetch(`${BASE}/bins/${binId}/capture`, {
      method: "POST",
      body: "event-one",
    });
    await SELF.fetch(`${BASE}/bins/${binId}/capture`, {
      method: "PUT",
      body: "event-two",
    });

    const listRes = await SELF.fetch(`${BASE}/bins/${binId}/events`);
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { events: Array<{ method: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.events.length).toBe(2);
    const methods = body.events.map((e) => e.method);
    expect(methods).toContain("POST");
    expect(methods).toContain("PUT");
  });
});

// ---------------------------------------------------------------------------
// Spec alias: ANY /hook/:binId → capture
// ---------------------------------------------------------------------------

describe("ANY /hook/:binId (spec alias for /bins/:binId/capture)", () => {
  it("captures a POST event via /hook/:binId and returns 201 with eventId", async () => {
    const binRes = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    const { binId } = (await binRes.json()) as { binId: string };

    const captureRes = await SELF.fetch(`${BASE}/hook/${binId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "alias-test" }),
    });
    expect(captureRes.status).toBe(201);
    const body = (await captureRes.json()) as { eventId: string; capturedAt: string };
    expect(typeof body.eventId).toBe("string");
    expect(typeof body.capturedAt).toBe("string");
  });

  it("captures a GET event via /hook/:binId and returns 201", async () => {
    const binRes = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    const { binId } = (await binRes.json()) as { binId: string };

    const captureRes = await SELF.fetch(`${BASE}/hook/${binId}`, { method: "GET" });
    expect(captureRes.status).toBe(201);
    const body = (await captureRes.json()) as { eventId: string };
    expect(typeof body.eventId).toBe("string");
  });

  it("alias-captured event appears in GET /bins/:binId/events", async () => {
    const binRes = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    const { binId } = (await binRes.json()) as { binId: string };

    await SELF.fetch(`${BASE}/hook/${binId}`, {
      method: "POST",
      body: "via-hook-alias",
    });

    const listRes = await SELF.fetch(`${BASE}/bins/${binId}/events`);
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  it("returns 404 for unknown bin via /hook/:binId", async () => {
    const res = await SELF.fetch(`${BASE}/hook/non-existent-bin`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Single event retrieval
// ---------------------------------------------------------------------------

describe("GET /bins/:binId/events/:eventId", () => {
  it("retrieves a single event by id", async () => {
    const binRes = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    const { binId } = (await binRes.json()) as { binId: string };

    const captureRes = await SELF.fetch(`${BASE}/bins/${binId}/capture`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello-world",
    });
    const { eventId } = (await captureRes.json()) as { eventId: string };

    const getRes = await SELF.fetch(`${BASE}/bins/${binId}/events/${eventId}`);
    expect(getRes.status).toBe(200);
    const event = (await getRes.json()) as {
      id: string;
      binId: string;
      method: string;
      body: string;
    };
    expect(event.id).toBe(eventId);
    expect(event.binId).toBe(binId);
    expect(event.method).toBe("POST");
    expect(event.body).toBe("hello-world");
  });
});

// ---------------------------------------------------------------------------
// HTML inspector
// ---------------------------------------------------------------------------

describe("GET /bins/:binId", () => {
  it("returns HTML inspector page", async () => {
    const binRes = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    const { binId } = (await binRes.json()) as { binId: string };

    const htmlRes = await SELF.fetch(`${BASE}/bins/${binId}`);
    expect(htmlRes.status).toBe(200);
    const ct = htmlRes.headers.get("Content-Type") ?? "";
    expect(ct).toContain("text/html");
    const text = await htmlRes.text();
    expect(text).toContain(binId);
  });
});

// ---------------------------------------------------------------------------
// Spec alias: GET /bins/:binId/requests → same as /bins/:binId/events
// ---------------------------------------------------------------------------

describe("GET /bins/:binId/requests (spec alias for /events)", () => {
  it("returns same event list as /bins/:binId/events", async () => {
    const binRes = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    const { binId } = (await binRes.json()) as { binId: string };

    await SELF.fetch(`${BASE}/bins/${binId}/capture`, {
      method: "POST",
      body: "alias-requests-test",
    });

    const requestsRes = await SELF.fetch(`${BASE}/bins/${binId}/requests`);
    expect(requestsRes.status).toBe(200);
    const body = (await requestsRes.json()) as { events: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Spec alias: GET /bins/:binId/live → WebSocket upgrade (101)
// ---------------------------------------------------------------------------

describe("GET /bins/:binId/live (spec alias for /tail)", () => {
  it("returns 101 Switching Protocols for WebSocket upgrade", async () => {
    const binRes = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    const { binId } = (await binRes.json()) as { binId: string };

    const wsRes = await SELF.fetch(`${BASE}/bins/${binId}/live`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    expect(wsRes.status).toBe(101);
  });
});

// ---------------------------------------------------------------------------
// Replay endpoint
// ---------------------------------------------------------------------------

describe("POST /bins/:binId/replay/:eventId", () => {
  it("returns 404 for unknown eventId", async () => {
    const binRes = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    const { binId } = (await binRes.json()) as { binId: string };

    const res = await SELF.fetch(`${BASE}/bins/${binId}/replay/nonexistent-event-id-xyz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUrl: "http://webhook-relay.workers.dev/bins/x/capture" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when targetUrl is missing from request body", async () => {
    const binRes = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    const { binId } = (await binRes.json()) as { binId: string };

    // Capture an event first
    const captureRes = await SELF.fetch(`${BASE}/bins/${binId}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const { eventId } = (await captureRes.json()) as { eventId: string };

    // Replay without targetUrl — must get 400
    const replayRes = await SELF.fetch(`${BASE}/bins/${binId}/replay/${eventId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(replayRes.status).toBe(400);
    const body = (await replayRes.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("targetUrl");
  });

  it("returns 502 with error field when target URL is unreachable", async () => {
    // Create bin and capture an event
    const binRes = await SELF.fetch(`${BASE}/bins`, { method: "POST" });
    const { binId } = (await binRes.json()) as { binId: string };

    const captureRes = await SELF.fetch(`${BASE}/bins/${binId}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "replay-network-error-test" }),
    });
    expect(captureRes.status).toBe(201);
    const { eventId } = (await captureRes.json()) as { eventId: string };

    // Replay to an unreachable host — should get 502 with error (not a crash)
    // This exercises the full handleReplay code path: event lookup → body reconstruct
    // → header filter → fetch (fails) → 502 error response
    const replayRes = await SELF.fetch(`${BASE}/bins/${binId}/replay/${eventId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUrl: "http://localhost:19999/unreachable" }),
    });
    expect(replayRes.status).toBe(502);
    const body = (await replayRes.json()) as {
      eventId: string;
      targetUrl: string;
      error: string;
      replayOk: boolean;
    };
    expect(body.eventId).toBe(eventId);
    expect(body.targetUrl).toBe("http://localhost:19999/unreachable");
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.replayOk).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 404 cases
// ---------------------------------------------------------------------------

describe("Error handling", () => {
  it("returns 404 for unknown bin", async () => {
    const res = await SELF.fetch(`${BASE}/bins/non-existent-bin-xyz/events`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown path", async () => {
    const res = await SELF.fetch(`${BASE}/totally-unknown`);
    expect(res.status).toBe(404);
  });
});
