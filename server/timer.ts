import type { Server } from 'socket.io'
import { state } from './state.js'
import { broadcast } from './broadcast.js'
import { tick } from '../src/engine/match-machine.js'
import type { MatchState } from '../src/engine/types.js'
import { saveMatchSnapshot } from './db/index.js'
import { logger } from './logger.js'

/** A single tatami writes at most one clock checkpoint per second. */
function commitTick(nextState: MatchState): boolean {
  if (state.match) {
    if (!state.rules || !state.matchTournamentId || !state.matchCategoryId) return false
    try {
      saveMatchSnapshot(state.match.id, state.matchTournamentId, {
        match: state.match,
        rules: state.rules,
        roundFlags: [...state.roundFlags],
        judgeVotes: Object.fromEntries(state.judgeVotes),
        matchState: nextState,
      }, state.matchCategoryId)
    } catch (err) {
      logger.error({ err, matchId: state.match.id }, '[rr] clock snapshot persist failed')
      return false
    }
  }
  state.matchState = nextState
  return true
}

export function startTicker(io: Server) {
  if (state.tickInterval) return
  state.tickInterval = setInterval(() => {
    if (!state.matchState || !state.rules || state.matchPaused) return
    const phase = state.matchState.phase
    if (phase === 'round' || phase === 'overtime') {
      if (!commitTick(tick(state.matchState, state.rules))) {
        state.matchPaused = true
        stopTicker()
      }
      broadcast(io)
    } else if (phase === 'rest' && state.matchState.timeLeft > 0) {
      if (!commitTick({ ...state.matchState, timeLeft: state.matchState.timeLeft - 1 })) {
        state.matchPaused = true
        stopTicker()
      }
      broadcast(io)
    }
  }, 1000)
}

export function stopTicker() {
  if (state.tickInterval) {
    clearInterval(state.tickInterval)
    state.tickInterval = null
  }
}
