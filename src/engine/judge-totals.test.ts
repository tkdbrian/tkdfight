import { describe, expect, it } from 'vitest'
import { computeJudgeTotalsForMatch, computePenaltyCountsForMatch } from './judge-totals'
import type { Competitor, MatchEvent, MatchState, RoundState } from './types'

let eventSeq = 0
function event(judgeId: string, competitor: Competitor, type: string, value: number): MatchEvent {
  return { id: `e${++eventSeq}`, ts: eventSeq, judgeId, competitor, type, value }
}
function round(number: number, events: MatchEvent[]): RoundState {
  return { number, events, totals: { red: 0, blue: 0 },
    deductions: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } }
}
function state(...rounds: RoundState[]): MatchState {
  return { phase: 'finished', currentRound: rounds.length, timeLeft: 0, rounds,
    firstPoint: null, result: null, pendingJuryDecision: false }
}

describe('pure judge display totals and official penalty counts', () => {
  it('returns empty totals for an unloaded, Tul or untimed Golden Point bout', () => {
    expect(computeJudgeTotalsForMatch(null)).toEqual({})
    expect(computeJudgeTotalsForMatch(state())).toEqual({})
    expect(computePenaltyCountsForMatch(null)).toEqual({ warnings: { red: 0, blue: 0 },
      fouls: { red: 0, blue: 0 } })
    expect(computePenaltyCountsForMatch(state())).toEqual({ warnings: { red: 0, blue: 0 },
      fouls: { red: 0, blue: 0 } })
  })

  it('shares arbiter deductions across judges, applies every third minor warning and clamps display at zero', () => {
    const bout = state(round(1, [
      event('J1', 'red', 'punch', 5), event('J1', 'blue', 'punch', 2),
      event('J2', 'red', 'punch', 1), event('J2', 'blue', 'punch', 4),
      event('J1', 'red', 'subtract_1', -1),
      event('arbiter', 'red', 'warning_minor', 0),
      event('arbiter', 'red', 'warning_minor', 0),
    ]), round(2, [
      event('arbiter', 'red', 'warning_minor', 0),
      event('arbiter', 'red', 'minus_point', -1),
      event('arbiter', 'blue', 'warning_serious', -1),
    ]))
    expect(computeJudgeTotalsForMatch(bout)).toEqual({
      J1: { red: 2, blue: 1, redFav: 5, blueFav: 2, redContra: 3, blueContra: 1 },
      J2: { red: 0, blue: 3, redFav: 1, blueFav: 4, redContra: 2, blueContra: 1 },
    })
    expect(computePenaltyCountsForMatch(bout)).toEqual({ warnings: { red: 3, blue: 1 },
      fouls: { red: 1, blue: 0 } })
  })

  it('handles sanction corrections in event order across rounds without negative counts', () => {
    const bout = state(round(1, [
      event('J1', 'red', 'punch', 2),
      event('arbiter', 'red', 'warning_minor', 0),
      event('arbiter', 'red', 'warning_minor', 0),
      event('arbiter', 'red', 'warning_minor', 0),
      event('arbiter', 'blue', 'minus_point', -1),
      event('arbiter', 'red', 'warning_serious', -1),
    ]), round(2, [
      event('arbiter', 'red', 'remove_warning', 0),
      event('arbiter', 'blue', 'remove_minus_point', 1),
      event('arbiter', 'red', 'remove_warning_serious', 1),
      event('arbiter', 'blue', 'remove_minus_point', 1),
    ]))
    expect(computeJudgeTotalsForMatch(bout).J1).toEqual({ red: 2, blue: 0,
      redFav: 2, blueFav: 0, redContra: 0, blueContra: 0 })
    expect(computePenaltyCountsForMatch(bout)).toEqual({ warnings: { red: 2, blue: 0 },
      fouls: { red: 0, blue: 0 } })
  })
})
