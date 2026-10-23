import {
  type CategoryPrimaryActionContext,
  categoryRestartBlockedReason,
  createRestartReplacement,
} from "@/lib/category-lifecycle";
import {
  CategoryRestartRequestError,
  lookupCategoryReplacement,
  requestCategoryRestart,
} from "@/lib/category-restart-client";
import {
  type RestartCategoryRequest,
  type RestartCategorySuccess,
  restartCategoryRequestSchema,
} from "@/lib/category-restart-contract";
import {
  PENDING_CATEGORY_RESTART_KEY,
  categoryRestartInteractionBlocked,
  useCategoryRestartState,
} from "@/store/category-restart-state";
import { type TournamentCategorySnapshot, useTournamentStore } from "@/store/tournament";
import { applyCanonicalDeletionObservation } from "@/lib/category-deletion-observation";
import { categoryDeletionInteractionBlocked } from "@/store/category-deletion-state";
import { categoryOperationErrorMessage } from "@/lib/category-operation-errors";
import { type CategoryRestartDeleteOptions, beginCategoryDeleteAndRestart, recoverCategoryDeleteAndRestart } from "@/lib/category-delete-and-restart-controller";
import { pendingDeleteAndRestartSource } from "@/lib/category-restart-journal";

let pendingRequest: RestartCategoryRequest | null = null;

function resolveDeletedReplacement(error: unknown): boolean | null {
  if (!(error instanceof CategoryRestartRequestError) || error.status !== 410
    || !["category_deleted", "replacement_deleted"].includes(error.code ?? "") || !error.deletion) return null;
  const source = error.categoryId ?? pendingRequest?.categoryId;
  if (!source || !applyCanonicalDeletionObservation(source, error.deletion)) {
    return recovery("El reemplazo se eliminó. Falta guardar la resolución local; solo lectura.");
  }
  try { localStorage.removeItem(PENDING_CATEGORY_RESTART_KEY); }
  catch { return recovery("El reemplazo se eliminó; falta cerrar la recuperación local."); }
  pendingRequest = null;
  useCategoryRestartState.setState({ pending: false, recoveryRequired: false,
    message: "La ejecución está archivada y su reemplazo fue eliminado. Consultá el Historial." });
  return true;
}

function recovery(message: string): false {
  useCategoryRestartState.setState({ pending: false, recoveryRequired: true, message });
  return false;
}

function publish(success: RestartCategorySuccess): boolean {
  if (!useTournamentStore.getState().applyCategoryRestart(success)) {
    return recovery(
      "El reinicio fue registrado. Falta recuperar el guardado local; la ejecución anterior queda en solo lectura."
    );
  }
  try {
    localStorage.removeItem(PENDING_CATEGORY_RESTART_KEY);
  } catch {
    return recovery("La nueva ejecución está guardada; falta cerrar la recuperación local.");
  }
  pendingRequest = null;
  useCategoryRestartState.setState({ pending: false, recoveryRequired: false, message: null });
  return true;
}

export async function recoverCategoryRestart(retryIfMissing = false, context?: Pick<CategoryPrimaryActionContext, "connected" | "stateReady" | "serverState">): Promise<boolean> {
  if (useCategoryRestartState.getState().pending) return false;
  if (pendingDeleteAndRestartSource()) return recoverCategoryDeleteAndRestart(retryIfMissing, context);
  try {
    const raw = localStorage.getItem(PENDING_CATEGORY_RESTART_KEY);
    if (!raw && !pendingRequest) return false;
    pendingRequest ??= restartCategoryRequestSchema.parse(JSON.parse(raw ?? "null"));
    useCategoryRestartState.setState({
      pending: true,
      recoveryRequired: true,
      message: "Recuperando ejecución…",
    });
    const success = await lookupCategoryReplacement(pendingRequest.categoryId);
    if (success) return publish(success);
    if (retryIfMissing && !categoryDeletionInteractionBlocked()) return publish(await requestCategoryRestart(pendingRequest));
    return recovery(
      "El servidor aún no registra el reinicio. Reintentá con la misma solicitud cuando el tatami esté libre."
    );
  } catch (error) {
    const resolved = resolveDeletedReplacement(error);
    if (resolved !== null) return resolved;
    return recovery(categoryOperationErrorMessage(error, "No se pudo recuperar la ejecución. Revisá la conexión y reintentá; los datos se conservaron."));
  }
}

export async function beginCategoryRestart(
  snapshot: TournamentCategorySnapshot,
  context: Pick<CategoryPrimaryActionContext, "connected" | "stateReady" | "serverState">,
  options?: CategoryRestartDeleteOptions,
): Promise<boolean> {
  if (options?.mode === "delete-and-restart") return beginCategoryDeleteAndRestart(snapshot, context, options);
  if (categoryRestartInteractionBlocked()) return false;
  const blocked = categoryRestartBlockedReason(context);
  if (blocked) {
    useCategoryRestartState.setState({ message: blocked });
    return false;
  }
  let payload: RestartCategoryRequest;
  try {
    payload = {
      requestId: crypto.randomUUID(), categoryId: snapshot.config.id,
      previousSnapshot: structuredClone(snapshot), replacementSnapshot: createRestartReplacement(snapshot),
    };
    restartCategoryRequestSchema.parse(payload);
    // This recovery journal is separate from the two authoritative category keys.
    localStorage.setItem(PENDING_CATEGORY_RESTART_KEY, JSON.stringify(payload));
  } catch (error) {
    useCategoryRestartState.setState({
      message: categoryOperationErrorMessage(error, "No se pudo preparar el reinicio. Revisá el almacenamiento local y reintentá; los datos se conservaron."),
    });
    return false;
  }
  pendingRequest = payload;
  useCategoryRestartState.setState({ pending: true, recoveryRequired: false, message: null });
  try {
    return publish(await requestCategoryRestart(payload));
  } catch (error) {
    const resolved = resolveDeletedReplacement(error);
    if (resolved !== null) return resolved;
    const definitiveCodes = [
      "invalid_payload",
      "active_match",
      "snapshot_conflict",
      "request_id_conflict",
    ];
    if (
      error instanceof CategoryRestartRequestError &&
      (error.status === 400 || error.status === 409) &&
      definitiveCodes.includes(error.code ?? "")
    ) {
      // A definitive HTTP rejection committed nothing. Keep both authorities intact.
      try {
        localStorage.removeItem(PENDING_CATEGORY_RESTART_KEY);
      } catch {
        /* Next load can safely lookup. */
      }
      pendingRequest = null;
      useCategoryRestartState.setState({
        pending: false,
        recoveryRequired: false,
        message: error.message,
      });
      return false;
    }
    // A network failure/invalid ACK is indeterminate, not evidence of rollback.
    useCategoryRestartState.setState({ pending: false, recoveryRequired: true });
    return recoverCategoryRestart();
  }
}
