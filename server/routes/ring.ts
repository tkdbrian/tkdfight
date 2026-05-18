import type { Express } from 'express'
import type { Server } from 'socket.io'
import { getRingConfig, setRingConfig } from '../ring-config.js'
import { getLocalIp } from '../helpers.js'
import { state } from '../state.js'
import { getFights, getCompetitors, upsertCompetitor, upsertFight, deletePendingFights, insertFightIfNew, getSourceRing } from '../db/index.js'
import db from '../db/index.js'

const PORT = Number.parseInt(process.env.PORT ?? '3001', 10)

export function registerRingRoute(app: Express, io: Server) {
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
      queuedFights: queued,
      completedFights: completed,
      judges: Array.from(judges.values()),
      online: true,
    })
  })

  // ── GET /api/ring/queue ──────────────────────────────────────────────────
  app.get('/api/ring/queue', (_req, res) => {
    const fights = getFights(state.activeTournamentId) as Array<{
      id: string; red_id: string; blue_id: string; completed: number; source_ring: string | null
    }>
    const competitors = getCompetitors(state.activeTournamentId)
    const competitorMap = new Map(competitors.map((c) => [c.id, c]))

    const pending = fights.filter((f) => f.completed === 0)
    const activeId = state.match?.id

    const queue = pending.slice(0, 10).map((f, i) => ({
      position: i + 1,
      fight: {
        id: f.id,
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
    const { fights, competitors, categoryName, newCategory, sourceRingLabel, sourceRingAddress } = req.body ?? {}

    if (!Array.isArray(fights) || !Array.isArray(competitors)) {
      res.status(400).json({ error: 'fights and competitors arrays are required' })
      return
    }

    // Nueva categoría: limpiar peleas pendientes del torneo actual y resetear estado
    if (newCategory) {
      deletePendingFights(state.activeTournamentId)
      state.fallos = []
      state.match = null
      state.matchState = null
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
      })
      imported++
    }

    res.json({ ok: true, imported })

    // Notify FightPage clients so they can add the new fights to their Zustand store
    // without requiring a full page reload.
    const importedFights = typedFights.map((f) => ({
      id: f.id,
      red: competitorMap.get(f.red_id) ?? { id: f.red_id, name: f.red_id },
      blue: competitorMap.get(f.blue_id) ?? { id: f.blue_id, name: f.blue_id },
      completed: false,
      groupId: f.group_id ?? categoryName ?? undefined,
    }))
    io.emit('fights:imported', { fights: importedFights, sourceRingLabel: sourceRingLabel ?? null })
  })

  // ── POST /api/ring/sync-fights ────────────────────────────────────────────
  // Sincroniza peleas al servidor sin resetear estado ni verificar double-start.
  // Usa INSERT OR IGNORE, por lo que es seguro llamarlo múltiples veces.
  // Usado por FightPage al montar para garantizar que el servidor tiene todas las peleas.
  app.post('/api/ring/sync-fights', (req, res) => {
    const { competitors, fights } = req.body ?? {}
    if (!Array.isArray(fights) || !Array.isArray(competitors)) {
      res.status(400).json({ error: 'fights and competitors arrays are required' })
      return
    }
    const tournamentId = state.activeTournamentId
    for (const c of competitors as Array<{ id: string; name: string; team?: string; weight?: number; belt?: string }>) {
      upsertCompetitor({ ...c, tournament_id: tournamentId })
    }
    let synced = 0
    for (const f of fights as Array<{ id: string; red_id: string; blue_id: string }>) {
      insertFightIfNew({ id: f.id, tournament_id: tournamentId, red_id: f.red_id, blue_id: f.blue_id })
      synced++
    }
    res.json({ ok: true, synced })
  })

  // ── POST /api/ring/remove-fights ─────────────────────────────────────────
  // Elimina peleas NO completadas por sus IDs. La pelea activa está protegida.
  app.post('/api/ring/remove-fights', (req, res) => {
    const { ids } = req.body ?? {}

    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids array is required' })
      return
    }

    const activeId = state.match?.id
    const toRemove = (ids as string[]).filter((id) => id !== activeId)
    const skipped = ids.length - toRemove.length

    if (toRemove.length === 0) {
      res.status(409).json({ error: 'active_fight', message: 'La pelea activa no puede removerse' })
      return
    }

    // Solo eliminar peleas pendientes (no completadas)
    const placeholders = toRemove.map(() => '?').join(',')
    db.prepare(
      `DELETE FROM fights WHERE id IN (${placeholders}) AND completed = 0`
    ).run(...toRemove)

    res.json({ ok: true, removed: toRemove.length, skipped })
  })

  // ── POST /api/ring/remote-result ─────────────────────────────────────────
  // Recibe el resultado de una pelea que se jugó en otro tatami.
  // Emite socket 'fight:remote-completed' para que FightPage/SetupPage del
  // tatami origen actualicen su Zustand automáticamente.
  app.post('/api/ring/remote-result', (req, res) => {
    const { fightId, winner, flagsRed, flagsBlue, completedIn } = req.body ?? {}
    if (typeof fightId !== 'string' || typeof winner !== 'string') {
      res.status(400).json({ error: 'fightId and winner are required' })
      return
    }
    res.json({ ok: true })
    io.emit('fight:remote-completed', {
      fightId,
      winner,
      flagsRed: flagsRed ?? 0,
      flagsBlue: flagsBlue ?? 0,
      completedIn: completedIn ?? 'otro tatami',
    })
  })
}
