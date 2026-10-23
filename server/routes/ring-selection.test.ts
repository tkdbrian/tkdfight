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

it("persists successful activation and import, but not a rejected switch or sync", async () => {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-ring-selection-test-"));
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
  const address = httpServer.address() as AddressInfo;
  const post = async (route: string, body: object): Promise<Response> => fetch(
    `http://127.0.0.1:${address.port}${route}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );

  const activated = await post("/api/ring/activate-category", {
    categoryId: "category-a", categoryName: "A", tournamentName: "Tournament",
  });
  expect(activated.status).toBe(200);
  const activeId = state.activeTournamentId;
  expect(database.getSelectedTournamentId()).toBe(activeId);

  const synced = await post("/api/ring/sync-fights", {
    categoryId: "category-b", categoryName: "B", tournamentName: "Tournament",
    competitors: [], fights: [],
  });
  expect(synced.status).toBe(200);
  expect(database.getSelectedTournamentId()).toBe(activeId);

  database.saveMatchSnapshot("fight-a", activeId, { match: {}, rules: {}, roundFlags: [] }, "category-a");
  const rejected = await post("/api/ring/activate-category", {
    categoryId: "category-b", categoryName: "B", tournamentName: "Tournament",
  });
  expect(rejected.status).toBe(409);
  expect(database.getSelectedTournamentId()).toBe(activeId);
  database.clearMatchSnapshot();

  const imported = await post("/api/ring/import-fights", {
    categoryId: "category-b", categoryName: "B", tournamentName: "Tournament",
    newCategory: true, competitors: [], fights: [],
  });
  expect(imported.status).toBe(200);
  expect(database.getSelectedTournamentId()).toBe(state.activeTournamentId);
  expect(state.activeTournamentId).not.toBe(activeId);
});

it("shows the previously active queue by default after a server restart", async () => {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-ring-restart-test-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  database = await import("../db/index.js");
  let { state } = await import("../state.js");
  let { registerRingRoute } = await import("./ring.js");
  state.activeTournamentId = database.createTournament("Initial", "");
  let app = express();
  app.use(express.json());
  httpServer = createServer(app);
  socketServer = new Server(httpServer);
  registerRingRoute(app, socketServer);
  await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
  let address = httpServer.address() as AddressInfo;

  const activated = await fetch(`http://127.0.0.1:${address.port}/api/ring/activate-category`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      categoryId: "category-a", categoryName: "A", tournamentName: "Tournament",
    }),
  });
  expect(activated.status).toBe(200);
  const activeId = state.activeTournamentId;
  database.upsertCompetitor({ id: "red-a", tournament_id: activeId, name: "Red" });
  database.upsertCompetitor({ id: "blue-a", tournament_id: activeId, name: "Blue" });
  database.insertFightIfNew({
    id: "fight-a", tournament_id: activeId, red_id: "red-a", blue_id: "blue-a",
  });
  database.createTournament("Newer empty", "B");
  await new Promise<void>((resolve) => socketServer?.close(() => resolve()));
  database.default.close();

  vi.resetModules();
  database = await import("../db/index.js");
  ({ state } = await import("../state.js"));
  ({ registerRingRoute } = await import("./ring.js"));
  state.activeTournamentId = database.getStartupTournamentId()!;
  expect(state.activeTournamentId).toBe(activeId);
  app = express();
  app.use(express.json());
  httpServer = createServer(app);
  socketServer = new Server(httpServer);
  registerRingRoute(app, socketServer);
  await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
  address = httpServer.address() as AddressInfo;

  const queue = await fetch(`http://127.0.0.1:${address.port}/api/ring/queue`);
  expect(queue.status).toBe(200);
  expect(await queue.json()).toMatchObject([{
    fight: { id: "fight-a", categoryId: "category-a" },
  }]);
  const status = await fetch(`http://127.0.0.1:${address.port}/api/ring/status`);
  expect(await status.json()).toMatchObject({ queuedFights: 1, completedFights: 0 });
});

it("rolls back a rejected fight batch and accepts the same IDs idempotently", async () => {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-ring-sync-batch-test-"));
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
  const address = httpServer.address() as AddressInfo;
  const post = (fights: object[], requiredConfirmedFightIds?: string[], categoryId = "category-batch"):
    Promise<Response> => fetch(
    `http://127.0.0.1:${address.port}/api/ring/sync-fights`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryId, categoryName: "Batch", tournamentName: "Tournament",
        ...(requiredConfirmedFightIds ? { requiredConfirmedFightIds } : {}),
        competitors: [
          { id: "red-batch", name: "Red" },
          { id: "blue-batch", name: "Blue" },
          { id: "third-batch", name: "Third" },
        ],
        fights,
      }),
    },
  );
  const first = { id: "fight-batch-1", red_id: "red-batch", blue_id: "blue-batch", completed: false };
  const second = { id: "fight-batch-2", red_id: "red-batch", blue_id: "third-batch", completed: false };
  const conflict = { ...second, id: first.id };

  expect((await post([first, conflict])).status).toBe(409);
  expect(database.getCategoryTournamentId("category-batch")).toBeNull();
  expect(database.default.prepare("SELECT COUNT(*) AS count FROM fights").get()).toEqual({ count: 0 });
  expect(database.default.prepare("SELECT COUNT(*) AS count FROM competitors").get()).toEqual({ count: 0 });

  const accepted = await post([first, second]);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ ok: true, synced: 2 });
  const retry = await post([first, second]);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ ok: true, synced: 0 });
  expect(database.default.prepare("SELECT COUNT(*) AS count FROM fights").get()).toEqual({ count: 2 });

  database.completeFight(first.id, "red", "points");
  expect((await post([first, second])).status).toBe(409);
  expect(database.default.prepare("SELECT COUNT(*) AS count FROM fights").get()).toEqual({ count: 2 });

  const stage = { id: "fight-batch-stage", red_id: "red-batch", blue_id: "third-batch", completed: false };
  expect((await post([stage], [second.id])).status).toBe(409);
  expect(database.default.prepare("SELECT COUNT(*) AS count FROM fights").get()).toEqual({ count: 2 });
  const tournamentId = database.getCategoryTournamentId("category-batch")!;
  const result = {
    fightId: second.id, categoryId: "category-batch", tournamentId,
    winner: "red" as const, reason: "points", flagsRed: 4, flagsBlue: 0,
    warningsRed: 0, warningsBlue: 0, foulsRed: 0, foulsBlue: 0,
  };
  database.savePendingMatchResult(result);
  expect((await post([stage], [second.id])).status).toBe(409);
  database.confirmMatchResult(result);
  const stageAccepted = await post([stage], [second.id]);
  expect(stageAccepted.status).toBe(200);
  expect(await stageAccepted.json()).toMatchObject({ ok: true, synced: 1 });
  expect((await post([stage], [second.id])).status).toBe(200);
  expect(database.default.prepare("SELECT COUNT(*) AS count FROM fights").get()).toEqual({ count: 3 });

  const foreignStage = { ...stage, id: "fight-foreign-stage" };
  expect((await post([foreignStage], [second.id], "category-foreign")).status).toBe(409);
  expect(database.getCategoryTournamentId("category-foreign")).toBeNull();
  expect(database.default.prepare("SELECT COUNT(*) AS count FROM fights").get()).toEqual({ count: 3 });
});
