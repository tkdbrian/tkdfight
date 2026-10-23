import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "tkd-continuation-"));
  directories.push(directory);
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  const database = await import("../db/index.js");
  const { state } = await import("../state.js");
  const { registerRingRoute } = await import("./ring.js");
  const categoryId = "category-a";
  const category = database.resolveCategoryTournament({
    categoryId,
    categoryName: "A",
    tournamentName: "T",
  });
  state.activeTournamentId = category.tournamentId;
  for (const [id, name] of [
    ["red", "Red"],
    ["blue", "Blue"],
  ]) {
    database.upsertCompetitor({ id, name, tournament_id: category.tournamentId });
  }
  const parentFightId = "parent-original";
  database.insertFightIfNew({
    id: parentFightId,
    tournament_id: category.tournamentId,
    red_id: "red",
    blue_id: "blue",
  });
  const resultInput = {
    fightId: parentFightId,
    categoryId,
    tournamentId: category.tournamentId,
    winner: "draw" as const,
    reason: "points",
    flagsRed: 2,
    flagsBlue: 2,
    warningsRed: 0,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 0,
  };
  database.confirmMatchResult(resultInput);
  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);
  const socketServer = new Server(httpServer);
  registerRingRoute(app, socketServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: object) =>
    fetch(`${base}/api/ring/sync-fights`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = (parentId = parentFightId) =>
    fetch(`${base}/api/ring/categories/${categoryId}/fights/${parentId}/continuation`);
  const payload = (id: string, parentId = parentFightId, stage = "timed-extra") => ({
    categoryId,
    categoryName: "A",
    tournamentName: "T",
    competitors: [
      { id: "red", name: "Red" },
      { id: "blue", name: "Blue" },
    ],
    fights: [{ id, red_id: "red", blue_id: "blue", completed: false }],
    eliminationContinuation: {
      parentFightId: parentId,
      parentRevision: 0,
      proposedFight: { id, red_id: "red", blue_id: "blue", stage },
    },
  });
  return {
    base,
    database,
    httpServer,
    socketServer,
    categoryId,
    parentFightId,
    tournamentId: category.tournamentId,
    post,
    get,
    payload,
    resultInput,
  };
}

describe("elimination continuation route", () => {
  it.each(["timed-extra", "golden-point"] as const)(
    "client accepts the real %s sync response without losing the confirmed parent",
    async (stage) => {
      const ctx = await setup();
      try {
        let parentFightId = ctx.parentFightId;
        if (stage === "golden-point") {
          const extraId = "03a334fc-5c45-4cb4-99e1-e567816aa728";
          expect((await ctx.post(ctx.payload(extraId))).status).toBe(200);
          ctx.database.confirmMatchResult({ ...ctx.resultInput, fightId: extraId });
          parentFightId = extraId;
        }
        const originalFetch = globalThis.fetch.bind(globalThis);
        vi.stubGlobal("fetch", (input: string, options?: RequestInit) =>
          originalFetch(new URL(input, `${ctx.base}/`), options));
        const clientModule = "../../src/lib/sync-proposed-fights.js";
        const { getCanonicalEliminationContinuation, syncProposedFights } =
          await import(clientModule);
        const childId = stage === "timed-extra"
          ? "8ec80737-f924-4c56-9d48-bf2e77335676"
          : "33449c68-b067-4d1e-afb7-cda20977f405";
        const canonical = await syncProposedFights(
          { id: ctx.categoryId, categoryName: "A", tournamentName: "T" },
          [{ id: childId, red: { id: "red", name: "Red" },
            blue: { id: "blue", name: "Blue" }, completed: false,
            continuationParentFightId: parentFightId, continuationStage: stage }],
          [parentFightId],
          { parentFightId, parentRevision: 0,
            proposedFight: { id: childId, red_id: "red", blue_id: "blue", stage } },
        );
        expect(canonical).toMatchObject({ id: childId, parentFightId, stage });
        expect((await ctx.get(parentFightId)).status).toBe(200);
        expect(await getCanonicalEliminationContinuation(ctx.categoryId, parentFightId))
          .toEqual(canonical);
        expect(ctx.database.default.prepare("SELECT status, winner FROM match_results WHERE fight_id = ?")
          .get(parentFightId)).toMatchObject({ status: "confirmed", winner: "draw" });
      } finally {
        vi.unstubAllGlobals();
        await new Promise<void>((resolve) => ctx.socketServer.close(() => resolve()));
        ctx.database.default.close();
      }
    },
  );

  it("persists one canonical timed extra and returns it on identical and different-id retry", async () => {
    const ctx = await setup();
    try {
      const firstId = "03a334fc-5c45-4cb4-99e1-e567816aa728";
      const secondId = "8ec80737-f924-4c56-9d48-bf2e77335676";
      const first = await ctx.post(ctx.payload(firstId));
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        canonicalFight: {
          id: firstId,
          parentFightId: ctx.parentFightId,
          parentRevision: 0,
          stage: "timed-extra",
        },
      });
      const identical = await ctx.post(ctx.payload(firstId));
      expect(identical.status).toBe(200);
      expect(await identical.json()).toMatchObject({ synced: 0 });
      const retry = await ctx.post(ctx.payload(secondId));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ canonicalFight: { id: firstId } });
      expect(await (await ctx.get()).json()).toMatchObject({ canonicalFight: { id: firstId } });
      expect(
        ctx.database.default
          .prepare("SELECT id FROM fights WHERE id IN (?, ?)")
          .all(firstId, secondId)
      ).toEqual([{ id: firstId }]);
    } finally {
      await new Promise<void>((resolve) => ctx.socketServer.close(() => resolve()));
      ctx.database.default.close();
    }
  });

  it("rejects unconfirmed parent, wrong revision and wrong stage without inserting a child", async () => {
    const ctx = await setup();
    try {
      const childId = "03a334fc-5c45-4cb4-99e1-e567816aa728";
      const wrongStage = await ctx.post(ctx.payload(childId, ctx.parentFightId, "golden-point"));
      expect(wrongStage.status).toBe(409);
      const wrongRevision = await ctx.post({
        ...ctx.payload(childId),
        eliminationContinuation: {
          ...ctx.payload(childId).eliminationContinuation,
          parentRevision: 1,
        },
      });
      expect(wrongRevision.status).toBe(409);
      ctx.database.default
        .prepare("UPDATE match_results SET status = 'pending_confirmation' WHERE fight_id = ?")
        .run(ctx.parentFightId);
      expect((await ctx.post(ctx.payload(childId))).status).toBe(409);
      expect(
        ctx.database.default.prepare("SELECT id FROM fights WHERE id = ?").get(childId)
      ).toBeUndefined();
      expect((await ctx.get()).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => ctx.socketServer.close(() => resolve()));
      ctx.database.default.close();
    }
  });

  it("allows golden point only from a confirmed drawn timed extra, then stops the chain", async () => {
    const ctx = await setup();
    try {
      const extraId = "03a334fc-5c45-4cb4-99e1-e567816aa728";
      const goldenId = "8ec80737-f924-4c56-9d48-bf2e77335676";
      expect((await ctx.post(ctx.payload(extraId))).status).toBe(200);
      const premature = await ctx.post(ctx.payload(goldenId, extraId, "golden-point"));
      expect(premature.status).toBe(409);
      ctx.database.confirmMatchResult({ ...ctx.resultInput, fightId: extraId });
      const golden = await ctx.post(ctx.payload(goldenId, extraId, "golden-point"));
      expect(golden.status).toBe(200);
      expect(await golden.json()).toMatchObject({
        canonicalFight: {
          id: goldenId,
          parentFightId: extraId,
          stage: "golden-point",
        },
      });
      ctx.database.confirmMatchResult({ ...ctx.resultInput, fightId: goldenId });
      const thirdId = "33449c68-b067-4d1e-afb7-cda20977f405";
      expect((await ctx.post(ctx.payload(thirdId, goldenId, "golden-point"))).status).toBe(409);
      expect(
        ctx.database.default.prepare("SELECT id FROM fights WHERE id = ?").get(thirdId)
      ).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => ctx.socketServer.close(() => resolve()));
      ctx.database.default.close();
    }
  });

  it("rolls back continuation and other sync writes if a later fight collides", async () => {
    const ctx = await setup();
    try {
      const childId = "03a334fc-5c45-4cb4-99e1-e567816aa728";
      const response = await ctx.post({
        ...ctx.payload(childId),
        fights: [
          ...ctx.payload(childId).fights,
          { id: ctx.parentFightId, red_id: "blue", blue_id: "red", completed: false },
        ],
      });
      expect(response.status).toBe(409);
      expect(
        ctx.database.default.prepare("SELECT id FROM fights WHERE id = ?").get(childId)
      ).toBeUndefined();
      expect((await ctx.get()).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => ctx.socketServer.close(() => resolve()));
      ctx.database.default.close();
    }
  });

  it("rejects a marked child without canonical parent proof", async () => {
    const ctx = await setup();
    try {
      const childId = "03a334fc-5c45-4cb4-99e1-e567816aa728";
      const response = await ctx.post({
        ...ctx.payload(childId),
        eliminationContinuation: undefined,
        fights: [
          {
            ...ctx.payload(childId).fights[0],
            continuationParentFightId: ctx.parentFightId,
            continuationStage: "timed-extra",
          },
        ],
      });
      expect(response.status).toBe(409);
      expect(
        ctx.database.default.prepare("SELECT id FROM fights WHERE id = ?").get(childId)
      ).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => ctx.socketServer.close(() => resolve()));
      ctx.database.default.close();
    }
  });

  it.each([
    "archived",
    "deleted",
  ])("rejects a %s category without changing its graph", async (kind) => {
    const ctx = await setup();
    try {
      if (kind === "archived") {
        const replacementId = ctx.database.createTournament("Replacement", "R");
        ctx.database.default
          .prepare(`
          INSERT INTO category_execution_archives
          (category_id, request_id, replacement_category_id, source_tournament_id,
           replacement_tournament_id, archived_at, previous_snapshot, replacement_snapshot,
           warnings, request_fingerprint)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
          .run(
            ctx.categoryId,
            "archive-request",
            "category-new",
            ctx.tournamentId,
            replacementId,
            "2026-10-23T00:00:00Z",
            "{}",
            "{}",
            "[]",
            "fingerprint"
          );
      } else {
        ctx.database.default
          .prepare(`
          INSERT INTO category_execution_deletions
          (category_id, request_id, tournament_id, deleted_at, counts, request_fingerprint)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
          .run(
            ctx.categoryId,
            "delete-request",
            ctx.tournamentId,
            "2026-10-23T00:00:00Z",
            "{}",
            "fingerprint"
          );
      }
      const childId = "03a334fc-5c45-4cb4-99e1-e567816aa728";
      expect((await ctx.post(ctx.payload(childId))).status).toBe(kind === "deleted" ? 410 : 409);
      expect(
        ctx.database.default.prepare("SELECT id FROM fights WHERE id = ?").get(childId)
      ).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => ctx.socketServer.close(() => resolve()));
      ctx.database.default.close();
    }
  });
});
