import {
  type RestartCategoryRequest,
  type RestartCategorySuccess,
  restartCategoryRequestSchema,
  restartCategorySuccessSchema,
} from "@/lib/category-restart-contract";
import { type CategoryDeletionReceipt, categoryDeletionErrorSchema } from "@/lib/category-deletion-contract";
import { CategoryOperationUserError, INVALID_CATEGORY_MESSAGE, categoryOperationServerMessage } from "@/lib/category-operation-errors";

export class CategoryRestartRequestError extends CategoryOperationUserError {
  constructor(
    _message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly deletion?: CategoryDeletionReceipt,
    public readonly categoryId?: string,
  ) {
    super(categoryOperationServerMessage(code, status));
    this.name = "CategoryRestartRequestError";
  }
}

async function readSuccess(response: Response): Promise<RestartCategorySuccess> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const terminal = categoryDeletionErrorSchema.safeParse(body);
    if (response.status === 410 && terminal.success) {
      throw new CategoryRestartRequestError(terminal.data.message, response.status,
        terminal.data.error, terminal.data.deletion, terminal.data.categoryId);
    }
    const error =
      body && typeof body === "object" ? (body as { message?: unknown; error?: unknown }) : null;
    throw new CategoryRestartRequestError(
      typeof error?.message === "string" ? error.message : `HTTP ${response.status}`,
      response.status,
      typeof error?.error === "string" ? error.error : undefined
    );
  }
  const parsed = restartCategorySuccessSchema.safeParse(body);
  if (!parsed.success)
    throw new CategoryOperationUserError("Respuesta de reinicio inválida; recuperá la ejecución antes de continuar.");
  return parsed.data;
}

export async function requestCategoryRestart(
  payload: RestartCategoryRequest
): Promise<RestartCategorySuccess> {
  if (!restartCategoryRequestSchema.safeParse(payload).success) throw new CategoryOperationUserError(INVALID_CATEGORY_MESSAGE);
  const success = await readSuccess(
    await fetch("/api/ring/restart-category", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
  if (success.categoryId !== payload.categoryId || success.requestId !== payload.requestId) {
    throw new CategoryOperationUserError("Respuesta de reinicio ajena a la solicitud; se requiere recuperación.");
  }
  return success;
}

export async function lookupCategoryReplacement(
  categoryId: string
): Promise<RestartCategorySuccess | null> {
  const response = await fetch(
    `/api/ring/categories/${encodeURIComponent(categoryId)}/replacement`,
    { method: "GET" }
  );
  if (response.status === 404) return null;
  const success = await readSuccess(response);
  if (success.categoryId !== categoryId)
    throw new CategoryOperationUserError("Respuesta de recuperación ajena a la categoría.");
  return success;
}
