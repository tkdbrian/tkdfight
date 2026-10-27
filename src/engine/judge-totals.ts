import type { MatchState } from './types'

export type JudgeTotals = Record<string, {
  red: number
  blue: number
  redFav: number
  blueFav: number
  redContra: number
  blueContra: number
}>

/** Score display and post-clock point decision, including the arbiter's deductions. */
export function computeJudgeTotalsForMatch(matchState: MatchState | null): JudgeTotals {
  const totals: JudgeTotals = {}
  if (!matchState) return totals

  // Every three minor warnings deduct one point; other arbiter deductions
  // affect each judge equally. Preserve the historical event-order semantics.
  const arbDeduct = { red: 0, blue: 0 }
  const warns = { red: 0, blue: 0 }
  for (const round of matchState.rounds) {
    for (const ev of round.events) {
      if (ev.judgeId !== 'arbiter') continue
      if (ev.type === 'warning_minor') {
        warns[ev.competitor]++
      } else if (ev.type === 'remove_warning') {
        warns[ev.competitor] = Math.max(0, warns[ev.competitor] - 1)
      } else if (ev.type === 'remove_warning_serious' || ev.type === 'remove_minus_point') {
        arbDeduct[ev.competitor] = Math.max(0, arbDeduct[ev.competitor] - ev.value)
      } else if (ev.value < 0) {
        arbDeduct[ev.competitor] += Math.abs(ev.value)
      }
    }
  }
  arbDeduct.red += Math.floor(warns.red / 3)
  arbDeduct.blue += Math.floor(warns.blue / 3)

  for (const round of matchState.rounds) {
    for (const ev of round.events) {
      if (ev.judgeId === 'arbiter') continue
      if (!totals[ev.judgeId]) {
        totals[ev.judgeId] = { red: 0, blue: 0, redFav: 0, blueFav: 0, redContra: 0, blueContra: 0 }
      }
      const total = totals[ev.judgeId]
      if (ev.value > 0) {
        total[ev.competitor === 'red' ? 'redFav' : 'blueFav'] += ev.value
      } else if (ev.value < 0) {
        total[ev.competitor === 'red' ? 'redContra' : 'blueContra'] += Math.abs(ev.value)
      }
    }
  }

  for (const total of Object.values(totals)) {
    total.redContra += arbDeduct.red
    total.blueContra += arbDeduct.blue
    total.red = Math.max(0, total.redFav - total.redContra)
    total.blue = Math.max(0, total.blueFav - total.blueContra)
  }
  return totals
}

/** Official result warning/foul columns. Corrections remove one active item. */
export function computePenaltyCountsForMatch(matchState: MatchState | null): {
  warnings: { red: number; blue: number }
  fouls: { red: number; blue: number }
} {
  const warnings = { red: 0, blue: 0 }
  const fouls = { red: 0, blue: 0 }
  if (!matchState) return { warnings, fouls }
  for (const round of matchState.rounds) {
    for (const ev of round.events) {
      if (ev.judgeId !== 'arbiter') continue
      if (ev.type === 'warning_minor' || ev.type === 'warning_serious') {
        warnings[ev.competitor] += 1
      } else if (ev.type === 'remove_warning' || ev.type === 'remove_warning_serious') {
        warnings[ev.competitor] = Math.max(0, warnings[ev.competitor] - 1)
      } else if (ev.type === 'minus_point') {
        fouls[ev.competitor] += 1
      } else if (ev.type === 'remove_minus_point') {
        fouls[ev.competitor] = Math.max(0, fouls[ev.competitor] - 1)
      }
    }
  }
  return { warnings, fouls }
}
