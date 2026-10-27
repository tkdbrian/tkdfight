import { useState } from "react";
import type { DemoImportPreview } from "../storage";
import type { DemoDeskState } from "../runtime/types";

const button = "min-h-11 rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-medium text-foreground hover:border-primary/60 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export interface DemoBackupProps {
  state: DemoDeskState;
  readOnly: boolean;
  exportBackup: () => Promise<string>;
  previewImport: (raw: string) => Promise<DemoImportPreview<DemoDeskState>>;
  importBackup: (preview: DemoImportPreview<DemoDeskState>) => Promise<unknown>;
  reset: () => Promise<unknown>;
  onError: (message: string) => void;
}

/** Deliberately never auto-overwrites a demo: read, inspect, then confirm. */
export function DemoBackup({ state, readOnly, exportBackup, previewImport, importBackup, reset, onError }: Readonly<DemoBackupProps>) {
  const [preview, setPreview] = useState<DemoImportPreview<DemoDeskState> | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);
  const [resetText, setResetText] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function download() {
    setBusy(true); setMessage("");
    try {
      const json = await exportBackup();
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `tkdfight-demo-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage("Respaldo descargado. Guardalo fuera del navegador.");
    } catch (error) { onError(error instanceof Error ? error.message : "No se pudo exportar el respaldo."); }
    finally { setBusy(false); }
  }

  async function inspect(file: File) {
    setBusy(true); setPreview(null); setConfirmImport(false); setMessage("");
    try { setPreview(await previewImport(await file.text())); }
    catch (error) { onError(error instanceof Error ? error.message : "El respaldo no es válido."); }
    finally { setBusy(false); }
  }

  async function applyImport() {
    if (!preview || !confirmImport) return;
    setBusy(true);
    try {
      await importBackup(preview);
      setPreview(null); setConfirmImport(false);
      setMessage("Respaldo importado. La demo anterior fue reemplazada.");
    } catch (error) { onError(error instanceof Error ? error.message : "No se pudo importar el respaldo."); }
    finally { setBusy(false); }
  }

  async function erase() {
    if (resetText !== "BORRAR") return;
    setBusy(true);
    try {
      await reset();
      setResetOpen(false); setResetText("");
      setMessage("Tu demo fue borrada de este navegador.");
    } catch (error) { onError(error instanceof Error ? error.message : "No se pudo borrar la demo."); }
    finally { setBusy(false); }
  }

  return <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-label="Respaldo y datos de la demo">
    <h2 className="text-xl font-bold">Tus datos de prueba</h2>
    <p className="mt-2 text-sm text-muted-foreground">{state.categoryOrder.length} categorías · {state.history.length} resultados confirmados. Solo existen en este perfil de navegador. Exportá un respaldo para conservarlos o pasarlos a otro dispositivo.</p>
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" disabled={busy} className={`${button} border-primary/50`} onClick={() => void download()}>Exportar respaldo</button>
      <button type="button" disabled={readOnly || busy} className={button} onClick={() => setResetOpen(!resetOpen)}>Borrar mi demo</button>
    </div>
    <label className="mt-4 block text-sm font-semibold">Importar respaldo JSON
      <input className="mt-1 block min-h-11 w-full rounded-lg border border-input bg-background p-2 text-base file:mr-3 file:rounded file:border-0 file:bg-secondary file:p-1 file:text-foreground"
        type="file" accept=".json,application/json" disabled={readOnly || busy}
        onChange={(event) => { const file = event.target.files?.[0]; if (file) void inspect(file); event.target.value = ""; }} />
    </label>
    {preview && <div className="mt-4 space-y-3 rounded-xl border border-primary/50 bg-primary/5 p-4">
      <h3 className="font-bold">Vista previa del respaldo</h3>
      <p>{preview.backup.snapshot.payload.categoryOrder.length} categorías · {preview.backup.snapshot.payload.history.length} resultados · exportado {new Date(preview.backup.exportedAt).toLocaleString("es-AR")}</p>
      <p className="text-amber-200">Importar reemplaza las {state.categoryOrder.length} categorías actuales de este navegador. No afecta a otros navegadores ni al torneo portable.</p>
      <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5 accent-primary" checked={confirmImport}
        onChange={(event) => setConfirmImport(event.target.checked)} /> Entiendo que se reemplazará mi demo actual</label>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!confirmImport || busy || readOnly}
        onClick={() => void applyImport()}>Importar y reemplazar</button>
        <button type="button" className={button} onClick={() => { setPreview(null); setConfirmImport(false); }}>Cancelar</button></div>
    </div>}
    {resetOpen && <div className="mt-4 space-y-3 rounded-xl border border-red-500 p-4">
      <h3 className="font-bold text-red-300">Borrar esta demo</h3>
      <p>Esto elimina categorías, combates, votos, resultados e historial solo de este navegador. Exportá primero si querés guardarlos.</p>
      <label className="block text-sm">Escribí BORRAR para confirmar<input className="mt-1 min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base"
        value={resetText} onChange={(event) => setResetText(event.target.value)} /></label>
      <div className="flex gap-2"><button type="button" className={`${button} border-red-400`} disabled={resetText !== "BORRAR" || busy || readOnly}
        onClick={() => void erase()}>Borrar definitivamente</button><button type="button" className={button}
        onClick={() => { setResetOpen(false); setResetText(""); }}>Cancelar</button></div>
    </div>}
    {message && <p role="status" className="mt-3 text-primary">{message}</p>}
  </section>;
}
