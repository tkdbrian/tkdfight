import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import { afterEach, expect, it, vi } from "vitest";

let directory: string | null = null;
let database: typeof import("../db/index.js") | null = null;
let httpServer: ReturnType<typeof createServer> | null = null;
let socketServer: Server | null = null;
let base = "";

afterEach(async () => {
  if (socketServer) await new Promise<void>((resolve) => socketServer?.close(() => resolve()));
  if (httpServer?.listening) await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  database?.default.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
  database = null;
  httpServer = null;
  socketServer = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function setup(): Promise<typeof import("../db/index.js")> {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-last-confirmed-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  database = await import("../db/index.js");
  const { state } = await import("../state.js");
  const { registerRingRoute } = await import("./ring.js");
  state.activeTournamentId = database.createTournament("Initial", "");
  const app = express();
  app.use(express.json());
  httpServer = createServer(app);
  socketServer = new Server(httpServer);
  registerRingRoute(app, socketServer);
  await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  return database;
}

function category(db: typeof import("../db/index.js"), categoryId: string): number {
  return db.resolveCategoryTournament({
    categoryId,
    tournamentName: categoryId,
    categoryName: categoryId,
  }).tournamentId;
}

function fight(
  db: typeof import("../db/index.js"),
  categoryId: string,
  tournamentId: number,
  fightId: string,
  reason: string,
  options: { confirmed?: boolean; at?: string; groupId?: string; sourceRing?: string } = {},
): void {
  const redId = `${fightId}-red`;
  const blueId = `${fightId}-blue`;
  db.upsertCompetitor({ id: redId, tournament_id: tournamentId, name: `Red ${fightId}` });
  db.upsertCompetitor({ id: blueId, tournament_id: tournamentId, name: `Blue ${fightId}` });
  db.upsertFight({
    id: fightId,
    tournament_id: tournamentId,
    red_id: redId,
    blue_id: blueId,
    group_id: options.groupId,
    source_ring: options.sourceRing,
  });
  const result = {
    fightId,
    categoryId,
    tournamentId,
    winner: "red" as const,
    reason,
    flagsRed: 4,
    flagsBlue: 0,
    warningsRed: 0,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 0,
  };
  db.savePendingMatchResult(result);
  if (options.confirmed) {
    db.confirmMatchResult(result);
    if (options.at) db.default.prepare("UPDATE match_results SET confirmed_at = ? WHERE fight_id = ?")
      .run(options.at, fightId);
  }
}

async function latest(categoryId: string): Promise<Response> {
  return fetch(`${base}/api/ring/categories/${encodeURIComponent(categoryId)}/last-confirmed`);
}

it("returns no evidence for a category without confirmed fights and rejects an unknown category", async () => {
  const db = await setup();
  category(db, "empty");
  expect(await (await latest("empty")).json()).toEqual({ ok: true, last: null, ambiguous: false });
  const missing = await latest("missing");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "category_not_found" });
});

it("returns the canonical pair for the newest confirmed result, including DQ, jury, playoff and imported fights", async () => {
  const db = await setup();
  const id = category(db, "category-a");
  fight(db, "category-a", id, "normal", "points", { confirmed: true, at: "2026-01-01 10:00:00" });
  fight(db, "category-a", id, "dq", "disqualification", { confirmed: true, at: "2026-01-01 10:01:00" });
  fight(db, "category-a", id, "jury", "jury", { confirmed: true, at: "2026-01-01 10:02:00" });
  fight(db, "category-a", id, "playoff", "points", {
    confirmed: true, at: "2026-01-01 10:03:00", groupId: "playoff",
  });
  fight(db, "category-a", id, "imported", "points", {
    confirmed: true, at: "2026-01-01 10:04:00", sourceRing: "remote-ring",
  });
  fight(db, "category-a", id, "pending", "points");
  db.default.prepare("UPDATE match_results SET created_at = ? WHERE fight_id = ?")
    .run("2026-12-31 23:59:59", "pending");
  const response = await latest("category-a");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    last: {
      fightId: "imported",
      categoryId: "category-a",
      redId: "imported-red",
      blueId: "imported-blue",
      confirmedAt: "2026-01-01 10:04:00",
    },
    ambiguous: false,
  });
  for (const [removed, expected] of [
    ["imported", "playoff"],
    ["playoff", "jury"],
    ["jury", "dq"],
    ["dq", "normal"],
  ]) {
    db.default.prepare("DELETE FROM match_results WHERE fight_id = ?").run(removed);
    const body = await (await latest("category-a")).json() as { last: { fightId: string } | null };
    expect(body.last?.fightId).toBe(expected);
  }
});

it("never borrows a newer result from another category or a completed structural bye", async () => {
  const db = await setup();
  const a = category(db, "category-a");
  const b = category(db, "category-b");
  fight(db, "category-a", a, "a", "points", { confirmed: true, at: "2026-01-01 10:00:00" });
  fight(db, "category-b", b, "b", "points", { confirmed: true, at: "2026-01-01 11:00:00" });
  db.upsertFight({ id: "bye", tournament_id: a, red_id: "a-red", blue_id: "a-blue", completed: true });
  expect(await (await latest("category-a")).json()).toMatchObject({
    last: { fightId: "a", redId: "a-red", blueId: "a-blue" }, ambiguous: false,
  });
});

it("declares equal most-recent second timestamps ambiguous and does not mutate on lookup or retry", async () => {
  const db = await setup();
  const id = category(db, "category-a");
  fight(db, "category-a", id, "earlier", "points", {
    confirmed: true, at: "2026-01-01 09:00:00",
  });
  fight(db, "category-a", id, "tied-a", "points", {
    confirmed: true, at: "2026-01-01 10:00:00",
  });
  fight(db, "category-a", id, "tied-b", "points", {
    confirmed: true, at: "2026-01-01 10:00:00",
  });
  const before = db.default.prepare("SELECT total_changes() AS n").get() as { n: number };
  expect(await (await latest("category-a")).json()).toEqual({
    ok: true, last: null, ambiguous: true,
  });
  const after = db.default.prepare("SELECT total_changes() AS n").get() as { n: number };
  expect(after.n).toBe(before.n);
  const input = db.getMatchResult("category-a", "earlier");
  expect(input).not.toBeNull();
  db.confirmMatchResult(input!);
  expect(await (await latest("category-a")).json()).toEqual({
    ok: true, last: null, ambiguous: true,
  });
  expect(db.default.prepare("SELECT confirmed_at FROM match_results WHERE fight_id = ?")
    .get("earlier")).toEqual({ confirmed_at: "2026-01-01 09:00:00" });
});
