import { z } from "zod";
import {
  type CategoryDeletionTombstone,
  categoryDeletionTombstoneSchema,
} from "@/lib/category-deletion-contract";

export const CATEGORY_DELETIONS_KEY = "tkd-category-deletions-v1";
export const RETIRED_CATEGORY_SOURCES_KEY = "tkd-retired-category-sources-v1";
const retiredSchema = z.array(
  z.union([
    z.strictObject({
      sourceCategoryId: z.string().min(1),
      deletedTargetCategoryId: z.string().min(1),
    }),
    z.strictObject({
      sourceCategoryId: z.string().min(1),
      reason: z.literal("archived"),
      replacementCategoryId: z.string().min(1),
    }),
  ])
);

export function readCategoryDeletions(): CategoryDeletionTombstone[] {
  return z
    .array(categoryDeletionTombstoneSchema)
    .parse(JSON.parse(localStorage.getItem(CATEGORY_DELETIONS_KEY) ?? "[]"));
}

export function categoryExecutionUnavailable(categoryId: string): boolean {
  try {
    return (
      readCategoryDeletions().some((item) => item.categoryId === categoryId) ||
      retiredSchema
        .parse(JSON.parse(localStorage.getItem(RETIRED_CATEGORY_SOURCES_KEY) ?? "[]"))
        .some((item) => item.sourceCategoryId === categoryId)
    );
  } catch {
    return true;
  }
}

export function categoryExecutionDeleted(categoryId: string): boolean {
  try {
    return readCategoryDeletions().some((item) => item.categoryId === categoryId);
  } catch {
    return true;
  }
}

export function persistCategoryDeletions(tombstones: readonly CategoryDeletionTombstone[]): void {
  const previous = readCategoryDeletions();
  const next = new Map(previous.map((item) => [item.categoryId, item]));
  for (const item of tombstones) {
    const parsed = categoryDeletionTombstoneSchema.parse(item);
    if (!next.has(parsed.categoryId)) next.set(parsed.categoryId, parsed);
  }
  if (next.size !== previous.length)
    localStorage.setItem(CATEGORY_DELETIONS_KEY, JSON.stringify([...next.values()]));
}

export function persistRetiredCategorySource(
  sourceCategoryId: string,
  deletedTarget: CategoryDeletionTombstone
): void {
  persistCategoryDeletions([deletedTarget]);
  if (sourceCategoryId === deletedTarget.categoryId) return;
  const previous = retiredSchema.parse(
    JSON.parse(localStorage.getItem(RETIRED_CATEGORY_SOURCES_KEY) ?? "[]")
  );
  if (!previous.some((item) => item.sourceCategoryId === sourceCategoryId)) {
    localStorage.setItem(
      RETIRED_CATEGORY_SOURCES_KEY,
      JSON.stringify([
        ...previous,
        { sourceCategoryId, deletedTargetCategoryId: deletedTarget.categoryId },
      ])
    );
  }
}

export function persistArchivedCategorySource(
  sourceCategoryId: string,
  replacementCategoryId: string
): void {
  const previous = retiredSchema.parse(
    JSON.parse(localStorage.getItem(RETIRED_CATEGORY_SOURCES_KEY) ?? "[]")
  );
  if (!previous.some((item) => item.sourceCategoryId === sourceCategoryId)) {
    localStorage.setItem(
      RETIRED_CATEGORY_SOURCES_KEY,
      JSON.stringify([...previous, { sourceCategoryId, reason: "archived", replacementCategoryId }])
    );
  }
}
