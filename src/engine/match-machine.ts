import type {
  Competitor,
  MatchEvent,
  MatchPhase,
  MatchState,
  RoundState,
  RuleSetSparring,
} from './types'
import {
  aggregateTotals,
  calculateEventValue,
  checkDQ,
  compareScores,
  computeRoundTotals,
  resolveTiebreak,
} from './scoring'

// ── Helpers ────────────────────────────────────────────────────────────────

function emptyRound(number: number): RoundState {
  return {
    number,
    totals: { red: 0, blue: 0 },
    deductions: { red: 0, blue: 0 },
    fouls: { red: 0, blue: 0 },
    events: [],
  }
}

function currentRoundState(state: MatchState): RoundState {
  return state.rounds[state.rounds.length - 1]
}

function replaceLastRound(state: MatchState, updated: RoundState): MatchState {
  return {
    ...state,
    rounds: [...state.rounds.slice(0, -1), updated],
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createMatch(rules: RuleSetSparring): MatchState {
  return {
    phase: 'idle',
    currentRound: 0,
    timeLeft: rules.rounds.duration_seconds,
    rounds: [],
    firstPoint: null,
    result: null,
    pendingJuryDecision: false,
  }
}

// ── Start ──────────────────────────────────────────────────────────────────

export function startPhase(state: MatchState, rules: RuleSetSparring): MatchState {
  if (state.phase === 'idle' || state.phase === 'rest') {
    const nextRound = state.currentRound + 1
    return {
      ...state,
      phase: 'round',
      currentRound: nextRound,
      timeLeft: rules.rounds.duration_seconds,
      rounds: [...state.rounds, emptyRound(nextRound)],
    }
  }
  if (state.phase === 'overtime') {
    return {
      ...state,
      timeLeft: rules.rounds.overtime_seconds ?? 60,
    }
  }
  // golden_point has no timer limit — just flip to active
  return state
}

// ── Add event ──────────────────────────────────────────────────────────────

export function addMatchEvent(
  state: MatchState,
  raw: Omit<MatchEvent, 'id' | 'ts' | 'value' | 'isDQ'>,
  rules: RuleSetSparring
): MatchState {
  if (state.phase !== 'round' && state.phase !== 'overtime' && state.phase !== 'golden_point' && state.phase !== 'penalties') {
    return state
  }

  const { value, isDQ } = calculateEventValue(raw.type, rules)

  // During penalties only deductions and DQ are allowed
  if (state.phase === 'penalties' && value > 0 && !isDQ) {
    return state
  }
  const event: MatchEvent = {
    id: Math.random().toString(36).slice(2),
    ts: Date.now(),
    ...raw,
    value,
    isDQ,
  }

  const round = currentRoundState(state)
  const updatedEvents = [...round.events, event]
  const computed = computeRoundTotals(updatedEvents)
  const updatedRound: RoundState = {
    ...round,
    events: updatedEvents,
    totals: computed.totals,
    deductions: computed.deductions,
    fouls: computed.fouls,
  }
  let next = replaceLastRound(state, updatedRound)

  // Track first scoring point
  if (value > 0 && next.firstPoint === null) {
    next = { ...next, firstPoint: raw.competitor }
  }

  // Check DQ — if accumulated fouls hit limit, opponent wins instantly
  const dqed = checkDQ(next.rounds, rules)
  if (dqed || isDQ) {
    const loser: Competitor = dqed ?? raw.competitor
    const winner: Competitor = loser === 'red' ? 'blue' : 'red'
    return { ...next, phase: 'finished', result: { winner, reason: 'dq' } }
  }

  // Golden point: any scoring point ends the match immediately
  if (state.phase === 'golden_point' && value > 0) {
    return {
      ...next,
      phase: 'finished',
      result: { winner: raw.competitor, reason: 'golden_point' },
    }
  }

  return next
}

// ── Timer tick ─────────────────────────────────────────────────────────────

export function tick(state: MatchState, rules: RuleSetSparring): MatchState {
  if (state.phase !== 'round' && state.phase !== 'overtime') return state
  if (state.timeLeft <= 0) return state

  const newTime = state.timeLeft - 1

  if (newTime > 0) return { ...state, timeLeft: newTime }

  // Time reached 0 — end phase
  return endPhase({ ...state, timeLeft: 0 }, rules)
}

// ── End phase ──────────────────────────────────────────────────────────────

export function endPhase(state: MatchState, rules: RuleSetSparring): MatchState {
  if (state.phase === 'round') {
    const totalRounds = rules.rounds.count
    if (state.currentRound < totalRounds) {
      // More rounds to go → rest
      return { ...state, phase: 'rest', timeLeft: rules.rounds.rest_seconds }
    }
    // Last round ended — go to penalties phase before evaluation
    return { ...state, phase: 'penalties' as MatchPhase, timeLeft: 0 }
  }

  if (state.phase === 'overtime') {
    // Overtime ended — check totals including overtime round
    return evaluateOvertime(state, rules)
  }

  return state
}

// ── Evaluation helpers ─────────────────────────────────────────────────────

function evaluateMatch(state: MatchState, rules: RuleSetSparring): MatchState {
  const totals = aggregateTotals(state.rounds)
  const winner = compareScores(totals)

  if (winner !== 'draw') {
    return { ...state, phase: 'finished', result: { winner, reason: 'points' } }
  }

  // It's a draw — run tiebreak cascade
  const tiebreakOrder = rules.tiebreak_order ?? []
  const tieResult = resolveTiebreak(state.rounds, state.firstPoint, tiebreakOrder)

  if (tieResult) {
    return { ...state, phase: 'finished', result: tieResult }
  }

  // Tiebreak cascade asks for golden_point
  if (tiebreakOrder.includes('golden_point') && rules.rounds.golden_point) {
    const nextRound = state.currentRound + 1
    return {
      ...state,
      phase: 'golden_point',
      currentRound: nextRound,
      timeLeft: 0,
      rounds: [...state.rounds, emptyRound(nextRound)],
    }
  }

  // Needs overtime first
  if (tiebreakOrder.includes('golden_point') || (rules.rounds.overtime_seconds ?? 0) > 0) {
    const nextRound = state.currentRound + 1
    return {
      ...state,
      phase: 'overtime',
      currentRound: nextRound,
      timeLeft: rules.rounds.overtime_seconds ?? 60,
      rounds: [...state.rounds, emptyRound(nextRound)],
    }
  }

  // Fall through to jury
  return { ...state, phase: 'finished', pendingJuryDecision: true, result: null }
}

function evaluateOvertime(state: MatchState, rules: RuleSetSparring): MatchState {
  const totals = aggregateTotals(state.rounds)
  const winner = compareScores(totals)

  if (winner !== 'draw') {
    return { ...state, phase: 'finished', result: { winner, reason: 'overtime_points' } }
  }

  // Still tied → golden point
  if (rules.rounds.golden_point) {
    const nextRound = state.currentRound + 1
    return {
      ...state,
      phase: 'golden_point',
      currentRound: nextRound,
      timeLeft: 0,
      rounds: [...state.rounds, emptyRound(nextRound)],
    }
  }

  // Otherwise jury
  return { ...state, phase: 'finished', pendingJuryDecision: true, result: null }
}

// ── Confirm penalties ───────────────────────────────────────────────────────

export function confirmPenalties(state: MatchState, rules: RuleSetSparring): MatchState {
  if (state.phase !== 'penalties') return state
  return evaluateMatch(state, rules)
}

// ── Jury decision (manual input) ───────────────────────────────────────────

export function resolveJury(state: MatchState, winner: Competitor): MatchState {
  return {
    ...state,
    phase: 'finished',
    pendingJuryDecision: false,
    result: { winner, reason: 'jury' },
  }
}

// ── Computed selectors ─────────────────────────────────────────────────────

export function getTotals(state: MatchState): { red: number; blue: number } {
  return aggregateTotals(state.rounds)
}

// ── Undo ────────────────────────────────────────────────────────────

export function undoLastEvent(
  state: MatchState,
  judgeId?: string
): MatchState {
  if (state.rounds.length === 0) return state
  const round = state.rounds[state.rounds.length - 1]
  const events = round.events
  if (events.length === 0) return state

  // Find last event by this judge (or last event overall if no judgeId)
  const idx = judgeId
    ? [...events].reverse().findIndex(e => e.judgeId === judgeId && e.value > 0)
    : events.length - 1
  if (idx === -1) return state

  const realIdx = judgeId ? events.length - 1 - idx : idx
  const updatedEvents = events.filter((_, i) => i !== realIdx)
  const computed = computeRoundTotals(updatedEvents)
  const updatedRound = { ...round, events: updatedEvents, totals: computed.totals, deductions: computed.deductions, fouls: computed.fouls }
  return replaceLastRound(state, updatedRound)
}
