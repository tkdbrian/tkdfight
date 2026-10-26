import type { MatchState, RuleSetSparring } from '../../src/engine/types.js'
import type { MatchSwapRequest } from '../../src/lib/match-swap-contract.js'
import type { MatchInfo } from '../state.js'
import db, {
  assertCategoryWritable,
  assertCompetitorWritable,
  assertFightWritable,
  assertTournamentWritable,
  getActiveMatchLock,
  getCategoryTournamentId,
  getMatchResult,
  loadMatchSnapshot,
} from './index.js'

db.exec(`CREATE TABLE IF NOT EXISTS match_swap_receipts (
  request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`)

function fingerprint(input: MatchSwapRequest): string {
  return JSON.stringify([
    input.categoryId, input.matchId, input.expectedRevision, input.expectedLoadId,
    input.expectedRedId, input.expectedBlueId,
  ])
}

/** Operational receipts are excluded from full backups and invalidated on restore. */
export function hasSwapReceipt(input: MatchSwapRequest): boolean {
  const row = db.prepare('SELECT fingerprint FROM match_swap_receipts WHERE request_id = ?')
    .get(input.requestId) as { fingerprint: string } | undefined
  if (row && row.fingerprint !== fingerprint(input)) throw new Error('request_conflict')
  return !!row
}

/** No scoring channel or round can exist yet; identities alone are eligible to move. */
export function isNeverStartedSparringState(
  current: MatchState | null | undefined,
  rules: RuleSetSparring | null | undefined,
): boolean {
  return !!current && !!rules && rules.mode === 'sparring'
    && current.phase === 'idle' && current.currentRound === 0
    && current.timeLeft === rules.rounds?.duration_seconds
    && Array.isArray(current.rounds) && current.rounds.length === 0
    && current.firstPoint === null && current.result === null
    && current.pendingJuryDecision === false && !current.goldenPoint
}

/** Exchange the color assignments of exactly one pending loaded fight in a single SQLite transaction. */
export function swapNeverStartedMatch(input: MatchSwapRequest): MatchInfo {
  return db.transaction(() => {
    assertCategoryWritable(input.categoryId)
    assertFightWritable(input.matchId)
    assertCompetitorWritable(input.expectedRedId)
    assertCompetitorWritable(input.expectedBlueId)
    if (input.expectedRedId === input.expectedBlueId) throw new Error('stale_competitors')

    const snapshot = loadMatchSnapshot()
    const lock = getActiveMatchLock()
    if (!snapshot || snapshot.corrupted || !snapshot.data
      || snapshot.categoryId !== input.categoryId || snapshot.fightId !== input.matchId
      || lock?.categoryId !== input.categoryId || lock.fightId !== input.matchId
      || lock.tournamentId !== snapshot.tournamentId || lock.resultStatus !== null
      || getCategoryTournamentId(input.categoryId) !== snapshot.tournamentId
      || getMatchResult(input.categoryId, input.matchId)) throw new Error('stale_match_context')
    assertTournamentWritable(snapshot.tournamentId)

    const saved = snapshot.data
    const match = saved.match as MatchInfo
    const rules = saved.rules as RuleSetSparring
    const timing = match?.preFight
    if (!timing || timing.loadId !== input.expectedLoadId
      || timing.revision !== input.expectedRevision) throw new Error('stale_revision')
    if (match.id !== input.matchId || match.categoryId !== input.categoryId
      || match.matchMode !== 'sparring' || match.goldenPoint
      || (match.timingKind !== 'regular' && match.timingKind !== 'elimination-final')
      || timing.timingKind !== match.timingKind || rules?.mode !== 'sparring') {
      throw new Error('swap_unavailable')
    }
    if (match.red?.id !== input.expectedRedId || match.blue?.id !== input.expectedBlueId) {
      throw new Error('stale_competitors')
    }
    if (timing.started || !isNeverStartedSparringState(saved.matchState, rules)
      || !Array.isArray(saved.roundFlags) || saved.roundFlags.length !== 0
      || saved.pendingResult || (saved.tulPhase && saved.tulPhase !== 'idle')
      || Object.keys(saved.judgeVotes ?? {}).length > 0) throw new Error('match_already_started')

    const row = db.prepare(`SELECT red_id, blue_id, completed, winner, reason,
      flags_red, flags_blue, result_revision FROM fights WHERE id = ? AND tournament_id = ?`)
      .get(input.matchId, snapshot.tournamentId) as {
        red_id: string; blue_id: string; completed: number; winner: string | null;
        reason: string | null; flags_red: number; flags_blue: number; result_revision: number;
      } | undefined
    if (!row || row.red_id !== input.expectedRedId || row.blue_id !== input.expectedBlueId) {
      throw new Error('stale_competitors')
    }
    if (row.completed !== 0 || row.winner !== null || row.reason !== null
      || row.flags_red !== 0 || row.flags_blue !== 0 || row.result_revision !== 0) {
      throw new Error('match_already_started')
    }

    const nextMatch: MatchInfo = {
      ...match, red: match.blue, blue: match.red,
      preFight: { ...timing, revision: timing.revision + 1, swapCount: (timing.swapCount ?? 0) + 1 },
    }
    const raw = db.prepare('SELECT data FROM match_snapshot WHERE id = 1 AND fight_id = ? AND category_id = ?')
      .get(input.matchId, input.categoryId) as { data: string } | undefined
    if (!raw) throw new Error('stale_match_context')
    const fight = db.prepare(`UPDATE fights SET red_id = ?, blue_id = ?
      WHERE id = ? AND tournament_id = ? AND red_id = ? AND blue_id = ?
        AND completed = 0 AND winner IS NULL AND reason IS NULL
        AND flags_red = 0 AND flags_blue = 0 AND result_revision = 0
        AND NOT EXISTS (SELECT 1 FROM match_results WHERE fight_id = ?)`)
      .run(input.expectedBlueId, input.expectedRedId, input.matchId, snapshot.tournamentId,
        input.expectedRedId, input.expectedBlueId, input.matchId)
    if (fight.changes !== 1) throw new Error('stale_competitors')
    const updated = db.prepare(`UPDATE match_snapshot SET data = ?, saved_at = datetime('now')
      WHERE id = 1 AND fight_id = ? AND category_id = ? AND tournament_id = ? AND data = ?`)
      .run(JSON.stringify({ ...saved, match: nextMatch }), input.matchId,
        input.categoryId, snapshot.tournamentId, raw.data)
    if (updated.changes !== 1) throw new Error('stale_match_context')
    db.prepare('INSERT INTO match_swap_receipts (request_id, fingerprint) VALUES (?, ?)')
      .run(input.requestId, fingerprint(input))
    return nextMatch
  })()
}
