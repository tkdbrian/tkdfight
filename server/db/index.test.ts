import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadIsolatedDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "tkd-fight-db-test-"));
  temporaryDirectories.push(directory);
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  return import("./index");
}

describe("durable active tournament selection", () => {
  it("adds revision zero to an old database without changing pending or confirmed results", async () => {
    let database = await loadIsolatedDatabase();
    const category = database.resolveCategoryTournament({ categoryId: "legacy-cas", tournamentName: "Old", categoryName: "Old" });
    database.upsertCompetitor({ id: "legacy-r", tournament_id: category.tournamentId, name: "Red" });
    database.upsertCompetitor({ id: "legacy-b", tournament_id: category.tournamentId, name: "Blue" });
    for (const id of ["old-pending", "old-confirmed"]) {
      database.insertFightIfNew({ id, tournament_id: category.tournamentId, red_id: "legacy-r", blue_id: "legacy-b" });
      const input = { fightId: id, categoryId: "legacy-cas", tournamentId: category.tournamentId,
        winner: "red" as const, reason: "points", flagsRed: 4, flagsBlue: 0,
        warningsRed: 2, warningsBlue: 0, foulsRed: 0, foulsBlue: 0 };
      database.savePendingMatchResult(input);
      if (id === "old-confirmed") database.confirmMatchResult(input);
    }
    database.default.exec("ALTER TABLE fights DROP COLUMN result_revision");
    const before = database.default.prepare("SELECT * FROM match_results ORDER BY fight_id").all();
    database.default.close();
    vi.resetModules();
    database = await import("./index");
    expect(database.default.prepare("SELECT * FROM match_results ORDER BY fight_id").all()).toEqual(before);
    expect(database.getMatchResult("legacy-cas", "old-pending"))
      .toMatchObject({ status: "pending_confirmation", flagsRed: 4, warningsRed: 2, revision: 0 });
    expect(database.getMatchResult("legacy-cas", "old-confirmed"))
      .toMatchObject({ status: "confirmed", flagsRed: 4, warningsRed: 2, revision: 0 });
    expect(database.default.prepare("SELECT result_revision FROM fights").all())
      .toEqual([{ result_revision: 0 }, { result_revision: 0 }]);
    database.default.close();
  });

  it("restores an explicitly selected older category after a restart", async () => {
    let database = await loadIsolatedDatabase();
    const selected = database.createTournament("Active", "A");
    const latest = database.createTournament("Newer", "B");
    database.setSelectedTournamentId(selected);
    database.default.close();

    vi.resetModules();
    database = await import("./index");
    expect(database.getStartupTournamentId()).toBe(selected);
    expect(database.getLatestTournament()?.id).toBe(latest);
    database.default.close();
  });

  it("gives a durable active-match lock priority over a different selection", async () => {
    let database = await loadIsolatedDatabase();
    const locked = database.createTournament("Locked", "A");
    const selected = database.createTournament("Selected", "B");
    database.setSelectedTournamentId(selected);
    database.saveMatchSnapshot("fight-a", locked, { match: {}, rules: {}, roundFlags: [] }, "category-a");
    database.default.close();

    vi.resetModules();
    database = await import("./index");
    expect(database.getStartupTournamentId()).toBe(locked);
    database.default.close();
  });

  it("falls back for old data and clears a deleted selection", async () => {
    const database = await loadIsolatedDatabase();
    const previous = database.createTournament("Previous", "A");
    const latest = database.createTournament("Latest", "B");
    expect(database.getStartupTournamentId()).toBe(latest);
    database.setSelectedTournamentId(previous);
    database.default.prepare("DELETE FROM tournaments WHERE id = ?").run(previous);
    expect(database.getSelectedTournamentId()).toBeNull();
    expect(database.getStartupTournamentId()).toBe(latest);
    database.default.close();
  });

  it("keeps independent DATA_DIR selections", async () => {
    let first = await loadIsolatedDatabase();
    const firstDirectory = process.env.DATA_DIR;
    const firstId = first.createTournament("First", "A");
    first.setSelectedTournamentId(firstId);
    first.default.close();

    const second = await loadIsolatedDatabase();
    expect(second.getSelectedTournamentId()).toBeNull();
    const secondId = second.createTournament("Second", "B");
    second.setSelectedTournamentId(secondId);
    second.default.close();

    vi.stubEnv("DATA_DIR", firstDirectory);
    vi.resetModules();
    first = await import("./index");
    expect(first.getSelectedTournamentId()).toBe(firstId);
    first.default.close();
  });
});

describe("category tournament association", () => {
  it("keeps legacy history unassigned and isolates repeated A/B registration", async () => {
    const database = await loadIsolatedDatabase();
    const legacyTournamentId = database.createTournament("Torneo viejo", "Adultos");
    database.upsertCompetitor({ id: "legacy-red", tournament_id: legacyTournamentId, name: "Rojo viejo" });
    database.upsertCompetitor({ id: "legacy-blue", tournament_id: legacyTournamentId, name: "Azul viejo" });
    database.insertFightIfNew({
      id: "legacy-fight",
      tournament_id: legacyTournamentId,
      red_id: "legacy-red",
      blue_id: "legacy-blue",
    });

    const categoryA = database.resolveCategoryTournament({
      categoryId: "category-a",
      tournamentName: "Torneo nuevo",
      categoryName: "Adultos",
      preferredTournamentId: legacyTournamentId,
    });
    const repeatedA = database.resolveCategoryTournament({
      categoryId: "category-a",
      tournamentName: "Torneo nuevo",
      categoryName: "Adultos",
      preferredTournamentId: legacyTournamentId,
    });
    const categoryB = database.resolveCategoryTournament({
      categoryId: "category-b",
      tournamentName: "Torneo nuevo",
      categoryName: "Juveniles",
      preferredTournamentId: legacyTournamentId,
    });

    expect(categoryA.legacyHistoryUnassigned).toBe(true);
    expect(categoryA.tournamentId).not.toBe(legacyTournamentId);
    expect(repeatedA.tournamentId).toBe(categoryA.tournamentId);
    expect(categoryB.tournamentId).not.toBe(categoryA.tournamentId);
    expect(database.getCategoryTournamentId("category-a")).toBe(categoryA.tournamentId);
    expect(database.getCategoryTournamentId("category-b")).toBe(categoryB.tournamentId);
    expect(database.getFights(legacyTournamentId)).toHaveLength(1);
    expect(database.default.prepare("SELECT COUNT(*) AS count FROM tournaments").get()).toMatchObject({ count: 3 });

    database.default.close();
  });

  it("keeps A/B histories separated and confirms a result only once", async () => {
    const database = await loadIsolatedDatabase();
    const createFight = (categoryId: string, fightId: string) => {
      const category = database.resolveCategoryTournament({
        categoryId,
        tournamentName: "Torneo",
        categoryName: categoryId,
      });
      const redId = `${fightId}-red`;
      const blueId = `${fightId}-blue`;
      database.upsertCompetitor({ id: redId, tournament_id: category.tournamentId, name: "Rojo" });
      database.upsertCompetitor({ id: blueId, tournament_id: category.tournamentId, name: "Azul" });
      database.insertFightIfNew({ id: fightId, tournament_id: category.tournamentId, red_id: redId, blue_id: blueId });
      return category;
    };
    const categoryA = createFight("category-a", "fight-a");
    const categoryB = createFight("category-b", "fight-b");
    const resultA = {
      fightId: "fight-a",
      categoryId: "category-a",
      tournamentId: categoryA.tournamentId,
      winner: "red" as const,
      reason: "points",
      flagsRed: 2,
      flagsBlue: 0,
      warningsRed: 0,
      warningsBlue: 1,
      foulsRed: 0,
      foulsBlue: 0,
    };

    database.saveMatchSnapshot("fight-a", categoryA.tournamentId, { match: {}, rules: {}, roundFlags: [] }, "category-a");
    database.savePendingMatchResult(resultA);
    const confirmedA = database.confirmMatchResult(resultA);
    const repeatedA = database.confirmMatchResult(resultA);

    expect(confirmedA.status).toBe("confirmed");
    expect(repeatedA.alreadyConfirmed).toBe(true);
    expect(database.countMatchResults("fight-a")).toBe(1);
    expect(database.getConfirmedMatchResult("category-a", "fight-a")?.winner).toBe("red");
    expect(database.getConfirmedMatchResult("category-b", "fight-a")).toBeNull();
    expect(database.getFights(categoryA.tournamentId)).toHaveLength(1);
    expect(database.getFights(categoryB.tournamentId)).toHaveLength(1);
    expect(database.getActiveMatchLock()).toBeNull();

    database.default.close();
  });

  it("rolls back a failed result save and retains the pending snapshot lock", async () => {
    const database = await loadIsolatedDatabase();
    const category = database.resolveCategoryTournament({
      categoryId: "category-a",
      tournamentName: "Torneo",
      categoryName: "Adultos",
    });
    database.upsertCompetitor({ id: "red", tournament_id: category.tournamentId, name: "Rojo" });
    database.upsertCompetitor({ id: "blue", tournament_id: category.tournamentId, name: "Azul" });
    database.insertFightIfNew({ id: "fight-a", tournament_id: category.tournamentId, red_id: "red", blue_id: "blue" });
    database.saveMatchSnapshot("fight-a", category.tournamentId, { match: {}, rules: {}, roundFlags: [] }, "category-a");
    database.default.exec(`
      CREATE TRIGGER reject_result BEFORE INSERT ON match_results
      BEGIN SELECT RAISE(ABORT, 'test write failure'); END;
    `);

    const input = {
      fightId: "fight-a",
      categoryId: "category-a",
      tournamentId: category.tournamentId,
      winner: "blue" as const,
      reason: "points",
      flagsRed: 0,
      flagsBlue: 2,
      warningsRed: 0,
      warningsBlue: 0,
      foulsRed: 0,
      foulsBlue: 0,
    };
    expect(() => database.confirmMatchResult(input)).toThrow("test write failure");
    expect(database.countMatchResults("fight-a")).toBe(0);
    expect((database.getFights(category.tournamentId)[0] as { completed: number }).completed).toBe(0);
    expect(database.getActiveMatchLock()?.fightId).toBe("fight-a");
    expect(database.loadMatchSnapshot()?.categoryId).toBe("category-a");

    database.default.close();
  });

  it("reuses an empty legacy tournament only once", async () => {
    const database = await loadIsolatedDatabase();
    const emptyTournamentId = database.createTournament("Torneo", "");

    const categoryA = database.resolveCategoryTournament({
      categoryId: "category-a",
      tournamentName: "Torneo",
      categoryName: "Adultos",
      preferredTournamentId: emptyTournamentId,
    });
    const categoryB = database.resolveCategoryTournament({
      categoryId: "category-b",
      tournamentName: "Torneo",
      categoryName: "Juveniles",
      preferredTournamentId: emptyTournamentId,
    });

    expect(categoryA.tournamentId).toBe(emptyTournamentId);
    expect(categoryB.tournamentId).not.toBe(emptyTournamentId);
    expect(categoryB.tournamentId).not.toBe(categoryA.tournamentId);

    database.default.close();
  });

  it("associates legacy history only when its complete identity fingerprint matches", async () => {
    const database = await loadIsolatedDatabase();
    const legacyTournamentId = database.createTournament("Torneo", "Adultos");
    database.upsertCompetitor({ id: "red", tournament_id: legacyTournamentId, name: "Rojo" });
    database.upsertCompetitor({ id: "blue", tournament_id: legacyTournamentId, name: "Azul" });
    database.insertFightIfNew({ id: "fight-a", tournament_id: legacyTournamentId, red_id: "red", blue_id: "blue" });

    const category = database.resolveCategoryTournament({
      categoryId: "category-a",
      tournamentName: "Torneo",
      categoryName: "Adultos",
      legacyFights: [{ id: "fight-a", red_id: "red", blue_id: "blue" }],
      legacyCompetitorIds: ["red", "blue"],
    });

    expect(category.tournamentId).toBe(legacyTournamentId);
    expect(category.legacyHistoryUnassigned).toBe(false);
    expect(database.getFights(category.tournamentId)).toHaveLength(1);

    database.default.close();
  });

  it("recovers a pending result without a snapshot after restart and confirms retries once", async () => {
    const database = await loadIsolatedDatabase();
    const category = database.resolveCategoryTournament({
      categoryId: "category-a",
      tournamentName: "Torneo",
      categoryName: "Adultos",
    });
    database.upsertCompetitor({ id: "red", tournament_id: category.tournamentId, name: "Rojo" });
    database.upsertCompetitor({ id: "blue", tournament_id: category.tournamentId, name: "Azul" });
    database.insertFightIfNew({ id: "fight-a", tournament_id: category.tournamentId, red_id: "red", blue_id: "blue" });
    database.saveMatchSnapshot("fight-a", category.tournamentId, { match: {}, rules: {}, roundFlags: [] }, "category-a");
    const pendingInput = {
      fightId: "fight-a",
      categoryId: "category-a",
      tournamentId: category.tournamentId,
      winner: "red" as const,
      reason: "points",
      flagsRed: 2,
      flagsBlue: 1,
      warningsRed: 0,
      warningsBlue: 0,
      foulsRed: 0,
      foulsBlue: 0,
    };
    database.savePendingMatchResult(pendingInput);
    database.clearMatchSnapshot("fight-a", "category-a");
    database.default.close();

    vi.resetModules();
    const restartedDatabase = await import("./index");
    expect(restartedDatabase.getActiveMatchLock()).toMatchObject({
      fightId: "fight-a",
      categoryId: "category-a",
      resultStatus: "pending_confirmation",
    });
    expect(restartedDatabase.getMatchResult("category-a", "fight-a")?.status).toBe("pending_confirmation");

    const confirmed = restartedDatabase.confirmMatchResult(pendingInput);
    const repeated = restartedDatabase.confirmMatchResult(pendingInput);
    expect(confirmed.status).toBe("confirmed");
    expect(repeated.alreadyConfirmed).toBe(true);
    expect(restartedDatabase.countMatchResults("fight-a")).toBe(1);
    expect(restartedDatabase.getActiveMatchLock()).toBeNull();
    restartedDatabase.default.close();
  });

  it("retains the origin category on imported fights for delayed remote results", async () => {
    const database = await loadIsolatedDatabase();
    const category = database.resolveCategoryTournament({
      categoryId: "destination-category",
      tournamentName: "Torneo",
      categoryName: "Adultos",
    });
    database.upsertCompetitor({ id: "red", tournament_id: category.tournamentId, name: "Rojo" });
    database.upsertCompetitor({ id: "blue", tournament_id: category.tournamentId, name: "Azul" });
    database.upsertFight({
      id: "imported-fight",
      tournament_id: category.tournamentId,
      red_id: "red",
      blue_id: "blue",
      source_ring: "10.0.0.2:3001",
      source_category_id: "origin-category",
    });

    expect(database.getSourceCategoryId("imported-fight")).toBe("origin-category");
    database.default.close();
  });
});
