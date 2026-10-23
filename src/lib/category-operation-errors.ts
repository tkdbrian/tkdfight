import { ZodError } from "zod";

export const INVALID_CATEGORY_MESSAGE =
  "La configuración de la categoría no es válida. Revisá las reglas y los datos antes de reintentar. Los datos se conservaron.";
export const UNCONFIRMED_CATEGORY_MESSAGE =
  "No se pudo confirmar la operación. Recuperá el estado del servidor antes de reintentar.";

/** Only application-authored messages may cross an unknown-error boundary. */
export class CategoryOperationUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CategoryOperationUserError";
  }
}

export function categoryOperationDisplayMessage(
  message: string | null | undefined,
  fallback = INVALID_CATEGORY_MESSAGE
): string | null {
  if (!message) return null;
  if (
    message.length > 220 ||
    /^\s*[[{]/.test(message) ||
    /invalid_union|unrecognized_keys|invalid_type|ZodError|"(?:issues|errors|code|path)"\s*:/i.test(
      message
    )
  )
    return fallback;
  return message;
}

export function categoryOperationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ZodError) return INVALID_CATEGORY_MESSAGE;
  if (error instanceof CategoryOperationUserError)
    return categoryOperationDisplayMessage(error.message, fallback) ?? fallback;
  return fallback;
}

export function categoryOperationServerMessage(code: string | undefined, status: number): string {
  switch (code) {
    case "invalid_payload":
      return INVALID_CATEGORY_MESSAGE;
    case "active_match":
      return "Tatami ocupado. Confirmá y cerrá el combate cargado antes de continuar.";
    case "snapshot_conflict":
      return "Los datos de la categoría cambiaron. Actualizá el estado y volvé a intentarlo.";
    case "request_id_conflict":
      return "La solicitud no coincide con la operación registrada. Recuperá el estado antes de reintentar.";
    case "category_archived":
      return "Esta ejecución ya está archivada. Consultá el Historial.";
    case "category_deleted":
    case "replacement_deleted":
      return "Esta ejecución o su reemplazo fue eliminado definitivamente. Consultá el Historial.";
    case "deletion_scope_ambiguous":
      return "No se pudo comprobar qué datos pertenecen a esta ejecución. No se eliminó información. Revisá su origen.";
    case "deletion_not_found":
      return "El servidor aún no registra una eliminación para esta categoría.";
    default:
      return status >= 500
        ? UNCONFIRMED_CATEGORY_MESSAGE
        : "El servidor rechazó la operación. Revisá los datos y actualizá el estado antes de reintentar.";
  }
}
