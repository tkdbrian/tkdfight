import db, { assertCategoryWritable, assertFightWritable, assertTournamentWritable, getActiveMatchLock,
  getMatchResult, isFightPending, loadMatchSnapshot } from './index.js'

export interface PostponeRequest {
  requestId: string
  categoryId: string
  matchId: string
  expectedRevision: number
  expectedLoadId: string
}

db.exec(`CREATE TABLE IF NOT EXISTS match_postpone_receipts (
  request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`)

function fingerprint(input: PostponeRequest): string {
  return JSON.stringify([input.categoryId,input.matchId,input.expectedRevision,input.expectedLoadId])
}

/** Operational receipts are not tournament history; restore invalidates them. */
export function hasPostponeReceipt(input: PostponeRequest): boolean {
  const row = db.prepare('SELECT fingerprint FROM match_postpone_receipts WHERE request_id = ?')
    .get(input.requestId) as {fingerprint:string}|undefined
  if (row && row.fingerprint !== fingerprint(input)) throw new Error('request_conflict')
  return !!row
}

/** Delete only the verified idle load; never remove the fight or its results. */
export function releaseNeverStartedMatch(input: PostponeRequest): void {
  db.transaction(() => {
    assertCategoryWritable(input.categoryId)
    assertFightWritable(input.matchId)
    const saved = loadMatchSnapshot()
    const lock = getActiveMatchLock()
    if (!saved || saved.corrupted || saved.fightId !== input.matchId || saved.categoryId !== input.categoryId
      || lock?.fightId !== input.matchId || lock.categoryId !== input.categoryId
      || getMatchResult(input.categoryId,input.matchId) || !isFightPending(input.matchId,saved.tournamentId)) throw new Error('stale_match_context')
    assertTournamentWritable(saved.tournamentId)
    const data = saved.data
    const timing: unknown = data?.match.preFight
    if (!timing || typeof timing !== 'object' || !('started' in timing) || timing.started !== false
      || !('revision' in timing) || timing.revision !== input.expectedRevision
      || !('loadId' in timing) || timing.loadId !== input.expectedLoadId) throw new Error('stale_revision')
    const current = data?.matchState
    if (!current || current.phase !== 'idle' || current.currentRound !== 0 || current.result
      || current.firstPoint !== null || current.rounds.some(round => round.events.length > 0)
      || data?.pendingResult || data?.roundFlags.length || Object.keys(data?.judgeVotes ?? {}).length
      || current.timeLeft !== data?.rules.rounds?.duration_seconds
      || (data?.tulPhase && data.tulPhase !== 'idle')) throw new Error('match_already_started')
    const deleted = db.prepare('DELETE FROM match_snapshot WHERE id = 1 AND fight_id = ? AND category_id = ?')
      .run(input.matchId,input.categoryId)
    if (deleted.changes !== 1) throw new Error('stale_match_context')
    db.prepare('INSERT INTO match_postpone_receipts (request_id,fingerprint) VALUES (?,?)')
      .run(input.requestId,fingerprint(input))
  })()
}
