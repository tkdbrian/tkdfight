import os from 'node:os'
import type { MatchState } from '../src/engine/types.js'
import {
  computeJudgeTotalsForMatch,
  computePenaltyCountsForMatch as computePurePenaltyCountsForMatch,
} from '../src/engine/judge-totals.js'
import { state } from './state.js'

export function getLocalIp(): string {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    // biome-ignore lint/style/noNonNullAssertion: networkInterfaces() returns undefined only for unknown keys, impossible here
    for (const net of nets[name]!) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return 'localhost'
}

export function computeJudgeTotals(): ReturnType<typeof computeJudgeTotalsForMatch> {
  return computeJudgeTotalsForMatch(state.matchState)
}

export function computePenaltyCounts(): ReturnType<typeof computePurePenaltyCountsForMatch> {
  return computePurePenaltyCountsForMatch(state.matchState)
}

export function computePenaltyCountsForMatch(
  matchState: MatchState | null,
): ReturnType<typeof computePurePenaltyCountsForMatch> {
  return computePurePenaltyCountsForMatch(matchState)
}

export function nowTimeStr(): string {
  const now = new Date()
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
}
