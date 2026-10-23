// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import { afterEach, expect, it, vi } from "vitest";
import { generateEliminationBracket, generateGroupsTournament } from "../../src/lib/bracket";
import {
  type CategoryRestartSnapshot,
  categoryRestartSnapshotSchema,
} from "../../src/lib/category-restart-contract";
import { categoryDeleteAndRestartSuccessSchema } from "../../src/lib/category-restart-modes-contract";
import baseline from "../../src/rules/rules/rules_sparring_itf_baseline.json";

let database: typeof import("../db/index.js") | undefined;
let directory: string | undefined;
let sockets: Server | undefined;
afterEach(async () => {
  if (sockets) await new Promise<void>((resolve) => sockets?.close(() => resolve()));
  database?.default.close();
  if (directory) {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(tmpdir()) ||
      !path.basename(target).startsWith("tkd-modes-http-")
    )
      throw new Error("Unsafe temporary directory");
    rmSync(target, { recursive: true, force: true });
  }
  sockets = undefined;
  database = undefined;
  directory = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});
function graph(elimination = false, large = false): CategoryRestartSnapshot {
  const competitors = ["Ana", "Bruno", "Carla"].map((name) => ({
    id: randomUUID(),
    name: name + (large ? "x".repeat(1000) : ""),
    team: large ? "Club".repeat(1000) : "Club",
  }));
  const bracket = elimination
    ? generateEliminationBracket(competitors)
    : { matches: [], seeds: [] };
  return categoryRestartSnapshotSchema.parse({
    phase: "fighting",
    config: {
      id: randomUUID(),
      eventId: "event",
      tournamentName: "Evento",
      categoryName: "Prueba",
      tableChief: "Mesa",
      ruleSet: baseline,
      judgesCount: 3,
      mode: elimination ? "elimination" : "round-robin",
      matchType: "sparring",
    },
    competitors,
    ...(elimination ? { groups: [], fights: [] } : generateGroupsTournament(competitors)),
    currentFightIndex: 0,
    bracketMatches: bracket.matches,
    bracketSeeds: bracket.seeds,
    setupStarted: true,
  });
}
async function setup() {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-modes-http-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  const db = await import("../db/index.js");
  database = db;
  const { state } = await import("../state.js");
  const { registerRingRoute } = await import("./ring.js");
  const { registerCategoryRestartBodyParser } = await import("./category-restart.js");
  const app = express();
  registerCategoryRestartBodyParser(app);
  app.use(express.json({ limit: "100kb" }));
  const server = createServer(app);
  const io = new Server(server);
  sockets = io;
  registerRingRoute(app, io);
  state.activeTournamentId = db.createTournament("Idle", "");
  db.setSelectedTournamentId(state.activeTournamentId);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const raw = (route: string, body: string): Promise<Response> =>
    fetch(base + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  const post = (route: string, body: unknown): Promise<Response> =>
    raw(route, JSON.stringify(body));
  return { db, state, io, base, post, raw };
}

it.each([
  false,
  true,
])("serves atomic canonical restart with real metadata and original receipt (elimination=%s)", async (elimination) => {
  const { db, state, io, base, post } = await setup();
  const source = graph(elimination);
  const sourceId = db.resolveCategoryTournament({
    categoryId: source.config.id,
    tournamentName: source.config.tournamentName,
    categoryName: source.config.categoryName,
  }).tournamentId;
  for (const entrant of source.competitors)
    db.upsertCompetitor({ ...entrant, tournament_id: sourceId });
  for (const fight of source.fights)
    db.upsertFight({
      id: fight.id,
      tournament_id: sourceId,
      red_id: fight.red.id,
      blue_id: fight.blue.id,
      group_id: fight.groupId,
    });
  state.activeTournamentId = sourceId;
  db.setSelectedTournamentId(sourceId);
  const emitted = vi.spyOn(io, "emit");
  const input = {
    requestId: randomUUID(),
    expectedRevision: db.previewCategoryDeletion(source).revision,
    previousSnapshot: source,
    replacementSnapshot: graph(elimination),
  };
  const route = `/api/ring/categories/${source.config.id}/delete-and-restart`;
  const response = await post(route, input);
  expect(response.status).toBe(200);
  const result = categoryDeleteAndRestartSuccessSchema.parse(await response.json());
  expect(result).toMatchObject({
    categoryId: source.config.id,
    replacementSnapshot: input.replacementSnapshot,
    deletion: { tournamentId: sourceId },
  });
  expect(state.activeTournamentId).toBe(db.getCategoryTournamentId(result.replacementCategoryId));
  expect(await (await fetch(base + route)).json()).toEqual(result);
  expect(await (await post(route, input)).json()).toEqual(result);
  expect(emitted).toHaveBeenCalledWith("category:deleted", result.deletion);
  expect(emitted).toHaveBeenCalledWith(
    "state:update",
    expect.objectContaining({
      categoryId: null,
      categoryDeletions: [
        {
          categoryId: source.config.id,
          requestId: input.requestId,
          deletedAt: result.deletion.deletedAt,
        },
      ],
    })
  );
  expect(db.default.prepare("SELECT * FROM category_execution_archives").all()).toEqual([]);
});

it("scopes 2MiB JSON parsing and rejects malformed/linkage/unknown payload without writes", async () => {
  const { db, state, base, post, raw } = await setup();
  const source = graph(false, true);
  const input = {
    requestId: randomUUID(),
    expectedRevision: db.previewCategoryDeletion(source).revision,
    previousSnapshot: source,
    replacementSnapshot: graph(false, true),
  };
  const route = `/api/ring/categories/${source.config.id}/delete-and-restart`;
  expect(JSON.stringify(input).length).toBeGreaterThan(100 * 1024);
  expect((await post(route, input)).status).toBe(200);
  const before = db.default.prepare("SELECT * FROM tournaments").all();
  const selected = state.activeTournamentId;
  for (const invalid of ["{", JSON.stringify({ ...input, unknown: true })]) {
    const response = await raw(route, invalid);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_payload",
      message: expect.stringMatching(/inválid|no es válid/),
    });
  }
  expect((await post(route, { padding: "x".repeat(2 * 1024 * 1024) })).status).toBe(413);
  expect((await post("/api/ring/config", { padding: "x".repeat(101 * 1024) })).status).toBe(413);
  expect((await post(route.replace(source.config.id, randomUUID()), input)).status).toBe(400);
  expect((await fetch(`${base}/api/ring/categories/absent/delete-and-restart`)).status).toBe(404);
  expect(db.default.prepare("SELECT * FROM tournaments").all()).toEqual(before);
  expect(state.activeTournamentId).toBe(selected);
});
