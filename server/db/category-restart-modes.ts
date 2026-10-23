import {
  type CategoryDeleteAndRestartError,
  type CategoryDeleteAndRestartRequest,
  type CategoryDeleteAndRestartSuccess,
  categoryDeleteAndRestartRequestSchema,
} from "../../src/lib/category-restart-modes-contract.js";
import {
  CategoryDeletionError,
  type CategoryDeletionOptions,
  deleteCategoryExecution,
  fingerprintCategoryRequest,
  getCategoryDeletion,
  getDeletedCategoryReplacement,
} from "./category-deletions.js";
import { createCategoryReplacement, validateCategoryReplacement } from "./category-executions.js";
import db, {
  getCategoryTournamentId,
  getSelectedTournamentId,
  setSelectedTournamentId,
} from "./index.js";

export class CategoryRestartModeError extends Error {
  constructor(readonly response: CategoryDeleteAndRestartError) {
    super(response.message);
  }
}
interface DeletedRestartRow {
  category_id: string;
  request_id: string;
  replacement_category_id: string;
  replacement_snapshot: string;
  request_fingerprint: string;
}
export function getCategoryDeleteAndRestart(
  categoryId: string
): CategoryDeleteAndRestartSuccess | null {
  const row = db
    .prepare("SELECT * FROM category_execution_deleted_restarts WHERE category_id = ?")
    .get(categoryId) as DeletedRestartRow | undefined;
  if (!row) return null;
  const deletion = getCategoryDeletion(categoryId);
  if (!deletion) throw new Error("Missing destructive restart deletion receipt");
  const replacementDeletion =
    getCategoryDeletion(row.replacement_category_id) ??
    getDeletedCategoryReplacement(row.replacement_category_id);
  if (replacementDeletion)
    throw new CategoryRestartModeError({
      ok: false,
      error: "replacement_deleted",
      message:
        "El reinicio se confirmó, pero su reemplazo fue eliminado; no se recuperó la copia inicial.",
      categoryId,
      requestId: row.request_id,
      deletion,
      replacementCategoryId: row.replacement_category_id,
      replacementDeletion,
    });
  const archive = db
    .prepare(
      "SELECT replacement_category_id FROM category_execution_archives WHERE category_id = ?"
    )
    .get(row.replacement_category_id) as { replacement_category_id: string } | undefined;
  if (archive)
    throw new CategoryRestartModeError({
      ok: false,
      error: "category_archived",
      message:
        "El reinicio se confirmó, pero su reemplazo ya fue archivado; no se recuperó la copia inicial.",
      categoryId,
      requestId: row.request_id,
      deletion,
      archivedCategoryId: row.replacement_category_id,
      replacementCategoryId: archive.replacement_category_id,
    });
  return {
    ok: true,
    requestId: row.request_id,
    categoryId,
    replacementCategoryId: row.replacement_category_id,
    deletion,
    replacementSnapshot: JSON.parse(
      row.replacement_snapshot
    ) as CategoryDeleteAndRestartSuccess["replacementSnapshot"],
  };
}
export function deleteAndRestartCategoryExecution(
  input: CategoryDeleteAndRestartRequest,
  options: CategoryDeletionOptions = {}
): CategoryDeleteAndRestartSuccess {
  return db.transaction(() => {
    if (!categoryDeleteAndRestartRequestSchema.safeParse(input).success)
      throw new CategoryDeletionError("invalid_payload", "La solicitud de reinicio no es válida.");
    const hash = fingerprintCategoryRequest(input);
    const prior = db
      .prepare("SELECT * FROM category_execution_deleted_restarts WHERE request_id = ?")
      .get(input.requestId) as DeletedRestartRow | undefined;
    if (prior) {
      if (prior.request_fingerprint !== hash)
        throw new CategoryDeletionError(
          "request_id_conflict",
          "El requestId ya se usó con otros datos."
        );
      return requireRestartReceipt(prior.category_id);
    }
    if (
      db
        .prepare(`SELECT 1 FROM category_execution_archives WHERE request_id = ?
      UNION ALL SELECT 1 FROM category_execution_deletions WHERE request_id = ?`)
        .get(input.requestId, input.requestId)
    )
      throw new CategoryDeletionError(
        "request_id_conflict",
        "El requestId ya se usó para otra operación."
      );
    const categoryId = input.previousSnapshot.config.id;
    validateCategoryReplacement({ ...input, categoryId });
    const sourceId = getCategoryTournamentId(categoryId);
    const selectedSource = sourceId !== null && getSelectedTournamentId() === sourceId;
    deleteCategoryExecution(
      {
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        localSnapshot: input.previousSnapshot,
      },
      options
    );
    const replacementId = createCategoryReplacement(input.replacementSnapshot);
    db.prepare(`INSERT INTO category_execution_deleted_restarts
      (category_id, request_id, replacement_category_id, replacement_snapshot, request_fingerprint, mode)
      VALUES (?, ?, ?, ?, ?, 'delete-and-restart')`).run(
      categoryId,
      input.requestId,
      input.replacementSnapshot.config.id,
      JSON.stringify(input.replacementSnapshot),
      hash
    );
    if (selectedSource) setSelectedTournamentId(replacementId);
    return requireRestartReceipt(categoryId);
  })();
}

function requireRestartReceipt(categoryId: string): CategoryDeleteAndRestartSuccess {
  const result = getCategoryDeleteAndRestart(categoryId);
  if (!result) throw new Error("Destructive restart receipt was not persisted");
  return result;
}
