import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import { afterEach, expect, it, vi } from "vitest";
import { generateGroupsTournament } from "../../src/lib/bracket";
import type {
  CategoryRestartSnapshot,
  RestartCategoryRequest,
  RestartCategorySuccess,
} from "../../src/lib/category-restart-contract";

let directory: string | null = null;
let database: typeof import("../db/index.js") | null = null;
let io: Server | null = null;
afterEach(async () => {
  if (io) await new Promise<void>((resolve) => io?.close(() => resolve()));
  database?.default.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  io = null;
  database = null;
  directory = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});
function graph(): CategoryRestartSnapshot {
  const competitors = ["Uno", "Dos", "Tres"].map((name) => ({ id: randomUUID(), name }));
  return {
    phase: "fighting",
    config: {
      id: randomUUID(),
      eventId: "event",
      tournamentName: "Evento",
      categoryName: "Categoría",
      tableChief: "Mesa",
      ruleSet: null,
      judgesCount: 3,
      mode: "round-robin",
      matchType: "sparring",
    },
    competitors,
    ...generateGroupsTournament(competitors),
    currentFightIndex: 0,
    bracketMatches: [],
    bracketSeeds: [],
    setupStarted: true,
  };
}
function request(): RestartCategoryRequest {
  const previousSnapshot = graph();
  return {
    requestId: randomUUID(),
    categoryId: previousSnapshot.config.id,
    previousSnapshot,
    replacementSnapshot: graph(),
  };
}
async function setup(): Promise<{
  db: typeof import("../db/index.js");
  state: typeof import("../state.js").state;
  post: (route: string, body: unknown) => Promise<Response>;
  get: (route: string) => Promise<Response>;
  remove: (route: string) => Promise<Response>;
  raw: (route: string, body: string) => Promise<Response>;
}> {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-restart-http-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  const db = await import("../db/index.js");
  database = db;
  const { state } = await import("../state.js");
  const { registerRingRoute } = await import("./ring.js");
  const { registerHistoryRoute } = await import("./history.js");
  const { registerCategoryRestartBodyParser } = await import("./category-restart.js");
  const app = express();
  registerCategoryRestartBodyParser(app);
  app.use(express.json());
  const server = createServer(app);
  io = new Server(server);
  registerRingRoute(app, io);
  registerHistoryRoute(app);
  state.activeTournamentId = db.createTournament("Empty", "");
  db.setSelectedTournamentId(state.activeTournamentId);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const raw = (route: string, body: string): Promise<Response> =>
    fetch(`${base}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  return {
    db,
    state,
    raw,
    post: (route, body) => raw(route, JSON.stringify(body)),
    get: (route) => fetch(`${base}${route}`),
    remove: (route) => fetch(`${base}${route}`, { method: "DELETE" }),
  };
}

it("publishes canonical POST/lookup/history, protects both generations, and preserves official stats", async () => {
  const { db, state, post, get, remove } = await setup();
  const input = request();
  const beforeStats = (await (await get("/api/stats")).json()) as {
    overview: { completedFights: number };
  };
  const response = await post("/api/ring/restart-category", input);
  expect(response.status).toBe(200);
  const result = (await response.json()) as RestartCategorySuccess;
  expect(result).toMatchObject({
    ok: true,
    requestId: input.requestId,
    replacementSnapshot: input.replacementSnapshot,
  });
  expect(await (await get(`/api/ring/categories/${input.categoryId}/replacement`)).json()).toEqual(
    result
  );
  expect(await (await post("/api/ring/restart-category", input)).json()).toEqual(result);
  expect((await get("/api/ring/categories/unknown/replacement")).status).toBe(404);
  const history = (await (await get("/api/history")).json()) as Array<Record<string, unknown>>;
  expect(history.find((item) => item.id === result.archive.sourceTournamentId)).toMatchObject({
    readOnly: true,
    archive: result.archive,
    fullSnapshot: input.previousSnapshot,
  });
  for (const id of [result.archive.sourceTournamentId, result.archive.replacementTournamentId]) {
    expect((await remove(`/api/history/${id}`)).status).toBe(409);
  }
  expect((await remove("/api/history")).status).toBe(200);
  expect(db.getTournament(result.archive.sourceTournamentId)).toBeDefined();
  expect(db.getTournament(result.archive.replacementTournamentId)).toBeDefined();
  expect(state.activeTournamentId).not.toBe(result.archive.sourceTournamentId);
  const afterStats = (await (await get("/api/stats")).json()) as typeof beforeStats;
  expect(afterStats.overview.completedFights).toBe(beforeStats.overview.completedFights);
});

it("bounds only restart JSON at 2MiB, accepts >100kb valid archives, and malformed/oversize is nonmutating", async () => {
  const { db, state, post, raw } = await setup();
  const input = request();
  const original = input.previousSnapshot.fights[0];
  input.previousSnapshot.fights.push(
    ...Array.from({ length: 35 }, () => ({
      ...original,
      id: randomUUID(),
      completed: true,
      winner: "red" as const,
      winReason: "x".repeat(4000),
    }))
  );
  expect(JSON.stringify(input).length).toBeGreaterThan(100 * 1024);
  expect((await post("/api/ring/restart-category", input)).status).toBe(200);
  const before = db.default.prepare("SELECT * FROM tournaments").all();
  const selected = state.activeTournamentId;
  expect((await raw("/api/ring/restart-category", "{")).status).toBe(400);
  expect(
    (await post("/api/ring/restart-category", { padding: "x".repeat(2 * 1024 * 1024) })).status
  ).toBe(413);
  expect((await post("/api/ring/config", { padding: "x".repeat(101 * 1024) })).status).toBe(413);
  expect((await post("/api/ring/restart-category", { ...request(), unknown: true })).status).toBe(
    400
  );
  expect(db.default.prepare("SELECT * FROM tournaments").all()).toEqual(before);
  expect(state.activeTournamentId).toBe(selected);
});

it("blocks another category's memory idle/pending and legacy locks; clears confirmed remnants only after commit", async () => {
  const { db, state, post } = await setup();
  const input = request();
  state.match = {
    id: "loaded-other",
    ringId: "T1",
    red: { id: "r", name: "R" },
    blue: { id: "b", name: "B" },
  };
  state.matchCategoryId = "other";
  state.resultConfirmed = false;
  expect((await post("/api/ring/restart-category", input)).status).toBe(409);
  expect(state.match?.id).toBe("loaded-other");
  state.resultConfirmed = true;
  db.default.exec(
    "CREATE TRIGGER fail_restart BEFORE INSERT ON category_execution_archives BEGIN SELECT RAISE(ABORT, 'fail'); END"
  );
  expect((await post("/api/ring/restart-category", input)).status).toBe(500);
  expect(state.match?.id).toBe("loaded-other");
  db.default.exec("DROP TRIGGER fail_restart");
  const activeId = state.activeTournamentId;
  expect((await post("/api/ring/restart-category", input)).status).toBe(200);
  expect(state.match).toBeNull();
  expect(state.activeTournamentId).toBe(activeId);
  db.saveMatchSnapshot("legacy", activeId, { match: {}, rules: {}, roundFlags: [] });
  expect((await post("/api/ring/restart-category", request())).status).toBe(409);
});

it("rejects archived mutation routes and legacy owner collisions before writes or broadcasts", async () => {
  const { db, state, post } = await setup();
  const input = request();
  const old = input.previousSnapshot;
  const source = db.resolveCategoryTournament({
    categoryId: input.categoryId,
    tournamentName: old.config.tournamentName,
    categoryName: old.config.categoryName,
  });
  for (const entry of old.competitors)
    db.upsertCompetitor({ ...entry, tournament_id: source.tournamentId });
  for (const fight of old.fights)
    db.upsertFight({
      id: fight.id,
      tournament_id: source.tournamentId,
      red_id: fight.red.id,
      blue_id: fight.blue.id,
    });
  state.activeTournamentId = source.tournamentId;
  db.setSelectedTournamentId(source.tournamentId);
  const response = await post("/api/ring/restart-category", input);
  expect(response.status).toBe(200);
  const result = (await response.json()) as RestartCategorySuccess;
  expect(state.activeTournamentId).toBe(result.archive.replacementTournamentId);
  const payload = {
    categoryId: input.categoryId,
    categoryName: old.config.categoryName,
    tournamentName: old.config.tournamentName,
    competitors: old.competitors,
    fights: old.fights.map((fight) => ({
      id: fight.id,
      red_id: fight.red.id,
      blue_id: fight.blue.id,
    })),
  };
  const mutations: Array<[string, object]> = [
    ["activate-category", payload],
    ["sync-fights", payload],
    ["import-fights", { ...payload, newCategory: true }],
    ["remove-fights", { categoryId: input.categoryId, ids: old.fights.map((fight) => fight.id) }],
    ["remote-result", { categoryId: input.categoryId, fightId: old.fights[0].id, winner: "red" }],
    ["remote-result", { fightId: old.fights[0].id, winner: "red" }],
    ["import-fights", { fights: payload.fights, competitors: payload.competitors }],
  ];
  const before = db.getFights(source.tournamentId);
  for (const [route, body] of mutations) {
    const rejected = await post(`/api/ring/${route}`, body);
    expect(rejected.status, route).toBe(409);
    expect(await rejected.json(), route).toMatchObject({
      error: "category_archived",
      replacementCategoryId: result.replacementCategoryId,
    });
  }
  state.activeTournamentId = source.tournamentId;
  expect((await post("/api/ring/full-reset", {})).status).toBe(409);
  expect((await post("/api/ring/remove-fights", { ids: [old.fights[0].id] })).status).toBe(409);
  expect(db.getFights(source.tournamentId)).toEqual(before);
});
