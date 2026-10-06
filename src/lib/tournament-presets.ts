// ── Tipo compartido ───────────────────────────────────────────────────────────

export interface TimePreset {
  id?: number          // undefined = preset hardcodeado (no viene del servidor)
  name: string
  ageFrom?: number
  ageTo?: number
  roundCount: number
  durationSeconds: number
  finalRounds?: number
  finalSeconds?: number
  tiebreakerSeconds?: number
  maxTiebreakers?: number
}

// ── Presets fijos: Copa Danes 26 ─────────────────────────────────────────────
// Basado en el reglamento del torneo:
//   Round Robin / todos los combates: 1 round × 1 min
//   Finales Infantiles A y B:         1 round × 1 min
//   Finales Pre-Junior → Veteranos:   1 round × 2 min
//   Desempate (todas las categorías): 1 round × 1 min → Punto de Oro

export const COPA_DANES_26: TimePreset[] = [
  {
    name: 'Kids (4-5)',
    ageFrom: 4,
    ageTo: 5,
    roundCount: 1,
    durationSeconds: 60,
    finalRounds: 1,
    finalSeconds: undefined,
    tiebreakerSeconds: 60,
    maxTiebreakers: 1,
  },
  {
    name: 'Infantiles A (6-7)',
    ageFrom: 6,
    ageTo: 7,
    roundCount: 1,
    durationSeconds: 60,
    finalRounds: 1,
    finalSeconds: undefined,
    tiebreakerSeconds: 60,
    maxTiebreakers: 1,
  },
  {
    name: 'Infantiles B (8-9)',
    ageFrom: 8,
    ageTo: 9,
    roundCount: 1,
    durationSeconds: 60,
    finalRounds: 1,
    finalSeconds: undefined,   // mismo tiempo que round regular
    tiebreakerSeconds: 60,
    maxTiebreakers: 1,
  },
  {
    name: 'Infantiles C (10-11)',
    ageFrom: 10,
    ageTo: 11,
    roundCount: 1,
    durationSeconds: 60,
    finalRounds: 1,
    finalSeconds: undefined,
    tiebreakerSeconds: 60,
    maxTiebreakers: 1,
  },
  {
    name: 'Pre-Junior (12-14)',
    ageFrom: 12,
    ageTo: 14,
    roundCount: 1,
    durationSeconds: 120,
    finalRounds: 1,
    finalSeconds: 120,
    tiebreakerSeconds: 60,
    maxTiebreakers: 1,
  },
  {
    name: 'Junior (15-17)',
    ageFrom: 15,
    ageTo: 17,
    roundCount: 1,
    durationSeconds: 120,
    finalRounds: 1,
    finalSeconds: 120,
    tiebreakerSeconds: 60,
    maxTiebreakers: 1,
  },
  {
    name: 'Adultos (18-35)',
    ageFrom: 18,
    ageTo: 35,
    roundCount: 1,
    durationSeconds: 120,
    finalRounds: 1,
    finalSeconds: 120,
    tiebreakerSeconds: 60,
    maxTiebreakers: 1,
  },
  {
    name: 'Seniors (36-45)',
    ageFrom: 36,
    ageTo: 45,
    roundCount: 1,
    durationSeconds: 90,
    finalRounds: 1,
    finalSeconds: 120,
    tiebreakerSeconds: 60,
    maxTiebreakers: 1,
  },
  {
    name: 'Veteranos (46+)',
    ageFrom: 46,
    roundCount: 1,
    durationSeconds: 90,
    finalRounds: 1,
    finalSeconds: 120,
    tiebreakerSeconds: 60,
    maxTiebreakers: 1,
  },
]

export type CategoryFormat = "round-robin" | "elimination";

export function getPresetForCategoryAge(ageFrom: string): TimePreset | null {
  const age = Number(ageFrom);
  if (ageFrom.trim() === "" || !Number.isFinite(age) || age < 0) return null;
  const preset = age < 12
    ? COPA_DANES_26[0]
    : age < 36
      ? COPA_DANES_26[4]
      : age < 46
        ? COPA_DANES_26[7]
        : COPA_DANES_26[8];
  return { ...preset };
}

export function getPresetForCategoryFormat(
  preset: TimePreset,
  format: CategoryFormat,
): TimePreset {
  if (preset.ageFrom === undefined || format !== "round-robin") return { ...preset };
  return { ...preset, roundCount: 1, durationSeconds: 60 };
}

// ── Helpers HTTP ──────────────────────────────────────────────────────────────

function dbToPreset(row: {
  id: number
  name: string
  round_count: number
  duration_seconds: number
  final_rounds: number | null
  final_seconds: number | null
  tiebreaker_seconds: number | null
  max_tiebreakers: number | null
}): TimePreset {
  return {
    id: row.id,
    name: row.name,
    roundCount: row.round_count,
    durationSeconds: row.duration_seconds,
    finalRounds: row.final_rounds ?? undefined,
    finalSeconds: row.final_seconds ?? undefined,
    tiebreakerSeconds: row.tiebreaker_seconds ?? undefined,
    maxTiebreakers: row.max_tiebreakers ?? undefined,
  }
}

export async function fetchPresets(): Promise<TimePreset[]> {
  const res = await fetch('/api/presets')
  if (!res.ok) throw new Error('Error al cargar presets')
  const rows = await res.json()
  return (rows as Parameters<typeof dbToPreset>[0][]).map(dbToPreset)
}

export async function savePreset(p: Omit<TimePreset, 'id'>): Promise<TimePreset> {
  const res = await fetch('/api/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: p.name,
      round_count: p.roundCount,
      duration_seconds: p.durationSeconds,
      final_rounds: p.finalRounds ?? null,
      final_seconds: p.finalSeconds ?? null,
      tiebreaker_seconds: p.tiebreakerSeconds ?? null,
      max_tiebreakers: p.maxTiebreakers ?? null,
    }),
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try { const body = await res.json(); if (body?.error) detail += `: ${body.error}` } catch { /* ignore */ }
    throw new Error(detail)
  }
  return dbToPreset(await res.json())
}

export async function deleteServerPreset(id: number): Promise<void> {
  const res = await fetch(`/api/presets/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Error al eliminar preset')
}
