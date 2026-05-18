import { z } from 'zod'

// ── Primitive schemas ────────────────────────────────────────────────────────

export const competitorColorSchema = z.enum(['red', 'blue'])
export const judgeIdSchema = z.string().min(1).max(8) // "J1", "J2", ..., "Arbiter"
export const fightIdSchema = z.string().min(1).max(128)
export const competitorIdSchema = z.string().min(1).max(128)

// Event types accepted by the engine (kept loose — the engine ignores unknown types).
export const matchEventTypeSchema = z.string().min(1).max(32)

// ── Payload schemas ──────────────────────────────────────────────────────────

export const judgeConnectSchema = z
  .object({
    requestedId: judgeIdSchema.optional(),
  })
  .nullable()

export const matchLoadSchema = z.object({
  rules: z.unknown(), // engine validates internally; trust shape from setup
  match: z.object({
    id: fightIdSchema,
    ringId: z.string().min(1).max(64).optional(),
    category: z.string().max(128).optional(),
    matchMode: z.enum(['sparring', 'patterns']).optional(),
    red: z.object({
      id: competitorIdSchema,
      name: z.string().min(1).max(128),
      club: z.string().max(128).optional(),
    }),
    blue: z.object({
      id: competitorIdSchema,
      name: z.string().min(1).max(128),
      club: z.string().max(128).optional(),
    }),
  }),
})

export const matchEventSchema = z.object({
  judgeId: judgeIdSchema,
  competitor: competitorColorSchema,
  type: matchEventTypeSchema,
})

export const judgeVoteSchema = z.object({
  judgeId: judgeIdSchema,
  vote: z.enum(['red', 'tie', 'blue']),
})

export const mesaFlagVoteSchema = z.object({
  judgeId: judgeIdSchema,
  vote: z.enum(['red', 'blue', 'draw']),
})

export const matchUndoSchema = z.object({
  judgeId: judgeIdSchema,
})

export const matchResolveJurySchema = z.object({
  winner: competitorColorSchema,
})

export const matchDqSchema = z.object({
  competitor: competitorColorSchema,
})

export const matchMedicalSchema = z.object({
  competitor: competitorColorSchema,
})

export const matchDeleteFalloSchema = z.object({
  id: z.number().int().nonnegative(),
})

/**
 * Safely parse a socket payload. On failure, logs at debug level and returns null.
 * Use the returned typed value or short-circuit the handler.
 */
export function safeParse<T>(schema: z.ZodType<T>, payload: unknown, event: string): T | null {
  const result = schema.safeParse(payload)
  if (!result.success) {
    console.warn(`[socket] invalid payload on "${event}":`, result.error.issues.map((i) => i.message).join(', '))
    return null
  }
  return result.data
}
