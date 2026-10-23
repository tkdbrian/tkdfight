import { useEffect, useId, useRef, useState } from "react";
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
  categoryDeletionSnapshotKey,
  currentCategoryDeletionSnapshot,
} from "@/lib/category-deletion-controller";
import {
  type CategoryPrimaryActionContext,
  categoryRestartBlockedReason,
} from "@/lib/category-lifecycle";
import { beginCategoryRestart, recoverCategoryRestart } from "@/lib/category-restart-controller";
import {
  categoryRestartInteractionBlocked,
  useCategoryRestartState,
} from "@/store/category-restart-state";
import { useCategoryDeletionState } from "@/store/category-deletion-state";
import {
  INVALID_CATEGORY_MESSAGE,
  categoryOperationDisplayMessage,
  categoryOperationErrorMessage,
} from "@/lib/category-operation-errors";
import type { TournamentCategorySnapshot } from "@/store/tournament";

type RestartMode = "archive" | "delete-and-restart";
interface PreparedRestart {
  snapshot: TournamentCategorySnapshot;
  key: string;
  preview: CategoryDeletionPreview;
}

export function CategoryRestartButton(context: CategoryPrimaryActionContext): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RestartMode>("archive");
  const [prepared, setPrepared] = useState<PreparedRestart | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmationId = useId();
  const modeName = useId();
  const previewSequence = useRef(0);
  const latest = useRef({ context, mode });
  latest.current = { context, mode };
  const { pending, recoveryRequired, message } = useCategoryRestartState(
    useShallow((state) => ({
      pending: state.pending,
      recoveryRequired: state.recoveryRequired,
      message: state.message,
    }))
  );
  const blocked = categoryRestartBlockedReason(context);
  const friendlyMessage = categoryOperationDisplayMessage(error ?? message);
  const deletionBlocked = useCategoryDeletionState(
    (state) => state.pending || state.recoveryRequired
  );
  const disabled = Boolean(blocked) || pending || recoveryRequired || deletionBlocked;
  const stale = prepared !== null && prepared.key !== categoryDeletionSnapshotKey(context.snapshot);
  function closeDialog(): void {
    previewSequence.current++;
    setOpen(false);
  }
  async function loadPreview(): Promise<void> {
    const current = latest.current;
    if (categoryRestartInteractionBlocked() || categoryRestartBlockedReason(current.context))
      return;
    const snapshot = structuredClone(currentCategoryDeletionSnapshot());
    const key = categoryDeletionSnapshotKey(snapshot);
    if (!key || snapshot.config.id !== current.context.snapshot.config.id) {
      setError(INVALID_CATEGORY_MESSAGE);
      return;
    }
    const sequence = ++previewSequence.current;
    setPrepared(null);
    setText("");
    setError(null);
    setLoading(true);
    try {
      const preview = await previewCategoryDeletion(snapshot);
      if (sequence !== previewSequence.current || latest.current.mode !== "delete-and-restart")
        return;
      if (
        categoryRestartInteractionBlocked() ||
        categoryRestartBlockedReason(latest.current.context) ||
        latest.current.context.snapshot.config.id !== snapshot.config.id ||
        categoryDeletionSnapshotKey(currentCategoryDeletionSnapshot()) !== key
      ) {
        setError(
          "La categoría o la conexión cambió. Actualizá la vista previa antes de reiniciar."
        );
        return;
      }
      setPrepared({ snapshot, key, preview });
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
  function chooseMode(next: RestartMode): void {
    if (useCategoryRestartState.getState().pending) return;
    previewSequence.current++;
    latest.current = { context: latest.current.context, mode: next };
    setMode(next);
    setPrepared(null);
    setText("");
    setError(null);
    setLoading(false);
    if (next === "delete-and-restart") void loadPreview();
  }
  useEffect(() => {
    if (useCategoryRestartState.getState().recoveryRequired) void recoverCategoryRestart();
  }, []);
  const completed = context.snapshot.fights.filter((fight) => fight.completed).length;
  const completedMatches = context.snapshot.bracketMatches.filter(
    (match) => match.completed
  ).length;
  return (
    <div className="space-y-1 max-w-sm">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => {
          chooseMode("archive");
          setOpen(true);
        }}
        data-testid="restart-category"
      >
        Reiniciar categoría…
      </Button>
      {(blocked || friendlyMessage) && (
        <p role="status" className="text-xs text-muted-foreground">
          {friendlyMessage ?? blocked}
        </p>
      )}
      {recoveryRequired && (
        <Button
          variant="outline"
          size="sm"
          disabled={pending || Boolean(blocked) || deletionBlocked}
          onClick={() => void recoverCategoryRestart(true, latest.current.context)}
          data-testid="recover-category-restart"
        >
          {pending ? "Recuperando…" : "Recuperar reinicio"}
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) {
            if (next) setOpen(true);
            else closeDialog();
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Reiniciar {context.snapshot.config.categoryName || "categoría"}
            </DialogTitle>
          </DialogHeader>
          <p>
            {completed} de {context.snapshot.fights.length} combates completados; {completedMatches}{" "}
            encuentros de llave completados.
          </p>
          <fieldset disabled={pending} className="space-y-2 text-sm">
            <legend>Destino de la ejecución actual</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={modeName}
                checked={mode === "archive"}
                onChange={() => chooseMode("archive")}
              />
              Archivar y reiniciar
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={modeName}
                checked={mode === "delete-and-restart"}
                onChange={() => chooseMode("delete-and-restart")}
              />
              Eliminar y reiniciar
            </label>
          </fieldset>
          <DialogDescription>
            {mode === "archive" ? (
              <>
                Se archivará la ejecución actual y se creará otra desde cero. Se conservarán los
                competidores, la configuración y el historial.
              </>
            ) : (
              <>
                Se eliminará definitivamente solo esta ejecución y se creará otra desde cero. Se
                conservarán los competidores, la configuración y los archivos anteriores.
              </>
            )}
          </DialogDescription>
          {mode === "delete-and-restart" && (
            <>
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
                <p role="alert">
                  La categoría cambió. Actualizá la vista previa antes de reiniciar.
                </p>
              )}
              {(stale || error) && (
                <Button
                  variant="outline"
                  disabled={disabled || loading}
                  onClick={() => void loadPreview()}
                >
                  Actualizar vista previa
                </Button>
              )}
            </>
          )}
          {friendlyMessage && <p role="alert">{friendlyMessage}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={closeDialog}>
              Cancelar
            </Button>
            <Button
              variant={mode === "archive" ? "default" : "destructive"}
              disabled={
                disabled ||
                (mode === "delete-and-restart" &&
                  (loading ||
                    !prepared ||
                    stale ||
                    (prepared.preview.requiresConfirmationText && text !== "ELIMINAR")))
              }
              onClick={async () => {
                const current = latest.current;
                if (
                  categoryRestartInteractionBlocked() ||
                  categoryRestartBlockedReason(current.context)
                )
                  return;
                const options =
                  current.mode === "delete-and-restart" && prepared
                    ? {
                        mode: "delete-and-restart" as const,
                        preview: prepared.preview,
                        confirmationText: text,
                      }
                    : undefined;
                if (current.mode === "delete-and-restart" && !options) return;
                if (
                  await beginCategoryRestart(
                    options && prepared ? prepared.snapshot : current.context.snapshot,
                    current.context,
                    options
                  )
                )
                  closeDialog();
              }}
            >
              {mode === "archive"
                ? pending
                  ? "Archivando…"
                  : "Archivar y reiniciar"
                : pending
                  ? "Eliminando y reiniciando…"
                  : "Eliminar y reiniciar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
