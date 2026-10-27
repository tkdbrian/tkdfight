import type { MatchState, RuleSetSparring } from './types'

/** Pure desk decisions shared by the socket server and the browser-only desk. */
export type FlagWinner = 'red' | 'blue' | 'draw'
export type FlagVote = FlagWinner
export type FlagVotes = ReadonlyMap<string, string> | Readonly<Record<string, string>>
export type FlagRound = {
  red: number
  blue: number
  draw: number
  winner: FlagWinner
  votes: Record<string, string>
}

function voteOf(votes: FlagVotes, judgeId: string): string | undefined {
  return typeof (votes as ReadonlyMap<string, string>).get === 'function'
    ? (votes as ReadonlyMap<string, string>).get(judgeId)
    : (votes as Readonly<Record<string, string>>)[judgeId]
}

export function tallyFlagWinner(votes: FlagVotes, judgesCount: number): {
  red: number; blue: number; draw: number; winner: FlagWinner
} {
  let red = 0, blue = 0, draw = 0
  for (let i = 1; i <= judgesCount; i++) {
    const vote = voteOf(votes, `J${i}`)
    if (vote === 'red') red++
    else if (vote === 'blue') blue++
    else if (vote === 'draw') draw++
  }
  // The desk's existing rule is plurality of red/blue unless draw leads both,
  // or red and blue are tied. This is NOT strict majority.
  const winner = draw > red && draw > blue || red === blue
    ? 'draw' : red > blue ? 'red' : 'blue'
  return { red, blue, draw, winner }
}

export function roundsWinner(rounds: ReadonlyArray<Pick<FlagRound, 'winner'>>): FlagWinner {
  const red = rounds.filter(round => round.winner === 'red').length
  const blue = rounds.filter(round => round.winner === 'blue').length
  const draw = rounds.filter(round => round.winner === 'draw').length
  if (draw > red && draw > blue || red === blue) return 'draw'
  return red > blue ? 'red' : 'blue'
}

export function hasPreFightActivity(
  matchState: MatchState | null,
  rules: RuleSetSparring | null,
  roundFlags: ReadonlyArray<unknown>,
  judgeVotes: FlagVotes,
): boolean {
  return !matchState || matchState.phase !== 'idle' || matchState.currentRound !== 0
    || !!matchState.result || matchState.firstPoint !== null || roundFlags.length > 0
    || (judgeVotes instanceof Map ? judgeVotes.size : Object.keys(judgeVotes).length) > 0
    || matchState.rounds.some(round => round.events.length > 0)
    || matchState.timeLeft !== rules?.rounds.duration_seconds
}

export function confirmFlagRound(input: {
  matchState: MatchState
  rules: RuleSetSparring
  roundFlags: ReadonlyArray<FlagRound>
  judgeVotes: FlagVotes
  requireIndividualFlags?: boolean
}): { matchState: MatchState; roundFlags: FlagRound[]; winner: FlagWinner | null } | null {
  const { matchState, rules, roundFlags, judgeVotes, requireIndividualFlags } = input
  if (matchState.phase !== 'rest'
    && !(matchState.phase === 'finished' && matchState.pendingJuryDecision)) return null
  if (requireIndividualFlags && (matchState.phase !== 'rest' || rules.judgingMode !== 'flags'
    || !Array.from({ length: rules.judgesCount }, (_, i) => `J${i + 1}`)
      .every(id => ['red', 'blue', 'draw'].includes(voteOf(judgeVotes, id) ?? '')))) return null
  const votes = judgeVotes instanceof Map ? Object.fromEntries(judgeVotes) : { ...judgeVotes }
  const tally = tallyFlagWinner(judgeVotes, rules.judgesCount)
  const nextFlags = [...roundFlags, { ...tally, votes }]
  if (nextFlags.length < rules.rounds.count) {
    return { matchState, roundFlags: nextFlags, winner: null }
  }
  const winner = roundsWinner(nextFlags)
  return { matchState: {
    ...matchState, phase: 'finished', timeLeft: 0, pendingJuryDecision: false,
    result: { winner, reason: 'points' },
  }, roundFlags: nextFlags, winner }
}

export function startTulVoting(matchState: MatchState): MatchState {
  return { ...matchState, phase: 'rest', result: null }
}

/** Returns null for a draw: a Tul winner must be red or blue. */
export function finishTulVoting(
  matchState: MatchState,
  votes: FlagVotes,
  judgesCount: number,
): MatchState | null {
  const { winner } = tallyFlagWinner(votes, judgesCount)
  if (winner === 'draw') return null
  return { ...matchState, phase: 'finished', result: { winner, reason: 'points' } }
}

export function reopenTulVoting(matchState: MatchState): MatchState {
  return { ...matchState, phase: 'rest', result: null }
}

export function finishPointsFromJudgeTotals(
  matchState: MatchState,
  judgeTotals: Readonly<Record<string, { red: number; blue: number }>>,
): MatchState {
  let red = 0, blue = 0, draw = 0
  for (const total of Object.values(judgeTotals)) {
    if (total.red > total.blue) red++
    else if (total.blue > total.red) blue++
    else draw++
  }
  const winner = draw > red && draw > blue || red === blue
    ? 'draw' : red > blue ? 'red' : 'blue'
  return { ...matchState, phase: 'finished', pendingJuryDecision: false,
    result: { winner, reason: 'points' } }
}

/** The persisted result's flag columns depend on bout mode, not the displayed score. */
export function resultFlagCounts(input: {
  matchMode?: string
  goldenPoint?: boolean
  matchState: MatchState | null
  roundFlags: ReadonlyArray<Pick<FlagRound, 'red' | 'blue'>>
  judgeVotes: FlagVotes
  judgesCount: number
}): { red: number; blue: number } {
  if (input.goldenPoint) {
    const votes = Object.values(input.matchState?.goldenPoint?.votes ?? {})
    return { red: votes.filter(vote => vote === 'red').length,
      blue: votes.filter(vote => vote === 'blue').length }
  }
  if (input.matchMode === 'tul') {
    const { red, blue } = tallyFlagWinner(input.judgeVotes, input.judgesCount)
    return { red, blue }
  }
  return input.roundFlags.reduce((counts, round) => ({
    red: counts.red + round.red, blue: counts.blue + round.blue,
  }), { red: 0, blue: 0 })
}
