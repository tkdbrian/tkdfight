import type { Express } from 'express'
import type { Server } from 'socket.io'
import { getRingConfig, setRingConfig } from '../ring-config.js'
import { getLocalIp } from '../helpers.js'
import { state } from '../state.js'
import { broadcast } from '../broadcast.js'
import { getFights, getCompetitors, upsertCompetitor, upsertFight, deletePendingFights, clearTournamentData, insertFightIfNew, isFightPending, createTournament, renameTournament, getCompetitorCount, getActiveMatchLock, getCategoryTournamentId, getSourceCategoryId, getTournamentCategoryId, resolveCategoryTournament, setSelectedTournamentId } from '../db/index.js'
import db from '../db/index.js'
import { eliminationContinuationSchema } from '../../src/lib/elimination-continuation-contract.js'
import { ensureEliminationContinuation, getEliminationContinuation, ContinuationConflict } from '../db/elimination-continuations.js'
import { registerCategoryRestartRoutes, sendCategoryExecutionError } from './category-restart.js'
import { registerCategoryDeletionRoutes } from './category-deletion.js'
import { registerCategoryRestartModesRoutes } from './category-restart-modes.js'
import {
  assertCategoryWritable, assertTournamentWritable, assertFightWritable, assertCompetitorWritable,
} from '../db/index.js'

const PORT = Number.parseInt(process.env.PORT ?? '3001', 10)

export function registerRingRoute(app: Express, io: Server) {
  registerCategoryRestartRoutes(app, io)
  registerCategoryDeletionRoutes(app, io)
  registerCategoryRestartModesRoutes(app, io)
  // Guard explicit identities AND existing owners before handlers can select, replace or broadcast.
  const executionWrites = new Set(['/import-fights', '/full-reset', '/activate-category',
    '/sync-fights', '/remove-fights', '/remote-result'])
  app.use('/api/ring', (req, res, next) => {
    if (req.method !== 'POST' || !executionWrites.has(req.path)) return next()
    const body: unknown = req.body
    const input = body !== null && typeof body === 'object'
      ? body as Record<string, unknown> : {}
    try {
      if (typeof input.categoryId === 'string') assertCategoryWritable(input.categoryId)
      if (typeof input.sourceCategoryId === 'string') assertCategoryWritable(input.sourceCategoryId)
      if (req.path === '/full-reset'
        || (req.path === '/import-fights' && !input.newCategory)
        || (req.path === '/remove-fights' && typeof input.categoryId !== 'string')) {
        assertTournamentWritable(state.activeTournamentId)
      }
      if (typeof input.fightId === 'string') assertFightWritable(input.fightId)
      if (Array.isArray(input.ids)) {
        for (const id of input.ids) if (typeof id === 'string') assertFightWritable(id)
      }
      if (Array.isArray(input.fights)) {
        for (const value of input.fights) {
          if (value === null || typeof value !== 'object') continue
          const fight = value as Record<string, unknown>
          if (typeof fight.id === 'string') assertFightWritable(fight.id)
          for (const id of [fight.red_id, fight.blue_id]) {
            if (typeof id === 'string') assertCompetitorWritable(id)
          }
        }
      }
      if (Array.isArray(input.competitors)) {
        for (const value of input.competitors) {
          if (value !== null && typeof value === 'object' && 'id' in value
            && typeof value.id === 'string') assertCompetitorWritable(value.id)
        }
      }
      next()
    } catch (error) {
      if (!sendCategoryExecutionError(error, res)) next(error)
    }
  })
  // ── GET /api/ring/status ─────────────────────────────────────────────────
  app.get('/api/ring/status', (_req, res) => {
    const config = getRingConfig()
    const ip = getLocalIp()
    const { match, matchState, judges } = state

    const allFights = getFights(state.activeTournamentId) as Array<{ completed: number }>
    const completed = allFights.filter((f) => f.completed === 1).length
    const queued = allFights.filter((f) => f.completed === 0).length

    res.json({
      alias: config.alias,
      name: config.name,
      ip,
      port: PORT,
      currentMatch: match
        ? {
            id: match.id,
            red: match.red,
            blue: match.blue,
            phase: matchState?.phase ?? 'idle',
            timeLeft: matchState?.timeLeft ?? 0,
            currentRound: matchState?.currentRound ?? 0,
          }
        : null,
      activeMatchLock: getActiveMatchLock() ?? (match && !state.resultConfirmed
        ? { fightId: match.id, categoryId: state.matchCategoryId }
        : null),
      queuedFights: queued,
      completedFights: completed,
      judges: Array.from(judges.values()),
      online: true,
    })
  })

  // ── GET /api/ring/queue ──────────────────────────────────────────────────
  app.get('/api/ring/queue', (req, res) => {
    const requestedCategoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : null
    const requestedTournamentId = requestedCategoryId ? getCategoryTournamentId(requestedCategoryId) : null
    if (requestedCategoryId && requestedTournamentId === null) {
      res.status(404).json({ error: 'category_not_found' })
      return
    }
    const tournamentId = requestedTournamentId ?? state.activeTournamentId
    const categoryId = requestedCategoryId
      ?? (state.matchTournamentId === tournamentId ? state.matchCategoryId : null)
      ?? getTournamentCategoryId(tournamentId)
    const fights = getFights(tournamentId) as Array<{
      id: string; red_id: string; blue_id: string; completed: number; source_ring: string | null
    }>
    const competitors = getCompetitors(tournamentId)
    const competitorMap = new Map(competitors.map((c) => [c.id, c]))

    const pending = fights.filter((f) => f.completed === 0)
    const activeId = state.match?.id ?? getActiveMatchLock()?.fightId

    const queue = pending.slice(0, 10).map((f, i) => ({
      position: i + 1,
      fight: {
        id: f.id,
        categoryId,
        red: competitorMap.get(f.red_id) ?? { id: f.red_id, name: f.red_id },
        blue: competitorMap.get(f.blue_id) ?? { id: f.blue_id, name: f.blue_id },
        sourceRing: f.source_ring ?? null,
      },
      status: f.id === activeId ? 'active' : i === 0 ? 'next' : 'queued',
    }))

    res.json(queue)
  })

  // ── GET /api/ring/results ────────────────────────────────────────────────
  app.get('/api/ring/results', (_req, res) => {
    res.json({
      alias: getRingConfig().alias,
      fallos: [...state.fallos],
    })
  })

  // ── PUT /api/ring/config ─────────────────────────────────────────────────
  app.put('/api/ring/config', (req, res) => {
    const { alias, name } = req.body ?? {}
    if (typeof alias !== 'string' || typeof name !== 'string') {
      res.status(400).json({ error: 'alias and name are required strings' })
      return
    }
    const config = setRingConfig(alias, name)
    res.json(config)
    io.emit('ring:config-updated', { alias: config.alias, name: config.name })
  })

  // ── POST /api/ring/import-fights ─────────────────────────────────────────
  // Recibe peleas + competidores de otro tatami y los inserta en la DB local.
  // Rechaza si algún competidor ya está en la pelea activa (Double Start Check).
  app.post('/api/ring/import-fights', (req, res) => {
    const { fights, competitors, categoryId, tournamentName, categoryName, newCategory, sourceRingLabel, sourceRingAddress, sourceCategoryId } = req.body ?? {}

    if (!Array.isArray(fights) || !Array.isArray(competitors)) {
      res.status(400).json({ error: 'fights and competitors arrays are required' })
      return
    }

    const activeLock = getActiveMatchLock()
    if (activeLock) {
      res.status(409).json({
        error: 'active_match',
        message: `El combate ${activeLock.fightId} sigue bloqueado; no se pueden importar ni reasignar peleas.`,
      })
      return
    }

    let legacyHistoryWarning: string | undefined
    // Nueva categoría: asignar o crear un torneo con ese nombre, luego limpiar pendientes
    if (newCategory) {
      const catName = typeof categoryName === 'string' && categoryName.trim()
        ? categoryName.trim()
        : 'Categoría'
      if (typeof categoryId === 'string' && categoryId.trim()) {
        const legacyFights = (fights as Array<{ id: string; red_id: string; blue_id: string }>).filter(
          (fight) => typeof fight.id === 'string' && typeof fight.red_id === 'string' && typeof fight.blue_id === 'string',
        )
        const legacyCompetitorIds = (competitors as Array<{ id: string }>).map((competitor) => competitor.id)
        const hasCompleteFingerprint = legacyFights.length === fights.length
          && legacyCompetitorIds.every((id) => typeof id === 'string')
        const association = resolveCategoryTournament({
          categoryId,
          tournamentName: typeof tournamentName === 'string' ? tournamentName : catName,
          categoryName: catName,
          preferredTournamentId: state.activeTournamentId,
          legacyFights: hasCompleteFingerprint ? legacyFights : [],
          legacyCompetitorIds: hasCompleteFingerprint ? legacyCompetitorIds : [],
        })
        state.activeTournamentId = association.tournamentId
        legacyHistoryWarning = association.legacyHistoryUnassigned
          ? 'El historial anterior no tenía identidad de categoría fiable; se conservó sin reasignar.'
          : undefined
      } else {
        const existingCount = getCompetitorCount(state.activeTournamentId)
        if (existingCount === 0) {
          // Torneo actual vacío → renombrarlo en lugar de crear uno nuevo
          renameTournament(state.activeTournamentId, catName, catName)
        } else {
          // Compatibilidad con clientes anteriores sin identidad de categoría
          state.activeTournamentId = createTournament(catName, catName)
        }
      }
      deletePendingFights(state.activeTournamentId)
      state.fallos = typeof categoryId === 'string'
        ? state.fallos.filter((fallo) => fallo.categoryId !== categoryId)
        : []
      state.match = null
      state.matchState = null
      state.matchCategoryId = null
      state.matchTournamentId = null
      state.resultConfirmed = false
      state.legacyMatchAssociationWarning = null
    }

    // Double Start Check: solo aplica cuando se importan peleas a un tatami ya activo (no newCategory)
    if (!newCategory && state.match) {
      const activeIds = new Set([state.match.red.id, state.match.blue.id])
      const conflicting = (competitors as Array<{ id: string; name: string }>)
        .filter((c) => activeIds.has(c.id))
        .map((c) => c.name)
      if (conflicting.length > 0) {
        res.status(409).json({
          error: 'double_start',
          message: `Conflicto: ${conflicting.join(', ')} está en combate activo`,
          conflicting,
        })
        return
      }
    }

    const tournamentId = state.activeTournamentId
    const typedCompetitors = competitors as Array<{ id: string; name: string; team?: string; weight?: number; belt?: string }>
    const typedFights = fights as Array<{ id: string; red_id: string; blue_id: string; round_index?: number; group_id?: string }>

    // Upsert competidores
    const competitorMap = new Map(typedCompetitors.map((c) => [c.id, c]))
    for (const c of typedCompetitors) {
      upsertCompetitor({ ...c, tournament_id: tournamentId })
    }

    // Upsert peleas (solo pendientes)
    let imported = 0
    for (const f of typedFights) {
      upsertFight({
        id: f.id,
        tournament_id: tournamentId,
        red_id: f.red_id,
        blue_id: f.blue_id,
        completed: false,
        round_index: f.round_index,
        group_id: f.group_id ?? categoryName ?? undefined,
        source_ring: typeof sourceRingAddress === 'string' ? sourceRingAddress : undefined,
        source_category_id: typeof sourceCategoryId === 'string' ? sourceCategoryId : undefined,
      })
      imported++
    }

    if (newCategory) setSelectedTournamentId(state.activeTournamentId)

    res.json({ ok: true, imported, warning: legacyHistoryWarning })

    // Notify FightPage clients so they can add the new fights to their Zustand store
    // without requiring a full page reload.
    // IMPORTANT: when newCategory=true the ring is setting up its own tournament and
    // already has the fights locally via setFights(). Broadcasting to all rings would
    // cause other rings to receive and append foreign fights, mixing competitors from
    // different tournaments in the same group. Only broadcast when reassigning fights
    // from Mesa Central (newCategory=false).
    if (!newCategory) {
      const importedFights = typedFights.map((f) => ({
        id: f.id,
        red: competitorMap.get(f.red_id) ?? { id: f.red_id, name: f.red_id },
        blue: competitorMap.get(f.blue_id) ?? { id: f.blue_id, name: f.blue_id },
        completed: false,
        groupId: f.group_id ?? categoryName ?? undefined,
      }))
      io.emit('fights:imported', {
        fights: importedFights,
        categoryId: getTournamentCategoryId(state.activeTournamentId),
        sourceRingLabel: sourceRingLabel ?? null,
      })
    }
  })

  // ── POST /api/ring/full-reset ─────────────────────────────────────────────
  // Limpia todos los combates y competidores de la DB y resetea el estado en
  // memoria del servidor. Emite 'ring:full-reset' para que todos los clientes
  // (tabs abiertas) limpien su Zustand store.
  app.post('/api/ring/full-reset', (_req, res) => {
    const activeLock = getActiveMatchLock()
    if (activeLock) {
      res.status(409).json({
        error: 'active_match',
        message: `El combate ${activeLock.fightId} no puede borrarse mientras esté pendiente de resolución.`,
      })
      return
    }
    clearTournamentData(state.activeTournamentId)
    state.fallos = []
    state.match = null
    state.matchState = null
    state.matchCategoryId = null
    state.matchTournamentId = null
    state.resultConfirmed = false
    state.legacyMatchAssociationWarning = null
    res.json({ ok: true })
    io.emit('ring:full-reset')
  })

  // ── POST /api/ring/sync-fights ────────────────────────────────────────────
  // Sincroniza peleas al servidor sin resetear estado ni verificar double-start.
  // Usa INSERT OR IGNORE, por lo que es seguro llamarlo múltiples veces.
  // Usado por FightPage al montar para garantizar que el servidor tiene todas las peleas.
  app.post('/api/ring/activate-category', (req, res) => {
    const { categoryId, categoryName, tournamentName } = req.body ?? {}
    if (typeof categoryId !== 'string' || !categoryId.trim()
      || typeof categoryName !== 'string' || typeof tournamentName !== 'string') {
      res.status(400).json({ error: 'category identity is required' })
      return
    }
    const activeLock = getActiveMatchLock()
    if (activeLock || (state.match && !state.resultConfirmed)) {
      const fightId = activeLock?.fightId ?? state.match?.id
      res.status(409).json({
        error: 'active_match',
        message: `El combate ${fightId ?? ''} sigue pendiente de confirmación o recuperación.`,
      })
      return
    }
    try {
      const association = resolveCategoryTournament({
        categoryId,
        categoryName,
        tournamentName,
        preferredTournamentId: state.activeTournamentId,
      })
      const categoryChanged = association.tournamentId !== state.activeTournamentId
        || state.matchCategoryId !== categoryId
      setSelectedTournamentId(association.tournamentId)
      state.activeTournamentId = association.tournamentId
      if (categoryChanged) {
        if (state.tickInterval) clearInterval(state.tickInterval)
        state.tickInterval = null
        state.rules = null
        state.match = null
        state.matchState = null
        state.matchPaused = false
        state.judges.clear()
        state.judgeVotes.clear()
        state.nextJudgeNum = 1
        state.fallos = []
        state.falloSeq = 1
        state.roundFlags = []
        state.matchTournamentId = null
        state.matchCategoryId = null
        state.resultConfirmed = false
        state.legacyMatchAssociationWarning = null
        state.tulPhase = 'idle'
      }
      broadcast(io)
      res.json({
        ok: true,
        tournamentId: association.tournamentId,
        warning: association.legacyHistoryUnassigned
          ? 'El historial anterior no tenía identidad de categoría fiable; se conservó sin reasignar.'
          : undefined,
      })
    } catch (err) {
      if (sendCategoryExecutionError(err, res)) return
      res.status(409).json({
        error: err instanceof Error ? err.message : 'No se pudo activar la categoría.',
      })
    }
  })

  app.get('/api/ring/categories/:categoryId/fights/:parentFightId/continuation', (req, res) => {
    const { categoryId, parentFightId } = req.params
    if (!categoryId || !parentFightId) {
      res.status(400).json({ error: 'invalid_continuation_identity' })
      return
    }
    const canonicalFight = getEliminationContinuation(categoryId, parentFightId)
    if (!canonicalFight) {
      res.status(404).json({ error: 'continuation_not_found' })
      return
    }
    res.json({ canonicalFight })
  })

  app.post('/api/ring/sync-fights', (req, res) => {
    const { categoryId, categoryName, tournamentName, competitors, fights,
      requiredConfirmedFightIds, eliminationContinuation } = req.body ?? {}
    if (typeof categoryId !== 'string' || !categoryId.trim()
      || typeof categoryName !== 'string' || typeof tournamentName !== 'string'
      || !Array.isArray(fights) || !Array.isArray(competitors)) {
      res.status(400).json({ error: 'category identity, fights and competitors are required' })
      return
    }
    if (requiredConfirmedFightIds !== undefined && (
      !Array.isArray(requiredConfirmedFightIds)
      || requiredConfirmedFightIds.length > 500
      || requiredConfirmedFightIds.some((id: unknown) =>
        typeof id !== 'string' || id.length === 0 || id.length > 128)
    )) {
      res.status(400).json({ error: 'requiredConfirmedFightIds must contain valid fight IDs' })
      return
    }
    const parsedContinuation = eliminationContinuation === undefined
      ? null : eliminationContinuationSchema.safeParse(eliminationContinuation)
    if (parsedContinuation?.success === false) {
      res.status(400).json({ error: 'invalid_elimination_continuation',
        message: 'La propuesta de continuación no tiene una identidad válida.' })
      return
    }
    const activeLock = getActiveMatchLock()
    const activeCategoryId = activeLock
      ? activeLock.categoryId
      : state.match && !state.resultConfirmed ? state.matchCategoryId : null
    if ((activeLock || (state.match && !state.resultConfirmed)) && activeCategoryId !== categoryId) {
      res.status(409).json({ error: 'active_match', message: 'Otra categoría tiene un combate activo en este tatami.' })
      return
    }
    const typedFights = fights as Array<{
      id: string; red_id: string; blue_id: string; completed?: boolean;
      continuationParentFightId?: string; continuationStage?: string;
    }>
    const typedCompetitors = competitors as Array<{ id: string; name: string; team?: string; weight?: number; belt?: string }>
    const fingerprintCompetitorIds = Array.from(new Set(typedFights.flatMap((fight) => [fight.red_id, fight.blue_id])))
    const pendingFights = typedFights.filter((fight) => !fight.completed)
    const continuationRequest = parsedContinuation?.success ? parsedContinuation.data : null
    if (continuationRequest && pendingFights.filter((fight) =>
      fight.id === continuationRequest.proposedFight.id
      && fight.red_id === continuationRequest.proposedFight.red_id
      && fight.blue_id === continuationRequest.proposedFight.blue_id).length !== 1) {
      res.status(400).json({ error: 'continuation_fight_missing',
        message: 'La pelea propuesta debe aparecer una vez en las peleas pendientes.' })
      return
    }
    const pendingCompetitorIds = new Set(pendingFights.flatMap((fight) => [fight.red_id, fight.blue_id]))
    try {
      const { association, synced, canonicalFight } = db.transaction(() => {
        const association = resolveCategoryTournament({
          categoryId,
          categoryName,
          tournamentName,
          preferredTournamentId: state.activeTournamentId,
          legacyFights: typedFights.map(({ id, red_id, blue_id }) => ({ id, red_id, blue_id })),
          legacyCompetitorIds: fingerprintCompetitorIds,
        })
        const tournamentId = association.tournamentId
        if (requiredConfirmedFightIds !== undefined) {
          const confirmedFight = db.prepare(`
            SELECT 1 AS ok FROM fights f
            JOIN match_results r ON r.fight_id = f.id
            WHERE f.id = ? AND f.tournament_id = ?
              AND r.category_id = ? AND r.tournament_id = ? AND r.status = 'confirmed'
          `)
          for (const fightId of new Set(requiredConfirmedFightIds as string[])) {
            if (!confirmedFight.get(fightId, tournamentId, categoryId, tournamentId)) {
              throw new Error(`El combate ${fightId} no tiene un resultado confirmado de esta categoría.`)
            }
          }
        }
        for (const competitor of typedCompetitors) {
          if (pendingCompetitorIds.has(competitor.id)) upsertCompetitor({ ...competitor, tournament_id: tournamentId })
        }
        const priorContinuation = continuationRequest
          ? getEliminationContinuation(categoryId, continuationRequest.parentFightId) : null
        const canonicalFight = continuationRequest
          ? ensureEliminationContinuation(categoryId, tournamentId, continuationRequest) : null
        let synced = canonicalFight && !priorContinuation ? 1 : 0
        for (const fight of pendingFights) {
          if (continuationRequest && fight.id === continuationRequest.proposedFight.id) continue
          if (fight.continuationParentFightId !== undefined
            || fight.continuationStage !== undefined) {
            const proof = typeof fight.continuationParentFightId === 'string'
              ? getEliminationContinuation(categoryId, fight.continuationParentFightId) : null
            if (!proof || proof.id !== fight.id || proof.stage !== fight.continuationStage
              || proof.red_id !== fight.red_id || proof.blue_id !== fight.blue_id) {
              throw new ContinuationConflict('La pelea de continuación no tiene prueba canónica.')
            }
          }
          const inserted = insertFightIfNew({
            id: fight.id, tournament_id: tournamentId, red_id: fight.red_id, blue_id: fight.blue_id,
          })
          if (inserted) synced++
          else if (!isFightPending(fight.id, tournamentId)) {
            throw new Error(`fight ${fight.id} already has a confirmed result`)
          }
        }
        return { association, synced, canonicalFight }
      })()
      res.json({
        ok: true,
        synced,
        tournamentId: association.tournamentId,
        ...(canonicalFight ? { canonicalFight } : {}),
        warning: association.legacyHistoryUnassigned
          ? 'El historial anterior no tenía identidad de categoría fiable; se conservó sin reasignar.'
          : undefined,
      })
    } catch (err) {
      if (sendCategoryExecutionError(err, res)) return
      res.status(409).json({
        error: err instanceof ContinuationConflict ? 'continuation_conflict' : 'sync_failed',
        message: err instanceof Error ? err.message : 'No se pudo sincronizar la categoría.',
      })
    }
  })

  // ── POST /api/ring/remove-fights ─────────────────────────────────────────
  // Elimina peleas NO completadas por sus IDs. La pelea activa está protegida.
  app.post('/api/ring/remove-fights', (req, res) => {
    const { ids, categoryId } = req.body ?? {}

    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids array is required' })
      return
    }

    const tournamentId = typeof categoryId === 'string' ? getCategoryTournamentId(categoryId) : state.activeTournamentId
    if (tournamentId === null) {
      res.status(404).json({ error: 'category_not_found' })
      return
    }
    const activeLock = getActiveMatchLock()
    const activeId = activeLock?.tournamentId === tournamentId
      ? activeLock.fightId
      : state.matchTournamentId === tournamentId ? state.match?.id : undefined
    const toRemove = (ids as string[]).filter((id) => id !== activeId)
    const skipped = ids.length - toRemove.length

    if (toRemove.length === 0) {
      res.status(409).json({ error: 'active_fight', message: 'La pelea activa no puede removerse' })
      return
    }

    // Solo eliminar peleas pendientes (no completadas)
    const placeholders = toRemove.map(() => '?').join(',')
    const result = db.prepare(
      `DELETE FROM fights WHERE id IN (${placeholders}) AND tournament_id = ? AND completed = 0`
    ).run(...toRemove, tournamentId)

    res.json({ ok: true, removed: result.changes, skipped: ids.length - result.changes })
  })

  // ── POST /api/ring/remote-result ─────────────────────────────────────────
  // Recibe el resultado de una pelea que se jugó en otro tatami.
  // Emite socket 'fight:remote-completed' para que FightPage/SetupPage del
  // tatami origen actualicen su Zustand automáticamente.
  app.post('/api/ring/remote-result', (req, res) => {
    const { fightId, categoryId, winner, flagsRed, flagsBlue, completedIn } = req.body ?? {}
    if (typeof fightId !== 'string' || typeof winner !== 'string') {
      res.status(400).json({ error: 'fightId and winner are required' })
      return
    }
    res.json({ ok: true })
    io.emit('fight:remote-completed', {
      fightId,
      categoryId: typeof categoryId === 'string' ? categoryId : getSourceCategoryId(fightId) ?? undefined,
      winner,
      flagsRed: flagsRed ?? 0,
      flagsBlue: flagsBlue ?? 0,
      completedIn: completedIn ?? 'otro tatami',
    })
  })
}
