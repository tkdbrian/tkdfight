// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateDoubleBracket,
  generateEliminationBracket,
  generateGroupsTournament,
  getActiveBracketFights,
} from "../../src/lib/bracket";
import type {
  CategoryRestartSnapshot,
  RestartCategoryRequest,
} from "../../src/lib/category-restart-contract";
import { restartCategorySuccessSchema } from "../../src/lib/category-restart-contract";

type DatabaseModule = typeof import("../db/index.js");
let database: DatabaseModule | undefined;
let directory: string | undefined;
let httpServer: ReturnType<typeof createServer> | undefined;
let socketServer: Server | undefined;

afterEach(async () => {
  if (socketServer) {
    await new Promise<void>((resolve) => socketServer?.close(() => resolve()));
  }
  if (httpServer?.listening) {
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  }
  socketServer = undefined;
  httpServer = undefined;
  database?.default.close();
  database = undefined;
  if (directory) {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(tmpdir()) ||
      !path.basename(target).startsWith("tkd-restart-independent-")
    ) {
      throw new Error(`Refusing unsafe temporary cleanup: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
  }
  directory = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function isolatedDatabase(): Promise<DatabaseModule> {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-restart-independent-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  database = await import("../db/index.js");
  return database;
}

function recordedExecution(): CategoryRestartSnapshot {
  const competitors = ["Uno", "Dos", "Tres"].map((name) => ({
    id: randomUUID(),
    name,
    team: "Club",
    weight: 57,
  }));
  return {
    phase: "fighting",
    config: {
      id: randomUUID(),
      eventId: "verification-event",
      tournamentName: "Mismo nombre humano",
      categoryName: "Misma categoría",
      tableChief: "Mesa de prueba",
      ruleSet: null,
      judgesCount: 3,
      mode: "round-robin",
      matchType: "tul",
      finalSeconds: 177,
    },
    competitors,
    ...generateGroupsTournament(competitors),
    currentFightIndex: 0,
    bracketMatches: [],
    bracketSeeds: [],
    setupStarted: true,
  };
}

function restartRequest(previous: CategoryRestartSnapshot): RestartCategoryRequest {
  return {
    requestId: randomUUID(),
    categoryId: previous.config.id,
    previousSnapshot: previous,
    replacementSnapshot: freshExecution(previous),
  };
}

function freshExecution(previous: CategoryRestartSnapshot): CategoryRestartSnapshot {
  const competitors = previous.competitors.map((entry) => ({ ...entry, id: randomUUID() }));
  const snapshot: CategoryRestartSnapshot = {
    config: { ...previous.config, id: randomUUID() },
    competitors,
    phase: "fighting",
    currentFightIndex: 0,
    setupStarted: true,
    fights: [],
    groups: [],
    bracketMatches: [],
    bracketSeeds: [],
  };
  if (snapshot.config.mode === "elimination") {
    const generated =
      competitors.length > 16
        ? generateDoubleBracket(competitors)
        : generateEliminationBracket(competitors);
    return { ...snapshot, bracketMatches: generated.matches, bracketSeeds: generated.seeds };
  }
  return { ...snapshot, ...generateGroupsTournament(competitors) };
}

function register(db: DatabaseModule, graph: CategoryRestartSnapshot): number {
  const { tournamentId } = db.resolveCategoryTournament({
    categoryId: graph.config.id,
    categoryName: graph.config.categoryName,
    tournamentName: graph.config.tournamentName,
  });
  for (const competitor of graph.competitors) {
    db.upsertCompetitor({ ...competitor, tournament_id: tournamentId });
  }
  for (const [order, fight] of graph.fights.entries()) {
    db.upsertFight({
      id: fight.id,
      tournament_id: tournamentId,
      red_id: fight.red.id,
      blue_id: fight.blue.id,
      group_id: fight.groupId,
      round_index: order,
    });
  }
  return tournamentId;
}

function confirmFirstFight(
  db: DatabaseModule,
  graph: CategoryRestartSnapshot,
  tournamentId: number
): void {
  const fight = graph.fights[0];
  db.confirmMatchResult({
    fightId: fight.id,
    tournamentId,
    categoryId: graph.config.id,
    winner: "blue",
    reason: "flags",
    flagsRed: 0,
    flagsBlue: 3,
    warningsRed: 1,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 1,
  });
  Object.assign(fight, {
    completed: true,
    winner: "blue",
    winReason: "flags",
    flagsRed: 0,
    flagsBlue: 3,
    warningsRed: 1,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 1,
  });
}

function durableRows(db: DatabaseModule): Record<string, unknown[]> {
  return Object.fromEntries(
    [
      "tournaments",
      "competitors",
      "fights",
      "match_results",
      "category_tournaments",
      "ring_selection",
    ].map((table) => [table, db.default.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
  );
}

async function isolatedHttp(): Promise<{
  db: DatabaseModule;
  state: typeof import("../state.js").state;
  send: (method: "GET" | "POST" | "DELETE", route: string, body?: unknown) => Promise<Response>;
}> {
  const db = await isolatedDatabase();
  const { state } = await import("../state.js");
  const { registerRingRoute } = await import("./ring.js");
  const { registerHistoryRoute } = await import("./history.js");
  const { registerCategoryRestartBodyParser } = await import("./category-restart.js");
  const app = express();
  registerCategoryRestartBodyParser(app);
  app.use(express.json());
  httpServer = createServer(app);
  socketServer = new Server(httpServer);
  registerRingRoute(app, socketServer);
  registerHistoryRoute(app);
  state.activeTournamentId = db.createTournament("Aislado", "");
  db.setSelectedTournamentId(state.activeTournamentId);
  await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    db,
    state,
    send: (method, route, body) =>
      fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
  };
}

describe("independent database restart invariants", () => {
  it("archives recorded RR Golden Point provenance without fabricating official results", async () => {
    const db = await isolatedDatabase();
    const previous = recordedExecution();
    const [first, second, third] = previous.competitors;
    const zeroMetrics = {
      flagsRed: 0,
      flagsBlue: 0,
      warningsRed: 0,
      warningsBlue: 0,
      foulsRed: 0,
      foulsBlue: 0,
    };
    previous.fights = previous.fights.map((fight) => ({
      ...fight,
      ...zeroMetrics,
      completed: true,
      winner:
        fight.red.id !== third.id && fight.blue.id !== third.id
          ? "draw"
          : fight.red.id === third.id
            ? "blue"
            : "red",
    }));
    // The archive retains this existing direct/direct/GP sequence as recorded.
    // Do not import client result-resolution modules into the server type boundary.
    const playoffBasis = "recorded-confirmed-regular-group";
    for (let stage = 0; stage < 2; stage += 1) {
      previous.fights.push({
        id: randomUUID(),
        red: first,
        blue: second,
        groupId: "G1",
        ...zeroMetrics,
        completed: true,
        winner: "draw",
        isTiebreakExtra: true,
        playoffKind: "direct",
        playoffBasis,
        tiebreakerSeconds: 30,
      });
    }
    previous.fights.push({
      id: randomUUID(),
      red: first,
      blue: second,
      groupId: "G1",
      ...zeroMetrics,
      completed: true,
      winner: "red",
      flagsRed: 3,
      isGoldenPointFight: true,
      isTiebreakExtra: false,
      playoffKind: "direct",
      playoffBasis,
      bracketMatchId: previous.fights[4].id,
    });

    const receipt = db.restartCategoryExecution(restartRequest(previous));
    expect(db.getCategoryArchive(receipt.archive.sourceTournamentId)?.fullSnapshot).toEqual(
      previous
    );
    expect(receipt.archive.warnings.join(" ")).toMatch(/local|registrad/i);
    expect(receipt.replacementSnapshot.fights).toHaveLength(3);
    expect(
      receipt.replacementSnapshot.fights.filter((fight) => fight.isGoldenPointFight)
    ).toHaveLength(0);
    expect(db.getFights(receipt.archive.sourceTournamentId)).toHaveLength(0);
    expect(db.getFights(receipt.archive.replacementTournamentId)).toHaveLength(3);
    expect(db.default.prepare("SELECT COUNT(*) AS n FROM match_results").get()).toEqual({ n: 0 });
  });

  it.each([
    "round-robin",
    "elimination",
  ] as const)("preserves exact SQL and full %s graph across archive, retries and module reload", async (mode) => {
    const db = await isolatedDatabase();
    let previous = recordedExecution();
    if (mode === "elimination") {
      previous.config.mode = mode;
      previous = freshExecution(previous);
      previous.fights = getActiveBracketFights(previous.bracketMatches, []);
    }
    const sourceId = register(db, previous);
    confirmFirstFight(db, previous, sourceId);
    db.setSelectedTournamentId(sourceId);
    const oldFights = db.default
      .prepare("SELECT * FROM fights WHERE tournament_id = ?")
      .all(sourceId);
    const oldCompetitors = db.getCompetitors(sourceId);
    const oldResults = db.default.prepare("SELECT * FROM match_results").all();
    const input = restartRequest(previous);
    const frozenPrevious = JSON.stringify(previous);

    const receipt = db.restartCategoryExecution(input);
    expect(db.getCategoryArchive(sourceId)?.fullSnapshot).toEqual(previous);
    expect(JSON.stringify(previous)).toBe(frozenPrevious);
    expect(
      db.default.prepare("SELECT * FROM fights WHERE tournament_id = ?").all(sourceId)
    ).toEqual(oldFights);
    expect(db.getCompetitors(sourceId)).toEqual(oldCompetitors);
    expect(db.default.prepare("SELECT * FROM match_results").all()).toEqual(oldResults);
    expect(receipt.replacementSnapshot.config).toEqual({
      ...previous.config,
      id: receipt.replacementCategoryId,
    });
    expect(db.getSelectedTournamentId()).toBe(receipt.archive.replacementTournamentId);
    expect(db.restartCategoryExecution(input)).toEqual(receipt);
    db.default.close();
    vi.resetModules();
    database = await import("../db/index.js");
    expect(database.getCategoryReplacement(input.categoryId)).toEqual(receipt);
    expect(database.getCategoryArchive(sourceId)?.fullSnapshot).toEqual(previous);
    expect(database.default.prepare("SELECT * FROM match_results").all()).toEqual(oldResults);
  });

  it("rejects spoofed-owner OR REPLACE before deleting a confirmed historic result", async () => {
    const db = await isolatedDatabase();
    const previous = recordedExecution();
    const sourceId = register(db, previous);
    confirmFirstFight(db, previous, sourceId);
    const receipt = db.restartCategoryExecution(restartRequest(previous));
    const before = durableRows(db);
    const oldFight = previous.fights[0];
    const freshEntrants = receipt.replacementSnapshot.competitors;

    expect(() =>
      db.upsertFight({
        id: oldFight.id,
        tournament_id: receipt.archive.replacementTournamentId,
        red_id: freshEntrants[0].id,
        blue_id: freshEntrants[1].id,
        completed: false,
      })
    ).toThrowError(
      expect.objectContaining({
        code: "category_archived",
        replacementCategoryId: receipt.replacementCategoryId,
      })
    );
    expect(durableRows(db)).toEqual(before);
    expect(db.getConfirmedMatchResult(previous.config.id, oldFight.id)).toMatchObject({
      winner: "blue",
      flagsBlue: 3,
      warningsRed: 1,
      foulsBlue: 1,
      status: "confirmed",
    });
  });

  it("does not capture a foreign durable participant through an as-recorded local alias", async () => {
    const db = await isolatedDatabase();
    const other = recordedExecution();
    const otherId = register(db, other);
    const local = recordedExecution();
    local.competitors[0] = other.competitors[0];
    Object.assign(local, generateGroupsTournament(local.competitors));
    const receipt = db.restartCategoryExecution(restartRequest(local));

    db.upsertCompetitor({
      ...other.competitors[0],
      name: "Nombre actualizado",
      tournament_id: otherId,
    });
    expect(
      db.getCompetitors(otherId).find((entry) => entry.id === other.competitors[0].id)
    ).toMatchObject({
      name: "Nombre actualizado",
      tournament_id: otherId,
    });
    expect(db.getCategoryArchive(receipt.archive.sourceTournamentId)?.fullSnapshot).toEqual(local);
    expect(() => db.assertCompetitorWritable(local.competitors[1].id)).toThrowError(
      expect.objectContaining({ code: "category_archived" })
    );
    expect(db.getFights(receipt.archive.sourceTournamentId)).toHaveLength(0);
    expect(db.getFights(otherId)).toHaveLength(3);
  });

  it("rolls back a late archive insertion failure without clearing a confirmed remnant", async () => {
    const db = await isolatedDatabase();
    const previous = recordedExecution();
    const sourceId = register(db, previous);
    confirmFirstFight(db, previous, sourceId);
    db.setSelectedTournamentId(sourceId);
    db.saveMatchSnapshot(
      previous.fights[0].id,
      sourceId,
      {
        match: { id: previous.fights[0].id },
        rules: {},
        roundFlags: [],
      },
      previous.config.id
    );
    const remnant = db.loadMatchSnapshot();
    const before = durableRows(db);
    const request = restartRequest(previous);
    db.default.exec(`CREATE TRIGGER independently_fail_archive
      BEFORE INSERT ON category_execution_archives
      BEGIN SELECT RAISE(ABORT, 'independent late failure'); END`);

    expect(() => db.restartCategoryExecution(request)).toThrow("independent late failure");
    expect(durableRows(db)).toEqual(before);
    expect(db.loadMatchSnapshot()).toEqual(remnant);
    expect(db.getCategoryReplacement(previous.config.id)).toBeNull();
    expect(db.getCategoryTournamentId(request.replacementSnapshot.config.id)).toBeNull();
    db.default.exec("DROP TRIGGER independently_fail_archive");
    expect(db.restartCategoryExecution(request)).toMatchObject({
      ok: true,
      requestId: request.requestId,
      replacementCategoryId: request.replacementSnapshot.config.id,
    });
  });

  it("adds archives to a disposable legacy database without changing official row values", async () => {
    let db = await isolatedDatabase();
    const previous = recordedExecution();
    const sourceId = register(db, previous);
    confirmFirstFight(db, previous, sourceId);
    db.setSelectedTournamentId(sourceId);
    const before = durableRows(db);
    db.default.exec("DROP TABLE category_execution_archives");
    db.default.close();
    vi.resetModules();
    database = await import("../db/index.js");
    db = database;

    expect(durableRows(db)).toEqual(before);
    expect(db.default.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    const receipt = db.restartCategoryExecution(restartRequest(previous));
    expect(db.getCategoryArchive(sourceId)?.fullSnapshot).toEqual(previous);
    expect(db.getConfirmedMatchResult(previous.config.id, previous.fights[0].id)).toMatchObject({
      winner: "blue",
      flagsBlue: 3,
      warningsRed: 1,
      foulsBlue: 1,
    });
    expect(receipt.archive.sourceTournamentId).toBe(sourceId);
  });
});

describe("independent in-process restart HTTP verification", () => {
  it("keeps terminal confirmed SQL and memory remnants on failure, then clears both after commit", async () => {
    const { db, state, send } = await isolatedHttp();
    const previous = recordedExecution();
    const sourceId = register(db, previous);
    confirmFirstFight(db, previous, sourceId);
    db.setSelectedTournamentId(sourceId);
    state.activeTournamentId = sourceId;
    const fight = previous.fights[0];
    state.match = {
      id: fight.id,
      ringId: "isolated-test-ring",
      red: fight.red,
      blue: fight.blue,
    };
    state.matchCategoryId = previous.config.id;
    state.matchTournamentId = sourceId;
    state.resultConfirmed = true;
    db.saveMatchSnapshot(
      fight.id,
      sourceId,
      {
        match: { id: fight.id },
        rules: {},
        roundFlags: [],
      },
      previous.config.id
    );
    const before = durableRows(db);
    const remnant = db.loadMatchSnapshot();
    const request = restartRequest(previous);
    db.default.exec(`CREATE TRIGGER fail_http_archive BEFORE INSERT ON category_execution_archives
      BEGIN SELECT RAISE(ABORT, 'independent HTTP rollback'); END`);

    expect((await send("POST", "/api/ring/restart-category", request)).status).toBe(500);
    expect(durableRows(db)).toEqual(before);
    expect(db.loadMatchSnapshot()).toEqual(remnant);
    expect(state.match?.id).toBe(fight.id);
    expect(state.resultConfirmed).toBe(true);
    db.default.exec("DROP TRIGGER fail_http_archive");

    const response = await send("POST", "/api/ring/restart-category", request);
    expect(response.status).toBe(200);
    const receipt = restartCategorySuccessSchema.parse(await response.json());
    expect(state.match).toBeNull();
    expect(db.loadMatchSnapshot()).toBeNull();
    expect(state.activeTournamentId).toBe(receipt.archive.replacementTournamentId);
    expect(db.getCategoryArchive(sourceId)?.fullSnapshot).toEqual(previous);
    expect(db.getConfirmedMatchResult(previous.config.id, fight.id)).toMatchObject({
      winner: "blue",
      status: "confirmed",
      flagsBlue: 3,
      foulsBlue: 1,
    });
  });

  it("rejects stale clients spoofing a writable owner and protects both generations from cleanup", async () => {
    const { db, state, send } = await isolatedHttp();
    const previous = recordedExecution();
    const sourceId = register(db, previous);
    confirmFirstFight(db, previous, sourceId);
    state.activeTournamentId = sourceId;
    db.setSelectedTournamentId(sourceId);
    const response = await send("POST", "/api/ring/restart-category", restartRequest(previous));
    expect(response.status).toBe(200);
    const receipt = restartCategorySuccessSchema.parse(await response.json());
    const before = durableRows(db);
    const oldFight = previous.fights[0];
    const fresh = receipt.replacementSnapshot;
    const spoofed = {
      categoryId: fresh.config.id,
      categoryName: fresh.config.categoryName,
      tournamentName: fresh.config.tournamentName,
      competitors: fresh.competitors,
      fights: [
        { id: oldFight.id, red_id: fresh.competitors[0].id, blue_id: fresh.competitors[1].id },
      ],
    };
    for (const route of ["sync-fights", "import-fights"]) {
      const rejected = await send("POST", `/api/ring/${route}`, {
        ...spoofed,
        newCategory: true,
      });
      expect(rejected.status, route).toBe(409);
      expect(await rejected.json()).toMatchObject({
        error: "category_archived",
        replacementCategoryId: receipt.replacementCategoryId,
      });
      expect(durableRows(db)).toEqual(before);
    }
    const history = await send("GET", "/api/history");
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sourceId,
          readOnly: true,
          fullSnapshot: previous,
          archive: receipt.archive,
        }),
      ])
    );
    for (const id of [sourceId, receipt.archive.replacementTournamentId]) {
      const rejected = await send("DELETE", `/api/history/${id}`);
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({
        error: "category_archived",
        replacementCategoryId: receipt.replacementCategoryId,
      });
    }
    const disposable = db.createTournament("Borrable", "Prueba descartable");
    expect((await send("DELETE", "/api/history")).status).toBe(200);
    expect(db.getTournament(disposable)).toBeUndefined();
    expect(db.getTournament(sourceId)).toMatchObject({ id: sourceId });
    expect(db.getTournament(receipt.archive.replacementTournamentId)).toMatchObject({
      id: receipt.archive.replacementTournamentId,
    });
    expect(db.getConfirmedMatchResult(previous.config.id, oldFight.id)).toMatchObject({
      winner: "blue",
      flagsBlue: 3,
      warningsRed: 1,
      foulsBlue: 1,
    });
  });

  it("accepts an archive larger than the global JSON limit and rejects oversized input without writes", async () => {
    const { db, state, send } = await isolatedHttp();
    const previous = recordedExecution();
    const original = previous.fights[0];
    previous.fights.push(
      ...Array.from({ length: 35 }, () => ({
        ...original,
        id: randomUUID(),
        completed: true,
        winner: "red" as const,
        winReason: "provenance:" + "x".repeat(3990),
      }))
    );
    const input = restartRequest(previous);
    expect(JSON.stringify(input).length).toBeGreaterThan(100 * 1024);
    const response = await send("POST", "/api/ring/restart-category", input);
    expect(response.status).toBe(200);
    const receipt = restartCategorySuccessSchema.parse(await response.json());
    expect(db.getCategoryArchive(receipt.archive.sourceTournamentId)?.fullSnapshot).toEqual(
      previous
    );
    const before = durableRows(db);
    const selected = state.activeTournamentId;

    const oversized = await send("POST", "/api/ring/restart-category", {
      padding: "x".repeat(2 * 1024 * 1024),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ ok: false, error: "invalid_payload" });
    expect(durableRows(db)).toEqual(before);
    expect(state.activeTournamentId).toBe(selected);
    expect(db.getCategoryReplacement(input.categoryId)).toEqual(receipt);
    expect(db.default.prepare("SELECT COUNT(*) AS n FROM match_results").get()).toEqual({ n: 0 });
  });
});
