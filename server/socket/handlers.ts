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
import {
  confirmMatchResult,
  getActiveMatchLock,
  getCategoryTournamentId,
  getMatchResult,
  getSourceCategoryId,
  getSourceRing,
  insertFightIfNew,
  isFightPending,
  resolveCategoryTournament,
  saveMatchSnapshot,
  savePendingMatchResult,
  upsertCompetitor,
  type MatchResultInput,
  type StoredMatchResult,
} from '../db/index.js'
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
  matchCommandContextSchema,
  matchResultConfirmationSchema,
  matchResultQuerySchema,
  matchDqSchema,
  matchMedicalSchema,
  matchDeleteFalloSchema,
  timerAdjustSchema,
  safeParse,
} from './schemas.js'

type FightWinner = Competitor | 'draw'

const MATCH_CONTEXT_EVENTS = new Set([
  'match:start', 'match:event', 'match:finishRound', 'match:confirmPenalties',
  'match:resolveJury', 'match:reset', 'judge:vote', 'match:undo',
  'match:undoArbiter', 'match:pause', 'match:resume', 'match:dq',
  'match:medical', 'match:saveFallo', 'timer:addSeconds',
  'match:skipToFlags', 'mesa:flagVote', 'mesa:confirmRound',
  'mesa:undoRound', 'tul:finish', 'tul:reset',
])

function tallyFlagWinner(votes: Map<string, string>, n: number): { red: number; blue: number; draw: number; winner: FightWinner } {
  let red = 0, blue = 0, draw = 0
  for (let i = 1; i <= n; i++) {
    const v = votes.get(`J${i}`)
    if (v === 'red') red++
    else if (v === 'blue') blue++
    else if (v === 'draw') draw++
  }
  let winner: FightWinner
  // Regla de mesa:
  // 1) Si empate es mayoría clara (draw > red y draw > blue), gana empate.
  // 2) Si rojo y azul empatan entre sí, gana empate.
  // 3) Si no, gana el color con más votos entre rojo/azul (aunque empate tenga el mismo valor).
  if (draw > red && draw > blue) winner = 'draw'
  else if (red === blue) winner = 'draw'
  else winner = red > blue ? 'red' : 'blue'
  return { red, blue, draw, winner }
}

function roundsWinner(flags: Array<{ red: number; blue: number; draw?: number; winner: string }>): FightWinner {
  const redR = flags.filter(r => r.winner === 'red').length
  const blueR = flags.filter(r => r.winner === 'blue').length
  const drawR = flags.filter(r => r.winner === 'draw').length
  if (drawR > redR && drawR > blueR) return 'draw'
  if (redR === blueR) return 'draw'
  return redR > blueR ? 'red' : 'blue'
}

export function registerSocketHandlers(io: Server) {
  io.on('connection', (socket: Socket) => {
    // Send current state on connect
    const ringConfig = getRingConfig()
    socket.emit('state:update', {
      rules: state.rules,
      match: state.match,
      categoryId: state.matchCategoryId,
      tournamentId: state.matchTournamentId,
      activeMatchLock: getActiveMatchLock(),
      resultConfirmed: state.resultConfirmed,
      legacyMatchAssociationWarning: state.legacyMatchAssociationWarning,
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

    socket.use(([event, raw], next) => {
      if (!MATCH_CONTEXT_EVENTS.has(event)) return next()
      const context = matchCommandContextSchema.safeParse(raw)
      if (!context.success) {
        next(new Error('stale_match_context'))
        return
      }
      const activeMatchMatches = context.data.categoryId === state.matchCategoryId
        && context.data.matchId === state.match?.id
      const pendingResultLock = event === 'match:saveFallo' && state.match === null
        ? getActiveMatchLock()
        : null
      const pendingResultMatches = event === 'match:saveFallo'
        && state.match === null
        && context.data.categoryId === state.matchCategoryId
        && pendingResultLock?.fightId === context.data.matchId
        && pendingResultLock.categoryId === context.data.categoryId
        && getMatchResult(context.data.categoryId, context.data.matchId)?.status === 'pending_confirmation'
      if (!activeMatchMatches && !pendingResultMatches) {
        next(new Error('stale_match_context'))
        return
      }
      next()
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

    socket.on('match:load', (raw: unknown, callback?: (response: {
      ok: boolean
      error?: string
      code?: string
      warning?: string
      tournamentId?: number
      alreadyLoaded?: boolean
    }) => void) => {
      const respond = (response: Parameters<NonNullable<typeof callback>>[0]) => callback?.(response)
      const data = safeParse(matchLoadSchema, raw, 'match:load')
      if (!data) {
        respond({ ok: false, code: 'invalid_payload', error: 'Datos de carga inválidos' })
        return
      }

      const activeLock = getActiveMatchLock()
      if (activeLock && (activeLock.categoryId !== data.categoryId || activeLock.fightId !== data.match.id)) {
        const legacy = activeLock.categoryId === null
        respond({
          ok: false,
          code: legacy ? 'legacy_match_unassigned' : 'match_in_progress',
          error: legacy
            ? `Hay un combate histórico ${activeLock.fightId} sin categoría asociable; no se reasignó ni se liberó automáticamente.`
            : `El combate ${activeLock.fightId} sigue pendiente de confirmación. Resolvelo antes de cargar otro.`,
        })
        return
      }
      if (activeLock && (!state.match || !state.matchState)) {
        respond({
          ok: false,
          code: 'active_match_unrecoverable',
          error: state.legacyMatchAssociationWarning ?? 'El combate operativo tiene un snapshot no recuperable; no se reemplazó.',
        })
        return
      }
      if (state.match && state.matchState && !state.resultConfirmed) {
        if (state.matchCategoryId === data.categoryId && state.match.id === data.match.id) {
          respond({ ok: true, tournamentId: state.matchTournamentId ?? undefined, alreadyLoaded: true })
          return
        }
        respond({ ok: false, code: 'match_in_progress', error: 'Hay otro combate operativo pendiente de resolución.' })
        return
      }

      let nextMatchState
      try {
        nextMatchState = createMatch(data.rules as RuleSetSparring)
      } catch (err) {
        logger.warn({ err }, '[match:load] rules rejected')
        respond({ ok: false, code: 'invalid_rules', error: 'Las reglas del combate no son válidas.' })
        return
      }

      try {
        const association = resolveCategoryTournament({
          categoryId: data.categoryId,
          tournamentName: data.tournamentName,
          categoryName: data.match.category ?? '',
          preferredTournamentId: state.activeTournamentId,
        })
        const tournamentId = association.tournamentId
        upsertCompetitor({ id: data.match.red.id, tournament_id: tournamentId, name: data.match.red.name, team: data.match.red.club })
        upsertCompetitor({ id: data.match.blue.id, tournament_id: tournamentId, name: data.match.blue.name, team: data.match.blue.club })
        const inserted = insertFightIfNew({
          id: data.match.id,
          tournament_id: tournamentId,
          red_id: data.match.red.id,
          blue_id: data.match.blue.id,
        })
        if (!inserted && !isFightPending(data.match.id, tournamentId)) {
          respond({ ok: false, code: 'fight_already_completed', error: 'Este combate ya tiene un resultado confirmado.' })
          return
        }
        const match: MatchInfo = { ...data.match, categoryId: data.categoryId } as MatchInfo
        saveMatchSnapshot(data.match.id, tournamentId, { match, rules: data.rules as Record<string, unknown>, roundFlags: [] }, data.categoryId)

        state.activeTournamentId = tournamentId
        state.matchTournamentId = tournamentId
        state.matchCategoryId = data.categoryId
        state.resultConfirmed = false
        state.legacyMatchAssociationWarning = association.legacyHistoryUnassigned
          ? 'El historial anterior no tenía una identidad de categoría fiable; quedó intacto y no se reasignó.'
          : null
        state.rules = data.rules as RuleSetSparring
        state.match = match
        state.matchState = nextMatchState
        state.tulPhase = 'idle'
        state.nextJudgeNum = 1
        state.judges.clear()
        state.judgeVotes.clear()
        state.roundFlags = []
        stopTicker()
        respond({
          ok: true,
          tournamentId,
          warning: state.legacyMatchAssociationWarning ?? undefined,
        })
      } catch (err) {
        logger.error({ err, categoryId: data.categoryId, matchId: data.match.id }, '[match:load] DB persist error')
        respond({ ok: false, code: 'persistence_failed', error: 'No se pudo persistir la carga; el combate no se inició.' })
        return
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
      // Misma regla que banderines: empate solo si draw/tie es mayoría clara,
      // o si rojo y azul están empatados entre sí.
      const jt = computeJudgeTotals()
      const judgeValues = Object.values(jt)
      let redLeads = 0, blueLeads = 0, tiedLeads = 0
      for (const t of judgeValues) {
        if (t.red > t.blue) redLeads++
        else if (t.blue > t.red) blueLeads++
        else tiedLeads++
      }
      let overall: FightWinner
      if (tiedLeads > redLeads && tiedLeads > blueLeads) overall = 'draw'
      else if (redLeads === blueLeads) overall = 'draw'
      else overall = redLeads > blueLeads ? 'red' : 'blue'
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
      if (!state.rules || !state.match || state.resultConfirmed) return
      if (state.matchState?.phase === 'finished' && state.matchState.result) return
      const resetState = createMatch(state.rules)
      try {
        saveMatchSnapshot(
          state.match.id,
          state.matchTournamentId ?? state.activeTournamentId,
          { match: state.match, rules: state.rules, roundFlags: [] },
          state.matchCategoryId ?? undefined,
        )
      } catch (err) {
        logger.error({ err, matchId: state.match.id }, '[match:reset] snapshot persist error')
        return
      }
      state.matchState = resetState
      state.judgeVotes.clear()
      state.roundFlags = []
      state.tulPhase = 'idle'
      stopTicker()
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

    socket.on('match:result:get', (raw: unknown, callback?: (response: {
      ok: boolean
      error?: string
      result: StoredMatchResult | null
    }) => void) => {
      const data = safeParse(matchResultQuerySchema, raw, 'match:result:get')
      if (!data) {
        callback?.({ ok: false, error: 'Consulta de resultado inválida', result: null })
        return
      }
      callback?.({ ok: true, result: getMatchResult(data.categoryId, data.matchId) })
    })

    socket.on('match:saveFallo', (raw: unknown, callback?: (response: {
      ok: boolean
      error?: string
      result?: StoredMatchResult
    }) => void) => {
      const data = safeParse(matchResultConfirmationSchema, raw, 'match:saveFallo')
      if (!data) {
        callback?.({ ok: false, error: 'Confirmación de resultado inválida' })
        return
      }
      const existing = getMatchResult(data.categoryId, data.matchId)
      const input: MatchResultInput | null = existing
        ? {
            fightId: existing.fightId,
            categoryId: existing.categoryId,
            tournamentId: existing.tournamentId,
            winner: existing.winner,
            reason: existing.reason,
            flagsRed: existing.flagsRed,
            flagsBlue: existing.flagsBlue,
            warningsRed: existing.warningsRed,
            warningsBlue: existing.warningsBlue,
            foulsRed: existing.foulsRed,
            foulsBlue: existing.foulsBlue,
          }
        : buildMatchResultInput(data.categoryId, data.matchId)
      if (!input) {
        callback?.({ ok: false, error: 'No hay resultado final disponible para guardar.' })
        return
      }
      try {
        if (!existing) savePendingMatchResult(input)
        const result = confirmMatchResult(input)
        state.resultConfirmed = true
        notifySourceRing(result)
        callback?.({ ok: true, result })
        broadcast(io)
      } catch (err) {
        logger.error({ err, categoryId: data.categoryId, matchId: data.matchId }, '[match:saveFallo] result confirmation failed')
        callback?.({ ok: false, error: 'No se pudo guardar el resultado; sigue pendiente y podés reintentar.' })
      }
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
      const { red, blue, draw, winner } = tallyFlagWinner(state.judgeVotes, state.rules.judgesCount)
      const votes = Object.fromEntries(state.judgeVotes)
      state.roundFlags.push({ red, blue, draw, winner, votes })
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
            saveMatchSnapshot(state.match.id, state.matchTournamentId ?? state.activeTournamentId, {
              match: state.match,
              rules: state.rules,
              roundFlags: [...state.roundFlags],
            }, state.matchCategoryId ?? undefined)
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

    // Deshacer el "Confirmar ganador" en tul — vuelve a fase de votación conservando los votos
    socket.on('tul:undoFinish', () => {
      if (state.match?.matchMode !== 'tul') return
      if (state.tulPhase !== 'finished') return
      state.tulPhase = 'voting'
      if (state.matchState) {
        // biome-ignore lint/suspicious/noExplicitAny: tul bypass
        state.matchState = { ...state.matchState, phase: 'rest', result: null } as any
      }
      broadcast(io)
    })
  })
}

function buildMatchResultInput(categoryId: string, matchId: string, winnerOverride?: 'red' | 'blue' | 'draw'): MatchResultInput | null {
  const result = state.matchState?.result
  if (!state.match
    || state.match.id !== matchId
    || state.matchCategoryId !== categoryId
    || state.matchTournamentId === null
    || (!winnerOverride && !result?.winner)) return null

  const winner = winnerOverride ?? result?.winner
  if (!winner) return null
  const { red: flagsRed, blue: flagsBlue } = state.match.matchMode === "tul"
    ? tallyFlagWinner(state.judgeVotes, state.rules?.judgesCount ?? 3)
    : {
        red: state.roundFlags.reduce((sum, round) => sum + round.red, 0),
        blue: state.roundFlags.reduce((sum, round) => sum + round.blue, 0),
      }
  const penalties = computePenaltyCounts()
  return {
    fightId: matchId,
    categoryId,
    tournamentId: state.matchTournamentId,
    winner,
    reason: result?.reason ?? 'points',
    flagsRed,
    flagsBlue,
    warningsRed: penalties.warnings.red,
    warningsBlue: penalties.warnings.blue,
    foulsRed: penalties.fouls.red,
    foulsBlue: penalties.fouls.blue,
  }
}

function persistPendingResult(input: MatchResultInput): void {
  savePendingMatchResult(input)
  if (state.fallos.some((fallo) => fallo.matchId === input.fightId && fallo.categoryId === input.categoryId)) return
  const totals = computeJudgeTotals()
  let redScore = 0, blueScore = 0
  for (const value of Object.values(totals)) {
    redScore += value.red
    blueScore += value.blue
  }
  state.fallos.push({
    id: state.falloSeq++,
    time: nowTimeStr(),
    redName: state.match?.red.name ?? 'Rojo',
    blueName: state.match?.blue.name ?? 'Azul',
    redScore,
    blueScore,
    winner: input.winner,
    matchId: input.fightId,
    categoryId: input.categoryId,
  })
  if (state.fallos.length > MAX_FALLOS_IN_MEMORY) {
    state.fallos.splice(0, state.fallos.length - MAX_FALLOS_IN_MEMORY)
  }
}

function notifySourceRing(result: StoredMatchResult): void {
  const sourceRing = getSourceRing(result.fightId)
  if (!sourceRing) return
  const ringAlias = getRingConfig().alias
  const sourceCategoryId = getSourceCategoryId(result.fightId)
  fetch(`http://${sourceRing}/api/ring/remote-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fightId: result.fightId,
      ...(sourceCategoryId ? { categoryId: sourceCategoryId } : {}),
      winner: result.winner,
      flagsRed: result.flagsRed,
      flagsBlue: result.flagsBlue,
      completedIn: ringAlias,
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => { /* best-effort: si el tatami origen no está online, se pierde */ })
}

function saveFallo(winnerOverride?: 'red' | 'blue' | 'draw'): void {
  const categoryId = state.matchCategoryId
  const matchId = state.match?.id
  if (!categoryId || !matchId) return
  const input = buildMatchResultInput(categoryId, matchId, winnerOverride)
  if (!input) return
  try {
    if (state.match && state.rules) {
      saveMatchSnapshot(
        matchId,
        input.tournamentId,
        {
          match: state.match,
          rules: state.rules,
          roundFlags: [...state.roundFlags],
          pendingResult: { winner: input.winner, reason: input.reason },
        },
        categoryId,
      )
    }
    persistPendingResult(input)
  } catch (err) {
    logger.error({ err, categoryId, matchId }, '[result] pending result persist failed')
  }
}
