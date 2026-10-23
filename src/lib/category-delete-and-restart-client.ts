import {
  CategoryOperationUserError,
  categoryOperationServerMessage,
  INVALID_CATEGORY_MESSAGE,
} from "@/lib/category-operation-errors";
import {
  type CategoryDeleteAndRestartError,
  type CategoryDeleteAndRestartRequest,
  type CategoryDeleteAndRestartSuccess,
  categoryDeleteAndRestartErrorSchema,
  categoryDeleteAndRestartRequestSchema,
  categoryDeleteAndRestartSuccessSchema,
} from "@/lib/category-restart-modes-contract";

export class CategoryDeleteAndRestartRequestError extends CategoryOperationUserError {
  constructor(
    public readonly status: number,
    public readonly payload?: CategoryDeleteAndRestartError
  ) {
    super(categoryOperationServerMessage(payload?.error, status));
    this.name = "CategoryDeleteAndRestartRequestError";
  }
}

function endpoint(categoryId: string): string {
  return `/api/ring/categories/${encodeURIComponent(categoryId)}/delete-and-restart`;
}

async function readResponse(
  response: Response,
  categoryId: string
): Promise<CategoryDeleteAndRestartSuccess> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = categoryDeleteAndRestartErrorSchema.safeParse(body);
    if (!parsed.success) throw new CategoryDeleteAndRestartRequestError(response.status);
    const error = parsed.data;
    if (
      (error.categoryId && error.categoryId !== categoryId) ||
      (error.deletion &&
        (error.deletion.categoryId !== categoryId ||
          (error.requestId && error.deletion.requestId !== error.requestId)))
    ) {
      throw new CategoryOperationUserError(
        "La resolución recibida no corresponde a esta categoría. Recuperá el estado antes de reintentar."
      );
    }
    if (
      error.deletion &&
      error.error === "category_archived" &&
      (!error.archivedCategoryId ||
        !error.replacementCategoryId ||
        error.archivedCategoryId === error.replacementCategoryId)
    ) {
      throw new CategoryOperationUserError(
        "La resolución de la ejecución archivada está incompleta. Recuperá el estado antes de reintentar."
      );
    }
    if (error.deletion && error.error === "replacement_deleted" && !error.replacementDeletion) {
      throw new CategoryOperationUserError(
        "La resolución de la ejecución eliminada está incompleta. Recuperá el estado antes de reintentar."
      );
    }
    throw new CategoryDeleteAndRestartRequestError(response.status, error);
  }
  const parsed = categoryDeleteAndRestartSuccessSchema.safeParse(body);
  if (!parsed.success || parsed.data.categoryId !== categoryId)
    throw new CategoryOperationUserError(
      "Respuesta de reinicio inválida; recuperá la ejecución antes de continuar."
    );
  return parsed.data;
}

export async function requestCategoryDeleteAndRestart(
  categoryId: string,
  request: CategoryDeleteAndRestartRequest
): Promise<CategoryDeleteAndRestartSuccess> {
  if (
    !categoryDeleteAndRestartRequestSchema.safeParse(request).success ||
    request.previousSnapshot.config.id !== categoryId
  ) {
    throw new CategoryOperationUserError(INVALID_CATEGORY_MESSAGE);
  }
  const receipt = await readResponse(
    await fetch(endpoint(categoryId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
    categoryId
  );
  if (
    receipt.requestId !== request.requestId ||
    receipt.replacementCategoryId !== request.replacementSnapshot.config.id
  ) {
    throw new CategoryOperationUserError(
      "Respuesta de reinicio ajena a la solicitud; se requiere recuperación."
    );
  }
  return receipt;
}

export async function lookupCategoryDeleteAndRestart(
  categoryId: string
): Promise<CategoryDeleteAndRestartSuccess | null> {
  try {
    return await readResponse(await fetch(endpoint(categoryId), { method: "GET" }), categoryId);
  } catch (error) {
    if (
      error instanceof CategoryDeleteAndRestartRequestError &&
      error.status === 404 &&
      error.payload?.error === "replacement_not_found"
    )
      return null;
    throw error;
  }
}
