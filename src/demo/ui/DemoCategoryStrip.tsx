import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DemoDeskState } from "../runtime/types";

export interface DemoCategoryStripProps {
  state: DemoDeskState;
  readOnly: boolean;
  busy: boolean;
  onSelect: (categoryId: string) => void;
  onCreate: () => void;
}

/** The original desk's category strip, driven only by the browser-local authority. */
export function DemoCategoryStrip({ state, readOnly, busy, onSelect, onCreate }: Readonly<DemoCategoryStripProps>) {
  const visibleIds = state.categoryOrder.filter((id) => Boolean(state.categories[id]));
  if (!visibleIds.length) return null;
  const names = visibleIds.map((id, index) => state.categories[id]?.config.categoryName || `Categoría ${index + 1}`);
  const nameCounts = new Map<string, number>();
  for (const name of names) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const duplicateIndexes = new Map<string, number>();

  return <section aria-label="Categorías del torneo" className="min-w-0 shrink-0 border-b border-border bg-background px-2 py-2 sm:px-4 print:hidden">
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:thin]">
        <div role="tablist" aria-label="Categorías" className="flex w-max min-w-full items-center gap-1"
          onKeyDown={(event) => {
            if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
            if (!tabs.length) return;
            const activeIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
            const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
              : event.key === "ArrowRight" ? (activeIndex + 1) % tabs.length
                : (activeIndex - 1 + tabs.length) % tabs.length;
            event.preventDefault();
            tabs[nextIndex]?.focus();
          }}>
          {visibleIds.map((id, index) => {
            const category = state.categories[id];
            const name = names[index];
            const duplicateIndex = (duplicateIndexes.get(name) ?? 0) + 1;
            duplicateIndexes.set(name, duplicateIndex);
            const label = (nameCounts.get(name) ?? 0) > 1 ? `${name} (${duplicateIndex})` : name;
            const selected = id === state.selectedCategoryId;
            const summary = `${category.config.matchType === "tul" ? "Tul" : "Lucha"} · ${category.config.mode === "elimination" ? "Eliminación" : "Round Robin"}`;
            return <div key={id} className="flex shrink-0 items-center">
              <button type="button" role="tab" aria-selected={selected} aria-controls="demo-category-panel"
                title={name} disabled={readOnly || busy} onClick={() => onSelect(id)}
                className={`min-h-11 max-w-[min(60vw,14rem)] border-b-2 px-3 py-2 text-left text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary disabled:opacity-50 sm:max-w-64 sm:text-sm ${selected
                  ? "border-primary bg-primary/10 text-primary" : "border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground"}`}>
                <span className={selected ? "block break-words leading-snug" : "block truncate"}>{label}</span>
                <span className="block truncate text-[10px] font-normal opacity-65">{summary}</span>
              </button>
              {index < visibleIds.length - 1 && <span className="mx-0.5 h-5 border-r border-border/70" aria-hidden="true" />}
            </div>;
          })}
        </div>
      </div>
      <Button type="button" size="sm" variant="outline" aria-label="Agregar categoría"
        className="h-11 min-w-11 shrink-0 gap-1.5 px-2 text-xs sm:min-w-0 sm:px-3 sm:text-sm"
        disabled={readOnly || busy} onClick={onCreate}>
        <Plus aria-hidden="true" className="size-4" />
        <span className="hidden sm:inline">Agregar categoría</span><span className="sm:hidden">Agregar</span>
      </Button>
    </div>
  </section>;
}
