import { afterEach, describe, expect, it } from 'vitest'
import { computeJudgeTotalsForMatch, computePenaltyCountsForMatch as purePenalties } from '../src/engine/judge-totals.js'
import type { MatchState } from '../src/engine/types.js'
import { computeJudgeTotals, computePenaltyCounts, computePenaltyCountsForMatch } from './helpers.js'
import { state } from './state.js'

const original = state.matchState
afterEach(() => { state.matchState = original })

describe('server helpers use the browser-shared engine', () => {
  it('produces the same sanctioned fallo totals and penalty columns', () => {
    const matchState: MatchState = {
      phase: 'finished', currentRound: 1, timeLeft: 0, firstPoint: 'red',
      pendingJuryDecision: false, result: { winner: 'red', reason: 'points' },
      rounds: [{ number: 1, totals: { red: 0, blue: 0 },
        deductions: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 },
        events: [
          { id: '1', ts: 1, judgeId: 'J1', competitor: 'red', type: 'punch', value: 3 },
          { id: '2', ts: 2, judgeId: 'arbiter', competitor: 'red', type: 'minus_point', value: -1 },
        ] }],
    }
    state.matchState = matchState
    expect(computeJudgeTotals()).toEqual(computeJudgeTotalsForMatch(matchState))
    expect(computeJudgeTotals().J1.red).toBe(2)
    expect(computePenaltyCounts()).toEqual(purePenalties(matchState))
    expect(computePenaltyCountsForMatch(matchState)).toEqual(purePenalties(matchState))
    expect(computePenaltyCounts().fouls.red).toBe(1)
  })

  it('keeps Tul and Golden Point no-event snapshots free of invented judge scores', () => {
    state.matchState = { phase: 'golden_point', currentRound: 1, timeLeft: 0,
      rounds: [], firstPoint: null, result: null, pendingJuryDecision: false,
      goldenPoint: { attempt: 1, votes: { J1: 'red' } } }
    expect(computeJudgeTotals()).toEqual({})
    expect(computePenaltyCounts()).toEqual({ warnings: { red: 0, blue: 0 },
      fouls: { red: 0, blue: 0 } })
  })
})
