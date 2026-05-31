import type { Express } from 'express'
import db from '../db/index.js'
import { state } from '../state.js'

export function registerHistoryRoute(app: Express) {
  app.get('/api/history', (_req, res) => {
    const tournaments = db
      .prepare('SELECT * FROM tournaments ORDER BY id DESC')
      .all() as Array<{ id: number; name: string; category: string; created_at: string }>

    const result = tournaments.map((t) => {
      const competitors = db
        .prepare('SELECT id, name, team FROM competitors WHERE tournament_id = ?')
        .all(t.id) as Array<{ id: string; name: string; team: string | null }>

      const fights = db
        .prepare(`
          SELECT
            f.id, f.completed, f.winner, f.reason,
            f.flags_red, f.flags_blue, f.group_id,
            rc.name AS red_name, rc.team AS red_team,
            bc.name AS blue_name, bc.team AS blue_team
          FROM fights f
          LEFT JOIN competitors rc ON f.red_id = rc.id
          LEFT JOIN competitors bc ON f.blue_id = bc.id
          WHERE f.tournament_id = ?
          ORDER BY f.round_index ASC, f.id ASC
        `)
        .all(t.id) as Array<{
          id: string
          completed: number
          winner: string | null
          reason: string | null
          flags_red: number
          flags_blue: number
          group_id: string | null
          red_name: string
          red_team: string | null
          blue_name: string
          blue_team: string | null
        }>

      return {
        id: t.id,
        name: t.name,
        category: t.category,
        createdAt: t.created_at,
        isActive: t.id === state.activeTournamentId,
        fightsTotal: fights.length,
        fightsCompleted: fights.filter((f) => f.completed === 1).length,
        competitors: competitors.map((c) => ({ id: c.id, name: c.name, team: c.team })),
        fights: fights.map((f) => ({
          id: f.id,
          completed: f.completed === 1,
          winner: f.winner as 'red' | 'blue' | 'draw' | null,
          flagsRed: f.flags_red,
          flagsBlue: f.flags_blue,
          groupId: f.group_id,
          redName: f.red_name ?? '?',
          redTeam: f.red_team,
          blueName: f.blue_name ?? '?',
          blueTeam: f.blue_team,
        })),
      }
    })

    res.json(result)
  })

  app.get('/api/stats', (_req, res) => {
    const overview = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM tournaments) as totalTournaments,
        (SELECT COUNT(*) FROM competitors) as totalCompetitors,
        (SELECT COUNT(*) FROM fights) as totalFights,
        (SELECT COUNT(*) FROM fights WHERE completed = 1) as completedFights,
        (SELECT COUNT(*) FROM fights WHERE completed = 1 AND winner = 'red') as redWins,
        (SELECT COUNT(*) FROM fights WHERE completed = 1 AND winner = 'blue') as blueWins,
        (SELECT COUNT(*) FROM fights WHERE completed = 1 AND (winner = 'draw' OR winner IS NULL)) as draws
    `).get() as {
      totalTournaments: number
      totalCompetitors: number
      totalFights: number
      completedFights: number
      redWins: number
      blueWins: number
      draws: number
    }

    const fights = db.prepare(`
      SELECT
        f.winner, f.flags_red, f.flags_blue,
        rc.name as red_name, rc.team as red_team,
        bc.name as blue_name, bc.team as blue_team
      FROM fights f
      LEFT JOIN competitors rc ON f.red_id = rc.id
      LEFT JOIN competitors bc ON f.blue_id = bc.id
      WHERE f.completed = 1
    `).all() as Array<{
      winner: string | null
      flags_red: number
      flags_blue: number
      red_name: string | null
      red_team: string | null
      blue_name: string | null
      blue_team: string | null
    }>

    const map = new Map<string, {
      name: string; team: string | null
      played: number; wins: number; draws: number; losses: number
      points: number; flagsFor: number; flagsAgainst: number
    }>()
    const get = (name: string, team: string | null) => {
      if (!map.has(name)) map.set(name, { name, team, played: 0, wins: 0, draws: 0, losses: 0, points: 0, flagsFor: 0, flagsAgainst: 0 })
      return map.get(name)!
    }
    for (const f of fights) {
      const red = get(f.red_name ?? '?', f.red_team)
      const blue = get(f.blue_name ?? '?', f.blue_team)
      red.played++; blue.played++
      red.flagsFor += f.flags_red; red.flagsAgainst += f.flags_blue
      blue.flagsFor += f.flags_blue; blue.flagsAgainst += f.flags_red
      if (f.winner === 'red') { red.wins++; red.points += 3; blue.losses++ }
      else if (f.winner === 'blue') { blue.wins++; blue.points += 3; red.losses++ }
      else { red.draws++; red.points += 1; blue.draws++; blue.points += 1 }
    }

    const topCompetitors = [...map.values()]
      .sort((a, b) => b.points - a.points || b.wins - a.wins || a.losses - b.losses)

    res.json({ overview, topCompetitors })
  })

  // Eliminar una categoría/torneo del historial (cascade borra competidores y combates)
  app.delete('/api/history/:id', (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' })
    }
    const exists = db.prepare('SELECT id FROM tournaments WHERE id = ?').get(id)
    if (!exists) return res.status(404).json({ error: 'no encontrado' })
    if (id === state.activeTournamentId) {
      return res.status(409).json({ error: 'No se puede borrar la categoría activa. Empezá una nueva primero.' })
    }
    db.prepare('DELETE FROM tournaments WHERE id = ?').run(id)
    res.json({ ok: true, deletedId: id })
  })

  // Borrar TODO el historial salvo la categoría activa (botón "limpiar pruebas")
  app.delete('/api/history', (_req, res) => {
    const result = db
      .prepare('DELETE FROM tournaments WHERE id != ?')
      .run(state.activeTournamentId)
    res.json({ ok: true, deleted: result.changes })
  })
}
