import type { MatchState, RuleSetSparring } from '../src/engine/types.js'
import { randomUUID } from 'node:crypto'

// Max fallos en memoria por ring. Previene leak en torneos largos.
// Se mantiene en memoria solo el histórico reciente; el persistido va a SQLite.
export const MAX_FALLOS_IN_MEMORY = 500

export type MatchInfo = {
  id: string
  ringId: string
  category?: string
  matchMode?: 'sparring' | 'patterns'
  red: { id: string; name: string; club?: string }
  blue: { id: string; name: string; club?: string }
}

export type FalloEntry = {
  id: number
  time: string
  redName: string
  blueName: string
  redScore: number
  blueScore: number
  winner: string
}

export type JudgeTotals = Record<
  string,
  {
    red: number
    blue: number
    redFav: number
    blueFav: number
    redContra: number
    blueContra: number
  }
>

export const state = {
  rules: null as RuleSetSparring | null,
  match: null as MatchInfo | null,
  matchState: null as MatchState | null,
  matchPaused: false,
  judges: new Map<string, string>(),   // socketId → judgeId
  judgeVotes: new Map<string, string>(), // judgeId → 'red'|'draw'|'blue'
  nextJudgeNum: 1,
  /** Token generado al arrancar el server. Los jueces lo reciben via QR y lo envían en judge:connect. */
  ringToken: randomUUID(),
  fallos: [] as FalloEntry[],
  falloSeq: 1,
  roundFlags: [] as Array<{ red: number; blue: number; winner: 'red' | 'blue' | 'draw' }>,
  tickInterval: null as ReturnType<typeof setInterval> | null,
  activeTournamentId: 1 as number,
}
