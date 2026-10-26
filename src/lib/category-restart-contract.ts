import { z } from "zod";

const id = z.string().min(1).max(128);
const text = z.string().max(4096);
const count = z.number().int().nonnegative();
const metric = count.optional();
const competitor = z.strictObject({
  id,
  name: z.string().min(1).max(1024),
  team: text.optional(),
  weight: z.number().finite().optional(),
});
const sparringRules = z.strictObject({
  mode: z.literal("sparring"),
  version: text.optional(),
  notes: text.optional(),
  judgesCount: z.number().int().min(1).max(5),
  rounds: z.strictObject({
    count: z.number().int().min(1),
    duration_seconds: count,
    rest_seconds: count,
    golden_point: z.boolean().optional(),
    overtime_seconds: count.optional(),
  }),
  points: z.record(z.string(), z.number().finite()),
  deductions: z.record(z.string(), z.union([z.number().finite(), z.literal("DQ")])),
  fouls_for_dq: count.optional(),
  fouls_examples: z.array(text).optional(),
  judgingMode: z.enum(["flags", "points"]).optional(),
  tiebreak_order: z.array(text).optional(),
  validation: z
    .strictObject({
      min_interval_ms_same_judge: count.optional(),
      require_majority_for_point: z.boolean().optional(),
    })
    .optional(),
});
const patternsRules = z.strictObject({
  mode: z.literal("patterns"),
  version: text.optional(),
  notes: text.optional(),
  judgesCount: z.number().int().min(1).max(5),
  scoringScale: z.strictObject({
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite(),
  }),
  criteria: z.array(
    z.strictObject({ key: id, label: text.optional(), weight: z.number().finite() })
  ),
  drop_high_low: z.boolean().optional(),
  decision: z.enum(["highestTotal", "flags"]),
  tie: z.array(text).optional(),
});
const config = z.strictObject({
  id,
  eventId: id.optional(),
  profileId: z.literal("yusan-2026").optional(),
  profileApplied: z.boolean().optional(),
  nameGenerated: z.boolean().optional(),
  requiresGradeSelection: z.boolean().optional(),
  tournamentName: text,
  categoryName: text,
  tableChief: text,
  ruleSet: z.union([sparringRules, patternsRules]).nullable(),
  judgesCount: z.number().int().min(1).max(5),
  mode: z.enum(["round-robin", "elimination", "groups"]),
  rrOrderMode: z.enum(["rest-optimized", "group-blocks"]).optional(),
  matchType: z.enum(["sparring", "tul"]),
  finalRounds: count.optional(),
  finalSeconds: count.optional(),
  tiebreakerSeconds: count.optional(),
  maxTiebreakers: count.optional(),
  weightLabel: text.optional(),
  ageDivision: z
    .enum([
      "kids",
      "infantiles-a",
      "infantiles-b",
      "infantiles-c",
      "pre-juniors",
      "juniors",
      "adultos",
      "seniors",
      "veteranos",
    ])
    .optional(),
  categoryAgeFrom: text.optional(),
  categoryAgeTo: text.optional(),
  categoryAgeOpenEnded: z.boolean().optional(),
  sexDivision: z.enum(["Masculino", "Femenino", "Mixto"]).optional(),
  gradeSystem: z.enum(["GUPS", "DAN"]).optional(),
  gupBand: text.optional(),
  danFrom: count.optional(),
  danTo: count.optional(),
});
const fight = z.strictObject({
  id,
  red: competitor,
  blue: competitor,
  winner: z.enum(["red", "blue", "draw"]).optional(),
  winReason: text.optional(),
  completed: z.boolean(),
  groupId: id.optional(),
  flagsRed: metric,
  flagsBlue: metric,
  warningsRed: metric,
  warningsBlue: metric,
  foulsRed: metric,
  foulsBlue: metric,
  isTiebreakExtra: z.boolean().optional(),
  playoffKind: z.enum(["direct", "mini"]).optional(),
  playoffBasis: text.optional(),
  tiebreakerSeconds: count.optional(),
  isFinalFight: z.boolean().optional(),
  isGoldenPointFight: z.boolean().optional(),
  importedFrom: text.optional(),
  bracketRound: count.optional(),
  bracketPosition: count.optional(),
  bracketMatchId: id.optional(),
  continuationParentFightId: id.optional(),
  continuationStage: z.enum(["timed-extra", "golden-point"]).optional(),
});
const slot = z.strictObject({ competitor: competitor.nullable(), fromMatchId: id.optional() });
const snapshotSchema = z
  .strictObject({
    phase: z.enum(["setup", "fighting", "results"]),
    config,
    competitors: z.array(competitor).max(4096),
    fights: z.array(fight).max(20000),
    groups: z
      .array(z.strictObject({ id, competitors: z.array(competitor).max(4096), size: count }))
      .max(4096),
    currentFightIndex: count,
    bracketMatches: z
      .array(
        z.strictObject({
          id,
          round: count,
          position: count,
          red: slot,
          blue: slot,
          winnerId: id.optional(),
          completed: z.boolean(),
          fightId: id.optional(),
          bracketGroup: z.enum(["A", "B"]).optional(),
        })
      )
      .max(8192),
    bracketSeeds: z.array(id.nullable()).max(8192),
    setupStarted: z.boolean(),
  })
  .superRefine((snapshot, context) => {
    const fail = (message: string): void => context.addIssue({ code: "custom", message });
    for (const collection of [
      snapshot.competitors,
      snapshot.fights,
      snapshot.groups,
      snapshot.bracketMatches,
    ]) {
      if (new Set(collection.map((entry) => entry.id)).size !== collection.length)
        fail("duplicate identity");
    }
    // The editable current roster may omit a participant still recorded in the
    // historical graph. Validate references against full participant records,
    // without rewriting that graph or re-adding entrants to the next execution.
    const entrants = new Set([
      ...snapshot.competitors.map((entry) => entry.id),
      ...snapshot.groups.flatMap((group) => group.competitors.map((entry) => entry.id)),
      ...snapshot.fights.flatMap((entry) => [entry.red.id, entry.blue.id]),
      ...snapshot.bracketMatches.flatMap((entry) =>
        [entry.red.competitor?.id, entry.blue.competitor?.id].filter(
          (identity): identity is string => typeof identity === "string"
        )
      ),
    ]);
    const brackets = new Set(snapshot.bracketMatches.map((entry) => entry.id));
    const fights = new Set(snapshot.fights.map((entry) => entry.id));
    if (snapshot.bracketSeeds.some((seed) => seed !== null && !entrants.has(seed)))
      fail("unknown seed");
    for (const entry of snapshot.fights) {
      if (entry.red.id === entry.blue.id) fail("fight requires distinct competitors");
      if (entry.continuationParentFightId &&
        (!fights.has(entry.continuationParentFightId) || entry.continuationParentFightId === entry.id))
        fail("unknown continuation parent");
      if (
        entry.bracketMatchId &&
        !brackets.has(entry.bracketMatchId) &&
        !(
          snapshot.config.mode !== "elimination" &&
          entry.isGoldenPointFight &&
          fights.has(entry.bracketMatchId) &&
          entry.bracketMatchId !== entry.id
        )
      ) {
        fail("unknown bracket match");
      }
    }
    for (const entry of snapshot.bracketMatches) {
      if (entry.fightId && !fights.has(entry.fightId)) fail("unknown bracket fight");
      for (const side of [entry.red, entry.blue]) {
        if (
          side.fromMatchId &&
          (!brackets.has(side.fromMatchId) || side.fromMatchId === entry.id)
        ) {
          fail("unknown bracket source");
        }
        if (side.competitor && !entrants.has(side.competitor.id))
          fail("unknown bracket competitor");
      }
      if (entry.winnerId && !entrants.has(entry.winnerId)) fail("unknown bracket winner");
    }
  });

export const categoryRestartSnapshotSchema = snapshotSchema;
export type CategoryRestartSnapshot = z.infer<typeof categoryRestartSnapshotSchema>;
export type CategoryRestartCompetitor = CategoryRestartSnapshot["competitors"][number];
export type CategoryRestartFight = CategoryRestartSnapshot["fights"][number];
export type CategoryRestartBracketMatch = CategoryRestartSnapshot["bracketMatches"][number];
export type CategoryRestartGroup = CategoryRestartSnapshot["groups"][number];

export interface CategoryArchiveMetadata {
  categoryId: string;
  replacementCategoryId: string;
  requestId: string;
  archivedAt: string;
  sourceTournamentId: number;
  replacementTournamentId: number;
  provenance: "as-recorded";
  warnings: string[];
}
export interface RestartCategoryRequest {
  requestId: string;
  categoryId: string;
  previousSnapshot: CategoryRestartSnapshot;
  replacementSnapshot: CategoryRestartSnapshot;
}
export interface RestartCategorySuccess {
  ok: true;
  requestId: string;
  categoryId: string;
  replacementCategoryId: string;
  archive: CategoryArchiveMetadata;
  replacementSnapshot: CategoryRestartSnapshot;
}
export interface RestartCategoryError {
  ok: false;
  error:
    | "invalid_payload"
    | "active_match"
    | "category_archived"
    | "snapshot_conflict"
    | "request_id_conflict"
    | "replacement_not_found"
    | "restart_failed";
  message: string;
  categoryId?: string;
  replacementCategoryId?: string;
  requestId?: string;
}
export interface ArchivedCategoryHistoryFields {
  readOnly: true;
  archive: CategoryArchiveMetadata;
  fullSnapshot: CategoryRestartSnapshot;
}
const archiveSchema = z.strictObject({
  categoryId: id,
  replacementCategoryId: id,
  requestId: z.uuid(),
  archivedAt: z.string().min(1),
  sourceTournamentId: z.number().int().positive(),
  replacementTournamentId: z.number().int().positive(),
  provenance: z.literal("as-recorded"),
  warnings: z.array(text),
});
export const restartCategoryRequestSchema: z.ZodType<RestartCategoryRequest> = z
  .strictObject({
    requestId: z.uuid(),
    categoryId: id,
    previousSnapshot: categoryRestartSnapshotSchema,
    replacementSnapshot: categoryRestartSnapshotSchema,
  })
  .refine(
    (request) =>
      request.categoryId === request.previousSnapshot.config.id &&
      request.categoryId !== request.replacementSnapshot.config.id,
    "category linkage mismatch"
  );

export const restartCategorySuccessSchema: z.ZodType<RestartCategorySuccess> = z
  .strictObject({
    ok: z.literal(true),
    requestId: z.uuid(),
    categoryId: id,
    replacementCategoryId: id,
    archive: archiveSchema,
    replacementSnapshot: categoryRestartSnapshotSchema,
  })
  .refine(
    (result) =>
      result.categoryId === result.archive.categoryId &&
      result.replacementCategoryId === result.archive.replacementCategoryId &&
      result.replacementCategoryId === result.replacementSnapshot.config.id &&
      result.requestId === result.archive.requestId,
    "canonical linkage mismatch"
  );
