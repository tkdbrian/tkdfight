import type { Server } from 'socket.io'
import { state } from './state.js'
import { computeJudgeTotals, computePenaltyCounts } from './helpers.js'
import { getRingConfig } from './ring-config.js'

export let serverUrl = 'http://localhost:3001'

export function setServerUrl(url: string) {
  serverUrl = url
}

export function broadcast(io: Server) {
  const ringConfig = getRingConfig()
  io.emit('state:update', {
    rules: state.rules,
    match: state.match,
    matchState: state.matchState,
    matchPaused: state.matchPaused,
    judges: Array.from(state.judges.values()),
    judgeVotes: Object.fromEntries(state.judgeVotes),
    judgeTotals: computeJudgeTotals(),
    penaltyCounts: computePenaltyCounts(),
    fallos: [...state.fallos],
    roundFlags: [...state.roundFlags],
    serverUrl,
    ringToken: state.ringToken,
    ringAlias: ringConfig.alias,
    ringName: ringConfig.name,
    tulPhase: state.tulPhase,
  })
}
