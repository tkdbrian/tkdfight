import { z } from "zod";
import {
  type RestartCategoryRequest,
  restartCategoryRequestSchema,
} from "@/lib/category-restart-contract";
import {
  type CategoryDeleteAndRestartRequest,
  categoryDeleteAndRestartRequestSchema,
} from "@/lib/category-restart-modes-contract";

const destructiveJournalSchema = z
  .strictObject({
    mode: z.literal("delete-and-restart"),
    categoryId: z.string().min(1),
    request: categoryDeleteAndRestartRequestSchema,
  })
  .refine((value) => value.categoryId === value.request.previousSnapshot.config.id);
interface ArchiveJournal {
  mode: "archive";
  request: RestartCategoryRequest;
}
export interface DeleteAndRestartJournal {
  mode: "delete-and-restart";
  categoryId: string;
  request: CategoryDeleteAndRestartRequest;
}
export type CategoryRestartJournal = ArchiveJournal | DeleteAndRestartJournal;

export function parseCategoryRestartJournal(raw: string): CategoryRestartJournal {
  const value: unknown = JSON.parse(raw);
  const destructive = destructiveJournalSchema.safeParse(value);
  if (destructive.success) return destructive.data;
  return { mode: "archive", request: restartCategoryRequestSchema.parse(value) };
}

export function pendingDeleteAndRestartSource(): string | null {
  try {
    const raw = localStorage.getItem("tkd-pending-category-restart-v1");
    if (!raw) return null;
    const parsed = parseCategoryRestartJournal(raw);
    return parsed.mode === "delete-and-restart" ? parsed.categoryId : null;
  } catch {
    return null;
  }
}
