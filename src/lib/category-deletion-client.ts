import {
  type CategoryDeletionPreview,
  type CategoryDeletionReceipt,
  type CategoryDeletionRequest,
  categoryDeletionErrorSchema,
  categoryDeletionPreviewRequestSchema,
  categoryDeletionPreviewSchema,
  categoryDeletionReceiptSchema,
  categoryDeletionRequestSchema,
} from "@/lib/category-deletion-contract";
import {
  CategoryOperationUserError,
  categoryOperationServerMessage,
  INVALID_CATEGORY_MESSAGE,
} from "@/lib/category-operation-errors";
import type { CategoryRestartSnapshot } from "@/lib/category-restart-contract";

export class CategoryDeletionRequestError extends CategoryOperationUserError {
  constructor(
    _message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly deletion?: CategoryDeletionReceipt,
    public readonly categoryId?: string
  ) {
    super(categoryOperationServerMessage(code, status));
    this.name = "CategoryDeletionRequestError";
  }
}

export async function readCategoryDeletionBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = categoryDeletionErrorSchema.safeParse(body);
    throw new CategoryDeletionRequestError(
      parsed.success ? parsed.data.message : `HTTP ${response.status}`,
      response.status,
      parsed.success ? parsed.data.error : undefined,
      parsed.success ? parsed.data.deletion : undefined,
      parsed.success ? parsed.data.categoryId : undefined
    );
  }
  return body;
}

function endpoint(categoryId: string, operation: string): string {
  return `/api/ring/categories/${encodeURIComponent(categoryId)}/${operation}`;
}

export async function previewCategoryDeletion(
  localSnapshot: CategoryRestartSnapshot
): Promise<CategoryDeletionPreview> {
  if (!categoryDeletionPreviewRequestSchema.safeParse({ localSnapshot }).success)
    throw new CategoryOperationUserError(INVALID_CATEGORY_MESSAGE);
  const response = await fetch(endpoint(localSnapshot.config.id, "deletion-preview"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localSnapshot }),
  });
  const parsed = categoryDeletionPreviewSchema.safeParse(await readCategoryDeletionBody(response));
  if (!parsed.success)
    throw new CategoryOperationUserError(
      "Vista previa de eliminación inválida. Actualizá el estado antes de reintentar."
    );
  if (parsed.data.categoryId !== localSnapshot.config.id)
    throw new CategoryOperationUserError("Vista previa ajena a la categoría.");
  return parsed.data;
}

export async function requestCategoryDeletion(
  categoryId: string,
  payload: CategoryDeletionRequest
): Promise<CategoryDeletionReceipt> {
  if (!categoryDeletionRequestSchema.safeParse(payload).success)
    throw new CategoryOperationUserError(INVALID_CATEGORY_MESSAGE);
  if (payload.localSnapshot.config.id !== categoryId)
    throw new CategoryOperationUserError("Solicitud ajena a la categoría.");
  const response = await fetch(endpoint(categoryId, "delete"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const parsed = categoryDeletionReceiptSchema.safeParse(await readCategoryDeletionBody(response));
  if (!parsed.success)
    throw new CategoryOperationUserError(
      "Respuesta de eliminación inválida; se requiere recuperación."
    );
  if (parsed.data.categoryId !== categoryId || parsed.data.requestId !== payload.requestId) {
    throw new CategoryOperationUserError("Respuesta de eliminación ajena a la solicitud.");
  }
  return parsed.data;
}

export async function lookupCategoryDeletion(
  categoryId: string
): Promise<CategoryDeletionReceipt | null> {
  const response = await fetch(endpoint(categoryId, "deletion"), { method: "GET" });
  let body: unknown;
  try {
    body = await readCategoryDeletionBody(response);
  } catch (error) {
    if (
      error instanceof CategoryDeletionRequestError &&
      error.status === 404 &&
      error.code === "deletion_not_found"
    )
      return null;
    throw error;
  }
  const parsed = categoryDeletionReceiptSchema.safeParse(body);
  if (!parsed.success)
    throw new CategoryOperationUserError(
      "Respuesta de recuperación inválida. Recuperá el estado antes de reintentar."
    );
  if (parsed.data.categoryId !== categoryId)
    throw new CategoryOperationUserError("Respuesta de recuperación ajena a la categoría.");
  return parsed.data;
}
