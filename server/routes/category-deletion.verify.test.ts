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
import {
  categoryDeletionPreviewSchema,
  categoryDeletionReceiptSchema,
} from "../../src/lib/category-deletion-contract";
import type {
  CategoryRestartSnapshot,
  RestartCategoryRequest,
} from "../../src/lib/category-restart-contract";

type DatabaseModule = typeof import("../db/index.js");
let database: DatabaseModule | undefined;
let directory: string | undefined;
let httpServer: ReturnType<typeof createServer> | undefined;
let socketServer: Server | undefined;

afterEach(async () => {
  if (socketServer) await new Promise<void>((resolve) => socketServer?.close(() => resolve()));
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
      !path.basename(target).startsWith("tkd-delete-independent-")
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
  }));
  return {
    phase: "fighting",
    config: {
      id: randomUUID(),
      eventId: "independent-deletion-event",
      tournamentName: "Mismo evento",
      categoryName: "Misma categoría",
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

function restartInput(previous: CategoryRestartSnapshot): RestartCategoryRequest {
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

function register(db: DatabaseModule, graph: CategoryRestartSnapshot): number {
  const { tournamentId } = db.resolveCategoryTournament({
    categoryId: graph.config.id,
    tournamentName: graph.config.tournamentName,
    categoryName: graph.config.categoryName,
  });
  for (const competitor of graph.competitors)
    db.upsertCompetitor({ ...competitor, tournament_id: tournamentId });
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

function confirmFirst(
  db: DatabaseModule,
  graph: CategoryRestartSnapshot,
  tournamentId: number
): void {
  const fight = graph.fights[0];
  db.confirmMatchResult({
    fightId: fight.id,
    categoryId: graph.config.id,
    tournamentId,
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

function allRows(db: DatabaseModule): Record<string, unknown[]> {
  return Object.fromEntries(
    [
      "tournaments",
      "category_tournaments",
      "competitors",
      "fights",
      "match_results",
      "ring_selection",
      "category_execution_archives",
      "category_execution_deletions",
      "category_deletion_identities",
    ].map((table) => [table, db.default.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
  );
}

async function isolatedHttp(): Promise<{
  db: DatabaseModule;
  state: typeof import("../state.js").state;
  send: (method: "GET" | "POST" | "DELETE", route: string, body?: unknown) => Promise<Response>;
}> {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-delete-independent-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  database = await import("../db/index.js");
  const db = database;
  const { state } = await import("../state.js");
  const { registerRingRoute } = await import("./ring.js");
  const { registerHistoryRoute } = await import("./history.js");
  const app = express();
  // Parser-boundary validation belongs to the owner's production-parser integration suite.
  app.use(express.json({ limit: "2mb" }));
  httpServer = createServer(app);
  socketServer = new Server(httpServer);
  registerRingRoute(app, socketServer);
  registerHistoryRoute(app);
  state.activeTournamentId = db.createTournament("Fixture vacía", "");
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
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      }),
  };
}

describe("independent single-execution deletion HTTP invariants", () => {
  it("rejects an unassigned legacy fight sharing target competitors instead of promising a deletable scope", async () => {
    const { db, send } = await isolatedHttp();
    const target = recorded();
    register(db, target);
    const route = `/api/ring/categories/${target.config.id}`;
    const original = categoryDeletionPreviewSchema.parse(
      await (await send("POST", `${route}/deletion-preview`, { localSnapshot: target })).json()
    );
    db.default
      .prepare("INSERT INTO fights (id, tournament_id, red_id, blue_id) VALUES (?, NULL, ?, ?)")
      .run(randomUUID(), target.competitors[0].id, target.competitors[1].id);
    const before = allRows(db);

    const preview = await send("POST", `${route}/deletion-preview`, { localSnapshot: target });
    expect(preview.status).toBe(409);
    expect(await preview.json()).toMatchObject({ error: "deletion_scope_ambiguous" });
    const deleted = await send("POST", `${route}/delete`, {
      requestId: randomUUID(),
      expectedRevision: original.revision,
      localSnapshot: target,
    });
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toMatchObject({ error: "deletion_scope_ambiguous" });
    expect(allRows(db)).toEqual(before);
  });

  it("deletes only the terminal generation and makes old transitive restart receipts non-resurrecting", async () => {
    const { db, state, send } = await isolatedHttp();
    const a = recorded();
    const aId = register(db, a);
    confirmFirst(db, a, aId);
    const firstRequest = restartInput(a);
    const first = db.restartCategoryExecution(firstRequest);
    const b = first.replacementSnapshot;
    confirmFirst(db, b, first.archive.replacementTournamentId);
    const secondRequest = restartInput(b);
    const second = db.restartCategoryExecution(secondRequest);
    const c = second.replacementSnapshot;
    const cId = second.archive.replacementTournamentId;
    state.activeTournamentId = cId;
    db.setSelectedTournamentId(cId);
    const immutableArchives = db.default
      .prepare("SELECT * FROM category_execution_archives ORDER BY rowid")
      .all();
    const preservedResults = db.default
      .prepare("SELECT * FROM match_results ORDER BY fight_id")
      .all();
    const preservedFights = db.default
      .prepare("SELECT * FROM fights WHERE tournament_id != ? ORDER BY id")
      .all(cId);
    const beforeStats = (await (await send("GET", "/api/stats")).json()) as {
      overview: { totalTournaments: number };
    };
    const route = `/api/ring/categories/${c.config.id}`;
    const previewResponse = await send("POST", `${route}/deletion-preview`, { localSnapshot: c });
    expect(previewResponse.status).toBe(200);
    const preview = categoryDeletionPreviewSchema.parse(await previewResponse.json());
    expect(preview).toMatchObject({
      categoryId: c.config.id,
      requiresConfirmationText: true,
      counts: { competitors: 3, fights: 3, confirmedResults: 0 },
    });
    const request = {
      requestId: randomUUID(),
      expectedRevision: preview.revision,
      localSnapshot: c,
    };

    const response = await send("POST", `${route}/delete`, request);
    expect(response.status).toBe(200);
    const receipt = categoryDeletionReceiptSchema.parse(await response.json());
    expect(receipt).toMatchObject({
      categoryId: c.config.id,
      tournamentId: cId,
      counts: preview.counts,
    });
    expect(
      db.default.prepare("SELECT * FROM category_execution_archives ORDER BY rowid").all()
    ).toEqual(immutableArchives);
    expect(db.default.prepare("SELECT * FROM match_results ORDER BY fight_id").all()).toEqual(
      preservedResults
    );
    expect(
      db.default.prepare("SELECT * FROM fights WHERE tournament_id != ? ORDER BY id").all(cId)
    ).toEqual(preservedFights);
    expect(db.getFights(cId)).toHaveLength(0);
    expect(db.getCompetitors(cId)).toHaveLength(0);
    expect(db.getSelectedTournamentId()).toBeNull();
    expect(db.getStartupTournamentId()).toBeNull();
    const history: unknown = await (await send("GET", "/api/history")).json();
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: aId, fullSnapshot: a }),
        expect.objectContaining({ id: first.archive.replacementTournamentId, fullSnapshot: b }),
      ])
    );
    expect(history).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: cId })]));
    const afterStats = (await (await send("GET", "/api/stats")).json()) as typeof beforeStats;
    expect(afterStats.overview.totalTournaments).toBe(beforeStats.overview.totalTournaments - 1);

    for (const oldRequest of [firstRequest, secondRequest]) {
      const lookup = await send("GET", `/api/ring/categories/${oldRequest.categoryId}/replacement`);
      expect(lookup.status).toBe(410);
      expect(await lookup.json()).toMatchObject({
        error: "replacement_deleted",
        categoryId: oldRequest.categoryId,
        deletion: receipt,
      });
      const replay = await send("POST", "/api/ring/restart-category", oldRequest);
      expect(replay.status).toBe(410);
      expect(await replay.json()).toMatchObject({
        error: "replacement_deleted",
        deletion: receipt,
      });
    }
    expect(await (await send("GET", `${route}/deletion`)).json()).toEqual(receipt);
    const fresh = recorded();
    expect(
      (
        await send("POST", "/api/ring/activate-category", {
          categoryId: fresh.config.id,
          categoryName: fresh.config.categoryName,
          tournamentName: fresh.config.tournamentName,
        })
      ).status
    ).toBe(200);
    expect(state.activeTournamentId).not.toBe(cId);
    expect(db.getCategoryTournamentId(fresh.config.id)).toBe(state.activeTournamentId);
    expect(db.default.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });

  it("tombstones a local-only draft without fabricating SQL or reserving same-name foreign owners", async () => {
    const { db, send } = await isolatedHttp();
    const other = recorded();
    const otherId = register(db, other);
    const draft = recorded();
    draft.phase = "setup";
    draft.fights = [];
    draft.groups = [];
    const tournaments = db.default.prepare("SELECT * FROM tournaments ORDER BY id").all();
    const route = `/api/ring/categories/${draft.config.id}`;
    const response = await send("POST", `${route}/deletion-preview`, { localSnapshot: draft });
    expect(response.status).toBe(200);
    const preview = categoryDeletionPreviewSchema.parse(await response.json());
    expect(preview).toMatchObject({
      requiresConfirmationText: false,
      counts: {
        competitors: 3,
        fights: 0,
        completedFights: 0,
        confirmedResults: 0,
        localOnlyFights: 0,
      },
    });
    const deleted = await send("POST", `${route}/delete`, {
      requestId: randomUUID(),
      expectedRevision: preview.revision,
      localSnapshot: draft,
    });
    expect(deleted.status).toBe(200);
    const receipt = categoryDeletionReceiptSchema.parse(await deleted.json());
    expect(receipt.tournamentId).toBeNull();
    expect(db.default.prepare("SELECT * FROM tournaments ORDER BY id").all()).toEqual(tournaments);
    expect(db.getCategoryTournamentId(draft.config.id)).toBeNull();
    const after = allRows(db);
    expect(() =>
      db.upsertCompetitor({ ...draft.competitors[0], tournament_id: otherId })
    ).toThrowError(expect.objectContaining({ code: "category_deleted" }));
    expect(allRows(db)).toEqual(after);
    db.upsertCompetitor({
      ...other.competitors[0],
      name: "Nombre legítimo actualizado",
      tournament_id: otherId,
    });
    expect(
      db.getCompetitors(otherId).find((entry) => entry.id === other.competitors[0].id)
    ).toMatchObject({ name: "Nombre legítimo actualizado" });
    expect(db.getFights(otherId)).toHaveLength(3);
  });

  it("rejects a foreign-claimed result on an owned fight before cascading any rows", async () => {
    const { db, send } = await isolatedHttp();
    const target = recorded();
    const targetId = register(db, target);
    confirmFirst(db, target, targetId);
    const route = `/api/ring/categories/${target.config.id}`;
    const originalPreview = categoryDeletionPreviewSchema.parse(
      await (await send("POST", `${route}/deletion-preview`, { localSnapshot: target })).json()
    );
    const foreign = recorded();
    const foreignId = register(db, foreign);
    db.default
      .prepare("UPDATE match_results SET tournament_id = ?, category_id = ? WHERE fight_id = ?")
      .run(foreignId, foreign.config.id, target.fights[0].id);
    const before = allRows(db);

    const preview = await send("POST", `${route}/deletion-preview`, { localSnapshot: target });
    expect(preview.status).toBe(409);
    expect(await preview.json()).toMatchObject({ error: "deletion_scope_ambiguous" });
    const deleted = await send("POST", `${route}/delete`, {
      requestId: randomUUID(),
      expectedRevision: originalPreview.revision,
      localSnapshot: target,
    });
    expect(deleted.status).toBe(409);
    expect(allRows(db)).toEqual(before);
    expect(
      db.default.prepare("SELECT * FROM match_results WHERE fight_id = ?").get(target.fights[0].id)
    ).toMatchObject({
      tournament_id: foreignId,
      category_id: foreign.config.id,
      status: "confirmed",
    });
  });

  it("rolls back rows, receipt, selection and confirmed recovery when snapshot cleanup fails", async () => {
    const { db, state, send } = await isolatedHttp();
    const target = recorded();
    const targetId = register(db, target);
    confirmFirst(db, target, targetId);
    db.setSelectedTournamentId(targetId);
    state.activeTournamentId = targetId;
    const fight = target.fights[0];
    state.match = { id: fight.id, ringId: "independent-test", red: fight.red, blue: fight.blue };
    state.matchCategoryId = target.config.id;
    state.matchTournamentId = targetId;
    state.resultConfirmed = true;
    db.saveMatchSnapshot(
      fight.id,
      targetId,
      { match: { id: fight.id }, rules: {}, roundFlags: [] },
      target.config.id
    );
    const route = `/api/ring/categories/${target.config.id}`;
    const response = await send("POST", `${route}/deletion-preview`, { localSnapshot: target });
    expect(response.status).toBe(200);
    const preview = categoryDeletionPreviewSchema.parse(await response.json());
    const request = {
      requestId: randomUUID(),
      expectedRevision: preview.revision,
      localSnapshot: target,
    };
    const before = allRows(db);
    const recoveryBefore = db.loadMatchSnapshot();
    db.default.exec(`CREATE TRIGGER independently_fail_deleted_snapshot
      BEFORE DELETE ON match_snapshot
      BEGIN SELECT RAISE(ABORT, 'independent snapshot cleanup failure'); END`);

    expect((await send("POST", `${route}/delete`, request)).status).toBe(500);
    expect(allRows(db)).toEqual(before);
    expect(db.loadMatchSnapshot()).toEqual(recoveryBefore);
    expect(db.getCategoryDeletion(target.config.id)).toBeNull();
    expect(db.getSelectedTournamentId()).toBe(targetId);
    expect(state.match?.id).toBe(fight.id);
    expect(state.resultConfirmed).toBe(true);
    db.default.exec("DROP TRIGGER independently_fail_deleted_snapshot");

    const success = await send("POST", `${route}/delete`, request);
    expect(success.status).toBe(200);
    expect(categoryDeletionReceiptSchema.parse(await success.json())).toMatchObject({
      categoryId: target.config.id,
      tournamentId: targetId,
    });
    expect(db.loadMatchSnapshot()).toBeNull();
    expect(state.match).toBeNull();
    expect(db.getSelectedTournamentId()).toBeNull();
    expect(db.getFights(targetId)).toHaveLength(0);
  });
});
