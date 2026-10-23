import type { FightEntry, TournamentConfig } from "@/store/tournament";
import { z } from "zod";
import type { CanonicalEliminationFight,
  EliminationContinuationRequest } from "@/lib/elimination-continuation-contract";

const canonicalFightSchema = z.strictObject({
  id: z.string().uuid(), red_id: z.string().min(1), blue_id: z.string().min(1),
  stage: z.enum(["timed-extra", "golden-point"]),
  parentFightId: z.string().min(1), parentRevision: z.number().int().nonnegative(),
});

const canonicalGetResponseSchema = z.strictObject({ canonicalFight: canonicalFightSchema });
const canonicalSyncResponseSchema = z.strictObject({
  canonicalFight: canonicalFightSchema,
  ok: z.literal(true),
  synced: z.number().int().nonnegative(),
  tournamentId: z.number().int().positive(),
  warning: z.string().optional(),
});

function parseCanonicalFight(payload: unknown, source: "get" | "sync"):
  CanonicalEliminationFight {
  const parsed = (source === "get" ? canonicalGetResponseSchema : canonicalSyncResponseSchema)
    .safeParse(payload);
  if (!parsed.success) throw new Error("El servidor no devolvió la pelea canónica.");
  return parsed.data.canonicalFight;
}

/** Read-only recovery: distinguish a missing child from a failed authority check. */
export async function getCanonicalEliminationContinuation(
  categoryId: string, parentFightId: string
): Promise<CanonicalEliminationFight | null> {
  const response = await fetch(`/api/ring/categories/${encodeURIComponent(categoryId)}/fights/${
    encodeURIComponent(parentFightId)}/continuation`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("No se pudo consultar el desempate canónico.");
  return parseCanonicalFight(await response.json(), "get");
}

/** Persist the proposed queue before exposing a new playoff/final locally. */
export async function syncProposedFights(
  config: Pick<TournamentConfig, "id" | "categoryName" | "tournamentName">,
  fights: FightEntry[],
  requiredConfirmedFightIds: readonly string[] = [],
  eliminationContinuation?: EliminationContinuationRequest
): Promise<CanonicalEliminationFight | null> {
  const competitors = Array.from(
    new Map(
      fights.flatMap((fight) => [
        [fight.red.id, { id: fight.red.id, name: fight.red.name, team: fight.red.team }],
        [fight.blue.id, { id: fight.blue.id, name: fight.blue.name, team: fight.blue.team }],
      ])
    ).values()
  );
  const response = await fetch("/api/ring/sync-fights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      categoryId: config.id,
      categoryName: config.categoryName,
      tournamentName: config.tournamentName,
      competitors,
      ...(requiredConfirmedFightIds.length > 0
        ? { requiredConfirmedFightIds: [...new Set(requiredConfirmedFightIds)] }
        : {}),
      ...(eliminationContinuation ? { eliminationContinuation } : {}),
      fights: fights.map((fight) => ({
        id: fight.id,
        red_id: fight.red.id,
        blue_id: fight.blue.id,
        completed: fight.completed,
        ...(fight.continuationParentFightId ? {
          continuationParentFightId: fight.continuationParentFightId,
          continuationStage: fight.continuationStage,
        } : {}),
      })),
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    throw new Error(body?.message ?? body?.error ?? "El servidor rechazó la nueva pelea.");
  }
  if (!eliminationContinuation) return null;
  return parseCanonicalFight(await response.json(), "sync");
}
