import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import { io as createClient, type Socket } from "socket.io-client";
import { afterEach, expect, it, vi } from "vitest";
import { generateGroupsTournament } from "../../src/lib/bracket";
import type {
  CategoryDeletionPreview,
  CategoryDeletionReceipt,
} from "../../src/lib/category-deletion-contract";
import type { CategoryRestartSnapshot } from "../../src/lib/category-restart-contract";
import baselineRules from "../../src/rules/rules/rules_sparring_itf_baseline.json";

let directory: string | null = null;
let db: typeof import("../db/index.js") | null = null;
let io: Server | null = null;
let client: Socket | null = null;
afterEach(async () => {
  client?.disconnect();
  if (io) await new Promise<void>((resolve) => io?.close(() => resolve()));
  db?.default.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
  db = null;
  io = null;
  client = null;
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
      categoryName: "Prueba",
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
async function setup() {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-delete-http-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  db = await import("../db/index.js");
  const { state } = await import("../state.js");
  const { registerRingRoute } = await import("./ring.js");
  const { registerHistoryRoute } = await import("./history.js");
  const { registerCategoryRestartBodyParser } = await import("./category-restart.js");
  const { registerCategoryDeletionBodyParser } = await import("./category-deletion.js");
  const { registerSocketHandlers } = await import("../socket/handlers.js");
  const app = express();
  registerCategoryRestartBodyParser(app);
  registerCategoryDeletionBodyParser(app);
  app.use(express.json({ limit: "100kb" }));
  const server = createServer(app);
  io = new Server(server);
  registerRingRoute(app, io);
  registerHistoryRoute(app);
  registerSocketHandlers(io);
  state.activeTournamentId = db.createTournament("Idle", "");
  db.setSelectedTournamentId(state.activeTournamentId);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const raw = (route: string, body: string): Promise<Response> =>
    fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const post = (route: string, body: unknown): Promise<Response> =>
    raw(route, JSON.stringify(body));
  return {
    database: db,
    state,
    post,
    raw,
    base,
    preview: async (snapshot: CategoryRestartSnapshot) => {
      const response = await post(`/api/ring/categories/${snapshot.config.id}/deletion-preview`, {
        localSnapshot: snapshot,
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<CategoryDeletionPreview>;
    },
  };
}
function ack(socket: Socket, event: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) =>
    socket
      .timeout(1000)
      .emit(event, payload, (error: Error | null, result: Record<string, unknown>) =>
        error ? reject(error) : resolve(result)
      )
  );
}

it("confirms exact receipt/history/status/tombstone propagation and denies stale HTTP/socket resurrection", async () => {
  const { database, state, post, base, preview } = await setup();
  const source = graph();
  const current = graph();
  const archive = database.restartCategoryExecution({
    requestId: randomUUID(),
    categoryId: source.config.id,
    previousSnapshot: source,
    replacementSnapshot: current,
  });
  state.activeTournamentId = archive.archive.replacementTournamentId;
  database.setSelectedTournamentId(state.activeTournamentId);
  client = createClient(base, { transports: ["websocket"], forceNew: true });
  await new Promise<void>((resolve) => client?.once("connect", resolve));
  const deletionEvent = new Promise<unknown>((resolve) =>
    client?.once("category:deleted", resolve)
  );
  const stateEvent = new Promise<Record<string, unknown>>((resolve) =>
    client?.once("state:update", resolve)
  );
  const before = await preview(current);
  const input = {
    requestId: randomUUID(),
    expectedRevision: before.revision,
    localSnapshot: current,
  };
  const response = await post(`/api/ring/categories/${current.config.id}/delete`, input);
  expect(response.status).toBe(200);
  const receipt = (await response.json()) as CategoryDeletionReceipt;
  expect(await deletionEvent).toEqual(receipt);
  expect(await stateEvent).toMatchObject({
    categoryId: null,
    match: null,
    categoryDeletions: [
      { categoryId: current.config.id, requestId: receipt.requestId, deletedAt: receipt.deletedAt },
    ],
  });
  expect(
    await (await fetch(`${base}/api/ring/categories/${current.config.id}/deletion`)).json()
  ).toEqual(receipt);
  const history = (await (await fetch(`${base}/api/history`)).json()) as Array<
    Record<string, unknown>
  >;
  expect(history.some((item) => item.id === receipt.tournamentId)).toBe(false);
  expect(history.find((item) => item.id === archive.archive.sourceTournamentId)).toMatchObject({
    fullSnapshot: source,
    replacementDeleted: { categoryId: current.config.id },
  });
  const stats = (await (await fetch(`${base}/api/stats`)).json()) as {
    overview: { totalTournaments: number };
  };
  expect(stats.overview.totalTournaments).toBe(2);
  expect((await fetch(`${base}/api/ring/categories/${source.config.id}/replacement`)).status).toBe(
    410
  );
  for (const [route, body] of [
    [
      "activate-category",
      { categoryId: current.config.id, categoryName: "X", tournamentName: "X" },
    ],
    [
      "sync-fights",
      {
        categoryId: current.config.id,
        categoryName: "X",
        tournamentName: "X",
        competitors: [],
        fights: [],
      },
    ],
    [
      "import-fights",
      {
        fights: [
          {
            id: current.fights[0].id,
            red_id: current.fights[0].red.id,
            blue_id: current.fights[0].blue.id,
          },
        ],
        competitors: [],
      },
    ],
    ["remote-result", { fightId: current.fights[0].id, winner: "red" }],
    ["remove-fights", { ids: [current.fights[0].id] }],
    ["full-reset", {}],
  ] as Array<[string, object]>) {
    const result = await post(`/api/ring/${route}`, body);
    expect(result.status, route).toBe(410);
    expect(await result.json()).toMatchObject({ error: "category_deleted", deletion: receipt });
  }
  expect(
    await ack(client, "match:load", {
      categoryId: randomUUID(),
      tournamentName: "X",
      rules: baselineRules,
      match: {
        id: current.fights[0].id,
        ringId: "T1",
        red: current.fights[0].red,
        blue: current.fights[0].blue,
      },
    })
  ).toMatchObject({ ok: false, code: "category_deleted", deletion: receipt });
  expect(
    await ack(client, "match:saveFallo", {
      categoryId: current.config.id,
      matchId: current.fights[0].id,
      expectedRevision: 0,
    })
  ).toMatchObject({ code: "category_deleted", deletion: receipt });
  const fresh = graph();
  expect(
    (
      await post("/api/ring/activate-category", {
        categoryId: fresh.config.id,
        categoryName: fresh.config.categoryName,
        tournamentName: fresh.config.tournamentName,
      })
    ).status
  ).toBe(200);
  expect(state.activeTournamentId).not.toBe(receipt.tournamentId);
  expect((await fetch(`${base}/api/history`, { method: "DELETE" })).status).toBe(200);
  expect(database.getCategoryDeletion(current.config.id)).toEqual(receipt);
});

it("rechecks global idle lock/race and preserves own confirmed memory+snapshot until successful commit", async () => {
  const { database, state, post, preview } = await setup();
  const current = graph();
  const id = database.resolveCategoryTournament({
    categoryId: current.config.id,
    categoryName: "Prueba",
    tournamentName: "Evento",
  }).tournamentId;
  for (const c of current.competitors) database.upsertCompetitor({ ...c, tournament_id: id });
  for (const f of current.fights)
    database.insertFightIfNew({
      id: f.id,
      tournament_id: id,
      red_id: f.red.id,
      blue_id: f.blue.id,
    });
  const fight = current.fights[0];
  database.confirmMatchResult({
    fightId: fight.id,
    categoryId: current.config.id,
    tournamentId: id,
    winner: "red",
    reason: "points",
    flagsRed: 3,
    flagsBlue: 0,
    warningsRed: 0,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 0,
  });
  Object.assign(fight, { completed: true, winner: "red", flagsRed: 3 });
  database.saveMatchSnapshot(
    fight.id,
    id,
    { match: {}, rules: {}, roundFlags: [] },
    current.config.id
  );
  state.match = { id: fight.id, ringId: "T1", red: fight.red, blue: fight.blue };
  state.matchCategoryId = current.config.id;
  state.matchTournamentId = id;
  state.resultConfirmed = true;
  state.activeTournamentId = id;
  database.setSelectedTournamentId(id);
  const prepared = await preview(current);
  const input = {
    requestId: randomUUID(),
    expectedRevision: prepared.revision,
    localSnapshot: current,
  };
  state.resultConfirmed = false;
  expect((await post(`/api/ring/categories/${current.config.id}/delete`, input)).status).toBe(409);
  state.resultConfirmed = true;
  database.default.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON category_execution_deletions BEGIN SELECT RAISE(ABORT, 'fail'); END"
  );
  expect((await post(`/api/ring/categories/${current.config.id}/delete`, input)).status).toBe(500);
  expect(state.match?.id).toBe(fight.id);
  expect(database.loadMatchSnapshot()?.fightId).toBe(fight.id);
  expect(database.getSelectedTournamentId()).toBe(id);
  database.default.exec("DROP TRIGGER fail_receipt");
  expect((await post(`/api/ring/categories/${current.config.id}/delete`, input)).status).toBe(200);
  expect(state.match).toBeNull();
  expect(state.matchCategoryId).toBeNull();
  expect(database.loadMatchSnapshot()).toBeNull();
  expect(database.getSelectedTournamentId()).toBeNull();
});

it("applies2MiB only to both deletion POSTs and malformed/path-mismatch/race/oversize never mutate", async () => {
  const { database, post, raw, preview } = await setup();
  const current = graph();
  current.fights.push(
    ...Array.from({ length: 35 }, () => ({
      ...current.fights[0],
      id: randomUUID(),
      winReason: "x".repeat(4000),
    }))
  );
  expect(JSON.stringify(current).length).toBeGreaterThan(100 * 1024);
  const prepared = await preview(current);
  const before = database.default.prepare("SELECT * FROM tournaments").all();
  const path = `/api/ring/categories/${current.config.id}`;
  expect((await raw(`${path}/delete`, "{")).status).toBe(400);
  expect(
    (await post(`${path}/deletion-preview`, { padding: "x".repeat(2 * 1024 * 1024) })).status
  ).toBe(413);
  expect((await post(`${path}/delete`, { padding: "x".repeat(2 * 1024 * 1024) })).status).toBe(413);
  expect(
    (await post("/api/ring/categories/wrong/deletion-preview", { localSnapshot: current })).status
  ).toBe(400);
  expect(
    (
      await post(`${path}/delete`, {
        requestId: randomUUID(),
        expectedRevision: "f".repeat(64),
        localSnapshot: current,
      })
    ).status
  ).toBe(409);
  expect((await post("/api/ring/sync-fights", { padding: "x".repeat(101 * 1024) })).status).toBe(
    413
  );
  expect(database.default.prepare("SELECT * FROM tournaments").all()).toEqual(before);
  expect(
    (
      await post(`${path}/delete`, {
        requestId: randomUUID(),
        expectedRevision: prepared.revision,
        localSnapshot: current,
      })
    ).status
  ).toBe(200);
});
