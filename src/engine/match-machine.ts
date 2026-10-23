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
  aggregateTotalsWithPenalties,
  calculateEventValue,
  checkDQ,
  compareScores,
  computeJudgeMajority,
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

/** A Golden Point is a separate, untimed bout, not a one-second round. */
export function createGoldenPointMatch(rules: RuleSetSparring): MatchState {
  return {
    ...createMatch(rules),
    phase: 'golden_point',
    currentRound: 1,
    timeLeft: 0,
    rounds: [emptyRound(1)],
    goldenPoint: { attempt: 1, votes: {} },
  }
}

export function castGoldenPointVote(
  state: MatchState,
  judgeId: string,
  competitor: Competitor,
  attempt: number,
  judgesCount: number,
): MatchState {
  if (state.phase !== 'golden_point' || !state.goldenPoint || attempt !== state.goldenPoint.attempt) return state
  if (!Number.isInteger(judgesCount) || judgesCount < 1 || judgesCount > 5) return state
  if (!Array.from({ length: judgesCount }, (_, i) => `J${i + 1}`).includes(judgeId)) return state
  if (state.goldenPoint.votes[judgeId]) return state
  const votes = { ...state.goldenPoint.votes, [judgeId]: competitor }
  const count = Object.values(votes).filter((vote) => vote === competitor).length
  if (count >= Math.floor(judgesCount / 2) + 1) {
    return { ...state, phase: 'finished', result: { winner: competitor, reason: 'golden_point' }, goldenPoint: { attempt, votes } }
  }
  if (Object.keys(votes).length === judgesCount) {
    return { ...state, goldenPoint: { attempt: attempt + 1, votes: {} } }
  }
  return { ...state, goldenPoint: { attempt, votes } }
}

/** Table-chief votes are provisional until the chief explicitly confirms the outcome. */
export function setTableGoldenPointVote(
  state: MatchState,
  judgeId: string,
  competitor: Competitor,
  attempt: number,
  judgesCount: number,
): MatchState {
  if (state.phase !== 'golden_point' || state.result || !state.goldenPoint ||
    attempt !== state.goldenPoint.attempt) return state
  if (!Number.isInteger(judgesCount) || judgesCount < 1 || judgesCount > 5) return state
  if (!Array.from({ length: judgesCount }, (_, i) => `J${i + 1}`).includes(judgeId)) return state
  if (state.goldenPoint.votes[judgeId] === competitor) return state
  return { ...state, goldenPoint: {
    attempt, votes: { ...state.goldenPoint.votes, [judgeId]: competitor },
  } }
}

/** Recalculate the decision from the stored per-judge choices, never from mutable totals. */
export function confirmTableGoldenOutcome(
  state: MatchState,
  attempt: number,
  judgesCount: number,
): MatchState {
  if (state.phase !== 'golden_point' || state.result || !state.goldenPoint ||
    attempt !== state.goldenPoint.attempt) return state
  if (!Number.isInteger(judgesCount) || judgesCount < 1 || judgesCount > 5) return state
  const votes = state.goldenPoint.votes
  const judgeIds = Array.from({ length: judgesCount }, (_, i) => `J${i + 1}`)
  if (Object.keys(votes).some((judgeId) => !judgeIds.includes(judgeId) ||
    (votes[judgeId] !== 'red' && votes[judgeId] !== 'blue'))) return state
  const red = Object.values(votes).filter((vote) => vote === 'red').length
  const blue = Object.values(votes).filter((vote) => vote === 'blue').length
  const threshold = Math.floor(judgesCount / 2) + 1
  if (red >= threshold || blue >= threshold) {
    return { ...state, phase: 'finished', result: {
      winner: red >= threshold ? 'red' : 'blue', reason: 'golden_point',
    } }
  }
  if (Object.keys(votes).length === judgesCount && red === blue) {
    return { ...state, goldenPoint: { attempt: attempt + 1, votes: {} } }
  }
  return state
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
  if (state.phase !== 'round' && state.phase !== 'overtime' && state.phase !== 'penalties') {
    return state
  }

  const { value, isDQ } = calculateEventValue(raw.type, rules)

  // During penalties only deductions, DQ, and reversal events are allowed
  if (state.phase === 'penalties' && value > 0 && !isDQ && !raw.type.startsWith('remove_')) {
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

  return next
}

export type SanctionKind = 'warning' | 'minus_point'

function activeSanctionEvents(
  state: MatchState,
  competitor: Competitor,
  kind: SanctionKind,
): MatchEvent[] {
  const active: MatchEvent[] = []
  for (const round of state.rounds) {
    for (const event of round.events) {
      if (event.judgeId !== 'arbiter' || event.competitor !== competitor) continue
      if (kind === 'warning' && (event.type === 'warning_minor' || event.type === 'warning_serious')) {
        active.push(event)
      } else if (kind === 'minus_point' && event.type === 'minus_point') {
        active.push(event)
      } else if ((kind === 'warning' &&
        (event.type === 'remove_warning' || event.type === 'remove_warning_serious')) ||
        (kind === 'minus_point' && event.type === 'remove_minus_point')) {
        active.pop()
      }
    }
  }
  return active
}

export function getSanctionCount(
  state: MatchState,
  competitor: Competitor,
  kind: SanctionKind,
): number {
  return activeSanctionEvents(state, competitor, kind).length
}

/** Change post-clock sanction metadata without recalculating an already decided winner or DQ. */
export function setSanctionCount(
  state: MatchState,
  competitor: Competitor,
  kind: SanctionKind,
  count: number,
  rules: RuleSetSparring,
): MatchState {
  if (!['rest', 'penalties', 'finished'].includes(state.phase) || !state.rounds.length ||
    !Number.isInteger(count) || count < 0 || count > 99) return state
  const active = activeSanctionEvents(state, competitor, kind)
  if (active.length === count) return state
  const events = [...currentRoundState(state).events]
  const change = count > active.length ? 1 : -1
  for (let index = active.length; index !== count; index += change) {
    const original = change < 0 ? active.pop() : undefined
    const type = change > 0
      ? kind === 'warning' ? 'warning_minor' : 'minus_point'
      : kind === 'warning'
        ? original?.type === 'warning_serious' ? 'remove_warning_serious' : 'remove_warning'
        : 'remove_minus_point'
    const { value } = calculateEventValue(type, rules)
    events.push({
      id: Math.random().toString(36).slice(2),
      ts: Date.now(),
      judgeId: 'arbiter',
      competitor,
      type,
      value: original ? -original.value : value,
      isDQ: false,
    })
  }
  const computed = computeRoundTotals(events)
  return replaceLastRound(state, { ...currentRoundState(state), events, ...computed })
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
    // Last round ended — flags mode (default) goes to rest so judges can vote; points mode uses penalties
    if ((rules.judgingMode ?? 'flags') === 'flags') {
      return { ...state, phase: 'rest', timeLeft: 0 }
    }
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
  // Regla: gana el color con mayoría estricta de jueces (≥ floor(n/2)+1).
  // Sin mayoría → empate y se aplica cascada de desempate / golden point / jurado.
  const judgesCount = rules.judgesCount ?? 1
  const { winner } = computeJudgeMajority(state.rounds, judgesCount)

  if (winner !== 'draw') {
    return { ...state, phase: 'finished', result: { winner, reason: 'points' } }
  }

  // It's a draw — run tiebreak cascade
  const tiebreakOrder = rules.tiebreak_order ?? []
  const tieResult = resolveTiebreak(state.rounds, state.firstPoint, tiebreakOrder)

  if (tieResult) {
    return { ...state, phase: 'finished', result: tieResult }
  }

  // Golden point / overtime — driven by the boolean flag, not by tiebreak_order
  if (rules.rounds.golden_point) {
    // If overtime is configured, go there first; golden point fires after evaluateOvertime
    if ((rules.rounds.overtime_seconds ?? 0) > 0) {
      const nextRound = state.currentRound + 1
      return {
        ...state,
        phase: 'overtime',
        currentRound: nextRound,
        timeLeft: rules.rounds.overtime_seconds ?? 60,
        rounds: [...state.rounds, emptyRound(nextRound)],
      }
    }
    // No overtime — go straight to golden point
    const nextRound = state.currentRound + 1
    return {
      ...state,
      phase: 'golden_point',
      currentRound: nextRound,
      timeLeft: 0,
      rounds: [...state.rounds, emptyRound(nextRound)],
      goldenPoint: { attempt: 1, votes: {} },
    }
  }

  // Fall through to jury
  return { ...state, phase: 'finished', pendingJuryDecision: true, result: null }
}

function evaluateOvertime(state: MatchState, rules: RuleSetSparring): MatchState {
  // Misma regla en overtime: mayoría estricta de jueces.
  const judgesCount = rules.judgesCount ?? 1
  const { winner } = computeJudgeMajority(state.rounds, judgesCount)

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
      goldenPoint: { attempt: 1, votes: {} },
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
