import { describe, expect, it } from 'vitest'
import { addMatchEvent, castGoldenPointVote, confirmTableGoldenOutcome, createGoldenPointMatch,
  endPhase, setTableGoldenPointVote, tick } from './match-machine'
import type { RuleSetSparring } from './types'
import baseline from '../rules/rules/rules_sparring_itf_baseline.json'

const rules = baseline as RuleSetSparring

describe('Punto de Oro', () => {
  it('lets the table chief review and replace a third vote before finalizing a majority', () => {
    let state = createGoldenPointMatch({ ...rules, judgesCount: 4 })
    for (const judgeId of ['J1', 'J2', 'J3']) {
      state = setTableGoldenPointVote(state, judgeId, 'red', 1, 4)
    }
    expect(state).toMatchObject({ phase: 'golden_point', result: null,
      goldenPoint: { attempt: 1, votes: { J1: 'red', J2: 'red', J3: 'red' } } })
    state = setTableGoldenPointVote(state, 'J3', 'blue', 1, 4)
    expect(confirmTableGoldenOutcome(state, 1, 4)).toBe(state)
    state = setTableGoldenPointVote(state, 'J4', 'red', 1, 4)
    expect(confirmTableGoldenOutcome(state, 1, 4)).toMatchObject({ phase: 'finished',
      result: { winner: 'red', reason: 'golden_point' } })
  })

  it('keeps a complete 2-2 split editable until the chief confirms another attempt', () => {
    let state = createGoldenPointMatch({ ...rules, judgesCount: 4 })
    for (const [judgeId, side] of [['J1', 'red'], ['J2', 'red'],
      ['J3', 'blue'], ['J4', 'blue']] as const) {
      state = setTableGoldenPointVote(state, judgeId, side, 1, 4)
    }
    expect(state).toMatchObject({ phase: 'golden_point', goldenPoint: { attempt: 1 } })
    state = setTableGoldenPointVote(state, 'J4', 'red', 1, 4)
    expect(confirmTableGoldenOutcome(state, 1, 4).result?.winner).toBe('red')
    state = setTableGoldenPointVote(state, 'J4', 'blue', 1, 4)
    state = confirmTableGoldenOutcome(state, 1, 4)
    expect(state).toMatchObject({ phase: 'golden_point', result: null,
      goldenPoint: { attempt: 2, votes: {} } })
  })
  it.each([3, 4, 5])('requires a strict majority with %i judges', (judgesCount) => {
    let state = createGoldenPointMatch({ ...rules, judgesCount })
    expect(state).toMatchObject({ phase: 'golden_point', timeLeft: 0, goldenPoint: { attempt: 1, votes: {} } })
    const threshold = Math.floor(judgesCount / 2) + 1
    for (let i = 1; i < threshold; i++) {
      state = castGoldenPointVote(state, `J${i}`, 'red', 1, judgesCount)
      expect(state.phase).toBe('golden_point')
    }
    state = castGoldenPointVote(state, `J${threshold}`, 'red', 1, judgesCount)
    expect(state).toMatchObject({ phase: 'finished', result: { winner: 'red', reason: 'golden_point' } })
  })

  it('keeps running without time, rejects duplicates and stale attempts, resets a 2–2 split', () => {
    let state = createGoldenPointMatch({ ...rules, judgesCount: 4 })
    const before = state
    expect(tick(state, rules)).toBe(before)
    expect(endPhase(state, rules)).toBe(before)
    expect(addMatchEvent(state, { judgeId: 'J1', competitor: 'red', type: 'pts_1' }, rules)).toBe(before)
    state = castGoldenPointVote(state, 'J1', 'red', 1, 4)
    expect(castGoldenPointVote(state, 'J1', 'blue', 1, 4)).toBe(state)
    state = castGoldenPointVote(state, 'J2', 'blue', 1, 4)
    state = castGoldenPointVote(state, 'J3', 'red', 1, 4)
    state = castGoldenPointVote(state, 'J4', 'blue', 1, 4)
    expect(state).toMatchObject({ phase: 'golden_point', goldenPoint: { attempt: 2, votes: {} } })
    expect(castGoldenPointVote(state, 'J1', 'red', 1, 4)).toBe(state)
    expect(castGoldenPointVote(state, 'J5', 'red', 2, 4)).toBe(state)
    state = castGoldenPointVote(state, 'J1', 'blue', 2, 4)
    state = castGoldenPointVote(state, 'J2', 'blue', 2, 4)
    state = castGoldenPointVote(state, 'J3', 'blue', 2, 4)
    expect(state.result).toMatchObject({ winner: 'blue', reason: 'golden_point' })
    expect(castGoldenPointVote(state, 'J4', 'red', 2, 4)).toBe(state)
  })
})
