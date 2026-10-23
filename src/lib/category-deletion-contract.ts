import { z } from "zod";
import { categoryRestartSnapshotSchema } from "./category-restart-contract";

const identity = z.string().min(1).max(128);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const categoryDeletionCountsSchema = z.strictObject({
  competitors: z.number().int().nonnegative(),
  fights: z.number().int().nonnegative(),
  completedFights: z.number().int().nonnegative(),
  confirmedResults: z.number().int().nonnegative(),
  localOnlyFights: z.number().int().nonnegative(),
});
export const categoryDeletionPreviewRequestSchema = z.strictObject({
  localSnapshot: categoryRestartSnapshotSchema,
});
export const categoryDeletionRequestSchema = z.strictObject({
  requestId: z.uuid(),
  expectedRevision: revision,
  localSnapshot: categoryRestartSnapshotSchema,
});
export const categoryDeletionPreviewSchema = z.strictObject({
  ok: z.literal(true),
  categoryId: identity,
  revision,
  counts: categoryDeletionCountsSchema,
  warnings: z.array(z.string().max(4096)),
  requiresConfirmationText: z.boolean(),
});
export const categoryDeletionReceiptSchema = z.strictObject({
  ok: z.literal(true),
  requestId: z.uuid(),
  categoryId: identity,
  tournamentId: z.number().int().positive().nullable(),
  deletedAt: z.iso.datetime(),
  counts: categoryDeletionCountsSchema,
});
export const categoryDeletionTombstoneSchema = z.strictObject({
  categoryId: identity,
  requestId: z.uuid(),
  deletedAt: z.iso.datetime(),
});
export const categoryDeletionErrorSchema = z.strictObject({
  ok: z.literal(false),
  error: z.enum([
    "invalid_payload",
    "active_match",
    "snapshot_conflict",
    "deletion_scope_ambiguous",
    "request_id_conflict",
    "category_archived",
    "category_deleted",
    "replacement_deleted",
    "deletion_not_found",
    "deletion_failed",
  ]),
  message: z.string().min(1),
  categoryId: identity.optional(),
  requestId: z.uuid().optional(),
  deletion: categoryDeletionReceiptSchema.optional(),
});
export type CategoryDeletionCounts = z.infer<typeof categoryDeletionCountsSchema>;
export type CategoryDeletionPreviewRequest = z.infer<typeof categoryDeletionPreviewRequestSchema>;
export type CategoryDeletionPreview = z.infer<typeof categoryDeletionPreviewSchema>;
export type CategoryDeletionRequest = z.infer<typeof categoryDeletionRequestSchema>;
export type CategoryDeletionReceipt = z.infer<typeof categoryDeletionReceiptSchema>;
export type CategoryDeletionTombstone = z.infer<typeof categoryDeletionTombstoneSchema>;
export type CategoryDeletionError = z.infer<typeof categoryDeletionErrorSchema>;
