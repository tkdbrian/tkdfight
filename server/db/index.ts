import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

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
for (const col of ['group_id TEXT', 'flags_red INTEGER NOT NULL DEFAULT 0', 'flags_blue INTEGER NOT NULL DEFAULT 0', 'source_ring TEXT']) {
  try { db.exec(`ALTER TABLE fights ADD COLUMN ${col}`) } catch { /* already exists */ }
}

// ── Indexes ──────────────────────────────────────────────────────────────────
// Sin estos, getFights/getQueue hacen full scan en cada llamada.

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_fights_tournament_completed ON fights(tournament_id, completed);
  CREATE INDEX IF NOT EXISTS idx_fights_tournament ON fights(tournament_id);
  CREATE INDEX IF NOT EXISTS idx_competitors_tournament ON competitors(tournament_id);
`)

// ── Tournaments ──────────────────────────────────────────────────────────────

export function createTournament(name: string, category: string): number {
  const result = db.prepare('INSERT INTO tournaments (name, category) VALUES (?, ?)').run(name, category)
  return result.lastInsertRowid as number
}

export function getTournament(id: number) {
  return db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id) as {
    id: number; name: string; category: string; created_at: string
  } | undefined
}

export function getLatestTournament() {
  return db.prepare('SELECT * FROM tournaments ORDER BY id DESC LIMIT 1').get() as {
    id: number; name: string; category: string; created_at: string
  } | undefined
}

export function renameTournament(id: number, name: string, category: string) {
  db.prepare('UPDATE tournaments SET name = ?, category = ? WHERE id = ?').run(name, category, id)
}

export function getCompetitorCount(tournamentId: number): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM competitors WHERE tournament_id = ?').get(tournamentId) as { cnt: number }
  return row.cnt
}

export function deletePendingFights(tournamentId: number) {
  db.prepare('DELETE FROM fights WHERE tournament_id = ? AND completed = 0').run(tournamentId)
}

export function clearTournamentData(tournamentId: number) {
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
  // Use INSERT ... ON CONFLICT DO UPDATE to avoid DELETE+INSERT (which fails FK constraints)
  db.prepare(`
    INSERT INTO competitors (id, tournament_id, name, team, weight, belt)
    VALUES (@id, @tournament_id, @name, @team, @weight, @belt)
    ON CONFLICT(id) DO UPDATE SET
      tournament_id = excluded.tournament_id,
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
}) {
  db.prepare(`
    INSERT OR REPLACE INTO fights (id, tournament_id, red_id, blue_id, completed, winner, reason, round_index, group_id, flags_red, flags_blue, source_ring)
    VALUES (@id, @tournament_id, @red_id, @blue_id, @completed, @winner, @reason, @round_index, @group_id, @flags_red, @flags_blue, @source_ring)
  `).run({ winner: null, reason: null, round_index: null, group_id: null, source_ring: null, ...f, completed: f.completed ? 1 : 0, flags_red: f.flags_red ?? 0, flags_blue: f.flags_blue ?? 0 })
}

// Insert only if the fight doesn't already exist (preserves group_id/round_index from import-fights)
export function insertFightIfNew(f: {
  id: string
  tournament_id: number
  red_id: string
  blue_id: string
}) {
  db.prepare(`
    INSERT OR IGNORE INTO fights (id, tournament_id, red_id, blue_id, completed, flags_red, flags_blue)
    VALUES (@id, @tournament_id, @red_id, @blue_id, 0, 0, 0)
  `).run(f)
}

export function completeFight(id: string, winner: string, reason: string, flagsRed = 0, flagsBlue = 0) {
  db.prepare('UPDATE fights SET completed = 1, winner = ?, reason = ?, flags_red = ?, flags_blue = ? WHERE id = ?').run(winner, reason, flagsRed, flagsBlue, id)
}

export function getSourceRing(fightId: string): string | null {
  const row = db.prepare('SELECT source_ring FROM fights WHERE id = ?').get(fightId) as { source_ring: string | null } | undefined
  return row?.source_ring ?? null
}

export function getFights(tournamentId: number) {
  return db.prepare('SELECT * FROM fights WHERE tournament_id = ? ORDER BY round_index ASC').all(tournamentId)
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

export interface MatchSnapshotData {
  // biome-ignore lint/suspicious/noExplicitAny: loose types — JSON round-trip
  match: Record<string, any>
  // biome-ignore lint/suspicious/noExplicitAny: loose types — JSON round-trip
  rules: Record<string, any>
  roundFlags: Array<{ red: number; blue: number; winner: string; votes: Record<string, string> }>
}

export function saveMatchSnapshot(fightId: string, tournamentId: number, data: MatchSnapshotData): void {
  db.prepare(`
    INSERT OR REPLACE INTO match_snapshot (id, fight_id, tournament_id, data, saved_at)
    VALUES (1, ?, ?, ?, datetime('now'))
  `).run(fightId, tournamentId, JSON.stringify(data))
}

export function loadMatchSnapshot(): { fightId: string; tournamentId: number; data: MatchSnapshotData } | null {
  const row = db.prepare('SELECT fight_id, tournament_id, data FROM match_snapshot WHERE id = 1').get() as {
    fight_id: string; tournament_id: number; data: string
  } | undefined
  if (!row) return null
  try {
    return { fightId: row.fight_id, tournamentId: row.tournament_id, data: JSON.parse(row.data) as MatchSnapshotData }
  } catch {
    return null
  }
}

export function clearMatchSnapshot(): void {
  db.prepare('DELETE FROM match_snapshot WHERE id = 1').run()
}

export function isFightPending(fightId: string): boolean {
  const row = db.prepare('SELECT completed FROM fights WHERE id = ?').get(fightId) as { completed: number } | undefined
  return row ? row.completed === 0 : false
}

export function deletePreset(id: number): void {
  db.prepare('DELETE FROM presets WHERE id = ?').run(id)
}

export default db
