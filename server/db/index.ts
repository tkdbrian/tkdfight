import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import {
  assertCategoryWritable, assertTournamentWritable, assertFightWritable, assertCompetitorWritable,
} from './category-executions.js'
export {
  restartCategoryExecution, getCategoryReplacement, getCategoryArchive,
  assertCategoryWritable, assertTournamentWritable, assertFightWritable, assertCompetitorWritable,
  isProtectedHistoryTournament, CategoryExecutionError,
} from './category-executions.js'
export {
  previewCategoryDeletion, deleteCategoryExecution, getCategoryDeletion,
  getCategoryDeletionTombstones, getDeletedCategoryReplacement, isDeletedTournament,
  assertCategoryNotDeleted, assertTournamentNotDeleted, assertIdentityNotDeleted,
  assertReplacementNotDeleted, CategoryDeletionError,
} from './category-deletions.js'
export { deleteAndRestartCategoryExecution, getCategoryDeleteAndRestart, CategoryRestartModeError } from './category-restart-modes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', '..', 'data')

mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(path.join(DATA_DIR, 'tournament.db'))

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// ── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS tournaments (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT    NOT NULL DEFAULT 'Torneo',
    category TEXT    NOT NULL DEFAULT '',
    created_at TEXT  NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS competitors (
    id            TEXT PRIMARY KEY,
    tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    team          TEXT,
    weight        REAL,
    belt          TEXT
  );

  CREATE TABLE IF NOT EXISTS fights (
    id            TEXT PRIMARY KEY,
    tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
    red_id        TEXT REFERENCES competitors(id),
    blue_id       TEXT REFERENCES competitors(id),
    completed     INTEGER NOT NULL DEFAULT 0,
    winner        TEXT,
    reason        TEXT,
    round_index   INTEGER,
    group_id      TEXT,
    flags_red     INTEGER NOT NULL DEFAULT 0,
    flags_blue    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS presets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT    NOT NULL,
    round_count         INTEGER NOT NULL DEFAULT 1,
    duration_seconds    INTEGER NOT NULL DEFAULT 60,
    final_rounds        INTEGER,
    final_seconds       INTEGER,
    tiebreaker_seconds  INTEGER,
    max_tiebreakers     INTEGER,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// Migrations for existing DBs (columns may not exist yet)
for (const col of ['group_id TEXT', 'flags_red INTEGER NOT NULL DEFAULT 0', 'flags_blue INTEGER NOT NULL DEFAULT 0', 'source_ring TEXT', 'source_category_id TEXT', 'result_revision INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(`ALTER TABLE fights ADD COLUMN ${col}`) } catch { /* already exists */ }
}

// ── Indexes ──────────────────────────────────────────────────────────────────
// Sin estos, getFights/getQueue hacen full scan en cada llamada.

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_fights_tournament_completed ON fights(tournament_id, completed);
  CREATE INDEX IF NOT EXISTS idx_fights_tournament ON fights(tournament_id);
  CREATE INDEX IF NOT EXISTS idx_competitors_tournament ON competitors(tournament_id);
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS category_tournaments (
    category_id TEXT PRIMARY KEY,
    tournament_id INTEGER NOT NULL UNIQUE REFERENCES tournaments(id) ON DELETE CASCADE,
    legacy_history_unassigned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS match_results (
    fight_id TEXT PRIMARY KEY REFERENCES fights(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    winner TEXT NOT NULL CHECK (winner IN ('red', 'blue', 'draw')),
    reason TEXT NOT NULL,
    flags_red INTEGER NOT NULL DEFAULT 0,
    flags_blue INTEGER NOT NULL DEFAULT 0,
    warnings_red INTEGER NOT NULL DEFAULT 0,
    warnings_blue INTEGER NOT NULL DEFAULT 0,
    fouls_red INTEGER NOT NULL DEFAULT 0,
    fouls_blue INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending_confirmation', 'confirmed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    confirmed_at TEXT
  );
`)

// One selection per DATA_DIR. A foreign key clears stale selections when history is deleted.
db.exec(`
  CREATE TABLE IF NOT EXISTS ring_selection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    tournament_id INTEGER REFERENCES tournaments(id) ON DELETE SET NULL
  )
`)

try { db.exec('ALTER TABLE category_tournaments ADD COLUMN legacy_history_unassigned INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }
try { db.exec('ALTER TABLE ring_selection ADD COLUMN explicitly_cleared INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }

// Execution archives are additive. Both generations survive ordinary history cleanup.
db.exec(`
  CREATE TABLE IF NOT EXISTS category_execution_archives (
    category_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    replacement_category_id TEXT NOT NULL UNIQUE,
    source_tournament_id INTEGER NOT NULL UNIQUE REFERENCES tournaments(id) ON DELETE RESTRICT,
    replacement_tournament_id INTEGER NOT NULL UNIQUE REFERENCES tournaments(id) ON DELETE RESTRICT,
    archived_at TEXT NOT NULL,
    previous_snapshot TEXT NOT NULL,
    replacement_snapshot TEXT NOT NULL,
    warnings TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS category_execution_deletions (
    category_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    tournament_id INTEGER UNIQUE REFERENCES tournaments(id) ON DELETE RESTRICT,
    deleted_at TEXT NOT NULL,
    counts TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS category_deletion_identities (
    kind TEXT NOT NULL CHECK(kind IN ('competitor', 'fight', 'bracket')),
    identity_id TEXT NOT NULL,
    category_id TEXT NOT NULL REFERENCES category_execution_deletions(category_id) ON DELETE RESTRICT,
    PRIMARY KEY(kind, identity_id)
  );
  CREATE TABLE IF NOT EXISTS category_execution_deleted_restarts (
    category_id TEXT PRIMARY KEY REFERENCES category_execution_deletions(category_id) ON DELETE RESTRICT,
    request_id TEXT NOT NULL UNIQUE REFERENCES category_execution_deletions(request_id) ON DELETE RESTRICT,
    replacement_category_id TEXT NOT NULL UNIQUE REFERENCES category_tournaments(category_id) ON DELETE RESTRICT,
    replacement_snapshot TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode = 'delete-and-restart')
  );
`)

// ── Tournaments ──────────────────────────────────────────────────────────────

export function createTournament(name: string, category: string): number {
  const result = db.prepare('INSERT INTO tournaments (name, category) VALUES (?, ?)').run(name, category)
  return result.lastInsertRowid as number
}

export interface CategoryTournament {
  tournamentId: number
  legacyHistoryUnassigned: boolean
}

export interface LegacyFightFingerprint {
  id: string
  red_id: string
  blue_id: string
}

function tournamentHasData(tournamentId: number): boolean {
  const row = db.prepare(`
    SELECT
      EXISTS(SELECT 1 FROM competitors WHERE tournament_id = ?) OR
      EXISTS(SELECT 1 FROM fights WHERE tournament_id = ?) AS has_data
  `).get(tournamentId, tournamentId) as { has_data: number }
  return row.has_data === 1
}

function hasUnassignedLegacyHistory(): boolean {
  const row = db.prepare(`
    SELECT EXISTS(
      SELECT 1 FROM tournaments t
      WHERE NOT EXISTS (
        SELECT 1 FROM category_tournaments ct WHERE ct.tournament_id = t.id
      ) AND (
        EXISTS(SELECT 1 FROM competitors c WHERE c.tournament_id = t.id) OR
        EXISTS(SELECT 1 FROM fights f WHERE f.tournament_id = t.id)
      )
    ) AS has_history
  `).get() as { has_history: number }
  return row.has_history === 1
}

export function resolveCategoryTournament(input: {
  categoryId: string
  tournamentName: string
  categoryName: string
  preferredTournamentId?: number
  legacyFights?: LegacyFightFingerprint[]
  legacyCompetitorIds?: string[]
}): CategoryTournament {
  assertCategoryWritable(input.categoryId)
  return db.transaction(() => {
    const existing = db.prepare('SELECT tournament_id, legacy_history_unassigned FROM category_tournaments WHERE category_id = ?').get(input.categoryId) as { tournament_id: number; legacy_history_unassigned: number } | undefined
    if (existing) return { tournamentId: existing.tournament_id, legacyHistoryUnassigned: existing.legacy_history_unassigned === 1 }

    let tournamentId: number | undefined
    const fingerprintFights = input.legacyFights ?? []
    const fingerprintCompetitors = new Set(input.legacyCompetitorIds ?? [])
    if (fingerprintFights.length > 0) {
      const unassigned = db.prepare(`
        SELECT t.id FROM tournaments t
        WHERE NOT EXISTS (SELECT 1 FROM category_tournaments ct WHERE ct.tournament_id = t.id)
      `).all() as Array<{ id: number }>
      const matchingCandidates = unassigned.filter(({ id }) => {
        const storedFights = db.prepare('SELECT id, red_id, blue_id FROM fights WHERE tournament_id = ?').all(id) as LegacyFightFingerprint[]
        if (storedFights.length !== fingerprintFights.length) return false
        const expectedFights = new Map(fingerprintFights.map((fight) => [fight.id, fight]))
        if (storedFights.some((fight) => {
          const expected = expectedFights.get(fight.id)
          return !expected || expected.red_id !== fight.red_id || expected.blue_id !== fight.blue_id
        })) return false
        const storedCompetitors = db.prepare('SELECT id FROM competitors WHERE tournament_id = ?').all(id) as Array<{ id: string }>
        return storedCompetitors.length === fingerprintCompetitors.size
          && storedCompetitors.every(({ id: competitorId }) => fingerprintCompetitors.has(competitorId))
      })
      if (matchingCandidates.length === 1) tournamentId = matchingCandidates[0].id
    }
    const legacyHistoryUnassigned = !tournamentId && hasUnassignedLegacyHistory()
    if (input.preferredTournamentId && !tournamentHasData(input.preferredTournamentId)) {
      const owner = db.prepare('SELECT category_id FROM category_tournaments WHERE tournament_id = ?').get(input.preferredTournamentId)
      if (!owner && !tournamentId) tournamentId = input.preferredTournamentId
    }
    if (!tournamentId) {
      const created = db.prepare('INSERT INTO tournaments (name, category) VALUES (?, ?)')
        .run(input.tournamentName || 'Torneo', input.categoryName)
      tournamentId = Number(created.lastInsertRowid)
    }
    db.prepare('INSERT INTO category_tournaments (category_id, tournament_id, legacy_history_unassigned) VALUES (?, ?, ?)')
      .run(input.categoryId, tournamentId, legacyHistoryUnassigned ? 1 : 0)
    return { tournamentId, legacyHistoryUnassigned }
  })()
}

export function getCategoryTournamentId(categoryId: string): number | null {
  const row = db.prepare('SELECT tournament_id FROM category_tournaments WHERE category_id = ?').get(categoryId) as { tournament_id: number } | undefined
  return row?.tournament_id ?? null
}

export function getTournamentCategoryId(tournamentId: number): string | null {
  const row = db.prepare('SELECT category_id FROM category_tournaments WHERE tournament_id = ?').get(tournamentId) as { category_id: string } | undefined
  return row?.category_id ?? null
}

export function getTournament(id: number) {
  return db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id) as {
    id: number; name: string; category: string; created_at: string
  } | undefined
}

export function getLatestTournament() {
  return db.prepare(`SELECT * FROM tournaments t WHERE NOT EXISTS (
    SELECT 1 FROM category_execution_deletions d WHERE d.tournament_id = t.id
  ) ORDER BY id DESC LIMIT 1`).get() as {
    id: number; name: string; category: string; created_at: string
  } | undefined
}

export function getSelectedTournamentId(): number | null {
  const row = db.prepare(`
    SELECT t.id FROM ring_selection s
    JOIN tournaments t ON t.id = s.tournament_id
    WHERE s.id = 1 AND NOT EXISTS (SELECT 1 FROM category_execution_deletions d WHERE d.tournament_id = t.id)
  `).get() as { id: number } | undefined
  return row?.id ?? null
}

export function setSelectedTournamentId(tournamentId: number): void {
  assertTournamentWritable(tournamentId)
  if (!getTournament(tournamentId)) throw new Error(`Tournament ${tournamentId} does not exist`)
  db.prepare(`
    INSERT INTO ring_selection (id, tournament_id) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET tournament_id = excluded.tournament_id, explicitly_cleared = 0
  `).run(tournamentId)
}

export function getStartupTournamentId(): number | null {
  const lockTournamentId = getActiveMatchLock()?.tournamentId
  if (lockTournamentId && getTournament(lockTournamentId)) return lockTournamentId

  const selection = db.prepare('SELECT explicitly_cleared FROM ring_selection WHERE id = 1').get() as { explicitly_cleared: number } | undefined
  if (selection?.explicitly_cleared === 1) return null

  const selectedId = getSelectedTournamentId()
  if (selectedId !== null) return selectedId

  // Old installations had no durable selection. Keep their former startup behavior.
  const writable = db.prepare(`SELECT t.id FROM tournaments t WHERE NOT EXISTS (
    SELECT 1 FROM category_execution_deletions d WHERE d.tournament_id = t.id
  ) AND NOT EXISTS (SELECT 1 FROM category_execution_archives a WHERE a.source_tournament_id = t.id)
    ORDER BY t.id DESC LIMIT 1`).get() as { id: number } | undefined
  return writable?.id ?? null
}

/** Internal inert workspace after explicit deselection, never an implicit public activation. */
export function getRetiredIdleTournamentId(): number | null {
  const selection = db.prepare('SELECT explicitly_cleared FROM ring_selection WHERE id = 1').get() as { explicitly_cleared: number } | undefined
  if (selection?.explicitly_cleared !== 1) return null
  const row = db.prepare('SELECT tournament_id FROM category_execution_deletions WHERE tournament_id IS NOT NULL ORDER BY deleted_at DESC LIMIT 1').get() as { tournament_id: number } | undefined
  return row?.tournament_id ?? null
}

export function renameTournament(id: number, name: string, category: string) {
  assertTournamentWritable(id)
  db.prepare('UPDATE tournaments SET name = ?, category = ? WHERE id = ?').run(name, category, id)
}

export function getCompetitorCount(tournamentId: number): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM competitors WHERE tournament_id = ?').get(tournamentId) as { cnt: number }
  return row.cnt
}

export function deletePendingFights(tournamentId: number) {
  assertTournamentWritable(tournamentId)
  db.prepare('DELETE FROM fights WHERE tournament_id = ? AND completed = 0').run(tournamentId)
}

export function clearTournamentData(tournamentId: number) {
  assertTournamentWritable(tournamentId)
  db.prepare('DELETE FROM fights WHERE tournament_id = ?').run(tournamentId)
  db.prepare('DELETE FROM competitors WHERE tournament_id = ?').run(tournamentId)
}

// ── Competitors ──────────────────────────────────────────────────────────────

export function upsertCompetitor(c: {
  id: string
  tournament_id: number
  name: string
  team?: string
  weight?: number
  belt?: string
}) {
  assertTournamentWritable(c.tournament_id)
  assertCompetitorWritable(c.id)
  const existing = db.prepare('SELECT tournament_id FROM competitors WHERE id = ?').get(c.id) as { tournament_id: number | null } | undefined
  if (existing && existing.tournament_id !== c.tournament_id) {
    throw new Error(`competitor ${c.id} already belongs to another tournament`)
  }
  db.prepare(`
    INSERT INTO competitors (id, tournament_id, name, team, weight, belt)
    VALUES (@id, @tournament_id, @name, @team, @weight, @belt)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      team = excluded.team,
      weight = excluded.weight,
      belt = excluded.belt
  `).run({ weight: null, belt: null, team: null, ...c })
}

export function getCompetitors(tournamentId: number) {
  return db.prepare('SELECT * FROM competitors WHERE tournament_id = ?').all(tournamentId) as {
    id: string; name: string; team?: string; weight?: number; belt?: string
  }[]
}

export function deleteCompetitor(id: string) {
  assertCompetitorWritable(id)
  db.prepare('DELETE FROM competitors WHERE id = ?').run(id)
}

// ── Fights ───────────────────────────────────────────────────────────────────

export function upsertFight(f: {
  id: string
  tournament_id: number
  red_id: string
  blue_id: string
  completed?: boolean
  winner?: string
  reason?: string
  round_index?: number
  group_id?: string
  flags_red?: number
  flags_blue?: number
  source_ring?: string
  source_category_id?: string
}) {
  assertTournamentWritable(f.tournament_id)
  assertFightWritable(f.id)
  assertCompetitorWritable(f.red_id)
  assertCompetitorWritable(f.blue_id)
  const owner = db.prepare('SELECT tournament_id FROM fights WHERE id = ?').get(f.id) as { tournament_id: number } | undefined
  if (owner && owner.tournament_id !== f.tournament_id) throw new Error('fight already belongs to another tournament')
  db.prepare(`
    INSERT OR REPLACE INTO fights (id, tournament_id, red_id, blue_id, completed, winner, reason, round_index, group_id, flags_red, flags_blue, source_ring, source_category_id)
    VALUES (@id, @tournament_id, @red_id, @blue_id, @completed, @winner, @reason, @round_index, @group_id, @flags_red, @flags_blue, @source_ring, @source_category_id)
  `).run({ winner: null, reason: null, round_index: null, group_id: null, source_ring: null, source_category_id: null, ...f, completed: f.completed ? 1 : 0, flags_red: f.flags_red ?? 0, flags_blue: f.flags_blue ?? 0 })
}

// Insert only if the fight doesn't already exist (preserves group_id/round_index from import-fights)
export function insertFightIfNew(f: {
  id: string
  tournament_id: number
  red_id: string
  blue_id: string
}) {
  assertTournamentWritable(f.tournament_id)
  assertFightWritable(f.id)
  assertCompetitorWritable(f.red_id)
  assertCompetitorWritable(f.blue_id)
  const existing = db.prepare('SELECT tournament_id, red_id, blue_id FROM fights WHERE id = ?').get(f.id) as {
    tournament_id: number | null; red_id: string; blue_id: string
  } | undefined
  if (existing) {
    if (existing.tournament_id !== f.tournament_id || existing.red_id !== f.red_id || existing.blue_id !== f.blue_id) {
      throw new Error(`fight ${f.id} is already associated with different category data`)
    }
    return false
  }
  db.prepare(`
    INSERT INTO fights (id, tournament_id, red_id, blue_id, completed, flags_red, flags_blue)
    VALUES (@id, @tournament_id, @red_id, @blue_id, 0, 0, 0)
  `).run(f)
  return true
}

export function completeFight(id: string, winner: string, reason: string, flagsRed = 0, flagsBlue = 0) {
  assertFightWritable(id)
  db.prepare('UPDATE fights SET completed = 1, winner = ?, reason = ?, flags_red = ?, flags_blue = ? WHERE id = ?').run(winner, reason, flagsRed, flagsBlue, id)
}

export const FIGHT_WINNERS = ['red', 'blue', 'draw'] as const
export type FightWinner = (typeof FIGHT_WINNERS)[number]

export interface MatchResultInput {
  fightId: string
  categoryId: string
  tournamentId: number
  winner: FightWinner
  reason: string
  flagsRed: number
  flagsBlue: number
  warningsRed: number
  warningsBlue: number
  foulsRed: number
  foulsBlue: number
}

export interface StoredMatchResult extends MatchResultInput {
  status: 'pending_confirmation' | 'confirmed'
  alreadyConfirmed: boolean
  /** Monotonic fight revision; invalidating a pending result must never recycle it. */
  revision: number
}

interface MatchResultRow {
  fight_id: string
  category_id: string
  tournament_id: number
  winner: FightWinner
  reason: string
  flags_red: number
  flags_blue: number
  warnings_red: number
  warnings_blue: number
  fouls_red: number
  fouls_blue: number
  status: StoredMatchResult['status']
}

function mapMatchResult(row: MatchResultRow, alreadyConfirmed = false): StoredMatchResult {
  return {
    fightId: row.fight_id,
    categoryId: row.category_id,
    tournamentId: row.tournament_id,
    winner: row.winner,
    reason: row.reason,
    flagsRed: row.flags_red,
    flagsBlue: row.flags_blue,
    warningsRed: row.warnings_red,
    warningsBlue: row.warnings_blue,
    foulsRed: row.fouls_red,
    foulsBlue: row.fouls_blue,
    status: row.status,
    alreadyConfirmed,
    revision: getMatchResultRevision(row.category_id, row.fight_id),
  }
}

function assertMatchResultOwnership(input: MatchResultInput): { completed: number } {
  assertCategoryWritable(input.categoryId)
  assertTournamentWritable(input.tournamentId)
  assertFightWritable(input.fightId)
  const category = db.prepare('SELECT tournament_id FROM category_tournaments WHERE category_id = ?')
    .get(input.categoryId) as { tournament_id: number } | undefined
  if (!category || category.tournament_id !== input.tournamentId) {
    throw new Error('category does not own this tournament')
  }
  const fight = db.prepare('SELECT tournament_id, completed FROM fights WHERE id = ?')
    .get(input.fightId) as { tournament_id: number; completed: number } | undefined
  if (!fight || fight.tournament_id !== input.tournamentId) {
    throw new Error('fight does not belong to this category')
  }
  return fight
}

function sameResult(row: MatchResultRow, input: MatchResultInput): boolean {
  return row.category_id === input.categoryId
    && row.tournament_id === input.tournamentId
    && row.winner === input.winner
    && row.reason === input.reason
    && row.flags_red === input.flagsRed
    && row.flags_blue === input.flagsBlue
    && row.warnings_red === input.warningsRed
    && row.warnings_blue === input.warningsBlue
    && row.fouls_red === input.foulsRed
    && row.fouls_blue === input.foulsBlue
}

function persistPendingResult(input: MatchResultInput): StoredMatchResult {
  const fight = assertMatchResultOwnership(input)
  const existing = db.prepare('SELECT * FROM match_results WHERE fight_id = ?').get(input.fightId) as MatchResultRow | undefined
  if (existing) {
    if (!sameResult(existing, input)) throw new Error('a different result is already stored for this fight')
    return mapMatchResult(existing)
  }
  if (fight.completed === 1) throw new Error('fight is already completed without a result record')

  db.prepare(`
    INSERT INTO match_results (
      fight_id, category_id, tournament_id, winner, reason,
      flags_red, flags_blue, warnings_red, warnings_blue, fouls_red, fouls_blue, status
    ) VALUES (
      @fightId, @categoryId, @tournamentId, @winner, @reason,
      @flagsRed, @flagsBlue, @warningsRed, @warningsBlue, @foulsRed, @foulsBlue, 'pending_confirmation'
    )
  `).run(input)
  const updated = db.prepare(`
    UPDATE fights SET completed = 1, winner = @winner, reason = @reason,
      flags_red = @flagsRed, flags_blue = @flagsBlue
    WHERE id = @fightId AND tournament_id = @tournamentId AND completed = 0
  `).run(input)
  if (updated.changes !== 1) throw new Error('fight result could not be persisted')
  return { ...input, status: 'pending_confirmation', alreadyConfirmed: false,
    revision: getMatchResultRevision(input.categoryId, input.fightId) }
}

export function savePendingMatchResult(input: MatchResultInput): StoredMatchResult {
  return db.transaction(() => persistPendingResult(input))()
}

/** Commit the final Golden Point snapshot and pending result as one durable operation. */
export function savePendingMatchResultWithSnapshot(
  input: MatchResultInput,
  snapshot: MatchSnapshotData,
): StoredMatchResult {
  return db.transaction(() => {
    if (getMatchResult(input.categoryId, input.fightId)) {
      throw new Error('a result is already stored for this fight')
    }
    saveMatchSnapshot(input.fightId, input.tournamentId, snapshot, input.categoryId)
    return persistPendingResult(input)
  })()
}

export interface SanctionResultMetrics {
  warningsRed: number
  warningsBlue: number
  foulsRed: number
  foulsBlue: number
}

/** Post-clock corrections must update recovery state and provisional ranking metrics together. */
export function saveMatchSanctionEdit(
  fightId: string,
  categoryId: string,
  tournamentId: number,
  snapshot: MatchSnapshotData,
  metrics: SanctionResultMetrics,
): StoredMatchResult | null {
  assertCategoryWritable(categoryId)
  assertTournamentWritable(tournamentId)
  assertFightWritable(fightId)
  return db.transaction(() => {
    const category = db.prepare('SELECT tournament_id FROM category_tournaments WHERE category_id = ?')
      .get(categoryId) as { tournament_id: number } | undefined
    const fight = db.prepare('SELECT tournament_id, completed FROM fights WHERE id = ?')
      .get(fightId) as { tournament_id: number; completed: number } | undefined
    if (!category || category.tournament_id !== tournamentId ||
      !fight || fight.tournament_id !== tournamentId) {
      throw new Error('category does not own this fight')
    }
    const row = db.prepare('SELECT * FROM match_results WHERE fight_id = ?')
      .get(fightId) as MatchResultRow | undefined
    if (row && (row.category_id !== categoryId || row.tournament_id !== tournamentId ||
      row.status !== 'pending_confirmation')) {
      throw new Error('result already confirmed or belongs to another category')
    }
    if (!row && snapshot.matchState?.phase === 'finished') {
      throw new Error('finished match has no pending result')
    }
    if (!row && fight.completed === 1) throw new Error('fight already completed without a pending result')
    saveMatchSnapshot(fightId, tournamentId, snapshot, categoryId)
    if (!row) return null
    const updated = db.prepare(`
      UPDATE match_results
      SET warnings_red = @warningsRed, warnings_blue = @warningsBlue,
          fouls_red = @foulsRed, fouls_blue = @foulsBlue
      WHERE fight_id = @fightId AND category_id = @categoryId AND status = 'pending_confirmation'
    `).run({ ...metrics, fightId, categoryId })
    if (updated.changes !== 1) throw new Error('pending result could not be updated')
    const adjusted = db.prepare('SELECT * FROM match_results WHERE fight_id = ?').get(fightId) as MatchResultRow
    return mapMatchResult(adjusted)
  })()
}

export function confirmMatchResult(input: MatchResultInput, expectedRevision = 0): StoredMatchResult {
  return db.transaction(() => {
    if (getMatchResultRevision(input.categoryId, input.fightId) !== expectedRevision) {
      throw new Error('stale result revision')
    }
    const result = persistPendingResult(input)
    if (result.status === 'confirmed') {
      clearMatchSnapshot(input.fightId, input.categoryId)
      return { ...result, alreadyConfirmed: true }
    }
    db.prepare(`
      UPDATE match_results SET status = 'confirmed', confirmed_at = datetime('now')
      WHERE fight_id = ? AND category_id = ? AND status = 'pending_confirmation'
    `).run(input.fightId, input.categoryId)
    clearMatchSnapshot(input.fightId, input.categoryId)
    const confirmedResult: StoredMatchResult = { ...result, status: 'confirmed', alreadyConfirmed: false }
    return confirmedResult
  })()
}

export function getConfirmedMatchResult(categoryId: string, fightId: string): StoredMatchResult | null {
  const row = db.prepare(`
    SELECT * FROM match_results
    WHERE category_id = ? AND fight_id = ? AND status = 'confirmed'
  `).get(categoryId, fightId) as MatchResultRow | undefined
  return row ? mapMatchResult(row, true) : null
}

export function getMatchResult(categoryId: string, fightId: string): StoredMatchResult | null {
  const row = db.prepare('SELECT * FROM match_results WHERE category_id = ? AND fight_id = ?')
    .get(categoryId, fightId) as MatchResultRow | undefined
  return row ? mapMatchResult(row, row.status === 'confirmed') : null
}

/** Persisted on the fight, not the replaceable pending-result row. */
export function getMatchResultRevision(categoryId: string, fightId: string): number {
  const row = db.prepare(`SELECT f.result_revision FROM fights f
    JOIN category_tournaments c ON c.tournament_id = f.tournament_id
    WHERE f.id = ? AND c.category_id = ?`).get(fightId, categoryId) as { result_revision: number } | undefined
  return row?.result_revision ?? 0
}

/** Invalidate only an unconfirmed result, preserving all recovery data in one transaction. */
export function reopenPendingFlagResult(
  fightId: string,
  categoryId: string,
  tournamentId: number,
  expectedRevision: number,
  snapshot: MatchSnapshotData,
): number {
  assertCategoryWritable(categoryId)
  assertTournamentWritable(tournamentId)
  assertFightWritable(fightId)
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM match_results WHERE fight_id = ?')
      .get(fightId) as MatchResultRow | undefined
    if (!row || row.category_id !== categoryId || row.tournament_id !== tournamentId ||
      row.status !== 'pending_confirmation' || row.reason !== 'points') {
      throw new Error('only a pending flags result can be reopened')
    }
    assertMatchResultOwnership({ ...mapMatchResult(row) })
    const lock = getActiveMatchLock()
    if (lock?.fightId !== fightId || lock.categoryId !== categoryId || lock.tournamentId !== tournamentId ||
      getMatchResultRevision(categoryId, fightId) !== expectedRevision) {
      throw new Error('stale match or result revision')
    }
    if (snapshot.matchState?.phase !== 'rest' || snapshot.matchState.result !== null || snapshot.pendingResult) {
      throw new Error('a reopened snapshot must be awaiting flag votes')
    }
    const updated = db.prepare(`UPDATE fights SET completed = 0, winner = NULL, reason = NULL,
      flags_red = 0, flags_blue = 0, result_revision = result_revision + 1
      WHERE id = ? AND tournament_id = ? AND completed = 1 AND result_revision = ?`)
      .run(fightId, tournamentId, expectedRevision)
    if (updated.changes !== 1) throw new Error('pending fight could not be reopened')
    const removed = db.prepare(`DELETE FROM match_results
      WHERE fight_id = ? AND category_id = ? AND status = 'pending_confirmation'`).run(fightId, categoryId)
    if (removed.changes !== 1) throw new Error('pending result could not be invalidated')
    saveMatchSnapshot(fightId, tournamentId, snapshot, categoryId)
    return expectedRevision + 1
  })()
}

export function countMatchResults(fightId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM match_results WHERE fight_id = ?').get(fightId) as { count: number }
  return row.count
}

export function getSourceRing(fightId: string): string | null {
  const row = db.prepare('SELECT source_ring FROM fights WHERE id = ?').get(fightId) as { source_ring: string | null } | undefined
  return row?.source_ring ?? null
}

export function getSourceCategoryId(fightId: string): string | null {
  const row = db.prepare('SELECT source_category_id FROM fights WHERE id = ?').get(fightId) as { source_category_id: string | null } | undefined
  return row?.source_category_id ?? null
}

export function getFights(tournamentId: number) {
  return db.prepare('SELECT * FROM fights WHERE tournament_id = ? ORDER BY round_index ASC').all(tournamentId)
}

/** Resolve a locked fight without inferring names or local fight numbers. */
export function getFightCompetitorNames(fightId: string, tournamentId: number): { redName: string; blueName: string } | null {
  const row = db.prepare(`SELECT r.name AS redName, b.name AS blueName FROM fights f
    JOIN competitors r ON r.id = f.red_id
    JOIN competitors b ON b.id = f.blue_id
    WHERE f.id = ? AND f.tournament_id = ?`).get(fightId, tournamentId) as { redName: string; blueName: string } | undefined
  return row ?? null
}

// ── Presets ──────────────────────────────────────────────────────────────────

export interface DbPreset {
  id: number
  name: string
  round_count: number
  duration_seconds: number
  final_rounds: number | null
  final_seconds: number | null
  tiebreaker_seconds: number | null
  max_tiebreakers: number | null
  created_at: string
}

export function getPresets(): DbPreset[] {
  return db.prepare('SELECT * FROM presets ORDER BY created_at ASC').all() as DbPreset[]
}

export function upsertPreset(p: Omit<DbPreset, 'id' | 'created_at'>): DbPreset {
  const result = db.prepare(`
    INSERT INTO presets (name, round_count, duration_seconds, final_rounds, final_seconds, tiebreaker_seconds, max_tiebreakers)
    VALUES (@name, @round_count, @duration_seconds, @final_rounds, @final_seconds, @tiebreaker_seconds, @max_tiebreakers)
  `).run(p)
  return db.prepare('SELECT * FROM presets WHERE id = ?').get(result.lastInsertRowid) as DbPreset
}

// ── Match snapshot (emergency save) ──────────────────────────────────────────
// Persiste el estado del combate en curso para que pueda recuperarse si el
// servidor se reinicia inesperadamente. Solo se guarda UNA fila (id = 1).

db.exec(`
  CREATE TABLE IF NOT EXISTS match_snapshot (
    id          INTEGER PRIMARY KEY DEFAULT 1,
    fight_id    TEXT    NOT NULL,
    tournament_id INTEGER NOT NULL,
    data        TEXT    NOT NULL,
    saved_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`)

for (const col of ['category_id TEXT']) {
  try { db.exec(`ALTER TABLE match_snapshot ADD COLUMN ${col}`) } catch { /* already exists */ }
}

export interface MatchSnapshotData {
  tulPhase?: 'idle' | 'voting' | 'finished'
  resultRevision?: number
  // biome-ignore lint/suspicious/noExplicitAny: loose types — JSON round-trip
  match: Record<string, any>
  // biome-ignore lint/suspicious/noExplicitAny: loose types — JSON round-trip
  rules: Record<string, any>
  roundFlags: Array<{ red: number; blue: number; draw?: number; winner: string; votes: Record<string, string> }>
  /** Optional for compatibility with snapshots saved before individual RR votes. */
  judgeVotes?: Record<string, string>
  pendingResult?: { winner: FightWinner; reason: string }
  /** Saved on each Golden Point vote so a restart cannot reset an attempt. */
  matchState?: import('../../src/engine/types.js').MatchState
}

export interface LoadedMatchSnapshot {
  fightId: string
  tournamentId: number
  categoryId: string | null
  data: MatchSnapshotData | null
  corrupted: boolean
}

export function saveMatchSnapshot(fightId: string, tournamentId: number, data: MatchSnapshotData, categoryId?: string): void {
  if (categoryId) assertCategoryWritable(categoryId)
  assertTournamentWritable(tournamentId)
  assertFightWritable(fightId)
  db.prepare(`
    INSERT OR REPLACE INTO match_snapshot (id, fight_id, tournament_id, data, saved_at, category_id)
    VALUES (1, ?, ?, ?, datetime('now'), ?)
  `).run(fightId, tournamentId, JSON.stringify({ ...data, resultRevision: categoryId ? getMatchResultRevision(categoryId, fightId) : 0 }), categoryId ?? null)
}

export function loadMatchSnapshot(): LoadedMatchSnapshot | null {
  const row = db.prepare('SELECT fight_id, tournament_id, category_id, data FROM match_snapshot WHERE id = 1').get() as {
    fight_id: string; tournament_id: number; category_id: string | null; data: string
  } | undefined
  if (!row) return null
  try {
    return {
      fightId: row.fight_id,
      tournamentId: row.tournament_id,
      categoryId: row.category_id,
      data: JSON.parse(row.data) as MatchSnapshotData,
      corrupted: false,
    }
  } catch {
    return { fightId: row.fight_id, tournamentId: row.tournament_id, categoryId: row.category_id, data: null, corrupted: true }
  }
}

export function clearMatchSnapshot(fightId?: string, categoryId?: string): void {
  if (categoryId) assertCategoryWritable(categoryId)
  if (fightId) assertFightWritable(fightId)
  const existing = loadMatchSnapshot()
  if (existing) assertTournamentWritable(existing.tournamentId)
  if (fightId && categoryId) {
    db.prepare('DELETE FROM match_snapshot WHERE id = 1 AND fight_id = ? AND category_id = ?').run(fightId, categoryId)
    return
  }
  db.prepare('DELETE FROM match_snapshot WHERE id = 1').run()
}

/** Post-commit operational cleanup only: never deletes pending/recovery snapshots or archive JSON. */
export function clearConfirmedMatchSnapshot(): void {
  db.prepare(`DELETE FROM match_snapshot WHERE EXISTS (
    SELECT 1 FROM match_results r WHERE r.fight_id = match_snapshot.fight_id
      AND r.category_id = match_snapshot.category_id
      AND r.tournament_id = match_snapshot.tournament_id AND r.status = 'confirmed'
  )`).run()
}

export function getActiveMatchLock(): { fightId: string; tournamentId: number; categoryId: string | null; resultStatus: string | null } | null {
  const row = db.prepare(`
    SELECT fight_id, tournament_id, category_id, result_status FROM (
      SELECT fight_id, tournament_id, category_id, status AS result_status, 0 AS priority
      FROM match_results WHERE status = 'pending_confirmation'
      UNION ALL
      SELECT s.fight_id, s.tournament_id, s.category_id, r.status AS result_status, 1 AS priority
      FROM match_snapshot s
      LEFT JOIN match_results r ON r.fight_id = s.fight_id AND r.category_id = s.category_id
      WHERE s.id = 1 AND (r.status IS NULL OR r.status != 'confirmed')
    ) ORDER BY priority LIMIT 1
  `).get() as { fight_id: string; tournament_id: number; category_id: string | null; result_status: string | null } | undefined
  if (!row) return null
  return { fightId: row.fight_id, tournamentId: row.tournament_id, categoryId: row.category_id, resultStatus: row.result_status }
}

export function isFightPending(fightId: string, tournamentId?: number): boolean {
  const row = db.prepare(`
    SELECT f.completed,
      EXISTS(SELECT 1 FROM match_results r WHERE r.fight_id = f.id AND r.status = 'pending_confirmation') AS pending_confirmation
    FROM fights f WHERE f.id = ? ${tournamentId === undefined ? '' : 'AND f.tournament_id = ?'}
  `).get(...(tournamentId === undefined ? [fightId] : [fightId, tournamentId])) as { completed: number; pending_confirmation: number } | undefined
  return row ? row.completed === 0 || row.pending_confirmation === 1 : false
}

export function deletePreset(id: number): void {
  db.prepare('DELETE FROM presets WHERE id = ?').run(id)
}

export default db
