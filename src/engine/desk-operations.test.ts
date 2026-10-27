import { describe, expect, it } from 'vitest'
import { createMatch, endPhase, startPhase } from './match-machine'
import {
  confirmFlagRound, finishPointsFromJudgeTotals, finishTulVoting,
  hasPreFightActivity, reopenTulVoting, resultFlagCounts, roundsWinner,
  startTulVoting, tallyFlagWinner,
} from './desk-operations'
import type { RuleSetSparring } from './types'

const rules: RuleSetSparring = {
  mode: 'sparring', judgesCount: 4, rounds: { count: 1, duration_seconds: 60, rest_seconds: 0 },
  points: {}, deductions: {}, judgingMode: 'flags',
}

const rest = (ruleSet = rules) => endPhase(startPhase(createMatch(ruleSet), ruleSet), ruleSet)

describe('shared desk decisions', () => {
  it('uses the desk flag plurality, not the scoring-engine strict-majority rule', () => {
    expect(tallyFlagWinner(new Map([['J1', 'red'], ['J2', 'red'], ['J3', 'blue'], ['J4', 'draw']]), 4))
      .toEqual({ red: 2, blue: 1, draw: 1, winner: 'red' })
    expect(tallyFlagWinner({ J1: 'red', J2: 'blue', J3: 'draw', J4: 'draw' }, 4).winner).toBe('draw')
    expect(roundsWinner([{ winner: 'red' }, { winner: 'blue' }, { winner: 'draw' }])).toBe('draw')
  })

  it('requires every judge for a one-round RR and finishes without mutating the source', () => {
    const matchState = rest()
    const votes = new Map([['J1', 'red'], ['J2', 'red'], ['J3', 'blue']])
    expect(confirmFlagRound({ matchState, rules, roundFlags: [], judgeVotes: votes,
      requireIndividualFlags: true })).toBeNull()
    votes.set('J4', 'draw')
    const decided = confirmFlagRound({ matchState, rules, roundFlags: [], judgeVotes: votes,
      requireIndividualFlags: true })
    expect(decided?.winner).toBe('red')
    expect(decided?.roundFlags[0]).toEqual({ red: 2, blue: 1, draw: 1, winner: 'red',
      votes: Object.fromEntries(votes) })
    expect(decided?.matchState).toMatchObject({ phase: 'finished', result: { winner: 'red', reason: 'points' } })
    expect(matchState.phase).toBe('rest')
  })

  it('preserves the two-round elimination final: first round does not finish', () => {
    const finalRules = { ...rules, rounds: { ...rules.rounds, count: 2 } }
    const first = confirmFlagRound({ matchState: rest(finalRules), rules: finalRules,
      roundFlags: [], judgeVotes: { J1: 'red', J2: 'red', J3: 'blue', J4: 'blue' } })
    expect(first?.winner).toBeNull()
    expect(first?.roundFlags).toHaveLength(1)
    const second = confirmFlagRound({ matchState: rest(finalRules), rules: finalRules,
      roundFlags: first!.roundFlags, judgeVotes: { J1: 'blue', J2: 'blue', J3: 'blue', J4: 'red' } })
    expect(second?.winner).toBe('blue')
  })

  it('starts Tul voting without a clock and refuses a drawn result', () => {
    const idle = createMatch(rules)
    const voting = startTulVoting(idle)
    expect(voting.phase).toBe('rest')
    expect(voting.rounds).toHaveLength(0)
    expect(finishTulVoting(voting, { J1: 'red', J2: 'blue', J3: 'draw' }, 3)).toBeNull()
    const finished = finishTulVoting(voting, { J1: 'red', J2: 'red', J3: 'blue' }, 3)!
    expect(finished.result).toEqual({ winner: 'red', reason: 'points' })
    expect(reopenTulVoting(finished)).toMatchObject({ phase: 'rest', result: null })
  })

  it('applies the same point-mode judge plurality after penalties', () => {
    const matchState = { ...rest(), phase: 'penalties' as const }
    expect(finishPointsFromJudgeTotals(matchState, { J1: { red: 3, blue: 1 },
      J2: { red: 2, blue: 1 }, J3: { red: 1, blue: 3 }, J4: { red: 2, blue: 2 } }).result)
      .toEqual({ winner: 'red', reason: 'points' })
  })

  it('persists mode-specific flag totals for sparring, Tul and Golden Point', () => {
    const common = { matchState: rest(), judgeVotes: { J1: 'red', J2: 'blue', J3: 'red' },
      judgesCount: 3, roundFlags: [{ red: 3, blue: 1 }, { red: 1, blue: 2 }] }
    expect(resultFlagCounts(common)).toEqual({ red: 4, blue: 3 })
    expect(resultFlagCounts({ ...common, matchMode: 'tul' })).toEqual({ red: 2, blue: 1 })
    expect(resultFlagCounts({ ...common, goldenPoint: true,
      matchState: { ...common.matchState, goldenPoint: { attempt: 1,
        votes: { J1: 'blue', J2: 'blue', J3: 'red' } } } }))
      .toEqual({ red: 1, blue: 2 })
  })

  it('refuses pre-fight swap/postpone after any vote, flag, event, or timer change', () => {
    const idle = createMatch(rules)
    expect(hasPreFightActivity(idle, rules, [], new Map())).toBe(false)
    expect(hasPreFightActivity(idle, rules, [], { J1: 'red' })).toBe(true)
    expect(hasPreFightActivity(idle, rules, [{ winner: 'red' }], {})).toBe(true)
    expect(hasPreFightActivity({ ...idle, timeLeft: 59 }, rules, [], {})).toBe(true)
    expect(hasPreFightActivity(startPhase(idle, rules), rules, [], {})).toBe(true)
  })
})
