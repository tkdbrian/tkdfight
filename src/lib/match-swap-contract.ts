import type { MatchInfo } from "../../server/state.js"

/** A loaded, never-started sparring fight may exchange assigned color identities. */
export interface MatchSwapRequest {
  requestId: string
  categoryId: string
  matchId: string
  expectedRevision: number
  expectedLoadId: string
  expectedRedId: string
  expectedBlueId: string
}

export interface MatchSwapReply {
  ok: boolean
  code?: string
  error?: string
  alreadyApplied?: boolean
  /** Canonical currently loaded match on success or superseded replay. */
  match?: MatchInfo
}
