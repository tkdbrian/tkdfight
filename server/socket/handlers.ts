import type { Server, Socket } from 'socket.io'
import { randomUUID } from 'node:crypto'
import { hasPostponeReceipt, releaseNeverStartedMatch } from '../db/match-postpone.js'
import { hasSwapReceipt, isNeverStartedSparringState, swapNeverStartedMatch } from '../db/match-swap.js'
import type { MatchSwapReply } from '../../src/lib/match-swap-contract.js'
import {
  createMatch,
  createGoldenPointMatch,
  castGoldenPointVote,
  setTableGoldenPointVote,
  confirmTableGoldenOutcome,
  getSanctionCount,
  setSanctionCount,
  startPhase,
  addMatchEvent,
  endPhase,
  resolveJury,
  undoLastEvent,
} from '../../src/engine/match-machine.js'
import type { Competitor, MatchState, RuleSetSparring } from '../../src/engine/types.js'
import type { MatchInfo } from '../state.js'
import { state, MAX_FALLOS_IN_MEMORY } from '../state.js'
import { broadcast, serverUrl } from '../broadcast.js'
import { startTicker, stopTicker } from '../timer.js'
import { computeJudgeTotals, computePenaltyCounts, computePenaltyCountsForMatch, nowTimeStr } from '../helpers.js'
import {
  confirmMatchResult,
  getActiveMatchLock,
  getCategoryTournamentId,
  getMatchResult,
  getFightCompetitorNames,
  getFightCompetitorIds,
  getMatchResultRevision,
  reopenPendingFlagResult,
  getSourceCategoryId,
  getSourceRing,
  insertFightIfNew,
  isFightPending,
  resolveCategoryTournament,
  saveMatchSnapshot,
  saveMatchSanctionEdit,
  savePendingMatchResult,
  savePendingMatchResultWithSnapshot,
  setSelectedTournamentId,
  upsertCompetitor,
  assertCategoryWritable,
  assertTournamentWritable,
  assertFightWritable,
  assertCompetitorWritable,
  CategoryExecutionError,
  CategoryDeletionError,
  getCategoryDeletionTombstones,
  type MatchResultInput,
  type StoredMatchResult,
} from '../db/index.js'
import { getRingConfig } from '../ring-config.js'
import { logger } from '../logger.js'
import {
  judgeConnectSchema,
  matchLoadSchema,
  matchConfigureSchema,
  matchPostponeSchema,
  matchSwapSchema,
  matchStartSchema,
  matchEventSchema,
  judgeVoteSchema,
  mesaFlagVoteSchema,
  goldenPointVoteSchema,
  mesaGoldenOutcomeSchema,
  mesaSanctionCountSchema,
  matchUndoSchema,
  matchResolveJurySchema,
  matchCommandContextSchema,
  matchResultConfirmationSchema,
  mesaUndoRoundSchema,
  tulUndoFinishSchema,
  tulFinishSchema,
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
  'tul:finish', 'tul:reset',
])

const ASSIGNMENT_FENCED_EVENTS = new Set([...MATCH_CONTEXT_EVENTS,
  'mesa:setSanctionCount', 'mesa:undoRound',
  'golden:vote', 'mesa:goldenVote', 'mesa:confirmGoldenOutcome'])

const EXECUTION_WRITE_EVENTS = new Set([...MATCH_CONTEXT_EVENTS, 'match:load', 'match:configure', 'match:postpone', 'match:swapCompetitors',
  'mesa:setSanctionCount', 'mesa:undoRound', 'golden:vote', 'mesa:goldenVote',
  'mesa:confirmGoldenOutcome', 'match:deleteFallo', 'match:clearFallos',
  'tul:retry', 'tul:undoFinish'])

/** Refuse an operational state change if its arbiter events cannot be recovered after a restart. */
function persistIndividualFlagState(
  nextState: MatchState,
  nextRoundFlags = state.roundFlags,
  nextJudgeVotes = state.judgeVotes,
  nextMatch = state.match,
): boolean {
  if (!state.match) return false
  if (!state.rules || !state.matchTournamentId || !state.matchCategoryId) return false
  try {
    saveMatchSnapshot(state.match.id, state.matchTournamentId, {
      match: nextMatch!,
      rules: state.rules,
      roundFlags: [...nextRoundFlags],
      judgeVotes: Object.fromEntries(nextJudgeVotes),
      matchState: nextState,
      ...(state.match.matchMode === 'tul' ? { tulPhase: nextState.phase === 'finished'
        ? 'finished' as const : nextState.phase === 'rest' ? 'voting' as const : state.tulPhase } : {}),
    }, state.matchCategoryId)
    return true
  } catch (err) {
    logger.error({ err, matchId: state.match.id }, '[rr] operational snapshot persist failed')
    return false
  }
}

function hasPreFightActivity(): boolean {
  const current = state.matchState
  return !current || current.phase !== 'idle' || current.currentRound !== 0 || !!current.result
    || current.firstPoint !== null || state.roundFlags.length > 0 || state.judgeVotes.size > 0
    || current.rounds.some(round => round.events.length > 0)
    || current.timeLeft !== state.rules?.rounds.duration_seconds
}

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
      categoryDeletions: getCategoryDeletionTombstones(),
      resultConfirmed: state.resultConfirmed,
      resultRevision: state.matchCategoryId && state.match ? getMatchResultRevision(state.matchCategoryId, state.match.id) : 0,
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

    socket.use((packet, next) => {
      const [event, raw] = packet
      if (EXECUTION_WRITE_EVENTS.has(event)) {
        const data = raw !== null && typeof raw === 'object'
          ? raw as Record<string, unknown> : {}
        try {
          if (typeof data.categoryId === 'string') assertCategoryWritable(data.categoryId)
          if (typeof data.matchId === 'string') assertFightWritable(data.matchId)
          if (event === 'match:load') {
            if (data.match !== null && typeof data.match === 'object') {
              const match = data.match as Record<string, unknown>
              if (typeof match.id === 'string') assertFightWritable(match.id)
              for (const side of [match.red, match.blue]) {
                if (side !== null && typeof side === 'object' && 'id' in side
                  && typeof side.id === 'string') assertCompetitorWritable(side.id)
              }
            }
          } else {
            if (state.matchCategoryId) assertCategoryWritable(state.matchCategoryId)
            if (state.matchTournamentId !== null) assertTournamentWritable(state.matchTournamentId)
            if (state.match) assertFightWritable(state.match.id)
            if (event === 'match:clearFallos' || event === 'match:deleteFallo') {
              for (const fallo of state.fallos) {
                if (event === 'match:deleteFallo' && fallo.id !== data.id) continue
                if (fallo.categoryId) assertCategoryWritable(fallo.categoryId)
                if (fallo.matchId) assertFightWritable(fallo.matchId)
              }
            }
          }
        } catch (error) {
          if (!(error instanceof CategoryExecutionError) && !(error instanceof CategoryDeletionError)) return next(error instanceof Error ? error : new Error('archive_guard_failed'))
          const response = { ok: false, code: error.code, error: error.message,
            ...(error instanceof CategoryExecutionError ? { replacementCategoryId: error.replacementCategoryId }
              : { categoryId: error.categoryId, deletion: error.deletion, status: error.code === 'category_deleted' || error.code === 'replacement_deleted' ? 410 : 409 }) }
          const reply: unknown = packet.at(-1)
          if (typeof reply === 'function') reply(response)
          else socket.emit('category:archived', response)
          return
        }
      }
      const enforceContext = MATCH_CONTEXT_EVENTS.has(event)
      if (!ASSIGNMENT_FENCED_EVENTS.has(event)) return next()
      const context = matchCommandContextSchema.safeParse(raw)
      if (!context.success) {
        if (enforceContext) next(new Error('stale_match_context'))
        else next() // Preserve the event's own invalid-payload ACK.
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
        if (enforceContext) next(new Error('stale_match_context'))
        else next() // These handlers return a specific wrong-context ACK.
        return
      }
      // A color-assignment swap leaves the fight ID unchanged. Fence all later operational
      // commands against the generation/revision their sender actually displayed.
      const timing = state.match?.matchMode === 'sparring' ? state.match.preFight : null
      const assignmentPayload = raw as Record<string, unknown>
      const supplied = assignmentPayload.expectedLoadId !== undefined
        || assignmentPayload.expectedAssignmentRevision !== undefined
      if (timing && ((timing.swapCount ?? 0) > 0 || supplied)
        && (assignmentPayload.expectedLoadId !== timing.loadId
          || assignmentPayload.expectedAssignmentRevision !== timing.revision)) {
        const response = { ok: false, code: 'stale_assignment',
          error: 'La asignacion de competidores cambio. Actualiza la pelea antes de operar.' }
        const reply: unknown = packet.at(-1)
        if (typeof reply === 'function') reply(response)
        else socket.emit('match:assignment-stale', response)
        broadcast(io)
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
        if (!Array.from({ length: maxJudges }, (_, i) => `J${i + 1}`).includes(requested)) {
          callback({ error: `Juez fuera de rango (J1–J${maxJudges})` })
          return
        }
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
      blockedFightId?: string
      blockedCategoryId?: string | null
      pendingConfirmation?: boolean
      blockedRedName?: string
      blockedBlueName?: string
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
        const matchingMatch = state.match?.id === activeLock.fightId && state.matchCategoryId === activeLock.categoryId
          ? state.match : null
        const names = matchingMatch ? { redName: matchingMatch.red.name, blueName: matchingMatch.blue.name }
          : getFightCompetitorNames(activeLock.fightId, activeLock.tournamentId)
        const pendingConfirmation = activeLock.resultStatus === 'pending_confirmation'
        const fightLabel = names ? `el combate de ${names.redName} vs. ${names.blueName}` : 'otro combate'
        respond({
          ok: false,
          code: legacy ? 'legacy_match_unassigned' : 'match_in_progress',
          blockedFightId: activeLock.fightId,
          blockedCategoryId: activeLock.categoryId,
          pendingConfirmation,
          blockedRedName: names?.redName,
          blockedBlueName: names?.blueName,
          error: legacy
            ? 'Hay un combate histórico sin categoría recuperable. Revisá su recuperación antes de cargar otra pelea.'
            : pendingConfirmation
              ? `Falta confirmar el resultado de ${names ? `${names.redName} vs. ${names.blueName}` : 'otro combate'}. Revisá y confirmá ese fallo antes de cargar otra pelea.`
              : `Sigue cargado ${fightLabel} en el tatami. Volvé a esa pelea antes de cargar otra.`,
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
        const names = `${state.match.red.name} vs. ${state.match.blue.name}`
        const pendingConfirmation = state.matchState.phase === 'finished' && !!state.matchState.result
        respond({ ok: false, code: 'match_in_progress',
          blockedFightId: state.match.id, blockedCategoryId: state.matchCategoryId,
          blockedRedName: state.match.red.name, blockedBlueName: state.match.blue.name, pendingConfirmation,
          error: pendingConfirmation ? `Falta confirmar el resultado de ${names}. Revisá y confirmá ese fallo antes de cargar otra pelea.`
            : `El combate de ${names} sigue cargado en el tatami. Volvé a esa pelea antes de cargar otra.` })
        return
      }

      let nextMatchState
      try {
        if (data.match.timingKind) {
          const rules = data.rules as RuleSetSparring | undefined
          if (!rules || rules.mode !== 'sparring' || !rules.rounds
            || !Number.isInteger(rules.rounds.duration_seconds) || rules.rounds.duration_seconds < 1 || rules.rounds.duration_seconds > 3600
            || !Number.isSafeInteger(rules.rounds.count) || rules.rounds.count < 1
            || !Number.isInteger(rules.rounds.rest_seconds) || rules.rounds.rest_seconds < 0 || rules.rounds.rest_seconds > 3600
            || (data.match.requireIndividualFlags && rules.rounds.count !== 1)) throw new Error('Invalid pre-fight timings')
        }
        if (data.match.goldenPoint && (
          data.match.matchMode !== 'sparring'
          || !Number.isInteger((data.rules as RuleSetSparring)?.judgesCount)
          || (data.rules as RuleSetSparring).judgesCount < 1
          || (data.rules as RuleSetSparring).judgesCount > 5
        )) throw new Error('Invalid Golden Point rules')
        nextMatchState = data.match.goldenPoint
          ? createGoldenPointMatch(data.rules as RuleSetSparring)
          : createMatch(data.rules as RuleSetSparring)
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
        const match: MatchInfo = { ...data.match, categoryId: data.categoryId,
          ...(data.match.timingKind ? { preFight: { loadId: randomUUID(), revision: 0, started: false, defaultRounds: (data.rules as RuleSetSparring).rounds.count, timingKind: data.match.timingKind } } : {}),
        } as MatchInfo
        saveMatchSnapshot(data.match.id, tournamentId, {
          match, rules: data.rules as Record<string, unknown>, roundFlags: [],
          matchState: nextMatchState,
        }, data.categoryId)

        setSelectedTournamentId(tournamentId)
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
        state.matchPaused = false
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

    socket.on('match:postpone', (raw: unknown, reply?: (value: {ok:boolean;code?:string;error?:string;alreadyApplied?:boolean}) => void) => {
      const parsed = matchPostponeSchema.safeParse(raw)
      if (!parsed.success) { reply?.({ok:false,code:'invalid_payload',error:'Solicitud de postergación inválida.'}); return }
      const data = parsed.data
      try {
        if (state.judges.has(socket.id)) { reply?.({ok:false,code:'unauthorized_judge',error:'Solo el jefe de mesa puede postergar.'}); return }
        if (hasPostponeReceipt(data)) { reply?.({ok:true,alreadyApplied:true}); broadcast(io); return }
        if (data.categoryId !== state.matchCategoryId || data.matchId !== state.match?.id) {
          reply?.({ok:false,code:'stale_match_context',error:'El combate cargado cambió. No se postergó.'}); return
        }
        const timing = state.match.preFight
        if (!timing || timing.loadId !== data.expectedLoadId || timing.revision !== data.expectedRevision) {
          reply?.({ok:false,code:'stale_revision',error:'La carga o sus ajustes cambiaron. Revisá antes de postergar.'}); return
        }
        if (timing.started || hasPreFightActivity() || state.matchPaused || state.resultConfirmed || state.tulPhase !== 'idle') {
          reply?.({ok:false,code:'match_already_started',error:'Solo se puede postergar un combate sin iniciar ni actividad registrada.'}); return
        }
        releaseNeverStartedMatch(data)
        stopTicker()
        state.match = null; state.matchState = null; state.rules = null
        state.matchCategoryId = null; state.matchTournamentId = null
        state.matchPaused = false; state.resultConfirmed = false
        state.judgeVotes.clear(); state.judges.clear(); state.nextJudgeNum = 1
        state.roundFlags = []; state.tulPhase = 'idle'; state.legacyMatchAssociationWarning = null
        reply?.({ok:true}); broadcast(io)
      } catch (error) {
        logger.error({error}, '[match:postpone] release failed')
        reply?.({ok:false,code:'persistence_failed',error:'No se pudo postergar. El combate y sus datos se conservaron.'})
      }
    })

    socket.on('match:swapCompetitors', (raw: unknown, reply?: (value: MatchSwapReply) => void) => {
      const parsed = matchSwapSchema.safeParse(raw)
      if (!parsed.success) {
        reply?.({ ok: false, code: 'invalid_payload', error: 'Solicitud de intercambio invalida.' })
        return
      }
      const data = parsed.data
      if (state.judges.has(socket.id)) {
        reply?.({ ok: false, code: 'unauthorized_judge', error: 'Solo el jefe de mesa puede intercambiar competidores.' })
        return
      }
      try {
        if (hasSwapReceipt(data)) {
          const current = state.match
          if (state.matchCategoryId === data.categoryId && current?.id === data.matchId
            && current.preFight?.loadId === data.expectedLoadId
            && current.red.id === data.expectedBlueId && current.blue.id === data.expectedRedId) {
            reply?.({ ok: true, alreadyApplied: true, match: current })
          } else {
            reply?.({ ok: false, code: 'request_superseded',
              error: 'Otro cambio reemplazo este intercambio; actualiza la pelea.',
              ...(current ? { match: current } : {}) })
          }
          broadcast(io)
          return
        }
        const match = state.match
        if (data.categoryId !== state.matchCategoryId || data.matchId !== match?.id) {
          reply?.({ ok: false, code: 'stale_match_context', error: 'El combate cargado cambio.' })
          return
        }
        if (!match.preFight || match.preFight.loadId !== data.expectedLoadId
          || match.preFight.revision !== data.expectedRevision) {
          reply?.({ ok: false, code: 'stale_revision', error: 'La carga o sus ajustes cambiaron.' })
          return
        }
        if (match.red.id !== data.expectedRedId || match.blue.id !== data.expectedBlueId) {
          reply?.({ ok: false, code: 'stale_competitors', error: 'Los competidores asignados cambiaron.' })
          return
        }
        if (match.matchMode !== 'sparring' || match.goldenPoint
          || (match.timingKind !== 'regular' && match.timingKind !== 'elimination-final')
          || match.preFight.timingKind !== match.timingKind || state.rules?.mode !== 'sparring') {
          reply?.({ ok: false, code: 'swap_unavailable', error: 'Esta pelea no admite intercambio.' })
          return
        }
        if (match.preFight.started || !isNeverStartedSparringState(state.matchState, state.rules)
          || state.matchPaused || state.resultConfirmed || state.tulPhase !== 'idle'
          || state.roundFlags.length > 0 || state.judgeVotes.size > 0) {
          reply?.({ ok: false, code: 'match_already_started', error: 'Solo se intercambia antes de toda actividad.' })
          return
        }
        const nextMatch = swapNeverStartedMatch(data)
        state.match = nextMatch
        reply?.({ ok: true, match: nextMatch })
        broadcast(io)
      } catch (error) {
        const code = error instanceof Error ? error.message : 'persistence_failed'
        if (['request_conflict', 'stale_match_context', 'stale_revision', 'stale_competitors',
          'swap_unavailable', 'match_already_started'].includes(code)) {
          reply?.({ ok: false, code, error: 'El intercambio no se aplico; actualiza la pelea.' })
          return
        }
        logger.error({ error, matchId: data.matchId }, '[match:swapCompetitors] transaction failed')
        reply?.({ ok: false, code: 'persistence_failed', error: 'No se guardo el intercambio; no se modifico la pelea.' })
      }
    })

    type ConfigurationReply = {
      ok: boolean; code?: string; error?: string; alreadyApplied?: boolean
      preFight?: MatchInfo['preFight']; rules?: RuleSetSparring
    }
    const configuration = (): ConfigurationReply => ({ ok: true, preFight: state.match?.preFight,
      ...(state.rules ? { rules: state.rules } : {}) })
    socket.on('match:configuration', (raw: unknown, reply?: (value: ConfigurationReply) => void) => {
      const parsed = matchCommandContextSchema.safeParse(raw)
      if (!parsed.success || parsed.data.categoryId !== state.matchCategoryId || parsed.data.matchId !== state.match?.id) {
        reply?.({ ok: false, code: 'stale_match_context', error: 'La pelea seleccionada ya no esta cargada.' })
        return
      }
      reply?.(configuration())
      broadcast(io)
    })
    socket.on('match:configure', (raw: unknown, reply?: (value: ConfigurationReply) => void) => {
      const parsed = matchConfigureSchema.safeParse(raw)
      if (!parsed.success) {
        reply?.({ok: false, code: 'invalid_payload', error: 'Ingresa una duracion valida y uno o dos rounds.'})
        return
      }
      const data = parsed.data
      if (data.categoryId !== state.matchCategoryId || data.matchId !== state.match?.id) {
        reply?.({ok: false, code: 'stale_match_context', error: 'La pelea seleccionada ya no esta cargada.'})
        return
      }
      const match = state.match, current = state.matchState, rules = state.rules
      if (match?.preFight && ((match.preFight.swapCount ?? 0) > 0 || data.expectedLoadId !== undefined)
        && data.expectedLoadId !== match.preFight.loadId) {
        reply?.({ok: false, code: 'stale_assignment', error: 'La carga de competidores cambio.'})
        return
      }
      if (state.judges.has(socket.id)) {
        reply?.({ok: false, code: 'unauthorized_judge', error: 'Solo el jefe de mesa puede ajustar el combate.'})
        return
      }
      if (!match?.preFight || !current || !rules || rules.mode !== 'sparring' || match.matchMode !== 'sparring'
        || match.goldenPoint || match.preFight.timingKind === 'continuation' || state.resultConfirmed) {
        reply?.({ok: false, code: 'configuration_unavailable', error: 'Esta pelea no admite ajustes previos verificables.'})
        return
      }
      if (match.preFight.started || hasPreFightActivity()) {
        reply?.({ok: false, code: 'match_already_started', error: 'La pelea ya comenzo o tiene actividad registrada; no se cambiaron sus ajustes.'})
        return
      }
      if ((match.requireIndividualFlags && data.rounds !== 1)
        || (match.preFight.timingKind !== 'elimination-final' && data.rounds !== rules.rounds.count)
        || (match.preFight.timingKind === 'elimination-final' && data.rounds !== 1 && data.rounds !== 2
          && data.rounds !== rules.rounds.count && data.rounds !== match.preFight.defaultRounds)) {
        reply?.({ok: false, code: 'invalid_round_count', error: 'Dos rounds solo estan disponibles en finales de eliminacion.'})
        return
      }
      if (data.expectedRevision !== match.preFight.revision) {
        if (data.expectedRevision + 1 === match.preFight.revision && data.durationSeconds === rules.rounds.duration_seconds
          && data.rounds === rules.rounds.count) {
          reply?.({...configuration(), alreadyApplied: true})
          return
        }
        reply?.({ok: false, code: 'stale_revision', error: 'Los ajustes cambiaron. Revisa la configuracion guardada.'})
        return
      }
      const nextRules = {...rules, rounds: {...rules.rounds, count: data.rounds, duration_seconds: data.durationSeconds}}
      const nextMatch = {...match, preFight: {...match.preFight, revision: match.preFight.revision + 1}}
      const nextState = createMatch(nextRules)
      try {
        saveMatchSnapshot(match.id, state.matchTournamentId ?? state.activeTournamentId, {
          match: nextMatch, rules: nextRules, matchState: nextState, roundFlags: [], judgeVotes: {},
        }, data.categoryId)
      } catch (err) {
        logger.error({err, matchId: match.id}, '[match:configure] snapshot persist failed')
        reply?.({ok: false, code: 'persistence_failed', error: 'No se pudieron guardar los ajustes. No se modifico el combate.'})
        return
      }
      state.match = nextMatch
      state.rules = nextRules
      state.matchState = nextState
      reply?.(configuration())
      broadcast(io)
    })

    socket.on('match:start', (raw: unknown, reply?: (value: ConfigurationReply) => void) => {
      const parsed = matchStartSchema.safeParse(raw)
      if (!parsed.success || !state.matchState || !state.rules) {
        reply?.({ok: false, code: 'invalid_payload', error: 'No se puede iniciar este combate.'})
        return
      }
      if (state.match?.preFight && parsed.data.expectedTimingRevision !== state.match.preFight.revision) {
        reply?.({ok: false, code: 'stale_revision', error: 'Los ajustes cambiaron. Revisalos antes de iniciar.'})
        broadcast(io)
        return
      }
      // Tul: sin timer ni rounds — ir directo a fase de votación
      if (state.match?.matchMode === 'tul') {
        if (state.tulPhase !== 'idle') return
        const nextState: MatchState = { ...state.matchState, phase: 'rest', result: null }
        if (!persistIndividualFlagState(nextState, state.roundFlags, new Map<string, string>())) return
        state.matchState = nextState
        state.tulPhase = 'voting'
        state.judgeVotes.clear()
        broadcast(io)
        return
      }
      const phase = state.matchState.phase
      if (phase === 'idle' || phase === 'rest') {
        const nextState = startPhase(state.matchState, state.rules)
        const nextMatch = state.match?.preFight
          ? {...state.match, preFight: {...state.match.preFight, started: true}} : state.match
        if (!persistIndividualFlagState(nextState, state.roundFlags, state.judgeVotes, nextMatch)) {
          reply?.({ok: false, code: 'persistence_failed', error: 'No se pudo guardar el inicio; el reloj no comenzo.'})
          return
        }
        state.match = nextMatch
        state.matchState = nextState
        startTicker(io)
        reply?.(configuration())
        broadcast(io)
      }
    })

    socket.on('match:event', (raw: unknown) => {
      const data = safeParse(matchEventSchema, raw, 'match:event')
      if (!data) return
      if (!state.matchState || !state.rules) return
      if (state.matchState.phase === 'golden_point') return
      const nextState = addMatchEvent(state.matchState, data, state.rules)
      if (!persistIndividualFlagState(nextState)) return
      state.matchState = nextState
      broadcast(io)
    })

    type SanctionReply = {
      ok: boolean
      code?: string
      status?: number
      error?: string
      alreadyApplied?: boolean
      counts?: ReturnType<typeof computePenaltyCounts>
      pendingResult?: StoredMatchResult | null
    }
    socket.on('mesa:setSanctionCount', (raw: unknown, reply?: (response: SanctionReply) => void) => {
      const data = safeParse(mesaSanctionCountSchema, raw, 'mesa:setSanctionCount')
      if (!data) {
        reply?.({ ok: false, code: 'invalid_payload', status: 400, error: 'Sanción inválida.' })
        return
      }
      if (data.categoryId !== state.matchCategoryId || data.matchId !== state.match?.id) {
        reply?.({ ok: false, code: 'stale_match_context', status: 409,
          error: 'La categoría o pelea ya no está activa.' })
        return
      }
      if (!state.match || !state.rules || !state.matchState || state.matchTournamentId === null ||
        state.match.matchMode === 'tul' || state.match.goldenPoint ||
        !['rest', 'penalties', 'finished'].includes(state.matchState.phase) ||
        !state.matchState.rounds.length || state.judges.has(socket.id)) {
        reply?.({ ok: false, code: 'wrong_phase', status: 409,
          error: 'Las sanciones se corrigen después del reloj desde la mesa.' })
        return
      }
      if (state.matchState.result?.reason === 'dq') {
        reply?.({ ok: false, code: 'winner_locked', status: 409,
          error: 'Una descalificación requiere revisar el fallo completo, no solo sus sanciones.' })
        return
      }
      let existing: StoredMatchResult | null
      try {
        existing = getMatchResult(data.categoryId, data.matchId)
      } catch (err) {
        logger.error({ err, matchId: data.matchId }, '[mesa:setSanctionCount] result read failed')
        reply?.({ ok: false, code: 'persistence_failed', error: 'No se pudo verificar el resultado.' })
        return
      }
      if (state.resultConfirmed || existing?.status === 'confirmed') {
        reply?.({ ok: false, code: 'result_confirmed', status: 409,
          error: 'El fallo oficial ya fue confirmado; no se modificaron sanciones.' })
        return
      }
      if (state.matchState.phase === 'finished' && !existing) {
        reply?.({ ok: false, code: 'pending_result_missing', status: 409,
          error: 'El resultado pendiente no se guardó. Revisá el fallo antes de corregir sanciones.' })
        return
      }
      const currentCount = getSanctionCount(state.matchState, data.competitor, data.kind)
      if (currentCount === data.count) {
        reply?.({ ok: true, alreadyApplied: true, counts: computePenaltyCounts(), pendingResult: existing })
        broadcast(io)
        return
      }
      if (currentCount !== data.expectedCount) {
        reply?.({ ok: false, code: 'stale_count', status: 409,
          error: 'El número de sanciones cambió. Revisá el estado antes de reintentar.',
          counts: computePenaltyCounts() })
        return
      }
      const nextState = setSanctionCount(state.matchState, data.competitor, data.kind, data.count, state.rules)
      if (nextState === state.matchState) {
        reply?.({ ok: false, code: 'invalid_adjustment', status: 409, error: 'No se pudo aplicar la corrección.' })
        return
      }
      const counts = computePenaltyCountsForMatch(nextState)
      try {
        existing = saveMatchSanctionEdit(data.matchId, data.categoryId, state.matchTournamentId, {
          match: state.match,
          rules: state.rules,
          roundFlags: [...state.roundFlags],
          judgeVotes: Object.fromEntries(state.judgeVotes),
          matchState: nextState,
          ...(nextState.result ? { pendingResult: nextState.result } : {}),
        }, {
          warningsRed: counts.warnings.red,
          warningsBlue: counts.warnings.blue,
          foulsRed: counts.fouls.red,
          foulsBlue: counts.fouls.blue,
        })
      } catch (err) {
        logger.error({ err, matchId: data.matchId }, '[mesa:setSanctionCount] persist failed')
        reply?.({ ok: false, code: 'persistence_failed', error: 'No se guardó la sanción; podés reintentar.' })
        return
      }
      state.matchState = nextState
      reply?.({ ok: true, counts, pendingResult: existing })
      broadcast(io)
    })

    socket.on('match:finishRound', () => {
      if (!state.matchState || !state.rules) return
      if (state.matchState.phase !== 'round' && state.matchState.phase !== 'overtime') return
      const nextState = endPhase({ ...state.matchState, timeLeft: 0 }, state.rules)
      if (!persistIndividualFlagState(nextState)) return
      state.matchPaused = false
      state.matchState = nextState
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
      if (state.matchState.phase === 'golden_point') return
      state.matchState = resolveJury(state.matchState, data.winner)
      broadcast(io)
    })

    socket.on('match:reset', () => {
      if (!state.rules || !state.match || state.resultConfirmed) return
      if (state.matchState?.phase === 'finished' && state.matchState.result) return
      const nextMatch = state.match.preFight && hasPreFightActivity()
        ? {...state.match, preFight: {...state.match.preFight, started: true}} : state.match
      const resetState = state.match.goldenPoint ? createGoldenPointMatch(state.rules) : createMatch(state.rules)
      try {
        saveMatchSnapshot(
          state.match.id,
          state.matchTournamentId ?? state.activeTournamentId,
          { match: nextMatch, rules: state.rules, roundFlags: [], matchState: resetState },
          state.matchCategoryId ?? undefined,
        )
      } catch (err) {
        logger.error({ err, matchId: state.match.id }, '[match:reset] snapshot persist error')
        return
      }
      state.match = nextMatch
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
      // RR table-chief flags are entered on the ring, never by a remote judge.
      if (state.match?.requireIndividualFlags) return
      if (state.matchState?.phase === 'golden_point') return
      const myJudgeId = state.judges.get(socket.id)
      if (!myJudgeId || myJudgeId !== data.judgeId) return
      // Normaliza 'tie' → 'draw' para consistencia con mesa:flagVote y tallyFlagWinner
      const normalizedVote = data.vote === 'tie' ? 'draw' : data.vote
      if (state.match?.matchMode === 'tul') {
        if (!state.matchState || state.tulPhase !== 'voting' || state.resultConfirmed) return
        const nextVotes = new Map(state.judgeVotes)
        nextVotes.set(data.judgeId, normalizedVote)
        if (!persistIndividualFlagState(state.matchState, state.roundFlags, nextVotes)) return
      }
      state.judgeVotes.set(data.judgeId, normalizedVote)
      broadcast(io)
    })

    type GoldenVoteReply = { ok: boolean; code?: string; error?: string; attempt?: number; alreadyApplied?: boolean }
    const applyGoldenVote = (raw: unknown, remote: boolean, reply?: (result: GoldenVoteReply) => void): void => {
      const data = safeParse(goldenPointVoteSchema, raw, remote ? 'golden:vote' : 'mesa:goldenVote')
      if (!data) {
        reply?.({ ok: false, code: 'invalid_payload', error: 'Voto inválido.' })
        return
      }
      if (data.categoryId !== state.matchCategoryId || data.matchId !== state.match?.id) {
        reply?.({ ok: false, code: 'stale_match_context', error: 'La categoría o pelea ya no está activa.' })
        return
      }
      if (!state.match || !state.rules || !state.matchState || state.matchState.phase !== 'golden_point') {
        reply?.({ ok: false, code: 'wrong_phase', error: 'Punto de Oro no está activo.' })
        return
      }
      if (remote && state.judges.get(socket.id) !== data.judgeId) {
        reply?.({ ok: false, code: 'unauthorized_judge', error: 'Juez no registrado para este voto.' })
        return
      }
      if (remote && state.rules.judgingMode !== 'points') {
        reply?.({ ok: false, code: 'wrong_judging_mode', error: 'La pelea usa jueces de mesa.' })
        return
      }
      if (!remote && (state.rules.judgingMode === 'points' || state.judges.has(socket.id))) {
        reply?.({ ok: false, code: 'wrong_judging_mode', error: 'La pelea usa jueces remotos.' })
        return
      }
      const nextState = remote
        ? castGoldenPointVote(state.matchState, data.judgeId, data.competitor, data.attempt, state.rules.judgesCount)
        : setTableGoldenPointVote(state.matchState, data.judgeId, data.competitor, data.attempt, state.rules.judgesCount)
      if (nextState === state.matchState) {
        if (!remote && data.attempt === state.matchState.goldenPoint?.attempt &&
          state.matchState.goldenPoint.votes[data.judgeId] === data.competitor) {
          reply?.({ ok: true, attempt: data.attempt, alreadyApplied: true })
          broadcast(io)
          return
        }
        reply?.({ ok: false, code: 'stale_or_duplicate_vote', error: 'Voto duplicado o intento anterior.' })
        return
      }
      try {
        saveMatchSnapshot(state.match.id, state.matchTournamentId ?? state.activeTournamentId, {
          match: state.match,
          rules: state.rules,
          roundFlags: [...state.roundFlags],
          matchState: nextState,
          ...(nextState.result ? { pendingResult: nextState.result } : {}),
        }, state.matchCategoryId ?? undefined)
      } catch (err) {
        logger.error({ err, matchId: state.match.id }, '[golden:vote] snapshot persist failed')
        reply?.({ ok: false, code: 'persistence_failed', error: 'No se pudo guardar el voto; no se aplicó.' })
        return
      }
      state.matchState = nextState
      if (nextState.phase === 'finished') saveFallo(nextState.result?.winner === 'draw' ? undefined : nextState.result?.winner)
      reply?.({ ok: true, attempt: nextState.goldenPoint?.attempt })
      broadcast(io)
    }

    socket.on('golden:vote', (raw: unknown, reply?: (result: GoldenVoteReply) => void) => applyGoldenVote(raw, true, reply))
    socket.on('mesa:goldenVote', (raw: unknown, reply?: (result: GoldenVoteReply) => void) => applyGoldenVote(raw, false, reply))

    socket.on('mesa:confirmGoldenOutcome', (raw: unknown, reply?: (result: GoldenVoteReply) => void) => {
      const data = safeParse(mesaGoldenOutcomeSchema, raw, 'mesa:confirmGoldenOutcome')
      if (!data) {
        reply?.({ ok: false, code: 'invalid_payload', error: 'Confirmación inválida.' })
        return
      }
      if (data.categoryId !== state.matchCategoryId || data.matchId !== state.match?.id) {
        reply?.({ ok: false, code: 'stale_match_context', error: 'La categoría o pelea ya no está activa.' })
        return
      }
      if (!state.match?.goldenPoint || !state.rules || !state.matchState ||
        state.rules.judgingMode === 'points' || state.judges.has(socket.id)) {
        reply?.({ ok: false, code: 'wrong_judging_mode', error: 'Esta acción requiere jueces de mesa.' })
        return
      }
      const current = state.matchState
      if (current.phase === 'finished' && current.result?.reason === 'golden_point' &&
        current.goldenPoint?.attempt === data.attempt &&
        getMatchResult(data.categoryId, data.matchId)) {
        reply?.({ ok: true, attempt: data.attempt, alreadyApplied: true })
        broadcast(io)
        return
      }
      if (current.phase === 'golden_point' && current.goldenPoint?.attempt === data.attempt + 1) {
        reply?.({ ok: true, attempt: current.goldenPoint.attempt, alreadyApplied: true })
        broadcast(io)
        return
      }
      if (current.phase !== 'golden_point' || !current.goldenPoint ||
        current.goldenPoint.attempt !== data.attempt) {
        reply?.({ ok: false, code: 'wrong_phase', error: 'El intento ya no está activo.' })
        return
      }
      const nextState = confirmTableGoldenOutcome(current, data.attempt, state.rules.judgesCount)
      if (nextState === current) {
        reply?.({ ok: false, code: 'insufficient_votes', error: 'Todavía no hay una decisión para confirmar.' })
        return
      }
      if (state.matchTournamentId === null) {
        reply?.({ ok: false, code: 'persistence_failed', error: 'No se pudo identificar el torneo activo.' })
        return
      }
      const snapshot = {
        match: state.match,
        rules: state.rules,
        roundFlags: [...state.roundFlags],
        matchState: nextState,
        ...(nextState.result ? { pendingResult: nextState.result } : {}),
      }
      let input: MatchResultInput | null = null
      try {
        if (nextState.phase === 'finished') {
          input = buildMatchResultInput(data.categoryId, data.matchId, undefined, nextState)
          if (!input) {
            reply?.({ ok: false, code: 'persistence_failed', error: 'No se pudo calcular el resultado.' })
            return
          }
          savePendingMatchResultWithSnapshot(input, snapshot)
        } else {
          saveMatchSnapshot(data.matchId, state.matchTournamentId, snapshot, data.categoryId)
        }
      } catch (err) {
        logger.error({ err, matchId: data.matchId }, '[mesa:confirmGoldenOutcome] persist failed')
        reply?.({ ok: false, code: 'persistence_failed', error: 'No se guardó el resultado; podés corregir y reintentar.' })
        return
      }
      state.matchState = nextState
      if (input) appendPendingFallo(input)
      reply?.({ ok: true, attempt: nextState.goldenPoint?.attempt })
      broadcast(io)
    })

    socket.on('match:undo', (raw: unknown) => {
      const data = safeParse(matchUndoSchema, raw, 'match:undo')
      if (!data) return
      if (!state.matchState) return
      if (state.matchState.phase === 'golden_point') return
      if (state.matchState.result || (state.matchCategoryId && state.match?.id &&
        getMatchResult(state.matchCategoryId, state.match.id))) return
      const myJudgeId = state.judges.get(socket.id)
      if (!myJudgeId || myJudgeId !== data.judgeId) return
      const nextState = undoLastEvent(state.matchState, data.judgeId)
      if (!persistIndividualFlagState(nextState)) return
      state.matchState = nextState
      broadcast(io)
    })

    // Árbitro/jefe de mesa puede deshacer el último evento sin ser juez registrado
    socket.on('match:undoArbiter', () => {
      if (!state.matchState) return
      if (state.matchState.phase === 'golden_point') return
      if (state.matchState.result || (state.matchCategoryId && state.match?.id &&
        getMatchResult(state.matchCategoryId, state.match.id))) return
      const nextState = undoLastEvent(state.matchState)
      if (!persistIndividualFlagState(nextState)) return
      state.matchState = nextState
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
      if (state.matchState.phase === 'round' || state.matchState.phase === 'overtime'
        || state.matchState.phase === 'rest') startTicker(io)
      broadcast(io)
    })

    socket.on('match:dq', (raw: unknown) => {
      const data = safeParse(matchDqSchema, raw, 'match:dq')
      if (!data) return
      if (!state.matchState || !state.rules) return
      if (state.matchState.phase === 'golden_point') return
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
      if (state.matchState.phase === 'golden_point') return
      state.matchPaused = true
      broadcast(io)
    })

    socket.on('match:result:get', (raw: unknown, callback?: (response: {
      ok: boolean
      error?: string
      result: StoredMatchResult | null
      redId?: string
      blueId?: string
    }) => void) => {
      const data = safeParse(matchResultQuerySchema, raw, 'match:result:get')
      if (!data) {
        callback?.({ ok: false, error: 'Consulta de resultado inválida', result: null })
        return
      }
      const pair = getFightCompetitorIds(data.categoryId, data.matchId)
      callback?.({ ok: true, result: getMatchResult(data.categoryId, data.matchId),
        ...(pair ? pair : {}) })
    })

    socket.on('match:saveFallo', (raw: unknown, callback?: (response: {
      ok: boolean
      error?: string
      result?: StoredMatchResult
      code?: string
    }) => void) => {
      const data = safeParse(matchResultConfirmationSchema, raw, 'match:saveFallo')
      if (!data) {
        callback?.({ ok: false, error: 'Confirmación de resultado inválida' })
        return
      }
      if (getMatchResultRevision(data.categoryId, data.matchId) !== data.expectedRevision) {
        callback?.({ ok: false, code: 'stale_result_revision', error: 'El resultado cambió; revisá los banderines antes de confirmar.' })
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
        const result = confirmMatchResult(input, data.expectedRevision)
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
      if (state.matchState.phase === 'golden_point') return
      let ms = state.matchState
      if (ms.phase === 'idle' || ms.phase === 'rest') {
        ms = startPhase(ms, state.rules)
      }
      if (ms.phase === 'round') {
        ms = endPhase({ ...ms, timeLeft: 0 }, state.rules)
      }
      if (!persistIndividualFlagState(ms)) return
      state.matchPaused = false
      state.matchState = ms
      stopTicker()
      broadcast(io)
    })

    socket.on('mesa:flagVote', (raw: unknown) => {
      const data = safeParse(mesaFlagVoteSchema, raw, 'mesa:flagVote')
      if (!data) return
      if (state.matchState?.phase === 'golden_point') return
      if (state.match?.matchMode === 'tul') {
        if (!state.matchState || state.tulPhase !== 'voting' || state.resultConfirmed) return
        const nextVotes = new Map(state.judgeVotes)
        nextVotes.set(data.judgeId, data.vote)
        if (!persistIndividualFlagState(state.matchState, state.roundFlags, nextVotes)) return
      }
      if (state.match?.requireIndividualFlags) {
        if (!state.rules || !state.matchState || !state.matchTournamentId || !state.matchCategoryId) return
        if (state.judges.has(socket.id)) return
        if (state.rules.judgingMode !== 'flags'
          || !['round', 'rest'].includes(state.matchState.phase)) return
        const judgeIds = Array.from({ length: state.rules.judgesCount }, (_, i) => `J${i + 1}`)
        if (!judgeIds.includes(data.judgeId)) return
        const nextVotes = new Map(state.judgeVotes)
        nextVotes.set(data.judgeId, data.vote)
        try {
          saveMatchSnapshot(state.match.id, state.matchTournamentId, {
            match: state.match,
            rules: state.rules,
            roundFlags: [...state.roundFlags],
            judgeVotes: Object.fromEntries(nextVotes),
            matchState: state.matchState,
          }, state.matchCategoryId)
        } catch (err) {
          logger.error({ err, matchId: state.match.id }, '[mesa:flagVote] snapshot persist failed')
          return
        }
      }
      state.judgeVotes.set(data.judgeId, data.vote)
      broadcast(io)
    })

    socket.on('mesa:confirmRound', () => {
      if (!state.rules || !state.matchState) return
      // Only allow flag confirmation during rest phase (or pending jury decision in points mode)
      const msPhase = state.matchState.phase
      if (msPhase !== 'rest' && !(msPhase === 'finished' && state.matchState.pendingJuryDecision)) return
      if (state.match?.requireIndividualFlags) {
        if (msPhase !== 'rest' || state.rules.judgingMode !== 'flags') return
        const judgeIds = Array.from({ length: state.rules.judgesCount }, (_, i) => `J${i + 1}`)
        if (!judgeIds.every((id) => {
          const vote = state.judgeVotes.get(id)
          return vote === 'red' || vote === 'blue' || vote === 'draw'
        })) return
      }
      const { red, blue, draw, winner } = tallyFlagWinner(state.judgeVotes, state.rules.judgesCount)
      const votes = Object.fromEntries(state.judgeVotes)
      const nextFlags = [...state.roundFlags, { red, blue, draw, winner, votes }]
      const totalRounds = state.rules.rounds.count
      if (nextFlags.length >= totalRounds) {
        const overall = roundsWinner(nextFlags)
        const nextState: MatchState = {
          ...state.matchState,
          phase: 'finished',
          timeLeft: 0,
          pendingJuryDecision: false,
          result: { winner: overall, reason: 'points' },
        }
        const input = state.matchCategoryId && state.match
          ? buildMatchResultInput(state.matchCategoryId, state.match.id, overall, nextState, nextFlags) : null
        if (!input || !state.match) return
        try {
          savePendingMatchResultWithSnapshot(input, { match: state.match, rules: state.rules,
            roundFlags: nextFlags, judgeVotes: {}, matchState: nextState,
            pendingResult: { winner: overall, reason: 'points' } })
        } catch (err) {
          logger.error({ err, matchId: state.match.id }, '[mesa:confirmRound] pending result persist failed')
          return
        }
        state.matchState = nextState
        state.roundFlags = nextFlags
        state.judgeVotes.clear()
        stopTicker()
        appendPendingFallo(input)
      } else {
        if (!persistIndividualFlagState(state.matchState, nextFlags, new Map<string, string>())) return
        state.roundFlags = nextFlags
        state.judgeVotes.clear()
      }
      broadcast(io)
    })

    socket.on('mesa:undoRound', (raw: unknown, reply?: (response: {
      ok: boolean; code?: string; error?: string; revision?: number; requiresAllVotes?: boolean
    }) => void) => {
      const reject = (code: string, error: string): void => reply?.({ ok: false, code, error })
      const data = safeParse(mesaUndoRoundSchema, raw, 'mesa:undoRound')
      if (!data) return reject('invalid_payload', 'Datos de corrección inválidos.')
      if (data.categoryId !== state.matchCategoryId || data.matchId !== state.match?.id) {
        return reject('stale_match_context', 'La categoría o pelea ya no está activa.')
      }
      if (!state.match || !state.matchState || !state.rules || state.matchTournamentId === null ||
        !state.roundFlags.length || state.match.goldenPoint || state.match.matchMode === 'tul' ||
        state.judges.has(socket.id)) {
        return reject('wrong_phase', 'Este resultado no admite corregir banderines desde la mesa.')
      }
      const lock = getActiveMatchLock()
      const stored = getMatchResult(data.categoryId, data.matchId)
      if (state.resultConfirmed || stored?.status === 'confirmed') {
        return reject('result_confirmed', 'El resultado ya fue confirmado; no se modificó.')
      }
      if (lock?.fightId !== data.matchId || lock.categoryId !== data.categoryId ||
        lock.tournamentId !== state.matchTournamentId) {
        return reject('stale_match_context', 'El tatami conserva otro combate activo.')
      }
      const phase = state.matchState.phase
      if (phase === 'round' || phase === 'overtime' || phase === 'golden_point') {
        return reject('wrong_phase', 'Terminá el round antes de corregir banderines.')
      }
      if (phase !== 'finished') {
        if (state.matchState.result || stored) return reject('wrong_phase', 'Hay un resultado pendiente de revisión.')
        if (!persistIndividualFlagState(state.matchState, state.roundFlags.slice(0, -1), new Map<string, string>())) {
          return reject('persistence_failed', 'No se pudo guardar la corrección; no se modificó el round.')
        }
        state.roundFlags.pop()
        state.judgeVotes.clear()
        reply?.({ ok: true, revision: getMatchResultRevision(data.categoryId, data.matchId) })
        broadcast(io)
        return
      }
      if (state.rules.judgingMode !== 'flags' || state.matchState.result?.reason !== 'points' ||
        !stored || stored.status !== 'pending_confirmation' || stored.reason !== 'points') {
        return reject('wrong_phase', 'Solo se corrige un fallo por banderines todavía sin confirmar.')
      }
      const currentRevision = getMatchResultRevision(data.categoryId, data.matchId)
      if (data.expectedRevision !== currentRevision) {
        return reject('stale_result_revision', 'El resultado cambió; actualizá la pantalla antes de corregir.')
      }
      const lastRound = state.roundFlags.at(-1)!
      const ids = Array.from({ length: state.rules.judgesCount }, (_, i) => `J${i + 1}`)
      // Restore only actual per-judge votes. Historic aggregate counts cannot identify a judge.
      const votes = new Map<string, string>()
      for (const id of ids) {
        const vote = lastRound.votes?.[id]
        if (vote === 'red' || vote === 'blue' || vote === 'draw') votes.set(id, vote)
      }
      const flags = state.roundFlags.slice(0, -1)
      const nextState: MatchState = { ...state.matchState, phase: 'rest', timeLeft: 0,
        pendingJuryDecision: false, result: null }
      let revision: number
      try {
        revision = reopenPendingFlagResult(data.matchId, data.categoryId, state.matchTournamentId,
          currentRevision, { match: state.match, rules: state.rules, roundFlags: flags,
            judgeVotes: Object.fromEntries(votes), matchState: nextState })
      } catch (err) {
        logger.error({ err, matchId: data.matchId }, '[mesa:undoRound] pending correction persist failed')
        return reject('persistence_failed', 'No se pudo guardar la corrección; el resultado original sigue intacto.')
      }
      stopTicker()
      state.matchState = nextState
      state.matchPaused = true
      state.roundFlags = flags
      state.judgeVotes = votes
      state.resultConfirmed = false
      state.fallos = state.fallos.filter((fallo) => fallo.matchId !== data.matchId || fallo.categoryId !== data.categoryId)
      reply?.({ ok: true, revision, requiresAllVotes: votes.size !== ids.length })
      broadcast(io)
    })

    socket.on('disconnect', () => {
      state.judges.delete(socket.id)
      broadcast(io)
    })

    // ── Tul mode ──────────────────────────────────────────────────────────────

    type TulReply = { ok: boolean; code?: string; error?: string; revision?: number }
    socket.on('tul:finish', (raw: unknown, reply?: (response: TulReply) => void) => {
      const reject = (code: string, error: string): void => reply?.({ ok: false, code, error })
      const data = safeParse(tulFinishSchema, raw, 'tul:finish')
      if (!data) return reject('invalid_payload', 'Datos de votación inválidos.')
      if (data.categoryId !== state.matchCategoryId || data.matchId !== state.match?.id)
        return reject('stale_match_context', 'La categoría o pelea ya no está activa.')
      if (!state.matchState || state.match?.matchMode !== 'tul' || !state.rules ||
        state.matchTournamentId === null || state.judges.has(socket.id))
        return reject('wrong_phase', 'No se puede confirmar esta votación.')
      if (state.resultConfirmed || getMatchResult(data.categoryId, data.matchId)?.status === 'confirmed')
        return reject('result_confirmed', 'El resultado ya fue confirmado.')
      const revision = getMatchResultRevision(data.categoryId, data.matchId)
      // Legacy first finishes are revision zero, never authority over reopened votes.
      if ((data.expectedRevision ?? 0) !== revision)
        return reject('stale_result_revision', 'La votación cambió; revisá el resultado.')
      if (state.tulPhase !== 'voting') return reject('wrong_phase', 'La votación no está abierta.')
      const judgesCount = state.rules?.judgesCount ?? 3
      const { winner } = tallyFlagWinner(state.judgeVotes, judgesCount)
      if (winner === 'draw') return reject('draw_not_allowed', 'En formas no se permite empate; corregí los votos.')
      const nextState: MatchState = { ...state.matchState, phase: 'finished',
        result: { winner, reason: 'points' } }
      const input = buildMatchResultInput(data.categoryId, data.matchId, winner, nextState)
      if (!input) return reject('wrong_phase', 'No hay resultado disponible.')
      try {
        savePendingMatchResultWithSnapshot(input, { match: state.match, rules: state.rules,
          roundFlags: [...state.roundFlags], judgeVotes: Object.fromEntries(state.judgeVotes),
          matchState: nextState, tulPhase: 'finished', pendingResult: { winner, reason: 'points' } })
      } catch (err) {
        logger.error({ err, matchId: data.matchId }, '[tul:finish] persistence failed')
        return reject('persistence_failed', 'No se guardó el resultado; la votación sigue abierta.')
      }
      state.matchState = nextState
      state.tulPhase = 'finished'
      stopTicker()
      appendPendingFallo(input)
      reply?.({ ok: true, revision })
      broadcast(io)
    })

    socket.on('tul:retry', () => {
      if (state.match?.matchMode !== 'tul') return
      if (state.tulPhase !== 'voting') return
      if (!state.matchState || !persistIndividualFlagState(state.matchState, state.roundFlags,
        new Map<string, string>())) return
      state.judgeVotes.clear()
      broadcast(io)
    })

    // Deshacer el "Confirmar ganador" en tul — vuelve a fase de votación conservando los votos
    socket.on('tul:undoFinish', (raw: unknown, reply?: (response: TulReply) => void) => {
      const reject = (code: string, error: string): void => reply?.({ ok: false, code, error })
      const data = safeParse(tulUndoFinishSchema, raw, 'tul:undoFinish')
      if (!data) return reject('invalid_payload', 'Datos de corrección inválidos.')
      if (data.categoryId !== state.matchCategoryId || data.matchId !== state.match?.id)
        return reject('stale_match_context', 'La categoría o pelea ya no está activa.')
      if (!state.match || !state.matchState || !state.rules || state.matchTournamentId === null ||
        state.match.matchMode !== 'tul' || state.judges.has(socket.id))
        return reject('wrong_phase', 'Este resultado no admite corregir votos.')
      const stored = getMatchResult(data.categoryId, data.matchId)
      if (state.resultConfirmed || stored?.status === 'confirmed')
        return reject('result_confirmed', 'El resultado ya fue confirmado; no se modificó.')
      if (state.tulPhase !== 'finished' || state.matchState.phase !== 'finished' ||
        state.matchState.result?.reason !== 'points' || stored?.status !== 'pending_confirmation' ||
        stored.reason !== 'points') return reject('wrong_phase', 'No hay votación pendiente para corregir.')
      if (data.expectedRevision !== getMatchResultRevision(data.categoryId, data.matchId))
        return reject('stale_result_revision', 'El resultado cambió; revisá la pantalla.')
      const nextState: MatchState = { ...state.matchState, phase: 'rest', result: null }
      let revision: number
      try {
        revision = reopenPendingFlagResult(data.matchId, data.categoryId, state.matchTournamentId,
          data.expectedRevision, { match: state.match, rules: state.rules, roundFlags: [...state.roundFlags],
            judgeVotes: Object.fromEntries(state.judgeVotes), matchState: nextState, tulPhase: 'voting' })
      } catch (err) {
        logger.error({ err, matchId: data.matchId }, '[tul:undoFinish] persistence failed')
        return reject('persistence_failed', 'No se guardó la corrección; el resultado sigue intacto.')
      }
      state.matchState = nextState
      state.tulPhase = 'voting'
      state.resultConfirmed = false
      state.fallos = state.fallos.filter((fallo) => fallo.matchId !== data.matchId || fallo.categoryId !== data.categoryId)
      reply?.({ ok: true, revision })
      broadcast(io)
    })
  })
}

function buildMatchResultInput(
  categoryId: string,
  matchId: string,
  winnerOverride?: 'red' | 'blue' | 'draw',
  matchState: MatchState | null = state.matchState,
  roundFlags = state.roundFlags,
): MatchResultInput | null {
  const result = matchState?.result
  if (!state.match
    || state.match.id !== matchId
    || state.matchCategoryId !== categoryId
    || state.matchTournamentId === null
    || (!winnerOverride && !result?.winner)) return null

  const winner = winnerOverride ?? result?.winner
  if (!winner) return null
  const { red: flagsRed, blue: flagsBlue } = state.match.goldenPoint
    ? {
        red: Object.values(matchState?.goldenPoint?.votes ?? {}).filter((vote) => vote === 'red').length,
        blue: Object.values(matchState?.goldenPoint?.votes ?? {}).filter((vote) => vote === 'blue').length,
      }
    : state.match.matchMode === "tul"
    ? tallyFlagWinner(state.judgeVotes, state.rules?.judgesCount ?? 3)
    : {
        red: roundFlags.reduce((sum, round) => sum + round.red, 0),
        blue: roundFlags.reduce((sum, round) => sum + round.blue, 0),
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
  appendPendingFallo(input)
}

function appendPendingFallo(input: MatchResultInput): void {
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
          ...(state.matchState ? { matchState: state.matchState } : {}),
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
