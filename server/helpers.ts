import os from 'node:os'
import { state } from './state.js'

export function getLocalIp(): string {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return 'localhost'
}

export function computeJudgeTotals(): ReturnType<typeof _computeJudgeTotals> {
  return _computeJudgeTotals()
}

function _computeJudgeTotals() {
  const totals: Record<
    string,
    { red: number; blue: number; redFav: number; blueFav: number; redContra: number; blueContra: number }
  > = {}
  const { matchState } = state
  if (!matchState) return totals

  // Compute arbiter deductions: every 3 warning_minor = 1 pt, minus_point = 1 pt each
  const arbDeduct = { red: 0, blue: 0 }
  const warns = { red: 0, blue: 0 }
  for (const round of matchState.rounds) {
    for (const ev of round.events) {
      if (ev.judgeId !== 'arbiter') continue
      if (ev.type === 'warning_minor') {
        warns[ev.competitor as 'red' | 'blue']++
      } else if (ev.type === 'remove_warning') {
        warns[ev.competitor as 'red' | 'blue'] = Math.max(0, warns[ev.competitor as 'red' | 'blue'] - 1)
      } else if (ev.type === 'remove_minus_point') {
        arbDeduct[ev.competitor as 'red' | 'blue'] = Math.max(0, arbDeduct[ev.competitor as 'red' | 'blue'] - 1)
      } else if (ev.value < 0) {
        arbDeduct[ev.competitor as 'red' | 'blue'] += Math.abs(ev.value)
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
      const t = totals[ev.judgeId]
      if (ev.value > 0) {
        t[ev.competitor === 'red' ? 'redFav' : 'blueFav'] += ev.value
      } else if (ev.value < 0) {
        t[ev.competitor === 'red' ? 'redContra' : 'blueContra'] += Math.abs(ev.value)
      }
    }
  }

  // Apply arbiter deductions equally to each judge so scoreDisplay reflects penalties
  for (const t of Object.values(totals)) {
    t.redContra += arbDeduct.red
    t.blueContra += arbDeduct.blue
  }

  for (const t of Object.values(totals)) {
    t.red = Math.max(0, t.redFav - t.redContra)
    t.blue = Math.max(0, t.blueFav - t.blueContra)
  }
  return totals
}

export function computePenaltyCounts(): { warnings: { red: number; blue: number }; fouls: { red: number; blue: number } } {
  const warnings = { red: 0, blue: 0 }
  const fouls = { red: 0, blue: 0 }
  const { matchState } = state
  if (!matchState) return { warnings, fouls }
  for (const round of matchState.rounds) {
    for (const ev of round.events) {
      if (ev.judgeId !== 'arbiter') continue
      if (ev.type === 'warning_minor' || ev.type === 'warning_serious') {
        warnings[ev.competitor] += 1
      } else if (ev.type === 'remove_warning') {
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

export function nowTimeStr(): string {
  const now = new Date()
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
}
