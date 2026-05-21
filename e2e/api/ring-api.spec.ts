/**
 * E2E tests: TKD Ring API — CORS headers and endpoints.
 *
 * CORS tests use Playwright's request fixture (not Node's native fetch) to avoid
 * a libuv crash on Windows / Node.js 24 when fetch() is used with an Origin header.
 *
 * Prerequisite: T2 server running  ->  $env:PORT="3002"; $env:DATA_DIR="./data-t2"; npx tsx server/index.ts
 */
import { test, expect } from "@playwright/test";

const T2 = "http://localhost:3002";
const ORIGIN = "http://localhost:3001"; // Mesa Central origin

// ── CORS ─────────────────────────────────────────────────────────────────────

test("GET /api/ring/queue returns CORS header allowing cross-origin access", async ({ request }) => {
  const res = await request.get(`${T2}/api/ring/queue`, {
    headers: { Origin: ORIGIN },
  });
  expect(res.ok()).toBe(true);
  const acao = res.headers()["access-control-allow-origin"];
  // Server echoes the request Origin when allowed, or returns "*" for anonymous requests
  expect(acao === "*" || acao === ORIGIN).toBe(true);
});

test("OPTIONS preflight for /api/ring/queue returns 200", async ({ request }) => {
  const res = await request.fetch(`${T2}/api/ring/queue`, {
    method: "OPTIONS",
    headers: {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  expect(res.status()).toBe(204);
  const headers = res.headers();
  expect(headers["access-control-allow-methods"]).toMatch(/GET/i);
});

test("GET /api/ring/status returns CORS header", async ({ request }) => {
  const res = await request.get(`${T2}/api/ring/status`, {
    headers: { Origin: ORIGIN },
  });
  expect(res.ok()).toBe(true);
  const acao = res.headers()["access-control-allow-origin"];
  expect(acao === "*" || acao === ORIGIN).toBe(true);
});

// ── Endpoints ─────────────────────────────────────────────────────────────────

test("GET /api/ring/status returns ip and port", async () => {
  const res = await fetch(`${T2}/api/ring/status`);
  expect(res.ok).toBe(true);
  const data = await res.json() as { ip: string; port: number };
  expect(typeof data.ip).toBe("string");
  expect(data.ip.length).toBeGreaterThan(0);
  expect(data.port).toBe(3002);
});

test("GET /api/ring/queue returns an array", async () => {
  const res = await fetch(`${T2}/api/ring/queue`);
  expect(res.ok).toBe(true);
  const data = await res.json();
  expect(Array.isArray(data)).toBe(true);
});

test("POST /api/ring/sync-fights with valid payload returns ok", async () => {
  const payload = {
    competitors: [
      { id: "e2e-red-1", name: "Red Test", weight: null, belt: null, team: null },
      { id: "e2e-blue-1", name: "Blue Test", weight: null, belt: null, team: null },
    ],
    fights: [
      {
        id: "e2e-fight-1",
        red: { id: "e2e-red-1", name: "Red Test" },
        blue: { id: "e2e-blue-1", name: "Blue Test" },
        category: "E2E Test Category",
        completed: false,
        winner: null,
        reason: null,
        round_index: null,
        group_id: null,
      },
    ],
  };
  const res = await fetch(`${T2}/api/ring/sync-fights`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(payload),
  });
  expect(res.ok).toBe(true);
  const data = await res.json() as { ok: boolean };
  expect(data.ok).toBe(true);
});
