import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { generateEliminationBracket, generateGroupsTournament } from "../../src/lib/bracket";
import type {
  CategoryRestartSnapshot,
  RestartCategoryRequest,
} from "../../src/lib/category-restart-contract";

let database: typeof import("./index.js") | null = null;
let directory: string | null = null;
afterEach(() => {
  database?.default.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  database = null;
  directory = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});
async function setup(): Promise<typeof import("./index.js")> {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-category-restart-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  database = await import("./index.js");
  return database;
}
function snapshot(mode: "round-robin" | "elimination" = "round-robin"): CategoryRestartSnapshot {
  const competitors = ["Uno", "Dos", "Tres"].map((name) => ({
    id: randomUUID(),
    name,
    team: "Club",
  }));
  const fixture =
    mode === "elimination" ? { groups: [], fights: [] } : generateGroupsTournament(competitors);
  const bracket =
    mode === "elimination" ? generateEliminationBracket(competitors) : { matches: [], seeds: [] };
  return {
    phase: "fighting",
    config: {
      id: randomUUID(),
      eventId: "event-one",
      tournamentName: "Evento",
      categoryName: "Categoría",
      tableChief: "Mesa",
      ruleSet: null,
      judgesCount: 3,
      mode,
      matchType: "sparring",
    },
    competitors,
    ...fixture,
    currentFightIndex: 0,
    bracketMatches: bracket.matches,
    bracketSeeds: bracket.seeds,
    setupStarted: true,
  };
}
function request(previousSnapshot = snapshot()): RestartCategoryRequest {
  const fresh = snapshot(
    previousSnapshot.config.mode === "elimination" ? "elimination" : "round-robin"
  );
  fresh.config = { ...previousSnapshot.config, id: fresh.config.id };
  fresh.competitors.forEach((entry, i) => {
    Object.assign(entry, { ...previousSnapshot.competitors[i], id: entry.id });
  });
  return {
    requestId: randomUUID(),
    categoryId: previousSnapshot.config.id,
    previousSnapshot,
    replacementSnapshot: fresh,
  };
}
function register(db: typeof import("./index.js"), graph: CategoryRestartSnapshot): number {
  const { tournamentId } = db.resolveCategoryTournament({
    categoryId: graph.config.id,
    categoryName: graph.config.categoryName,
    tournamentName: graph.config.tournamentName,
  });
  for (const entry of graph.competitors)
    db.upsertCompetitor({ ...entry, tournament_id: tournamentId });
  for (const fight of graph.fights)
    db.upsertFight({
      id: fight.id,
      tournament_id: tournamentId,
      red_id: fight.red.id,
      blue_id: fight.blue.id,
      group_id: fight.groupId,
    });
  return tournamentId;
}

it("archives exact old graph/SQL, creates fresh owned fixture, and returns canonical retries after reload", async () => {
  const db = await setup();
  const input = request();
  const sourceId = register(db, input.previousSnapshot);
  db.setSelectedTournamentId(sourceId);
  const before = db.default.prepare("SELECT * FROM fights WHERE tournament_id = ?").all(sourceId);
  const result = db.restartCategoryExecution(input);
  expect(result).toMatchObject({
    ok: true,
    categoryId: input.categoryId,
    replacementCategoryId: input.replacementSnapshot.config.id,
    replacementSnapshot: input.replacementSnapshot,
    archive: { sourceTournamentId: sourceId, provenance: "as-recorded" },
  });
  expect(db.default.prepare("SELECT * FROM fights WHERE tournament_id = ?").all(sourceId)).toEqual(
    before
  );
  expect(db.getCategoryArchive(sourceId)?.fullSnapshot).toEqual(input.previousSnapshot);
  expect(db.getFights(result.archive.replacementTournamentId)).toHaveLength(3);
  expect(db.getSelectedTournamentId()).toBe(result.archive.replacementTournamentId);
  expect(db.restartCategoryExecution(input)).toEqual(result);
  expect(() =>
    db.restartCategoryExecution({
      ...input,
      replacementSnapshot: { ...input.replacementSnapshot, currentFightIndex: 1 },
    })
  ).toThrowError(expect.objectContaining({ code: "request_id_conflict" }));
  expect(() => db.restartCategoryExecution({ ...input, requestId: randomUUID() })).toThrowError(
    expect.objectContaining({ code: "category_archived" })
  );
  db.default.close();
  vi.resetModules();
  database = await import("./index.js");
  expect(database.getCategoryReplacement(input.categoryId)).toEqual(result);
});

it("archives an unregistered local-only graph without claiming named legacy SQL or fabricating results", async () => {
  const db = await setup();
  const input = request();
  input.previousSnapshot.fights[0] = {
    ...input.previousSnapshot.fights[0],
    completed: true,
    winner: "blue",
    flagsBlue: 3,
    importedFrom: "T2",
  };
  const legacyId = db.createTournament("Evento", "Categoría");
  db.upsertCompetitor({ id: "legacy", name: "Uno", tournament_id: legacyId });
  db.setSelectedTournamentId(legacyId);
  const result = db.restartCategoryExecution(input);
  expect(result.archive.sourceTournamentId).not.toBe(legacyId);
  expect(db.getFights(result.archive.sourceTournamentId)).toEqual([]);
  expect(db.default.prepare("SELECT * FROM match_results").all()).toEqual([]);
  expect(db.getCategoryArchive(result.archive.sourceTournamentId)?.fullSnapshot).toEqual(
    input.previousSnapshot
  );
  expect(result.archive.warnings.join(" ")).toMatch(/local|registrad/i);
  expect(db.getSelectedTournamentId()).toBe(legacyId);
});

it("validates only authoritative intersections, preserves SQL extras, and rolls back stale snapshots", async () => {
  const db = await setup();
  const input = request();
  const sourceId = register(db, input.previousSnapshot);
  const fight = input.previousSnapshot.fights[0];
  const result = {
    fightId: fight.id,
    categoryId: input.categoryId,
    tournamentId: sourceId,
    winner: "red" as const,
    reason: "points",
    flagsRed: 3,
    flagsBlue: 0,
    warningsRed: 1,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 0,
  };
  db.confirmMatchResult(result);
  db.upsertFight({
    id: "unlinked-earlier-run",
    tournament_id: sourceId,
    red_id: fight.red.id,
    blue_id: fight.blue.id,
    completed: true,
    winner: "blue",
  });
  const countBefore = db.default.prepare("SELECT COUNT(*) AS n FROM tournaments").get();
  expect(() => db.restartCategoryExecution(input)).toThrowError(
    expect.objectContaining({ code: "snapshot_conflict" })
  );
  expect(db.default.prepare("SELECT COUNT(*) AS n FROM tournaments").get()).toEqual(countBefore);
  expect(db.getCategoryReplacement(input.categoryId)).toBeNull();
  Object.assign(fight, {
    completed: true,
    winner: "red",
    winReason: "points",
    flagsRed: 3,
    flagsBlue: 0,
    warningsRed: 1,
  });
  const archived = db.restartCategoryExecution(input);
  expect(archived.archive.warnings.join(" ")).toMatch(/vincul|unlinked/i);
  expect(db.getFights(sourceId)).toHaveLength(4);
  expect(db.getConfirmedMatchResult(input.categoryId, fight.id)).toMatchObject(result);
});

it("blocks durable pending matches anywhere and memory idle locks, but permits confirmed remnants", async () => {
  const db = await setup();
  const input = request();
  const other = snapshot();
  const otherId = register(db, other);
  db.saveMatchSnapshot(
    other.fights[0].id,
    otherId,
    { match: {}, rules: {}, roundFlags: [] },
    other.config.id
  );
  expect(() => db.restartCategoryExecution(input)).toThrowError(
    expect.objectContaining({ code: "active_match" })
  );
  db.clearMatchSnapshot();
  expect(() => db.restartCategoryExecution(input, { hasUnconfirmedMatch: true })).toThrowError(
    expect.objectContaining({ code: "active_match" })
  );
  const fight = other.fights[0];
  db.savePendingMatchResult({
    fightId: fight.id,
    categoryId: other.config.id,
    tournamentId: otherId,
    winner: "red",
    reason: "points",
    flagsRed: 3,
    flagsBlue: 0,
    warningsRed: 0,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 0,
  });
  expect(() => db.restartCategoryExecution(input)).toThrowError(
    expect.objectContaining({ code: "active_match" })
  );
  db.confirmMatchResult(db.getMatchResult(other.config.id, fight.id)!);
  expect(db.restartCategoryExecution(input).ok).toBe(true);
});

it("rejects recycled identities, changed config/entrant order, progress and fake byes", async () => {
  const db = await setup();
  const input = request();
  const assertConflict = (changed: RestartCategoryRequest): void => {
    expect(() => db.restartCategoryExecution(changed)).toThrowError(
      expect.objectContaining({ code: "snapshot_conflict" })
    );
    expect(db.getCategoryReplacement(input.categoryId)).toBeNull();
  };
  assertConflict({ ...input, replacementSnapshot: input.previousSnapshot });
  assertConflict({
    ...input,
    replacementSnapshot: {
      ...input.replacementSnapshot,
      config: { ...input.replacementSnapshot.config, eventId: "changed" },
    },
  });
  assertConflict({
    ...input,
    replacementSnapshot: {
      ...input.replacementSnapshot,
      competitors: [...input.replacementSnapshot.competitors].reverse(),
    },
  });
  const progressed = structuredClone(input);
  Object.assign(progressed.replacementSnapshot.fights[0], { completed: true, winner: "red" });
  assertConflict(progressed);
  const elimination = request(snapshot("elimination"));
  const future = elimination.replacementSnapshot.bracketMatches.find((entry) => entry.round > 0)!;
  future.completed = true;
  future.winnerId = elimination.replacementSnapshot.competitors[0].id;
  assertConflict(elimination);
  const clean = request(snapshot("elimination"));
  expect(db.restartCategoryExecution(clean).replacementSnapshot).toEqual(clean.replacementSnapshot);
});

it("rejects altered embedded entrant display data and nonstandard regular-fight stage markers", async () => {
  const db = await setup();
  const elimination = request(snapshot("elimination"));
  const side = elimination.replacementSnapshot.bracketMatches.find(
    (entry) => entry.red.competitor
  )?.red;
  side!.competitor = { ...side!.competitor!, name: "Injected display name" };
  expect(() => db.restartCategoryExecution(elimination)).toThrowError(
    expect.objectContaining({ code: "snapshot_conflict" })
  );
  for (const stage of [{ isFinalFight: true }, { bracketRound: 2 }, { tiebreakerSeconds: 99 }]) {
    const input = request();
    Object.assign(input.replacementSnapshot.fights[0], stage);
    expect(() => db.restartCategoryExecution(input)).toThrowError(
      expect.objectContaining({ code: "snapshot_conflict" })
    );
  }
});

it("rolls back injected archive failure without selection or partial replacement changes", async () => {
  const db = await setup();
  const input = request();
  const sourceId = register(db, input.previousSnapshot);
  db.setSelectedTournamentId(sourceId);
  const before = db.default.prepare("SELECT * FROM tournaments").all();
  db.default.exec(
    "CREATE TRIGGER fail_archive BEFORE INSERT ON category_execution_archives BEGIN SELECT RAISE(ABORT, 'injected archive failure'); END"
  );
  expect(() => db.restartCategoryExecution(input)).toThrow("injected archive failure");
  expect(db.default.prepare("SELECT * FROM tournaments").all()).toEqual(before);
  expect(db.getSelectedTournamentId()).toBe(sourceId);
  expect(db.getCategoryTournamentId(input.replacementSnapshot.config.id)).toBeNull();
});

it("guards every archived SQL owner before replacement or result writes and keeps historic reads", async () => {
  const db = await setup();
  const input = request();
  const sourceId = register(db, input.previousSnapshot);
  const fight = input.previousSnapshot.fights[0];
  const resultInput = {
    fightId: fight.id,
    categoryId: input.categoryId,
    tournamentId: sourceId,
    winner: "red" as const,
    reason: "points",
    flagsRed: 3,
    flagsBlue: 0,
    warningsRed: 0,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 0,
  };
  db.confirmMatchResult(resultInput);
  Object.assign(fight, { completed: true, winner: "red", flagsRed: 3 });
  const archived = db.restartCategoryExecution(input);
  const before = db.default.prepare("SELECT * FROM fights WHERE tournament_id = ?").all(sourceId);
  const actions = [
    () =>
      db.resolveCategoryTournament({
        categoryId: input.categoryId,
        categoryName: "X",
        tournamentName: "X",
      }),
    () => db.setSelectedTournamentId(sourceId),
    () => db.renameTournament(sourceId, "Changed", "Changed"),
    () => db.clearTournamentData(sourceId),
    () => db.deletePendingFights(sourceId),
    () =>
      db.upsertCompetitor({ ...input.previousSnapshot.competitors[0], tournament_id: sourceId }),
    () => db.deleteCompetitor(input.previousSnapshot.competitors[0].id),
    () =>
      db.upsertFight({
        id: fight.id,
        tournament_id: archived.archive.replacementTournamentId,
        red_id: input.replacementSnapshot.competitors[0].id,
        blue_id: input.replacementSnapshot.competitors[1].id,
      }),
    () =>
      db.insertFightIfNew({
        id: fight.id,
        tournament_id: sourceId,
        red_id: fight.red.id,
        blue_id: fight.blue.id,
      }),
    () => db.completeFight(fight.id, "blue", "points"),
    () => db.savePendingMatchResult(resultInput),
    () => db.confirmMatchResult(resultInput),
    () =>
      db.saveMatchSnapshot(
        fight.id,
        sourceId,
        { match: {}, rules: {}, roundFlags: [] },
        input.categoryId
      ),
  ];
  for (const action of actions) {
    expect(action).toThrowError(
      expect.objectContaining({
        code: "category_archived",
        replacementCategoryId: archived.replacementCategoryId,
      })
    );
  }
  expect(db.default.prepare("SELECT * FROM fights WHERE tournament_id = ?").all(sourceId)).toEqual(
    before
  );
  expect(db.getConfirmedMatchResult(input.categoryId, fight.id)).toMatchObject({ winner: "red" });
  expect(db.getActiveMatchLock()).toBeNull();
});

it("does not let an as-recorded local archive capture an unrelated durable participant owner", async () => {
  const db = await setup();
  const other = snapshot();
  const otherId = register(db, other);
  const input = request();
  input.previousSnapshot.competitors[0] = other.competitors[0];
  // Foreign participant aliases in a local graph are not a durable ownership reassignment.
  db.restartCategoryExecution(input);
  expect(() => db.assertCompetitorWritable(other.competitors[0].id)).not.toThrow();
  expect(() =>
    db.upsertCompetitor({ ...other.competitors[0], name: "Updated", tournament_id: otherId })
  ).not.toThrow();
  expect(
    db.getCompetitors(otherId).find((entry) => entry.id === other.competitors[0].id)?.name
  ).toBe("Updated");
});

for (const [mode, count] of [["elimination", 0], ["elimination", 1], ["round-robin", 0], ["round-robin", 1], ["round-robin", 2]] as const) {
  it(`durably restarts ${mode} with ${count} entrants as a clean setup draft`, async () => {
    const db = await setup();
    const previous = snapshot(mode);
    const sourceId = register(db, previous);
    const oldRows = db.getFights(sourceId);
    previous.competitors = previous.competitors.slice(0, count);
    const before = structuredClone(previous);
    const next: CategoryRestartSnapshot = { ...structuredClone(previous),
      config: { ...previous.config, id: randomUUID() },
      competitors: previous.competitors.map((entry) => ({ ...entry, id: randomUUID() })),
      phase: "setup", setupStarted: false, currentFightIndex: 0,
      fights: [], groups: [], bracketMatches: [], bracketSeeds: [] };
    const operation = { requestId: randomUUID(), categoryId: previous.config.id, previousSnapshot: previous, replacementSnapshot: next };
    const result = db.restartCategoryExecution(operation);
    expect(result.replacementSnapshot).toEqual(next);
    const replacementId = db.getCategoryTournamentId(next.config.id);
    expect(replacementId).not.toBeNull();
    expect(db.getFights(replacementId!)).toEqual([]);
    expect(db.getCompetitors(replacementId!)).toHaveLength(count);
    expect(db.restartCategoryExecution(operation)).toEqual(result);
    expect(previous).toEqual(before);
    expect(db.getFights(sourceId)).toEqual(oldRows);
    expect(db.getCategoryArchive(sourceId)?.fullSnapshot).toEqual(before);
  });
}

it.each(["sufficient", "started", "fighting", "index", "seeds", "foreign-config", "roster", "reused-id"])("rejects forged draft %s atomically", async (fault) => {
  const db = await setup();
  const previous = snapshot();
  const sourceId = register(db, previous);
  previous.competitors = previous.competitors.slice(0, fault === "sufficient" ? 3 : 1);
  const next: CategoryRestartSnapshot = { ...structuredClone(previous),
    config: { ...previous.config, id: randomUUID() },
    competitors: previous.competitors.map((entry) => ({ ...entry, id: randomUUID() })),
    phase: "setup", setupStarted: false, currentFightIndex: 0,
    fights: [], groups: [], bracketMatches: [], bracketSeeds: [] };
  if (fault === "started") next.setupStarted = true;
  if (fault === "fighting") next.phase = "fighting";
  if (fault === "index") next.currentFightIndex = 1;
  if (fault === "seeds") next.bracketSeeds = [null];
  if (fault === "foreign-config") next.config.eventId = "another-event";
  if (fault === "roster") next.competitors[0].name = "Changed";
  if (fault === "reused-id") next.competitors[0].id = previous.competitors[0].id;
  const before = db.getFights(sourceId);
  expect(() => db.restartCategoryExecution({ requestId: randomUUID(), categoryId: previous.config.id,
    previousSnapshot: previous, replacementSnapshot: next })).toThrow();
  expect(db.getFights(sourceId)).toEqual(before);
  expect(db.getCategoryTournamentId(next.config.id)).toBeNull();
  expect(db.getCategoryArchive(sourceId)).toBeNull();
});
