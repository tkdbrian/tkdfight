import { z } from "zod";
import {
  categoryDeletionErrorSchema,
  categoryDeletionReceiptSchema,
} from "./category-deletion-contract";
import { categoryRestartSnapshotSchema } from "./category-restart-contract";

const identity = z.string().min(1).max(128);

export const categoryDeleteAndRestartRequestSchema = z
  .strictObject({
    requestId: z.uuid(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    previousSnapshot: categoryRestartSnapshotSchema,
    replacementSnapshot: categoryRestartSnapshotSchema,
  })
  .refine((value) => value.previousSnapshot.config.id !== value.replacementSnapshot.config.id, {
    message: "La nueva ejecución necesita una identidad distinta.",
  });

export const categoryDeleteAndRestartSuccessSchema = z
  .strictObject({
    ok: z.literal(true),
    requestId: z.uuid(),
    categoryId: identity,
    replacementCategoryId: identity,
    deletion: categoryDeletionReceiptSchema,
    replacementSnapshot: categoryRestartSnapshotSchema,
  })
  .refine(
    (value) =>
      value.categoryId === value.deletion.categoryId &&
      value.requestId === value.deletion.requestId &&
      value.replacementCategoryId === value.replacementSnapshot.config.id &&
      value.categoryId !== value.replacementCategoryId,
    { message: "El recibo y la nueva ejecución no corresponden al mismo reinicio." }
  );

export const categoryDeleteAndRestartErrorSchema = categoryDeletionErrorSchema.extend({
  error: z.enum([
    ...categoryDeletionErrorSchema.shape.error.options,
    "replacement_not_found",
    "restart_failed",
  ]),
  archivedCategoryId: identity.optional(),
  replacementCategoryId: identity.optional(),
  replacementDeletion: categoryDeletionReceiptSchema.optional(),
});

export type CategoryDeleteAndRestartRequest = z.infer<typeof categoryDeleteAndRestartRequestSchema>;
export type CategoryDeleteAndRestartSuccess = z.infer<typeof categoryDeleteAndRestartSuccessSchema>;
export type CategoryDeleteAndRestartError = z.infer<typeof categoryDeleteAndRestartErrorSchema>;
