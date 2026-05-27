import type { Server, Socket } from 'socket.io'
import {
  createMatch,
  startPhase,
  addMatchEvent,
  endPhase,
  resolveJury,
  undoLastEvent,
} from '../../src/engine/match-machine.js'
import type { Competitor, RuleSetSparring } from '../../src/engine/types.js'
import type { MatchInfo } from '../state.js'
import { state, MAX_FALLOS_IN_MEMORY } from '../state.js'
import { broadcast, serverUrl } from '../broadcast.js'
import { startTicker, stopTicker } from '../timer.js'
import { computeJudgeTotals, computePenaltyCounts, nowTimeStr } from '../helpers.js'
import { completeFight, insertFightIfNew, upsertCompetitor, getSourceRing, saveMatchSnapshot, clearMatchSnapshot } from '../db/index.js'
import { getRingConfig } from '../ring-config.js'
import { logger } from '../logger.js'
import {
  judgeConnectSchema,
  matchLoadSchema,
  matchEventSchema,
  judgeVoteSchema,
  mesaFlagVoteSchema,
  matchUndoSchema,
  matchResolveJurySchema,
  matchDqSchema,
  matchMedicalSchema,
  matchDeleteFalloSchema,
  timerAdjustSchema,
  safeParse,
} from './schemas.js'

type FightWinner = Competitor | 'draw'

function tallyFlagWinner(votes: Map<string, string>, n: number): { red: number; blue: number; draw: number; winner: FightWinner } {
  let red = 0, blue = 0, draw = 0
  for (let i = 1; i <= n; i++) {
    const v = votes.get(`J${i}`)
    if (v === 'red') red++
    else if (v === 'blue') blue++
    else if (v === 'draw') draw++
  }
  let winner: FightWinner
  if (red > blue && red > draw) winner = 'red'
  else if (blue > red && blue > draw) winner = 'blue'
  else if (draw > red && draw > blue) winner = 'draw'
  else if (red === blue) winner = 'draw'   // empate rojo-azul → empate
  else winner = red > blue ? 'red' : 'blue' // color gana vs empate en empate
  return { red, blue, draw, winner }
}

function roundsWinner(flags: Array<{ red: number; blue: number; winner: string }>): FightWinner {
  const redR = flags.filter(r => r.winner === 'red').length
  const blueR = flags.filter(r => r.winner === 'blue').length
  if (redR > blueR) return 'red'
  if (blueR > redR) return 'blue'
  // Rounds empatados — desempate por total de votos de banderas
  const totalRed = flags.reduce((s, r) => s + r.red, 0)
  const totalBlue = flags.reduce((s, r) => s + r.blue, 0)
  if (totalRed > totalBlue) return 'red'
  if (totalBlue > totalRed) return 'blue'
  return 'draw'
}

export function registerSocketHandlers(io: Server) {
  io.on('connection', (socket: Socket) => {
    // Send current state on connect
    const ringConfig = getRingConfig()
    socket.emit('state:update', {
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
      ringToken: state.ringToken, // enviado solo en el connect inicial, no en cada broadcast
      ringAlias: ringConfig.alias,
      ringName: ringConfig.name,
    })

    socket.on('judge:connect', (raw: unknown, callback: (r: { judgeId?: string; error?: string }) => void) => {
      const data = safeParse(judgeConnectSchema, raw, 'judge:connect')
      if (data === null && raw !== undefined && raw !== null) {
        callback({ error: 'Payload inválido' })
        return
      }
      // Validar token de anillo — protege contra jueces no autorizados en la red
      if (data?.token !== state.ringToken) {
        callback({ error: 'Token inválido — escaneá el QR del tatami' })
        return
      }
      const maxJudges = state.rules?.judgesCount ?? 5
      if (state.judges.size >= maxJudges) {
        callback({ error: 'Máximo de jueces alcanzado' })
        return
      }
      const requested = data?.requestedId
      if (requested) {
        if (Array.from(state.judges.values()).includes(requested)) {
          callback({ error: `${requested} ya está ocupado` })
          return
        }
        state.judges.set(socket.id, requested)
        callback({ judgeId: requested })
      } else {
        const judgeId = `J${state.nextJudgeNum++}`
        state.judges.set(socket.id, judgeId)
        callback({ judgeId })
      }
      broadcast(io)
    })

    socket.on('match:load', (raw: unknown) => {
      const data = safeParse(matchLoadSchema, raw, 'match:load')
      if (!data) return
      state.rules = data.rules as RuleSetSparring
      state.match = data.match as MatchInfo
      state.matchState = createMatch(data.rules as RuleSetSparring)
      state.tulPhase = 'idle'
      state.nextJudgeNum = 1
      state.judges.clear()
      state.judgeVotes.clear()
      state.roundFlags = []
      stopTicker()
      // Persist to SQLite
      const tid = state.activeTournamentId
      try {
        upsertCompetitor({ id: data.match.red.id, tournament_id: tid, name: data.match.red.name, team: data.match.red.club })
        upsertCompetitor({ id: data.match.blue.id, tournament_id: tid, name: data.match.blue.name, team: data.match.blue.club })
        insertFightIfNew({ id: data.match.id, tournament_id: tid, red_id: data.match.red.id, blue_id: data.match.blue.id })
        // Emergency save: snapshot inicial (sin rounds completados todavía)
        saveMatchSnapshot(data.match.id, tid, { match: data.match, rules: data.rules, roundFlags: [] })
      } catch (err) {
        logger.error({ err }, '[match:load] DB persist error')
      }
      broadcast(io)
    })

    socket.on('match:start', () => {
      if (!state.matchState || !state.rules) return
      // Tul: sin timer ni rounds — ir directo a fase de votación
      if (state.match?.matchMode === 'tul') {
        if (state.tulPhase !== 'idle') return
        state.tulPhase = 'voting'
        state.judgeVotes.clear()
        broadcast(io)
        return
      }
      const phase = state.matchState.phase
      if (phase === 'idle' || phase === 'rest') {
        state.matchState = startPhase(state.matchState, state.rules)
        startTicker(io)
        broadcast(io)
      }
    })

    socket.on('match:event', (raw: unknown) => {
      const data = safeParse(matchEventSchema, raw, 'match:event')
      if (!data) return
      if (!state.matchState || !state.rules) return
      state.matchState = addMatchEvent(state.matchState, data, state.rules)
      broadcast(io)
    })

    socket.on('match:finishRound', () => {
      if (!state.matchState || !state.rules) return
      if (state.matchState.phase !== 'round' && state.matchState.phase !== 'overtime') return
      state.matchPaused = false
      state.matchState = endPhase({ ...state.matchState, timeLeft: 0 }, state.rules)
      if (state.matchState.phase === 'finished') {
        saveFallo()
      }
      broadcast(io)
    })

    socket.on('match:confirmPenalties', () => {
      if (!state.matchState || !state.rules) return
      if (state.matchState.phase !== 'penalties') return
      // Winner = majority of judge leads (same principle as flag voting).
      // This ensures penalties never override the "how many judges gave the win" rule.
      const jt = computeJudgeTotals()
      const judgeValues = Object.values(jt)
      let redLeads = 0, blueLeads = 0
      for (const t of judgeValues) {
        if (t.red > t.blue) redLeads++
        else if (t.blue > t.red) blueLeads++
      }
      let overall: FightWinner
      if (redLeads > blueLeads) overall = 'red'
      else if (blueLeads > redLeads) overall = 'blue'
      else overall = 'draw'
      state.matchState = {
        ...state.matchState,
        phase: 'finished',
        pendingJuryDecision: false,
        result: { winner: overall, reason: 'points' },
      }
      stopTicker()
      saveFallo(overall)
      broadcast(io)
    })

    socket.on('match:resolveJury', (raw: unknown) => {
      const data = safeParse(matchResolveJurySchema, raw, 'match:resolveJury')
      if (!data) return
      if (!state.matchState) return
      state.matchState = resolveJury(state.matchState, data.winner)
      broadcast(io)
    })

    socket.on('match:reset', () => {
      if (!state.rules) return
      state.matchState = createMatch(state.rules)
      state.judgeVotes.clear()
      state.roundFlags = []
      state.tulPhase = 'idle'
      stopTicker()
      try { clearMatchSnapshot() } catch { /* non-critical */ }
      broadcast(io)
    })

    socket.on('judge:vote', (raw: unknown) => {
      const data = safeParse(judgeVoteSchema, raw, 'judge:vote')
      if (!data) return
      const myJudgeId = state.judges.get(socket.id)
      if (!myJudgeId || myJudgeId !== data.judgeId) return
      // Normaliza 'tie' → 'draw' para consistencia con mesa:flagVote y tallyFlagWinner
      const normalizedVote = data.vote === 'tie' ? 'draw' : data.vote
      state.judgeVotes.set(data.judgeId, normalizedVote)
      broadcast(io)
    })

    socket.on('match:undo', (raw: unknown) => {
      const data = safeParse(matchUndoSchema, raw, 'match:undo')
      if (!data) return
      if (!state.matchState) return
      const myJudgeId = state.judges.get(socket.id)
      if (!myJudgeId || myJudgeId !== data.judgeId) return
      state.matchState = undoLastEvent(state.matchState, data.judgeId)
      broadcast(io)
    })

    // Árbitro/jefe de mesa puede deshacer el último evento sin ser juez registrado
    socket.on('match:undoArbiter', () => {
      if (!state.matchState) return
      state.matchState = undoLastEvent(state.matchState)
      broadcast(io)
    })

    socket.on('match:pause', () => {
      if (!state.matchState || state.matchPaused) return
      if (state.matchState.phase !== 'round' && state.matchState.phase !== 'overtime') return
      state.matchPaused = true
      broadcast(io)
    })

    socket.on('match:resume', () => {
      if (!state.matchState || !state.matchPaused) return
      state.matchPaused = false
      broadcast(io)
    })

    socket.on('match:dq', (raw: unknown) => {
      const data = safeParse(matchDqSchema, raw, 'match:dq')
      if (!data) return
      if (!state.matchState || !state.rules) return
      state.matchState = addMatchEvent(
        state.matchState,
        { judgeId: 'arbiter', competitor: data.competitor, type: 'disqualify' },
        state.rules,
      )
      state.matchPaused = false
      state.matchState = endPhase({ ...state.matchState, timeLeft: 0 }, state.rules)
      stopTicker()
      saveFallo(data.competitor === 'red' ? 'blue' : 'red')
      broadcast(io)
    })

    socket.on('match:medical', (raw: unknown) => {
      const data = safeParse(matchMedicalSchema, raw, 'match:medical')
      if (!data) return
      if (!state.matchState) return
      state.matchPaused = true
      broadcast(io)
    })

    socket.on('match:saveFallo', () => {
      saveFallo()
      broadcast(io)
    })

    socket.on('match:deleteFallo', (raw: unknown) => {
      const data = safeParse(matchDeleteFalloSchema, raw, 'match:deleteFallo')
      if (!data) return
      const idx = state.fallos.findIndex((f) => f.id === data.id)
      if (idx !== -1) state.fallos.splice(idx, 1)
      broadcast(io)
    })

    socket.on('timer:addSeconds', (raw: unknown) => {
      const data = safeParse(timerAdjustSchema, raw, 'timer:addSeconds')
      if (!data) return
      if (!state.matchState || !state.matchPaused) return
      const phase = state.matchState.phase
      if (phase !== 'round' && phase !== 'overtime' && phase !== 'rest') return
      state.matchState = {
        ...state.matchState,
        timeLeft: Math.max(0, state.matchState.timeLeft + data.seconds),
      }
      broadcast(io)
    })

    socket.on('match:clearFallos', () => {
      state.fallos.length = 0
      broadcast(io)
    })

    socket.on('match:skipToFlags', () => {
      if (!state.matchState || !state.rules) return
      let ms = state.matchState
      if (ms.phase === 'idle' || ms.phase === 'rest') {
        ms = startPhase(ms, state.rules)
      }
      if (ms.phase === 'round') {
        state.matchPaused = false
        ms = endPhase({ ...ms, timeLeft: 0 }, state.rules)
      }
      state.matchState = ms
      stopTicker()
      broadcast(io)
    })

    socket.on('mesa:flagVote', (raw: unknown) => {
      const data = safeParse(mesaFlagVoteSchema, raw, 'mesa:flagVote')
      if (!data) return
      state.judgeVotes.set(data.judgeId, data.vote)
      broadcast(io)
    })

    socket.on('mesa:confirmRound', () => {
      if (!state.rules || !state.matchState) return
      // Only allow flag confirmation during rest phase (or pending jury decision in points mode)
      const msPhase = state.matchState.phase
      if (msPhase !== 'rest' && !(msPhase === 'finished' && state.matchState.pendingJuryDecision)) return
      const { red, blue, winner } = tallyFlagWinner(state.judgeVotes, state.rules.judgesCount)
      const votes = Object.fromEntries(state.judgeVotes)
      state.roundFlags.push({ red, blue, winner, votes })
      state.judgeVotes.clear()
      const totalRounds = state.rules.rounds.count
      if (state.roundFlags.length >= totalRounds) {
        const overall = roundsWinner(state.roundFlags)
        state.matchState = {
          ...state.matchState,
          phase: 'finished',
          timeLeft: 0,
          pendingJuryDecision: false,
          result: { winner: overall, reason: 'points' },
        }
        stopTicker()
        saveFallo(overall)
      } else {
        // Actualizar snapshot con el round recién completado (guardado intermedio)
        if (state.match?.id) {
          try {
            saveMatchSnapshot(state.match.id, state.activeTournamentId, {
              match: state.match,
              rules: state.rules,
              roundFlags: [...state.roundFlags],
            })
          } catch { /* non-critical */ }
        }
      }
      broadcast(io)
    })

    socket.on('mesa:undoRound', () => {
      if (!state.roundFlags.length || !state.matchState || !state.rules) return
      // No deshacer mientras hay un round activo
      const msPhase = state.matchState.phase
      if (msPhase === 'round' || msPhase === 'overtime' || msPhase === 'golden_point') return
      state.roundFlags.pop()
      state.judgeVotes.clear()
      // Si el combate ya terminó por conteo de rounds, volver a fase de descanso
      if (msPhase === 'finished' && state.matchState.result?.reason === 'points') {
        state.matchState = {
          ...state.matchState,
          phase: 'rest',
          result: null,
          pendingJuryDecision: false,
        }
      }
      broadcast(io)
    })

    socket.on('disconnect', () => {
      state.judges.delete(socket.id)
      broadcast(io)
    })

    // ── Tul mode ──────────────────────────────────────────────────────────────

    socket.on('tul:finish', () => {
      if (!state.matchState || state.match?.matchMode !== 'tul') return
      if (state.tulPhase !== 'voting') return
      const judgesCount = state.rules?.judgesCount ?? 3
      const { winner } = tallyFlagWinner(state.judgeVotes, judgesCount)
      // Actualizar matchState con resultado final (la fase 'finished' ya existe en MatchPhase)
      // biome-ignore lint/suspicious/noExplicitAny: tul bypass — 'finished' es una MatchPhase válida
      state.matchState = { ...state.matchState, phase: 'finished', result: { winner, reason: 'points' } } as any
      state.tulPhase = 'finished'
      stopTicker()
      saveFallo(winner)
      broadcast(io)
    })

    socket.on('tul:retry', () => {
      if (state.match?.matchMode !== 'tul') return
      if (state.tulPhase !== 'voting') return
      state.judgeVotes.clear()
      broadcast(io)
    })
  })
}

function saveFallo(winnerOverride?: 'red' | 'blue' | 'draw') {
  const jt = computeJudgeTotals()
  let redTotal = 0, blueTotal = 0
  for (const v of Object.values(jt)) {
    redTotal += v.red
    blueTotal += v.blue
  }
  let winner: 'red' | 'blue' | 'draw'
  if (winnerOverride) {
    winner = winnerOverride
  } else if (redTotal > blueTotal) {
    winner = 'red'
  } else if (blueTotal > redTotal) {
    winner = 'blue'
  } else {
    winner = 'draw'
  }
  // Accumulate flags from all rounds
  const flagsRed = state.roundFlags.reduce((s, r) => s + r.red, 0)
  const flagsBlue = state.roundFlags.reduce((s, r) => s + r.blue, 0)
  state.fallos.push({
    id: state.falloSeq++,
    time: nowTimeStr(),
    redName: state.match?.red.name ?? 'Rojo',
    blueName: state.match?.blue.name ?? 'Azul',
    redScore: redTotal,
    blueScore: blueTotal,
    winner,
  })
  // Cap en memoria: los excedentes ya están persistidos en SQLite via completeFight()
  if (state.fallos.length > MAX_FALLOS_IN_MEMORY) {
    state.fallos.splice(0, state.fallos.length - MAX_FALLOS_IN_MEMORY)
  }
  // Persist to SQLite if fight has an id
  if (state.match?.id) {
    try {
      completeFight(state.match.id, winner, '', flagsRed, flagsBlue)
      // Si la pelea fue reasignada desde otro tatami, notificarle el resultado
      const sourceRing = getSourceRing(state.match.id)
      if (sourceRing) {
        const ringAlias = getRingConfig().alias
        fetch(`http://${sourceRing}/api/ring/remote-result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fightId: state.match.id,
            winner,
            flagsRed,
            flagsBlue,
            completedIn: ringAlias,
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => { /* best-effort: si el tatami origen no está online, se pierde */ })
      }
      // Pelea completada — eliminar snapshot de emergencia
      clearMatchSnapshot()
    } catch {
      // Not critical — in-memory state is source of truth
    }
  }
}
