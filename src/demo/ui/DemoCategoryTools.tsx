import { useState } from "react";
import type { DemoDeskCommand, DemoDeskState } from "../runtime/types";

const control = "min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-base text-foreground transition-colors hover:border-primary/60 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";
const input = "min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
type ManagementAction = "archive" | "delete-and-restart" | "delete";

export function DemoCategoryTools({ state, categoryId, readOnly, dispatch }: Readonly<{
  state: DemoDeskState;
  categoryId: string;
  readOnly: boolean;
  dispatch: (command: DemoDeskCommand) => Promise<unknown>;
}>) {
  const category = state.categories[categoryId];
  const [action, setAction] = useState<ManagementAction | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [guestRed, setGuestRed] = useState("");
  const [guestBlue, setGuestBlue] = useState("");
  const [guestCategory, setGuestCategory] = useState("");
  const [guestOrigin, setGuestOrigin] = useState("Mesa local");
  const [firstSlot, setFirstSlot] = useState("");
  const [secondSlot, setSecondSlot] = useState("");
  if (!category) return null;
  const locked = readOnly || !!state.active || working;
  const canSwap = category.phase === "fighting" && category.config.mode === "elimination"
    && !state.active && !category.fights.some((fight) => fight.completed || !fight.bracketMatchId
      || fight.isTiebreakExtra || fight.isGoldenPointFight)
    && !state.history.some((entry) => entry.categoryId === categoryId);
  const initialSlots = category.bracketMatches.filter((match) => match.round === 0).flatMap((match) =>
    (["red", "blue"] as const).map((side) => ({ key: `${match.id}|${side}`,
      label: `${match.bracketGroup ? `Llave ${match.bracketGroup} · ` : ""}Ronda inicial ${match.position + 1} · ${side === "red" ? "Rojo" : "Azul"}: ${match[side].competitor?.name ?? "Libre"}` })));
  const confirmationWord = category.config.categoryName.trim() || "BORRAR";

  async function manage() {
    if (!action || confirmation !== confirmationWord || locked) return;
    setWorking(true);
    try {
      const command: DemoDeskCommand = action === "delete"
        ? { type: "category/delete", categoryId, confirm: true }
        : { type: "category/restart", categoryId, mode: action, confirm: true };
      if (await dispatch(command)) { setAction(null); setConfirmation(""); }
    } finally { setWorking(false); }
  }

  return <details className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-label="Herramientas de categoría">
    <summary className="min-h-11 cursor-pointer text-lg font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Herramientas de la categoría <span className="text-sm font-normal text-muted-foreground">(opcional)</span></summary>
    <div className="mt-3 grid gap-3 lg:grid-cols-2">
      {canSwap && <details className="rounded-xl border border-border bg-background p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Cambiar posiciones de la llave</summary>
        <p className="mt-2 text-sm text-muted-foreground">Solo antes de cargar o terminar la primera pelea. Puede cambiar los IDs de combates aún no usados.</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-sm">Primera posición<select className={`${input} mt-1`} value={firstSlot} disabled={locked}
            onChange={(event) => setFirstSlot(event.target.value)}><option value="">Seleccionar</option>
            {initialSlots.map((slot) => <option key={slot.key} value={slot.key}>{slot.label}</option>)}</select></label>
          <label className="text-sm">Segunda posición<select className={`${input} mt-1`} value={secondSlot} disabled={locked}
            onChange={(event) => setSecondSlot(event.target.value)}><option value="">Seleccionar</option>
            {initialSlots.map((slot) => <option key={slot.key} value={slot.key}>{slot.label}</option>)}</select></label>
        </div>
        <button type="button" className={`${control} mt-2`} disabled={locked || !firstSlot || !secondSlot || firstSlot === secondSlot}
          onClick={() => {
            const [aMatchId, aSlot] = firstSlot.split("|") as [string, "red" | "blue"];
            const [bMatchId, bSlot] = secondSlot.split("|") as [string, "red" | "blue"];
            void dispatch({ type: "category/swapBracketSlots", categoryId, aMatchId, aSlot, bMatchId, bSlot });
          }}>Intercambiar posiciones</button>
      </details>}
      {category.phase === "fighting" && <details className="rounded-xl border border-border bg-background p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Combate invitado local</summary>
        <p className="mt-2 text-sm text-muted-foreground">Exhibición fuera de la clasificación. No conecta con Mesa Central ni con otro tatami.</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-sm">Rojo<input className={`${input} mt-1`} disabled={locked} value={guestRed} onChange={(event) => setGuestRed(event.target.value)} /></label>
          <label className="text-sm">Azul<input className={`${input} mt-1`} disabled={locked} value={guestBlue} onChange={(event) => setGuestBlue(event.target.value)} /></label>
          <label className="text-sm">Nombre de la exhibición<input className={`${input} mt-1`} disabled={locked} value={guestCategory} onChange={(event) => setGuestCategory(event.target.value)} /></label>
          <label className="text-sm">Origen<input className={`${input} mt-1`} disabled={locked} value={guestOrigin} onChange={(event) => setGuestOrigin(event.target.value)} /></label>
        </div>
        <button type="button" className={`${control} mt-2`} disabled={locked || !guestRed.trim() || !guestBlue.trim() || !guestCategory.trim() || !guestOrigin.trim()}
          onClick={async () => {
            setWorking(true);
            try { if (await dispatch({ type: "category/addGuestFight", categoryId, redName: guestRed,
              blueName: guestBlue, categoryName: guestCategory, originRing: guestOrigin })) {
              setGuestRed(""); setGuestBlue(""); setGuestCategory("");
            } } finally { setWorking(false); }
          }}>Agregar exhibición</button>
      </details>}
    </div>
    <details className="mt-3 rounded-xl border border-red-900/70 bg-background p-3">
      <summary className="min-h-11 cursor-pointer py-2 font-semibold text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Reiniciar, archivar o borrar categoría</summary>
      <p className="mt-2 text-sm text-muted-foreground">Estas acciones son solo de esta demo. Exportá un respaldo antes de borrar resultados.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={locked} className={control} onClick={() => { setAction("archive"); setConfirmation(""); }}>Archivar y crear otra ejecución</button>
        <button type="button" disabled={locked} className={control} onClick={() => { setAction("delete-and-restart"); setConfirmation(""); }}>Reiniciar sin conservar resultados</button>
        <button type="button" disabled={locked} className={`${control} border-red-700 text-red-200`} onClick={() => { setAction("delete"); setConfirmation(""); }}>Borrar categoría</button>
      </div>
      {action && <div className="mt-3 space-y-2 rounded-lg border border-red-600 p-3">
        <p role="alert" className="text-red-100">{action === "archive"
          ? "Se guardará la ejecución anterior en el archivo local y se creará un borrador nuevo."
          : action === "delete-and-restart"
            ? "Se eliminarán los resultados de esta categoría y se creará un borrador nuevo."
            : "Se eliminarán esta categoría y todos sus resultados locales."}</p>
        <label className="block text-sm">Escribí exactamente «{confirmationWord}» para confirmar
          <input className={`${input} mt-1`} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <div className="flex flex-wrap gap-2"><button type="button" disabled={locked || confirmation !== confirmationWord}
          className={`${control} border-red-500`} onClick={() => void manage()}>Confirmar acción</button>
          <button type="button" className={control} onClick={() => { setAction(null); setConfirmation(""); }}>Cancelar</button></div>
      </div>}
      {Object.keys(state.archives).length > 0 && <p className="mt-2 text-sm text-muted-foreground">Ejecuciones archivadas en este navegador: {Object.keys(state.archives).length}. Incluidas en el respaldo JSON.</p>}
    </details>
  </details>;
}
