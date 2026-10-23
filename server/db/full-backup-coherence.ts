import { z } from "zod";

const fighter = z.object({ id: z.string().min(1) });
const snapshot = z.object({
  setupStarted: z.boolean(),
  phase: z.enum(["setup", "fighting", "results"]).optional(),
  config: z.object({ id: z.string().min(1) }),
  competitors: z.array(fighter),
  groups: z.array(z.unknown()).optional(),
  bracketMatches: z.array(z.unknown()).optional(),
  fights: z.array(
    z.object({ id: z.string().min(1), red: fighter, blue: fighter, completed: z.boolean() })
  ),
});
const registry = z.object({ version: z.literal(2), categories: z.record(z.string(), snapshot) });

export interface CoherentSql {
  tables: {
    category_tournaments: Array<{ category_id: string; tournament_id: number }>;
    fights: Array<{
      id: string;
      tournament_id: number | null;
      red_id: string | null;
      blue_id: string | null;
      completed: number;
    }>;
    competitors: Array<{ id: string; tournament_id: number | null }>;
    category_execution_archives?: Array<{ category_id: string }>;
    category_execution_deletions?: Array<{ category_id: string }>;
  };
}

export function assertBrowserSqlCoherent(sql: CoherentSql, rawRegistry: string | null): void {
  if (rawRegistry === null) {
    if (sql.tables.category_tournaments.length)
      throw new Error("Browser category registry missing SQL ownership");
    return;
  }
  const parsed = registry.parse(JSON.parse(rawRegistry) as unknown);
  const owners = new Map(
    sql.tables.category_tournaments.map((row) => [row.category_id, row.tournament_id])
  );
  const sqlFights = new Map(sql.tables.fights.map((row) => [row.id, row]));
  const sqlCompetitors = new Map(sql.tables.competitors.map((row) => [row.id, row]));
  const retired = new Set([
    ...(sql.tables.category_execution_archives ?? []).map((row) => row.category_id),
    ...(sql.tables.category_execution_deletions ?? []).map((row) => row.category_id),
  ]);
  for (const categoryId of owners.keys()) {
    if (!retired.has(categoryId) && !Object.hasOwn(parsed.categories, categoryId))
      throw new Error(`Active SQL category missing browser owner: ${categoryId}`);
  }
  for (const [categoryId, category] of Object.entries(parsed.categories)) {
    if (category.config.id !== categoryId) throw new Error("Browser category identity mismatch");
    const tournamentId = owners.get(categoryId);
    if (!tournamentId) {
      if (
        category.phase !== "setup" ||
        category.fights.length !== 0 ||
        (category.groups?.length ?? 0) !== 0 ||
        (category.bracketMatches?.length ?? 0) !== 0
      )
        throw new Error(`Browser category lacks SQL owner: ${categoryId}`);
      continue;
    }
    if (!category.setupStarted) continue;
    for (const competitor of category.competitors) {
      if (sqlCompetitors.get(competitor.id)?.tournament_id !== tournamentId)
        throw new Error(`Browser competitor lacks SQL ownership: ${competitor.id}`);
    }
    for (const fight of category.fights) {
      const row = sqlFights.get(fight.id);
      if (
        !row ||
        row.tournament_id !== tournamentId ||
        row.red_id !== fight.red.id ||
        row.blue_id !== fight.blue.id ||
        (row.completed === 1) !== fight.completed
      )
        throw new Error(`Browser fight differs from SQL: ${fight.id}`);
    }
  }
}
