import type { Server } from 'socket.io'
import { state } from './state.js'
import { broadcast } from './broadcast.js'
import { tick } from '../src/engine/match-machine.js'

export function startTicker(io: Server) {
  if (state.tickInterval) return
  state.tickInterval = setInterval(() => {
    if (!state.matchState || !state.rules || state.matchPaused) return
    const phase = state.matchState.phase
    if (phase === 'round' || phase === 'overtime') {
      state.matchState = tick(state.matchState, state.rules)
      broadcast(io)
    } else if (phase === 'rest' && state.matchState.timeLeft > 0) {
      state.matchState = { ...state.matchState, timeLeft: state.matchState.timeLeft - 1 }
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
