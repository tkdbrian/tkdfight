import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { previewCategoryDeletion } from "@/lib/category-deletion-client";
import type { CategoryDeletionPreview } from "@/lib/category-deletion-contract";
import {
  beginCategoryDeletion,
  categoryDeletionSnapshotKey,
  currentCategoryDeletionSnapshot,
} from "@/lib/category-deletion-controller";
import { categoryExecutionUnavailable } from "@/lib/category-deletion-persistence";
import {
  type CategoryPrimaryActionContext,
  categoryRestartBlockedReason,
} from "@/lib/category-lifecycle";
import {
  CategoryOperationUserError,
  categoryOperationDisplayMessage,
  categoryOperationErrorMessage,
  INVALID_CATEGORY_MESSAGE,
} from "@/lib/category-operation-errors";
import { useCategoryDeletionState } from "@/store/category-deletion-state";
import {
  categoryRestartInteractionBlocked,
  useCategoryRestartState,
} from "@/store/category-restart-state";
import type { TournamentCategorySnapshot } from "@/store/tournament";

interface PreparedDeletion {
  preview: CategoryDeletionPreview;
  snapshot: TournamentCategorySnapshot;
  key: string;
}

export function CategoryDeleteButton(context: CategoryPrimaryActionContext): React.JSX.Element {
  const confirmationId = useId();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [prepared, setPrepared] = useState<PreparedDeletion | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const previewSequence = useRef(0);
  const { pending, recoveryRequired, message } = useCategoryDeletionState(
    useShallow((state) => ({
      pending: state.pending,
      recoveryRequired: state.recoveryRequired,
      message: state.message,
    }))
  );
  const restartBlocked = useCategoryRestartState(
    (state) => state.pending || state.recoveryRequired
  );
  const blocked = categoryRestartBlockedReason(context)?.replaceAll("reiniciar", "eliminar");
  const unavailable = categoryExecutionUnavailable(context.snapshot.config.id);
  const currentKey = categoryDeletionSnapshotKey(context.snapshot);
  const invalidSnapshot = currentKey === null;
  const stale = prepared !== null && prepared.key !== currentKey;
  const friendlyMessage = categoryOperationDisplayMessage(error ?? message);
  const disabled =
    Boolean(blocked) ||
    pending ||
    recoveryRequired ||
    restartBlocked ||
    unavailable ||
    invalidSnapshot;

  async function loadPreview(): Promise<void> {
    if (categoryRestartInteractionBlocked() || blocked || unavailable) return;
    const snapshot = structuredClone(currentCategoryDeletionSnapshot());
    if (snapshot.config.id !== context.snapshot.config.id) return;
    const sequence = ++previewSequence.current;
    setOpen(true);
    setLoading(true);
    setPrepared(null);
    setText("");
    setError(null);
    try {
      const preview = await previewCategoryDeletion(snapshot);
      if (
        sequence !== previewSequence.current ||
        currentCategoryDeletionSnapshot().config.id !== snapshot.config.id
      )
        return;
      const key = categoryDeletionSnapshotKey(snapshot);
      if (!key) throw new CategoryOperationUserError(INVALID_CATEGORY_MESSAGE);
      setPrepared({ preview, snapshot, key });
    } catch (failure) {
      if (sequence === previewSequence.current)
        setError(
          categoryOperationErrorMessage(
            failure,
            "No se pudo verificar el alcance. Revisá la conexión y actualizá la vista previa."
          )
        );
    } finally {
      if (sequence === previewSequence.current) setLoading(false);
    }
  }

  return (
    <div className="max-w-sm text-sm">
      <div className="mt-2 space-y-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={disabled}
          onClick={() => void loadPreview()}
        >
          Eliminar categoría…
        </Button>
        {blocked && <p className="text-xs text-muted-foreground">{blocked}</p>}
        {invalidSnapshot && !open && <p role="status">{INVALID_CATEGORY_MESSAGE}</p>}
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) {
            setOpen(next);
            if (!next) previewSequence.current++;
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Eliminar{" "}
              {prepared?.snapshot.config.categoryName ||
                context.snapshot.config.categoryName ||
                "categoría"}{" "}
              definitivamente
            </DialogTitle>
            <DialogDescription>
              Se eliminará solo esta ejecución y su historial operativo. Las demás categorías y los
              archivos anteriores se conservarán. Esta acción no se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          {loading && <p role="status">Verificando alcance con el servidor…</p>}
          {prepared && (
            <div className="space-y-2 text-sm">
              <p>
                {prepared.preview.counts.competitors} competidores ·{" "}
                {prepared.preview.counts.fights} combates ·{" "}
                {prepared.preview.counts.completedFights} completados ·{" "}
                {prepared.preview.counts.confirmedResults} resultados confirmados ·{" "}
                {prepared.preview.counts.localOnlyFights} combates solo locales.
              </p>
              {prepared.preview.warnings.map((warning) => (
                <p role="note" key={warning}>
                  {warning}
                </p>
              ))}
              {prepared.preview.requiresConfirmationText && (
                <label htmlFor={confirmationId} className="block space-y-1">
                  <span>Escribí ELIMINAR</span>
                  <Input
                    id={confirmationId}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    disabled={pending}
                    autoComplete="off"
                  />
                </label>
              )}
            </div>
          )}
          {stale && (
            <p role="alert">La categoría cambió. Actualizá la vista previa antes de eliminar.</p>
          )}
          {invalidSnapshot && <p role="alert">{INVALID_CATEGORY_MESSAGE}</p>}
          {friendlyMessage && <p role="alert">{friendlyMessage}</p>}
          {(stale || error) && (
            <Button
              type="button"
              variant="outline"
              disabled={disabled || loading}
              onClick={() => void loadPreview()}
            >
              Actualizar vista previa
            </Button>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                previewSequence.current++;
                setOpen(false);
              }}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={
                disabled ||
                loading ||
                !prepared ||
                stale ||
                (prepared.preview.requiresConfirmationText && text !== "ELIMINAR")
              }
              onClick={async () => {
                if (
                  prepared &&
                  (await beginCategoryDeletion(prepared.snapshot, prepared.preview, context, text))
                ) {
                  setOpen(false);
                  toast.success("Categoría eliminada definitivamente");
                }
              }}
            >
              {pending ? "Eliminando…" : "Eliminar definitivamente"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
