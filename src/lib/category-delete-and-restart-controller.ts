import {
  CategoryDeleteAndRestartRequestError,
  lookupCategoryDeleteAndRestart,
  requestCategoryDeleteAndRestart,
} from "@/lib/category-delete-and-restart-client";
import type { CategoryDeletionPreview } from "@/lib/category-deletion-contract";
import {
  categoryDeletionSnapshotKey,
  currentCategoryDeletionSnapshot,
} from "@/lib/category-deletion-controller";
import { categoryExecutionDeleted } from "@/lib/category-deletion-persistence";
import {
  type CategoryPrimaryActionContext,
  categoryRestartBlockedReason,
  createRestartReplacement,
} from "@/lib/category-lifecycle";
import {
  categoryOperationErrorMessage,
  INVALID_CATEGORY_MESSAGE,
} from "@/lib/category-operation-errors";
import {
  type DeleteAndRestartJournal,
  parseCategoryRestartJournal,
} from "@/lib/category-restart-journal";
import {
  type CategoryDeleteAndRestartSuccess,
  categoryDeleteAndRestartRequestSchema,
} from "@/lib/category-restart-modes-contract";
import {
  categoryDeletionInteractionBlocked,
  PENDING_CATEGORY_DELETION_KEY,
  useCategoryDeletionState,
} from "@/store/category-deletion-state";
import {
  categoryRestartInteractionBlocked,
  PENDING_CATEGORY_RESTART_KEY,
  useCategoryRestartState,
} from "@/store/category-restart-state";
import { type TournamentCategorySnapshot, useTournamentStore } from "@/store/tournament";

type RestartContext = Pick<
  CategoryPrimaryActionContext,
  "connected" | "stateReady" | "serverState"
>;
export interface CategoryRestartDeleteOptions {
  mode: "delete-and-restart";
  preview: CategoryDeletionPreview;
  confirmationText: string;
}

function recovery(message: string): false {
  useCategoryRestartState.setState({ pending: false, recoveryRequired: true, message });
  return false;
}

function finish(message: string | null): boolean {
  try {
    localStorage.removeItem(PENDING_CATEGORY_RESTART_KEY);
  } catch {
    return recovery(
      "El reinicio está registrado; falta cerrar la recuperación local. Solo lectura."
    );
  }
  const deletionState = useCategoryDeletionState.getState();
  if (
    !localStorage.getItem(PENDING_CATEGORY_DELETION_KEY) &&
    deletionState.observed.length &&
    deletionState.observed.every((marker) => categoryExecutionDeleted(marker.categoryId))
  ) {
    useCategoryDeletionState.setState({
      pending: false,
      recoveryRequired: false,
      message: null,
      observed: [],
    });
  }
  useCategoryRestartState.setState({
    pending: false,
    recoveryRequired: false,
    message,
    pendingDeleteAndRestartSourceId: null,
  });
  return true;
}

function publish(receipt: CategoryDeleteAndRestartSuccess): boolean {
  if (!useTournamentStore.getState().applyCategoryDeleteAndRestart(receipt))
    return recovery("El reinicio fue registrado. Falta recuperar el guardado local; solo lectura.");
  return finish(null);
}

function settleError(journal: DeleteAndRestartJournal, error: unknown): boolean | null {
  if (!(error instanceof CategoryDeleteAndRestartRequestError)) return null;
  const payload = error.payload;
  if (payload?.deletion) {
    if (
      payload.categoryId !== journal.categoryId ||
      payload.deletion.categoryId !== journal.categoryId
    )
      return null;
    if (!["category_archived", "replacement_deleted", "category_deleted"].includes(payload.error))
      return null;
    const initialId =
      payload.error === "replacement_deleted" && payload.replacementCategoryId
        ? payload.replacementCategoryId
        : payload.requestId === journal.request.requestId
          ? journal.request.replacementSnapshot.config.id
          : payload.archivedCategoryId;
    if (!initialId) return null;
    if (!useTournamentStore.getState().resolveCommittedCategoryRestart(payload, initialId))
      return recovery("La ejecución ya cambió. Falta guardar su resolución local; solo lectura.");
    return finish(
      "La ejecución actual se eliminó y su reemplazo ya cambió. Consultá el Historial; no se restauró una ejecución anterior."
    );
  }
  if (
    (error.status === 400 || error.status === 409) &&
    payload &&
    [
      "invalid_payload",
      "active_match",
      "snapshot_conflict",
      "deletion_scope_ambiguous",
      "request_id_conflict",
      "category_archived",
    ].includes(payload.error)
  ) {
    if (!finish(error.message)) return false;
    return false;
  }
  return null;
}

export async function recoverCategoryDeleteAndRestart(
  retryIfMissing = false,
  context?: RestartContext
): Promise<boolean> {
  if (useCategoryRestartState.getState().pending) return false;
  let journal: DeleteAndRestartJournal | null = null;
  try {
    const raw = localStorage.getItem(PENDING_CATEGORY_RESTART_KEY);
    if (!raw) return false;
    const parsed = parseCategoryRestartJournal(raw);
    if (parsed.mode !== "delete-and-restart") return false;
    journal = parsed;
    useCategoryRestartState.setState({
      pending: true,
      recoveryRequired: true,
      pendingDeleteAndRestartSourceId: journal.categoryId,
      message: "Recuperando reinicio…",
    });
    const receipt = await lookupCategoryDeleteAndRestart(journal.categoryId);
    if (receipt) return publish(receipt);
    if (
      retryIfMissing &&
      context &&
      !categoryRestartBlockedReason(context) &&
      !categoryDeletionInteractionBlocked()
    ) {
      return publish(await requestCategoryDeleteAndRestart(journal.categoryId, journal.request));
    }
    return recovery(
      "El servidor aún no registra el reinicio. Reintentá la misma solicitud cuando el tatami esté libre."
    );
  } catch (error) {
    if (journal) {
      const resolved = settleError(journal, error);
      if (resolved !== null) return resolved;
    }
    return recovery(
      categoryOperationErrorMessage(
        error,
        "No se pudo recuperar el reinicio. Revisá la conexión y reintentá; los datos se conservaron."
      )
    );
  }
}

export async function beginCategoryDeleteAndRestart(
  snapshot: TournamentCategorySnapshot,
  context: RestartContext,
  options: CategoryRestartDeleteOptions
): Promise<boolean> {
  if (categoryRestartInteractionBlocked()) return false;
  const blocked = categoryRestartBlockedReason(context);
  if (blocked) {
    useCategoryRestartState.setState({ message: blocked });
    return false;
  }
  const key = categoryDeletionSnapshotKey(snapshot);
  if (!key) {
    useCategoryRestartState.setState({ message: INVALID_CATEGORY_MESSAGE });
    return false;
  }
  if (
    key !== categoryDeletionSnapshotKey(currentCategoryDeletionSnapshot()) ||
    options.preview.categoryId !== snapshot.config.id ||
    (options.preview.requiresConfirmationText && options.confirmationText !== "ELIMINAR")
  ) {
    useCategoryRestartState.setState({
      message: "La categoría cambió o falta la confirmación exacta. Actualizá la vista previa.",
    });
    return false;
  }
  let journal: DeleteAndRestartJournal;
  try {
    journal = {
      mode: "delete-and-restart",
      categoryId: snapshot.config.id,
      request: {
        requestId: crypto.randomUUID(),
        expectedRevision: options.preview.revision,
        previousSnapshot: structuredClone(snapshot),
        replacementSnapshot: createRestartReplacement(snapshot),
      },
    };
    categoryDeleteAndRestartRequestSchema.parse(journal.request);
    localStorage.setItem(PENDING_CATEGORY_RESTART_KEY, JSON.stringify(journal));
  } catch (error) {
    useCategoryRestartState.setState({
      message: categoryOperationErrorMessage(
        error,
        "No se pudo preparar el reinicio. Revisá el almacenamiento local y reintentá."
      ),
    });
    return false;
  }
  useCategoryRestartState.setState({
    pending: true,
    recoveryRequired: false,
    message: null,
    pendingDeleteAndRestartSourceId: journal.categoryId,
  });
  try {
    return publish(await requestCategoryDeleteAndRestart(journal.categoryId, journal.request));
  } catch (error) {
    const resolved = settleError(journal, error);
    if (resolved !== null) return resolved;
    useCategoryRestartState.setState({ pending: false, recoveryRequired: true });
    return recoverCategoryDeleteAndRestart();
  }
}
