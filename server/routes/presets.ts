import type { Express } from 'express'
import { getPresets, upsertPreset, deletePreset } from '../db/index.js'

export function registerPresetsRoute(app: Express) {
  // ── GET /api/presets ────────────────────────────────────────────────────────
  app.get('/api/presets', (_req, res) => {
    try {
      res.json(getPresets())
    } catch (err) {
      res.status(500).json({ error: 'Error al leer presets' })
    }
  })

  // ── POST /api/presets ───────────────────────────────────────────────────────
  app.post('/api/presets', (req, res) => {
    const { name, round_count, duration_seconds, final_rounds, final_seconds, tiebreaker_seconds, max_tiebreakers } = req.body ?? {}
    if (!name || typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'El campo "name" es requerido' })
      return
    }
    try {
      const preset = upsertPreset({
        name: name.trim(),
        round_count: Number(round_count ?? 1),
        duration_seconds: Number(duration_seconds ?? 60),
        final_rounds: final_rounds != null ? Number(final_rounds) : null,
        final_seconds: final_seconds != null ? Number(final_seconds) : null,
        tiebreaker_seconds: tiebreaker_seconds != null ? Number(tiebreaker_seconds) : null,
        max_tiebreakers: max_tiebreakers != null ? Number(max_tiebreakers) : null,
      })
      res.status(201).json(preset)
    } catch (err) {
      res.status(500).json({ error: 'Error al guardar preset' })
    }
  })

  // ── DELETE /api/presets/:id ─────────────────────────────────────────────────
  app.delete('/api/presets/:id', (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'ID inválido' })
      return
    }
    try {
      deletePreset(id)
      res.status(204).end()
    } catch (err) {
      res.status(500).json({ error: 'Error al eliminar preset' })
    }
  })
}
