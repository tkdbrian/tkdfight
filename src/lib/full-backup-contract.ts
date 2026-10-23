import { z } from "zod";

export const BACKUP_MAX_BYTES = 32 * 1024 * 1024;
export const BACKUP_BROWSER_KEYS = [
  "tkd-tournament",
  "tkd-tournament-categories",
  "tkd-category-deletions-v1",
  "tkd-retired-category-sources-v1",
] as const;

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ])
);
const sqlSchema = z.strictObject({
  tables: z.record(z.string(), z.array(z.record(z.string(), jsonValue))),
  sequences: z.record(z.string(), z.number().int().nonnegative()),
});
const browserSchema = z.strictObject({
  "tkd-tournament": z.string().nullable(),
  "tkd-tournament-categories": z.string().nullable(),
  "tkd-category-deletions-v1": z.string().nullable(),
  "tkd-retired-category-sources-v1": z.string().nullable(),
});
const backupRoleSchema = z.enum(["T1", "T2", "T3", "MC"]);
export type BackupRole = z.infer<typeof backupRoleSchema>;
const id = z.string().min(1);
const count = z.number().int().nonnegative();
const competitor = z.object({
  id,
  name: z.string(),
  team: z.string().optional(),
  weight: z.number().finite().optional(),
});
const fight = z.object({
  id,
  red: competitor,
  blue: competitor,
  completed: z.boolean(),
  winner: z.enum(["red", "blue", "draw"]).optional(),
  groupId: id.optional(),
  bracketMatchId: id.optional(),
  continuationParentFightId: id.optional(),
  continuationStage: z.enum(["timed-extra", "golden-point"]).optional(),
  flagsRed: count.optional(),
  flagsBlue: count.optional(),
  warningsRed: count.optional(),
  warningsBlue: count.optional(),
  foulsRed: count.optional(),
  foulsBlue: count.optional(),
});
const slot = z.object({ competitor: competitor.nullable(), fromMatchId: id.optional() });
const snapshot = z
  .object({
    phase: z.enum(["setup", "fighting", "results"]),
    config: z
      .object({
        id,
        tournamentName: z.string().optional(),
        categoryName: z.string().optional(),
        mode: z.enum(["round-robin", "elimination", "groups"]).optional(),
        matchType: z.enum(["sparring", "tul"]).optional(),
      })
      .passthrough(),
    competitors: z.array(competitor),
    fights: z.array(fight),
    groups: z.array(z.object({ id, competitors: z.array(competitor), size: count })),
    bracketMatches: z.array(
      z.object({
        id,
        round: count,
        position: count,
        red: slot,
        blue: slot,
        completed: z.boolean(),
        winnerId: id.optional(),
        fightId: id.optional(),
      })
    ),
    bracketSeeds: z.array(id.nullable()),
    currentFightIndex: count,
    setupStarted: z.boolean(),
    categoryRevision: count.optional(),
    categoryOperationReason: z.string().nullable().optional(),
    eventProfiles: z.record(z.string(), z.literal("yusan-2026")).optional(),
  })
  .passthrough();
const archive = z.object({
  categoryId: id,
  replacementCategoryId: id,
  requestId: id,
  archivedAt: z.string(),
  sourceTournamentId: count,
  replacementTournamentId: count,
  provenance: z.literal("as-recorded"),
  warnings: z.array(z.string()),
});
const payloadSchema = z.strictObject({ sql: sqlSchema, browser: browserSchema });
const envelopeSchema = z.strictObject({
  format: z.literal("tkd-backup"),
  version: z.literal(1),
  buildId: z.string().min(1).max(200),
  role: backupRoleSchema,
  backupId: z.string().min(1).max(200),
  createdAt: z.iso.datetime().refine((value) => value.endsWith("Z")),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: payloadSchema,
});

export type BackupPayload = z.infer<typeof payloadSchema>;
export type BackupEnvelope = z.infer<typeof envelopeSchema>;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateBrowserPayload(browser: BackupPayload["browser"]): void {
  const main = browser["tkd-tournament"];
  if (main !== null) {
    const parsed: unknown = JSON.parse(main);
    if (
      !z.strictObject({ version: z.literal(1), state: snapshot.partial() }).safeParse(parsed)
        .success
    )
      throw new Error("Invalid tournament browser version");
  }
  const categories = browser["tkd-tournament-categories"];
  if (categories !== null) {
    const parsed: unknown = JSON.parse(categories);
    const checked = z
      .union([
        z.object({ version: z.literal(1), categories: z.record(z.string(), snapshot) }),
        z.object({
          version: z.literal(2),
          categories: z.record(z.string(), snapshot),
          archives: z.record(z.string(), archive).optional(),
          visibleCategoryIds: z.array(id),
          selectedCategoryId: id.nullable(),
          draftCategoryId: id.nullable(),
          draftReturnCategoryId: id.nullable(),
        }),
      ])
      .safeParse(parsed);
    if (!checked.success) throw new Error("Invalid category browser version");
    for (const [categoryId, category] of Object.entries(checked.data.categories)) {
      if (category.config.id !== categoryId) throw new Error("Category registry identity mismatch");
    }
    if (checked.data.version === 2) {
      const {
        categories: saved,
        visibleCategoryIds,
        selectedCategoryId,
        draftCategoryId,
        draftReturnCategoryId,
      } = checked.data;
      for (const id of visibleCategoryIds)
        if (!Object.hasOwn(saved, id)) throw new Error("Visible category missing");
      for (const id of [selectedCategoryId, draftCategoryId, draftReturnCategoryId])
        if (id && !Object.hasOwn(saved, id)) throw new Error("Selected category missing");
    }
  }
  const deleted = browser["tkd-category-deletions-v1"];
  if (
    deleted !== null &&
    !z
      .array(z.object({ categoryId: id, requestId: id, deletedAt: z.string() }))
      .safeParse(JSON.parse(deleted)).success
  )
    throw new Error("Invalid category deletion tombstones");
  const retired = browser["tkd-retired-category-sources-v1"];
  if (
    retired !== null &&
    !z
      .array(
        z.union([
          z.object({ sourceCategoryId: id, deletedTargetCategoryId: id }),
          z.object({
            sourceCategoryId: id,
            reason: z.literal("archived"),
            replacementCategoryId: id,
          }),
        ])
      )
      .safeParse(JSON.parse(retired)).success
  )
    throw new Error("Invalid retired category sources");
}

export async function createBackupEnvelope(
  payload: BackupPayload,
  buildId: string,
  role: BackupRole,
  backupId: string,
  createdAt: string
): Promise<BackupEnvelope> {
  const checked = payloadSchema.parse(payload);
  validateBrowserPayload(checked.browser);
  const payloadHash = await sha256Hex(canonicalJson(checked));
  const envelope = envelopeSchema.parse({
    format: "tkd-backup",
    version: 1,
    buildId,
    role,
    backupId,
    createdAt,
    payloadHash,
    payload: checked,
  });
  if (new TextEncoder().encode(JSON.stringify(envelope)).length > BACKUP_MAX_BYTES)
    throw new Error("Backup exceeds 32 MiB");
  return envelope;
}

export async function parseBackupEnvelope(
  raw: string,
  buildId: string,
  role: BackupRole
): Promise<BackupEnvelope> {
  if (new TextEncoder().encode(raw).length > BACKUP_MAX_BYTES)
    throw new Error("Backup exceeds 32 MiB");
  const envelope = envelopeSchema.parse(JSON.parse(raw) as unknown);
  if (envelope.buildId !== buildId || envelope.role !== role)
    throw new Error("Backup build or role mismatch");
  validateBrowserPayload(envelope.payload.browser);
  if ((await sha256Hex(canonicalJson(envelope.payload))) !== envelope.payloadHash)
    throw new Error("Backup payload hash mismatch");
  return envelope;
}
