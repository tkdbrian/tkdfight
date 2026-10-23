import { z } from "zod";
import {
  CategoryDeletionRequestError,
  lookupCategoryDeletion,
  requestCategoryDeletion,
} from "@/lib/category-deletion-client";
import {
  type CategoryDeletionPreview,
  type CategoryDeletionReceipt,
  categoryDeletionRequestSchema,
} from "@/lib/category-deletion-contract";
import { applyCanonicalDeletionObservation } from "@/lib/category-deletion-observation";
import { categoryExecutionUnavailable } from "@/lib/category-deletion-persistence";
import {
  type CategoryPrimaryActionContext,
  categoryRestartBlockedReason,
} from "@/lib/category-lifecycle";
import {
  categoryOperationErrorMessage,
  INVALID_CATEGORY_MESSAGE,
} from "@/lib/category-operation-errors";
import { categoryRestartSnapshotSchema } from "@/lib/category-restart-contract";
import {
  PENDING_CATEGORY_DELETION_KEY,
  useCategoryDeletionState,
} from "@/store/category-deletion-state";
import { categoryRestartInteractionBlocked } from "@/store/category-restart-state";
import { type TournamentCategorySnapshot, useTournamentStore } from "@/store/tournament";

const journalSchema = z.strictObject({
  categoryId: z.string().min(1),
  request: categoryDeletionRequestSchema,
});
type DeletionContext = Pick<
  CategoryPrimaryActionContext,
  "connected" | "stateReady" | "serverState"
>;

export function currentCategoryDeletionSnapshot(): TournamentCategorySnapshot {
  const state = useTournamentStore.getState();
  return {
    phase: state.phase,
    config: state.config,
    competitors: state.competitors,
    fights: state.fights,
    groups: state.groups,
    currentFightIndex: state.currentFightIndex,
    bracketMatches: state.bracketMatches,
    bracketSeeds: state.bracketSeeds,
    setupStarted: state.setupStarted,
  };
}

export function categoryDeletionSnapshotKey(snapshot: TournamentCategorySnapshot): string | null {
  const parsed = categoryRestartSnapshotSchema.safeParse(snapshot);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}

function recovery(message: string): false {
  useCategoryDeletionState.setState({ pending: false, recoveryRequired: true, message });
  return false;
}

function releaseRejectedRequest(error: unknown): boolean {
  if (
    !(error instanceof CategoryDeletionRequestError) ||
    (error.status !== 400 && error.status !== 409) ||
    ![
      "invalid_payload",
      "active_match",
      "snapshot_conflict",
      "deletion_scope_ambiguous",
      "request_id_conflict",
      "category_archived",
    ].includes(error.code ?? "")
  )
    return false;
  try {
    localStorage.removeItem(PENDING_CATEGORY_DELETION_KEY);
  } catch {
    recovery(error.message);
    return true;
  }
  useCategoryDeletionState.setState({
    pending: false,
    recoveryRequired: false,
    message: error.message,
  });
  return true;
}

function publish(receipt: CategoryDeletionReceipt, sourceCategoryId = receipt.categoryId): boolean {
  if (!applyCanonicalDeletionObservation(sourceCategoryId, receipt)) {
    return recovery(
      "La eliminación está registrada. Falta recuperar el guardado local; solo lectura."
    );
  }
  try {
    localStorage.removeItem(PENDING_CATEGORY_DELETION_KEY);
  } catch {
    return recovery("La eliminación está guardada; falta cerrar la recuperación local.");
  }
  useCategoryDeletionState.setState({
    pending: false,
    recoveryRequired: false,
    message: null,
    observed: [],
  });
  return true;
}

export async function recoverCategoryDeletion(
  retryIfMissing = false,
  context?: DeletionContext
): Promise<boolean> {
  if (useCategoryDeletionState.getState().pending) return false;
  let sourceCategoryId: string | undefined;
  try {
    const raw = localStorage.getItem(PENDING_CATEGORY_DELETION_KEY);
    if (!raw) {
      const observed = useCategoryDeletionState.getState().observed;
      if (!observed.length) return false;
      if (!useTournamentStore.getState().applyCategoryDeletions(observed)) return false;
      useCategoryDeletionState.setState({
        pending: false,
        recoveryRequired: false,
        message: null,
        observed: [],
      });
      return true;
    }
    const journal = journalSchema.parse(JSON.parse(raw));
    sourceCategoryId = journal.categoryId;
    if (journal.categoryId !== journal.request.localSnapshot.config.id)
      throw new Error("Recuperación de eliminación inválida.");
    useCategoryDeletionState.setState({
      pending: true,
      recoveryRequired: true,
      message: "Recuperando eliminación…",
    });
    const canonical = await lookupCategoryDeletion(journal.categoryId);
    if (canonical) return publish(canonical);
    if (retryIfMissing && context && !categoryRestartBlockedReason(context)) {
      return publish(await requestCategoryDeletion(journal.categoryId, journal.request));
    }
    return recovery(
      "El servidor aún no registra la eliminación. Reintentá la misma solicitud cuando el tatami esté libre."
    );
  } catch (error) {
    if (
      error instanceof CategoryDeletionRequestError &&
      error.status === 410 &&
      error.deletion &&
      sourceCategoryId &&
      (!error.categoryId || error.categoryId === sourceCategoryId)
    )
      return publish(error.deletion, sourceCategoryId);
    if (releaseRejectedRequest(error)) return false;
    return recovery(
      categoryOperationErrorMessage(
        error,
        "No se pudo recuperar la eliminación. Revisá la conexión y reintentá; los datos se conservaron."
      )
    );
  }
}

export async function beginCategoryDeletion(
  snapshot: TournamentCategorySnapshot,
  preview: CategoryDeletionPreview,
  context: DeletionContext,
  confirmationText: string
): Promise<boolean> {
  if (categoryRestartInteractionBlocked()) return false;
  const blocked = categoryRestartBlockedReason(context);
  if (blocked) {
    useCategoryDeletionState.setState({ message: blocked });
    return false;
  }
  if (
    !categoryDeletionSnapshotKey(snapshot) ||
    !categoryDeletionSnapshotKey(currentCategoryDeletionSnapshot())
  ) {
    useCategoryDeletionState.setState({ message: INVALID_CATEGORY_MESSAGE });
    return false;
  }
  if (
    categoryExecutionUnavailable(snapshot.config.id) ||
    useTournamentStore.getState().categoryOperationReason ||
    preview.categoryId !== snapshot.config.id ||
    (preview.requiresConfirmationText && confirmationText !== "ELIMINAR") ||
    categoryDeletionSnapshotKey(snapshot) !==
      categoryDeletionSnapshotKey(currentCategoryDeletionSnapshot())
  ) {
    useCategoryDeletionState.setState({
      message: "La categoría cambió o falta la confirmación exacta. Actualizá la vista previa.",
    });
    return false;
  }
  const journal = {
    categoryId: snapshot.config.id,
    request: {
      requestId: crypto.randomUUID(),
      expectedRevision: preview.revision,
      localSnapshot: structuredClone(snapshot),
    },
  };
  try {
    journalSchema.parse(journal);
    localStorage.setItem(PENDING_CATEGORY_DELETION_KEY, JSON.stringify(journal));
  } catch (error) {
    useCategoryDeletionState.setState({
      message: categoryOperationErrorMessage(
        error,
        "No se pudo preparar la eliminación. Revisá el almacenamiento local y reintentá; los datos se conservaron."
      ),
    });
    return false;
  }
  useCategoryDeletionState.setState({ pending: true, recoveryRequired: false, message: null });
  try {
    return publish(await requestCategoryDeletion(journal.categoryId, journal.request));
  } catch (error) {
    if (
      error instanceof CategoryDeletionRequestError &&
      error.status === 410 &&
      error.deletion &&
      (!error.categoryId || error.categoryId === journal.categoryId)
    )
      return publish(error.deletion, journal.categoryId);
    if (releaseRejectedRequest(error)) return false;
    useCategoryDeletionState.setState({ pending: false, recoveryRequired: true });
    return recoverCategoryDeletion();
  }
}
