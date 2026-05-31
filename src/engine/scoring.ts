import type { Competitor, MatchEvent, MatchResult, RoundState, RuleSetSparring } from './types'

// ── Point calculation ──────────────────────────────────────────────────────

export function calculateEventValue(
  type: string,
  rules: RuleSetSparring
): { value: number; isDQ: boolean } {
  // Subtract events (judge correction): subtract_1 → -1, subtract_2 → -2, subtract_3 → -3
  const subMatch = type.match(/^subtract_(\d+)$/)
  if (subMatch) return { value: -Number(subMatch[1]), isDQ: false }

  const deductionRaw = rules.deductions[type]
  if (deductionRaw !== undefined) {
    if (deductionRaw === 'DQ') return { value: 0, isDQ: true }
    return { value: deductionRaw as number, isDQ: false }
  }
  const pointValue = rules.points[type]
  if (pointValue !== undefined) return { value: pointValue, isDQ: false }
  return { value: 0, isDQ: false }
}

// ── Round totals ───────────────────────────────────────────────────────────

export function computeRoundTotals(events: MatchEvent[]): {
  totals: { red: number; blue: number }
  deductions: { red: number; blue: number }
  fouls: { red: number; blue: number }
} {
  const totals = { red: 0, blue: 0 }
  const deductions = { red: 0, blue: 0 }
  const fouls = { red: 0, blue: 0 }

  for (const ev of events) {
    totals[ev.competitor] += ev.value
    if (ev.value < 0) {
      deductions[ev.competitor] += ev.value  // accumulates as negative
    }
    if (ev.isDQ) {
      fouls[ev.competitor] += 1
    }
  }
  return { totals, deductions, fouls }
}

// ── Aggregate across all rounds ────────────────────────────────────────────

export function aggregateTotals(rounds: RoundState[]): { red: number; blue: number } {
  return rounds.reduce(
    (acc, r) => ({ red: acc.red + r.totals.red, blue: acc.blue + r.totals.blue }),
    { red: 0, blue: 0 }
  )
}

// Counts warning_minor events per competitor across all rounds (cumulative match-wide)
export function countWarnings(rounds: RoundState[]): { red: number; blue: number } {
  let red = 0, blue = 0
  for (const r of rounds) {
    for (const ev of r.events) {
      if (ev.judgeId !== 'arbiter') continue
      if (ev.type === 'warning_minor') {
        if (ev.competitor === 'red') red++
        else blue++
      } else if (ev.type === 'remove_warning') {
        if (ev.competitor === 'red') red = Math.max(0, red - 1)
        else blue = Math.max(0, blue - 1)
      }
    }
  }
  return { red, blue }
}

// Aggregates totals + applies every-3-warnings = 1 point deduction (match-wide cumulative)
export function aggregateTotalsWithPenalties(rounds: RoundState[]): { red: number; blue: number } {
  const base = aggregateTotals(rounds)
  const warns = countWarnings(rounds)
  return {
    red: base.red - Math.floor(warns.red / 3),
    blue: base.blue - Math.floor(warns.blue / 3),
  }
}

export function aggregateDeductions(rounds: RoundState[]): { red: number; blue: number } {
  return rounds.reduce(
    (acc, r) => ({ red: acc.red + r.deductions.red, blue: acc.blue + r.deductions.blue }),
    { red: 0, blue: 0 }
  )
}

export function aggregateFouls(rounds: RoundState[]): { red: number; blue: number } {
  return rounds.reduce(
    (acc, r) => ({ red: acc.red + r.fouls.red, blue: acc.blue + r.fouls.blue }),
    { red: 0, blue: 0 }
  )
}

// ── Winner comparison ──────────────────────────────────────────────────────

export function compareScores(
  totals: { red: number; blue: number }
): Competitor | 'draw' {
  if (totals.red > totals.blue) return 'red'
  if (totals.blue > totals.red) return 'blue'
  return 'draw'
}

// Per-judge tally + majority rule.
// Each judge "favors" red, blue or ties based on their own accumulated points.
// Winner = color with strict majority of judges (≥ floor(n/2)+1).
// Without majority → draw (regardless of raw point sums).
export function computeJudgeMajority(
  rounds: RoundState[],
  judgesCount: number
): { redLeaders: number; blueLeaders: number; ties: number; winner: Competitor | 'draw' } {
  const totals: Record<string, { red: number; blue: number }> = {}
  for (const r of rounds) {
    for (const ev of r.events) {
      if (ev.judgeId === 'arbiter') continue
      if (!totals[ev.judgeId]) totals[ev.judgeId] = { red: 0, blue: 0 }
      totals[ev.judgeId][ev.competitor] += ev.value
    }
  }
  let redLeaders = 0
  let blueLeaders = 0
  let ties = 0
  for (const t of Object.values(totals)) {
    if (t.red > t.blue) redLeaders++
    else if (t.blue > t.red) blueLeaders++
    else ties++
  }
  const accounted = redLeaders + blueLeaders + ties
  if (accounted < judgesCount) ties += judgesCount - accounted
  let winner: Competitor | 'draw'
  // Regla consistente con mesa/banderines:
  // - draw gana solo si es mayoría clara (ties > red y ties > blue)
  // - si red y blue empatan, resultado draw
  // - si no, gana el color con más jueces líderes
  if (ties > redLeaders && ties > blueLeaders) winner = 'draw'
  else if (redLeaders === blueLeaders) winner = 'draw'
  else winner = redLeaders > blueLeaders ? 'red' : 'blue'
  return { redLeaders, blueLeaders, ties, winner }
}

// "fewest deductions against" = competitor who had fewer deductions imposed on them
// deductions are stored as negative, so "fewer deductions" = closer to 0 = higher value
export function fewestDeductionsAgainst(
  rounds: RoundState[]
): Competitor | 'draw' {
  const d = aggregateDeductions(rounds)
  // d.red is negative sum of deductions against red, same for blue
  // The one with LESS deductions (i.e. higher/less-negative value) wins
  if (d.red > d.blue) return 'red'   // red had fewer deductions
  if (d.blue > d.red) return 'blue'
  return 'draw'
}

// ── Tiebreak cascade ───────────────────────────────────────────────────────

export function resolveTiebreak(
  rounds: RoundState[],
  firstPoint: Competitor | null,
  tiebreakOrder: string[]
): MatchResult | null {
  for (const step of tiebreakOrder) {
    switch (step) {
      case 'fewest_deductions_against': {
        const r = fewestDeductionsAgainst(rounds)
        if (r !== 'draw') return { winner: r, reason: 'points' }
        break
      }
      case 'first_clean_point': {
        if (firstPoint) return { winner: firstPoint, reason: 'points' }
        break
      }
      case 'golden_point':
        // golden_point is handled as a match phase, not resolved here
        return null
      case 'jury_decision':
        // requires manual input — signal caller via null
        return null
    }
  }
  return null
}

// ── DQ check ──────────────────────────────────────────────────────────────

export function checkDQ(
  rounds: RoundState[],
  rules: RuleSetSparring
): Competitor | null {
  const limit = rules.fouls_for_dq ?? 3
  const fouls = aggregateFouls(rounds)
  if (fouls.red >= limit) return 'red'
  if (fouls.blue >= limit) return 'blue'
  return null
}
