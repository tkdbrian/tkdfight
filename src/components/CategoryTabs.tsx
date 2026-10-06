import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArchiveRestore, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTournamentStore, type TournamentCategoryEntry } from "@/store/tournament";
import type { ServerState } from "@/lib/socket-types";
import { cn } from "@/lib/utils";
import { categoryTabSummary } from "@/lib/category-tab-summary";

interface CategoryTabsProps {
  connected: boolean;
  stateReady: boolean;
  serverState: ServerState;
}

export function CategoryTabs({ connected, stateReady, serverState }: CategoryTabsProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const categoryRevision = useTournamentStore((store) => store.categoryRevision);
  const activeCategoryId = useTournamentStore((store) => store.config.id);
  const activeCategoryName = useTournamentStore((store) => store.config.categoryName);
  const activeTournamentName = useTournamentStore((store) => store.config.tournamentName);
  const activeMatchType = useTournamentStore((store) => store.config.matchType);
  const activeMode = useTournamentStore((store) => store.config.mode);
  const operationReason = useTournamentStore((store) => store.categoryOperationReason);
  const [notice, setNotice] = useState("");
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const operationInProgressRef = useRef(false);
  const [isBusy, setIsBusy] = useState(false);
  const actionsDisabled = isBusy || !!operationReason;

  const store = useTournamentStore.getState();
  const entries = store.getCategoryEntries();
  const visibleCategories = entries.filter((entry) => entry.visible);
  const hiddenCategories = entries.filter((entry) => !entry.visible);
  const activeEntry = entries.find((entry) => entry.id === activeCategoryId);
  const draftEntry = entries.find((entry) => entry.id === activeCategoryId && entry.isDraft);
  const serverLock = serverState.activeMatchLock ?? (
    serverState.match && !serverState.resultConfirmed
      ? {
          fightId: serverState.match.id,
          categoryId: serverState.categoryId ?? serverState.match.categoryId ?? null,
          tournamentId: serverState.tournamentId ?? 0,
          resultStatus: null,
        }
      : null
  );
  const lockCategory = serverLock?.categoryId
    ? entries.find((entry) => entry.id === serverLock.categoryId)
    : undefined;
  const localFightRecovered = !!(
    serverLock
    && lockCategory
    && lockCategory.fightIds.includes(serverLock.fightId)
  );
  const recoveryDataMissing = !!serverLock && !localFightRecovered;

  async function runOperation(operation: () => Promise<void>) {
    if (operationInProgressRef.current || useTournamentStore.getState().categoryOperationReason) return;
    operationInProgressRef.current = true;
    setIsBusy(true);
    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo completar la operación de categoría.";
      setNotice(message);
      toast.error(message);
    } finally {
      operationInProgressRef.current = false;
      setIsBusy(false);
    }
  }

  useEffect(() => {
    if (!serverLock?.categoryId || !localFightRecovered || activeCategoryId === serverLock.categoryId) return;
    const lockedEntry = entries.find((entry) => entry.id === serverLock.categoryId);
    if (!lockedEntry) return;
    if (!lockedEntry.visible) store.reopenCategory(lockedEntry.id);
    if (store.selectCategory(lockedEntry.id)) {
      setNotice(`Se restauró la categoría ${lockedEntry.name} para continuar la recuperación del combate.`);
    }
  }, [serverLock?.categoryId, serverLock?.fightId, localFightRecovered, activeCategoryId, categoryRevision]);

  function blockedReason(targetCategoryId?: string): string | null {
    if (!connected || !stateReady) return "Esperando una respuesta del servidor para confirmar que es seguro cambiar de categoría.";
    if (operationReason) return operationReason;
    if (serverLock) {
      if (targetCategoryId === serverLock.categoryId && localFightRecovered) return null;
      const fightLabel = serverLock.fightId ? ` ${serverLock.fightId}` : "";
      if (recoveryDataMissing) {
        return `Recuperación pendiente: el servidor conserva el combate${fightLabel}, pero la llave local no contiene sus datos. No se cambió ni descartó información.`;
      }
      return `El combate de ${lockCategory?.name ?? "otra categoría"} sigue pendiente de confirmación o recuperación. Confirmalo antes de cambiar de categoría.`;
    }
    if (!store.hasValidCategoryRegistry()) return "No se pudo leer el registro local de categorías. No se sobrescribieron los datos.";
    return null;
  }

  async function activateServerCategory(entry: TournamentCategoryEntry): Promise<boolean> {
    if (serverLock && entry.id === serverLock.categoryId && localFightRecovered) return true;
    const setOperationReason = useTournamentStore.getState().setCategoryOperationReason;
    setOperationReason(`Activando ${entry.name} en el servidor…`);
    try {
      const response = await fetch("/api/ring/activate-category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: entry.id,
          categoryName: entry.name === "Nueva categoría" ? "" : entry.name,
          tournamentName: entry.tournamentName,
        }),
      });
      const result = await response.json() as { error?: string; warning?: string };
      if (!response.ok) throw new Error(result.error ?? "El servidor rechazó el cambio de categoría.");
      if (result.warning) toast.warning(result.warning);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo activar la categoría en el servidor.";
      setNotice(message);
      toast.error(message);
      return false;
    } finally {
      setOperationReason(null);
    }
  }

  async function selectEntry(entry: TournamentCategoryEntry) {
    const reason = blockedReason(entry.id);
    if (reason) {
      setNotice(reason);
      toast.warning(reason);
      return;
    }
    if (!entry.visible) {
      setNotice(`Reabrí ${entry.name} antes de seleccionarla.`);
      return;
    }
    const previousEntry = entries.find((candidate) => candidate.id === activeCategoryId);
    if (!await activateServerCategory(entry)) return;
    if (!store.selectCategory(entry.id)) {
      if (previousEntry) void fetch("/api/ring/activate-category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: previousEntry.id,
          categoryName: previousEntry.name === "Nueva categoría" ? "" : previousEntry.name,
          tournamentName: previousEntry.tournamentName,
        }),
      });
      const message = "No se pudo restaurar la categoría. El registro está dañado o no disponible; no se modificó.";
      setNotice(message);
      toast.error(message);
      return;
    }
    setNotice("");
  }

  async function createCategory() {
    const reason = blockedReason();
    if (reason) {
      setNotice(reason);
      toast.warning(reason);
      return;
    }
    const previousId = activeCategoryId;
    const categoryId = store.createCategory();
    if (!categoryId) {
      const message = "No se pudo guardar el registro de categorías. La categoría actual quedó intacta.";
      setNotice(message);
      toast.error(message);
      return;
    }
    const newEntry = store.getCategoryEntries().find((entry) => entry.id === categoryId);
    if (!newEntry || !await activateServerCategory(newEntry)) {
      store.cancelCategoryCreation(categoryId);
      const previousEntry = entries.find((entry) => entry.id === previousId);
      if (previousEntry) void fetch("/api/ring/activate-category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: previousEntry.id,
          categoryName: previousEntry.name === "Nueva categoría" ? "" : previousEntry.name,
          tournamentName: previousEntry.tournamentName,
        }),
      });
      return;
    }
    setNotice("");
    navigate("/");
  }

  async function hideCategory(entry: TournamentCategoryEntry) {
    const reason = blockedReason(entry.id === serverLock?.categoryId ? entry.id : undefined);
    if (reason) {
      setNotice(reason);
      toast.warning(reason);
      return;
    }
    if (visibleCategories.length <= 1) {
      const message = "La única categoría visible debe permanecer abierta.";
      setNotice(message);
      toast.info(message);
      return;
    }
    const fallback = entry.id === activeCategoryId
      ? visibleCategories.find((candidate) => candidate.id !== entry.id)?.id
      : undefined;
    if (fallback) {
      const fallbackEntry = entries.find((candidate) => candidate.id === fallback);
      if (!fallbackEntry || !await activateServerCategory(fallbackEntry)) return;
    }
    if (!store.hideCategory(entry.id, fallback)) {
      const message = "No se pudo ocultar la categoría; sus datos siguen guardados.";
      setNotice(message);
      toast.error(message);
      return;
    }
    setNotice("");
  }

  async function reopenCategory(entry: TournamentCategoryEntry) {
    const reason = blockedReason(entry.id === serverLock?.categoryId ? entry.id : undefined);
    if (reason) {
      setNotice(reason);
      toast.warning(reason);
      return;
    }
    if (!store.reopenCategory(entry.id)) {
      const message = "No se pudo reabrir la categoría; el registro local no está disponible.";
      setNotice(message);
      toast.error(message);
      return;
    }
    if (entry.id === serverLock?.categoryId) await selectEntry({ ...entry, visible: true });
    else setNotice("");
  }

  async function cancelDraft() {
    if (!draftEntry) return;
    const reason = blockedReason();
    if (reason) {
      setNotice(reason);
      toast.warning(reason);
      setCancelDialogOpen(false);
      return;
    }
    const returnEntry = entries.find((entry) => entry.id !== draftEntry.id && entry.visible);
    if (!returnEntry || !await activateServerCategory(returnEntry)) return;
    if (!store.cancelCategoryCreation(draftEntry.id)) {
      const message = "No se pudo cancelar el borrador. Las demás categorías permanecen intactas.";
      setNotice(message);
      toast.error(message);
      return;
    }
    setCancelDialogOpen(false);
    setNotice("");
    navigate("/");
  }

  const nameCounts = new Map<string, number>();
  for (const entry of visibleCategories) nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  const nameIndexes = new Map<string, number>();

  return (
    <>
      <section className="shrink-0 border-b border-border bg-background px-2 py-2 sm:px-4" aria-label="Categorías del torneo">
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            aria-label="Desplazar categorías a la izquierda"
            onClick={() => scrollRef.current?.scrollBy({ left: -240, behavior: "smooth" })}
            disabled={visibleCategories.length < 3 || actionsDisabled}
          >
            <ChevronLeft className="size-4" />
          </Button>

          <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:thin]">
            <div role="tablist" aria-label="Categorías" className="flex w-max min-w-full items-center gap-1">
              {visibleCategories.map((entry, index) => {
                const duplicateCount = nameCounts.get(entry.name) ?? 0;
                const duplicateIndex = (nameIndexes.get(entry.name) ?? 0) + 1;
                nameIndexes.set(entry.name, duplicateIndex);
                const label = duplicateCount > 1 ? `${entry.name} (${duplicateIndex})` : entry.name;
                const selected = entry.id === activeCategoryId;
                const tabEntry = selected ? { ...entry, tournamentName: activeTournamentName, matchType: activeMatchType, mode: activeMode } : entry;
                const tabSummary = categoryTabSummary(tabEntry);
                return (
                  <div key={entry.id} className="group flex shrink-0 items-center">
                    <button
                      id={`category-tab-${entry.id}`}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls="category-panel"
                      title={entry.tournamentName ? `${entry.tournamentName} · ${entry.name}` : entry.name}
                      onClick={() => void runOperation(() => selectEntry(entry))}
                      disabled={actionsDisabled}
                      className={cn(
                        "max-w-56 truncate border-b-2 px-3 py-2 text-left text-xs font-semibold transition-colors sm:max-w-64 sm:text-sm",
                        selected
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
                      )}
                    >
                      <span className="block truncate">{label}</span>
                      <span className="block truncate text-[10px] font-normal opacity-65">{tabSummary}</span>
                    </button>
                    {visibleCategories.length > 1 && (
                      <button
                        type="button"
                        aria-label={`Ocultar ${entry.name}`}
                        title={`Ocultar ${entry.name}`}
                        onClick={() => void runOperation(() => hideCategory(entry))}
                        disabled={actionsDisabled}
                        className="mr-1 rounded p-1 text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                    {index < visibleCategories.length - 1 && <span className="mx-0.5 h-5 border-r border-border/70" aria-hidden="true" />}
                  </div>
                );
              })}
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 shrink-0 gap-1.5 px-2 text-xs sm:px-3 sm:text-sm"
            onClick={() => void runOperation(createCategory)}
            aria-label="Agregar categoría"
            disabled={actionsDisabled}
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">Agregar categoría</span>
            <span className="sm:hidden">Agregar</span>
          </Button>

          <details className="group relative shrink-0">
            <summary
              className={cn(
                "flex h-9 cursor-pointer list-none items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground",
                hiddenCategories.length === 0 && "hidden",
              )}
              aria-label="Categorías ocultas"
            >
              <ArchiveRestore className="size-4" />
              <span className="hidden sm:inline">Ocultas</span>
              <span>{hiddenCategories.length}</span>
            </summary>
            {hiddenCategories.length > 0 && (
              <div className="absolute right-0 top-full z-50 mt-1 max-h-64 min-w-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg">
                <p className="px-2 py-1.5 text-[10px] font-semibold uppercase text-muted-foreground">Reabrir categoría</p>
                {hiddenCategories.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => void runOperation(() => reopenCategory(entry))}
                    disabled={actionsDisabled}
                    className="block w-full rounded px-2 py-2 text-left text-sm hover:bg-secondary"
                  >
                    <span className="block truncate">{entry.name}</span>
                    {entry.tournamentName && <span className="block truncate text-xs text-muted-foreground">{entry.tournamentName}</span>}
                  </button>
                ))}
              </div>
            )}
          </details>

          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            aria-label="Desplazar categorías a la derecha"
            onClick={() => scrollRef.current?.scrollBy({ left: 240, behavior: "smooth" })}
            disabled={visibleCategories.length < 3 || actionsDisabled}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        {draftEntry && (
          <div className="mt-1 flex items-center justify-between gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-xs">
            <span className="text-amber-700 dark:text-amber-300">Borrador de categoría. La categoría anterior sigue guardada.</span>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setCancelDialogOpen(true)} disabled={actionsDisabled}>
              Cancelar creación
            </Button>
          </div>
        )}

        {serverLock && !recoveryDataMissing && (
          <p role="status" className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            {serverState.match
              ? `Combate pendiente en ${lockCategory?.name ?? "una categoría"}; el cambio está bloqueado hasta confirmar.`
              : `Recuperando el combate ${serverLock.fightId} de ${lockCategory?.name ?? "la categoría"}; no se cargó automáticamente.`}
          </p>
        )}
        {recoveryDataMissing && (
          <div role="alert" className="mt-1 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <strong>Recuperación pendiente.</strong>{" "}
            {serverLock?.resultStatus === "pending_confirmation"
              ? `El servidor conserva un resultado para ${serverLock.fightId}, pero la llave local de ${serverLock.categoryId ?? "origen desconocido"} no contiene esa pelea. El resultado no se aplicó a una llave incompleta.`
              : `El servidor conserva el lock ${serverLock?.fightId ?? "sin identidad verificable"}, pero no se encontró la pelea en las llaves locales. No se descartó información.`}
          </div>
        )}
        {notice && !recoveryDataMissing && <p role="status" className="mt-1 text-xs text-amber-700 dark:text-amber-300">{notice}</p>}
        {!connected || !stateReady ? (
          <p role="status" className="mt-1 text-xs text-muted-foreground">Esperando estado del servidor; cambiar de categoría está temporalmente bloqueado.</p>
        ) : null}
        {!store.hasValidCategoryRegistry() && (
          <p role="alert" className="mt-1 text-xs text-destructive">El registro local de categorías no se pudo leer. No se sobrescribió.</p>
        )}
        <span className="sr-only" data-active-category={activeCategoryId} data-active-name={activeCategoryName}>
          Categoría activa: {activeEntry?.name ?? activeCategoryName}
        </span>
      </section>

      <Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar creación de categoría</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Se descartará solo el borrador actual. Las demás categorías, sus llaves y resultados no se modificarán.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCancelDialogOpen(false)} disabled={actionsDisabled}>Seguir editando</Button>
            <Button type="button" variant="destructive" onClick={() => void runOperation(cancelDraft)} disabled={actionsDisabled}>Descartar borrador</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}