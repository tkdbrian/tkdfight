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
import { generateGroupsTournament } from "../../src/lib/bracket";
import { categoryDeletionPreviewSchema } from "../../src/lib/category-deletion-contract";
import {
  type CategoryRestartSnapshot,
  categoryRestartSnapshotSchema,
  type RestartCategoryRequest,
  restartCategorySuccessSchema,
} from "../../src/lib/category-restart-contract";
import {
  type CategoryDeleteAndRestartRequest,
  categoryDeleteAndRestartSuccessSchema,
} from "../../src/lib/category-restart-modes-contract";
import baseline from "../../src/rules/rules/rules_sparring_itf_baseline.json";

type DatabaseModule = typeof import("../db/index.js");
let database: DatabaseModule | undefined;
let directory: string | undefined;
let httpServer: ReturnType<typeof createServer> | undefined;
let socketServer: Server | undefined;

afterEach(async () => {
  if (socketServer) await new Promise<void>((resolve) => socketServer?.close(() => resolve()));
  if (httpServer?.listening)
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  socketServer = undefined;
  httpServer = undefined;
  database?.default.close();
  database = undefined;
  if (directory) {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(tmpdir()) ||
      !path.basename(target).startsWith("tkd-modes-independent-")
    ) {
      throw new Error(`Refusing unsafe temporary cleanup: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
  }
  directory = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

function recorded(): CategoryRestartSnapshot {
  const competitors = ["Ana", "Bruno", "Carla"].map((name) => ({
    id: randomUUID(),
    name,
    team: "Mismo club",
    weight: 54,
  }));
  return categoryRestartSnapshotSchema.parse({
    phase: "fighting",
    config: {
      id: randomUUID(),
      eventId: "independent-modes-event",
      tournamentName: "Evento",
      categoryName: "Mayores",
      tableChief: "Mesa",
      judgesCount: 3,
      mode: "round-robin",
      matchType: "sparring",
      ruleSet: {
        ...baseline,
        mode: "sparring",
        judgesCount: 3,
        rounds: { ...baseline.rounds, count: 2, duration_seconds: 90 },
      },
    },
    competitors,
    ...generateGroupsTournament(competitors),
    currentFightIndex: 0,
    bracketMatches: [],
    bracketSeeds: [],
    setupStarted: true,
  });
}

function archiveInput(previous: CategoryRestartSnapshot): RestartCategoryRequest {
  const competitors = previous.competitors.map((entry) => ({ ...entry, id: randomUUID() }));
  return {
    requestId: randomUUID(),
    categoryId: previous.config.id,
    previousSnapshot: previous,
    replacementSnapshot: {
      ...structuredClone(previous),
      config: { ...previous.config, id: randomUUID() },
      competitors,
      ...generateGroupsTournament(competitors),
      currentFightIndex: 0,
      bracketMatches: [],
      bracketSeeds: [],
      phase: "fighting",
      setupStarted: true,
    },
  };
}

function register(db: DatabaseModule, snapshot: CategoryRestartSnapshot): number {
  const { tournamentId } = db.resolveCategoryTournament({
    categoryId: snapshot.config.id,
    categoryName: snapshot.config.categoryName,
    tournamentName: snapshot.config.tournamentName,
  });
  for (const competitor of snapshot.competitors)
    db.upsertCompetitor({ ...competitor, tournament_id: tournamentId });
  for (const [index, fight] of snapshot.fights.entries())
    db.upsertFight({
      id: fight.id,
      tournament_id: tournamentId,
      red_id: fight.red.id,
      blue_id: fight.blue.id,
      group_id: fight.groupId,
      round_index: index,
    });
  return tournamentId;
}

function confirm(db: DatabaseModule, graph: CategoryRestartSnapshot, tournamentId: number): void {
  const fight = graph.fights[0];
  db.confirmMatchResult({
    fightId: fight.id,
    categoryId: graph.config.id,
    tournamentId,
    winner: "red",
    reason: "flags",
    flagsRed: 3,
    flagsBlue: 0,
    warningsRed: 1,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 1,
  });
  Object.assign(fight, {
    completed: true,
    winner: "red",
    winReason: "flags",
    flagsRed: 3,
    flagsBlue: 0,
    warningsRed: 1,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 1,
  });
}

function rows(db: DatabaseModule): Record<string, unknown[]> {
  return Object.fromEntries(
    [
      "tournaments",
      "category_tournaments",
      "competitors",
      "fights",
      "match_results",
      "ring_selection",
      "match_snapshot",
      "category_execution_archives",
      "category_execution_deletions",
      "category_deletion_identities",
      "category_execution_deleted_restarts",
    ].map((table) => [table, db.default.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
  );
}

interface Fixture {
  db: DatabaseModule;
  state: typeof import("../state.js").state;
  send: (method: "POST" | "GET", route: string, body?: unknown) => Promise<Response>;
  destructive: (
    graph: CategoryRestartSnapshot,
    requestId?: string
  ) => Promise<CategoryDeleteAndRestartRequest>;
}

async function fixture(): Promise<Fixture> {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-modes-independent-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  database = await import("../db/index.js");
  const db = database;
  const { state } = await import("../state.js");
  const { registerRingRoute } = await import("./ring.js");
  const { registerHistoryRoute } = await import("./history.js");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  httpServer = createServer(app);
  socketServer = new Server(httpServer);
  registerRingRoute(app, socketServer);
  registerHistoryRoute(app);
  state.activeTournamentId = db.createTournament("Fixture", "");
  db.setSelectedTournamentId(state.activeTournamentId);
  await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  const send: Fixture["send"] = (method, route, body) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  return {
    db,
    state,
    send,
    destructive: async (graph, requestId = randomUUID()) => {
      const response = await send(
        "POST",
        `/api/ring/categories/${graph.config.id}/deletion-preview`,
        { localSnapshot: graph }
      );
      expect(response.status).toBe(200);
      const preview = categoryDeletionPreviewSchema.parse(await response.json());
      const restart = archiveInput(graph);
      return {
        requestId,
        expectedRevision: preview.revision,
        previousSnapshot: graph,
        replacementSnapshot: restart.replacementSnapshot,
      };
    },
  };
}

describe("independent atomic restart modes HTTP invariants", () => {
  it.each([
    "replacement fight",
    "combined receipt",
    "replacement selection",
  ])("rolls back the nested deletion and all replacement work on late %s failure", async (stage) => {
    const { db, state, send, destructive } = await fixture();
    const source = recorded();
    const sourceId = register(db, source);
    confirm(db, source, sourceId);
    db.setSelectedTournamentId(sourceId);
    state.activeTournamentId = sourceId;
    state.match = {
      id: source.fights[0].id,
      ringId: "TEST",
      red: source.fights[0].red,
      blue: source.fights[0].blue,
    };
    state.matchCategoryId = source.config.id;
    state.matchTournamentId = sourceId;
    state.resultConfirmed = true;
    db.saveMatchSnapshot(
      source.fights[0].id,
      sourceId,
      { match: { id: source.fights[0].id }, rules: {}, roundFlags: [] },
      source.config.id
    );
    const request = await destructive(source);
    const before = rows(db);
    const trigger =
      stage === "replacement fight"
        ? `BEFORE INSERT ON fights WHEN NEW.tournament_id != ${sourceId}`
        : stage === "combined receipt"
          ? "BEFORE INSERT ON category_execution_deleted_restarts"
          : `BEFORE UPDATE ON ring_selection WHEN NEW.tournament_id IS NOT NULL AND NEW.tournament_id != ${sourceId}`;
    db.default.exec(
      `CREATE TRIGGER fail_independent_late ${trigger} BEGIN SELECT RAISE(ABORT, 'independent late failure'); END`
    );
    const route = `/api/ring/categories/${source.config.id}/delete-and-restart`;
    const failed = await send("POST", route, request);
    expect(failed.status).toBe(500);
    expect(rows(db)).toEqual(before);
    expect(state.match?.id).toBe(source.fights[0].id);
    expect(state.resultConfirmed).toBe(true);
    expect(state.activeTournamentId).toBe(sourceId);
    expect((await send("GET", route)).status).toBe(404);
    db.default.exec("DROP TRIGGER fail_independent_late");
    const success = await send("POST", route, request);
    expect(success.status).toBe(200);
    const receipt = categoryDeleteAndRestartSuccessSchema.parse(await success.json());
    expect(db.getSelectedTournamentId()).toBe(
      db.getCategoryTournamentId(receipt.replacementCategoryId)
    );
    expect(db.getFights(sourceId)).toHaveLength(0);
    expect(db.loadMatchSnapshot()).toBeNull();
    expect(state.match).toBeNull();
    expect(db.default.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("archives real runtime rules by HTTP then deletes only its current replacement without changing another selection or prior archive", async () => {
    const { db, state, send, destructive } = await fixture();
    const a = recorded();
    const aId = register(db, a);
    confirm(db, a, aId);
    const archiveRequest = archiveInput(a);
    const archivedResponse = await send("POST", "/api/ring/restart-category", archiveRequest);
    expect(archivedResponse.status).toBe(200);
    const archived = restartCategorySuccessSchema.parse(await archivedResponse.json());
    expect(archived.replacementSnapshot.config.ruleSet).toEqual(a.config.ruleSet);
    expect(
      await (await send("GET", `/api/ring/categories/${a.config.id}/replacement`)).json()
    ).toEqual(archived);
    const saved = db.default
      .prepare("SELECT previous_snapshot FROM category_execution_archives WHERE category_id = ?")
      .get(a.config.id) as { previous_snapshot: string };
    expect(JSON.parse(saved.previous_snapshot).config.ruleSet).toEqual(a.config.ruleSet);
    const archiveRows = db.default
      .prepare("SELECT * FROM category_execution_archives ORDER BY rowid")
      .all();
    const current = archived.replacementSnapshot;
    const other = recorded();
    const otherId = register(db, other);
    db.setSelectedTournamentId(otherId);
    state.activeTournamentId = otherId;
    const otherRows = db.getFights(otherId);
    const request = await destructive(current);
    const route = `/api/ring/categories/${current.config.id}/delete-and-restart`;
    const response = await send("POST", route, request);
    expect(response.status).toBe(200);
    const receipt = categoryDeleteAndRestartSuccessSchema.parse(await response.json());
    expect(receipt).not.toHaveProperty("archive");
    expect(receipt.deletion.categoryId).toBe(current.config.id);
    expect(receipt.replacementSnapshot.config.ruleSet).toEqual(a.config.ruleSet);
    expect(
      receipt.replacementSnapshot.competitors.map(({ name, team, weight }) => ({
        name,
        team,
        weight,
      }))
    ).toEqual(current.competitors.map(({ name, team, weight }) => ({ name, team, weight })));
    expect(db.getSelectedTournamentId()).toBe(otherId);
    expect(state.activeTournamentId).toBe(otherId);
    expect(db.getFights(otherId)).toEqual(otherRows);
    expect(
      db.default.prepare("SELECT * FROM category_execution_archives ORDER BY rowid").all()
    ).toEqual(archiveRows);
    const history: unknown = await (await send("GET", "/api/history")).json();
    expect(history).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: aId, fullSnapshot: a })])
    );
    expect(history).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: archived.archive.replacementTournamentId }),
      ])
    );
    const oldLookup = await send("GET", `/api/ring/categories/${a.config.id}/replacement`);
    expect(oldLookup.status).toBe(410);
    expect(await oldLookup.json()).toMatchObject({
      error: "replacement_deleted",
      deletion: receipt.deletion,
    });
    const after = rows(db);
    expect(await (await send("POST", route, request)).json()).toEqual(receipt);
    expect(await (await send("GET", route)).json()).toEqual(receipt);
    expect(rows(db)).toEqual(after);
    const conflictingArchive = { ...archiveInput(other), requestId: request.requestId };
    const conflict = await send("POST", "/api/ring/restart-category", conflictingArchive);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "request_id_conflict" });
    expect(rows(db)).toEqual(after);
  });

  it("never returns the initial replacement after it was archived or its archive descendant was deleted", async () => {
    const { db, send, destructive } = await fixture();
    const source = recorded();
    register(db, source);
    const request = await destructive(source);
    const route = `/api/ring/categories/${source.config.id}/delete-and-restart`;
    const response = await send("POST", route, request);
    expect(response.status).toBe(200);
    const receipt = categoryDeleteAndRestartSuccessSchema.parse(await response.json());
    const next = receipt.replacementSnapshot;
    const archiveRequest = archiveInput(next);
    const archivedResponse = await send("POST", "/api/ring/restart-category", archiveRequest);
    expect(archivedResponse.status).toBe(200);
    const archived = restartCategorySuccessSchema.parse(await archivedResponse.json());
    const before = rows(db);
    for (const method of ["GET", "POST"] as const) {
      const guard = await send(method, route, method === "POST" ? request : undefined);
      expect(guard.status).toBe(409);
      expect(await guard.json()).toMatchObject({
        error: "category_archived",
        categoryId: source.config.id,
        deletion: receipt.deletion,
        archivedCategoryId: next.config.id,
        replacementCategoryId: archived.replacementCategoryId,
      });
    }
    expect(rows(db)).toEqual(before);
    const terminal = archived.replacementSnapshot;
    const previewResponse = await send(
      "POST",
      `/api/ring/categories/${terminal.config.id}/deletion-preview`,
      { localSnapshot: terminal }
    );
    const preview = categoryDeletionPreviewSchema.parse(await previewResponse.json());
    const deleted = await send("POST", `/api/ring/categories/${terminal.config.id}/delete`, {
      requestId: randomUUID(),
      expectedRevision: preview.revision,
      localSnapshot: terminal,
    });
    expect(deleted.status).toBe(200);
    const terminalDeletion: unknown = await deleted.json();
    const after = rows(db);
    const guard = await send("GET", route);
    expect(guard.status).toBe(410);
    expect(await guard.json()).toMatchObject({
      error: "replacement_deleted",
      deletion: receipt.deletion,
      replacementCategoryId: receipt.replacementCategoryId,
      replacementDeletion: terminalDeletion,
    });
    expect(rows(db)).toEqual(after);
  });

  it("rejects cross-mode archived request reuse and malformed real metadata without partial durable writes", async () => {
    const { db, send, destructive } = await fixture();
    const source = recorded();
    register(db, source);
    const archivedRequest = archiveInput(source);
    const response = await send("POST", "/api/ring/restart-category", archivedRequest);
    expect(response.status).toBe(200);
    const archived = restartCategorySuccessSchema.parse(await response.json());
    const current = archived.replacementSnapshot;
    const request = await destructive(current, archivedRequest.requestId);
    const before = rows(db);
    const conflict = await send(
      "POST",
      `/api/ring/categories/${current.config.id}/delete-and-restart`,
      request
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "request_id_conflict" });
    expect(rows(db)).toEqual(before);
    const invalidPrevious = {
      ...current,
      config: { ...current.config, ruleSet: { ...baseline, version: 7, mode: "sparring" } },
    };
    for (const [route, body] of [
      [
        "/api/ring/restart-category",
        { ...archiveInput(current), previousSnapshot: invalidPrevious },
      ],
      [
        `/api/ring/categories/${current.config.id}/delete-and-restart`,
        { ...request, requestId: randomUUID(), previousSnapshot: invalidPrevious },
      ],
    ] as const) {
      const rejected = await send("POST", route, body);
      expect(rejected.status).toBe(400);
      const error: unknown = await rejected.json();
      expect(error).toMatchObject({
        ok: false,
        error: "invalid_payload",
        message: expect.any(String),
      });
      expect(JSON.stringify(error)).not.toMatch(
        /unrecognized_keys|invalid_union|invalid_type|"issues"/
      );
    }
    expect(rows(db)).toEqual(before);
  });
});
