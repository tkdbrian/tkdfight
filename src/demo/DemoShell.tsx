import { useCallback, useEffect, useRef, useState } from "react";
import { DatabaseBackup, History, Info, ListOrdered, Swords, Trophy, Users } from "lucide-react";
import { createBrowserDeskRuntime, makeDemoCommandId } from "./runtime";
import type { DemoDeskCommand } from "./runtime/types";
import { requestDemoStoragePersistence } from "./storage";
import { DemoBackup } from "./ui/DemoBackup";
import { DemoSetup, purgeDemoPendingDrafts, type DemoCategoryNavigationRequest } from "./ui/DemoSetup";
import { DemoCategoryStrip } from "./ui/DemoCategoryStrip";
import { DemoStandings } from "./ui/DemoStandings";
import { DemoFight } from "./ui/DemoFight";

type OfflineState = "preparing" | "ready" | "unavailable" | "failed";
const DEMO_WORKER_PATH = "/demo-sw.js";
const DEMO_CACHE_PREFIX = "tkd-browser-demo-precache";
const OFFLINE_READY_TIMEOUT_MS = 15_000;
export const DEMO_SHELL_ASSET_PATH = new URL(import.meta.url).pathname;
function essentialAssetPaths(): string[] {
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href], link[rel="manifest"][href]');
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]');
  return [
    "/index.html", DEMO_SHELL_ASSET_PATH,
    ...[...links].map((link) => new URL(link.href).pathname),
    ...[...scripts].map((script) => new URL(script.src).pathname),
  ];
}
type Runtime = ReturnType<typeof createBrowserDeskRuntime>;
type View = Awaited<ReturnType<Runtime["read"]>>;
type Tab = "setup" | "fight" | "standings" | "history" | "data";
const button = "min-h-11 rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/60 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const navigationGroups: { label: string; items: { key: Tab; label: string; short: string; icon: typeof Users }[] }[] = [
  { label: "Preparación", items: [{ key: "setup", label: "Competidores", short: "Compet.", icon: Users }] },
  { label: "Torneo", items: [
    { key: "fight", label: "Combate", short: "Combate", icon: Swords },
    { key: "standings", label: "Clasificación", short: "Tabla", icon: ListOrdered },
  ] },
  { label: "Análisis", items: [{ key: "history", label: "Historial", short: "Hist.", icon: History }] },
  { label: "Datos locales", items: [{ key: "data", label: "Respaldo", short: "Respaldo", icon: DatabaseBackup }] },
];
let retainedRuntime: Runtime | null = null;
let runtimeUsers = 0;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingClose: Promise<void> | null = null;

function retainRuntime(): Runtime {
  if (closeTimer !== null) { clearTimeout(closeTimer); closeTimer = null; }
  retainedRuntime ??= createBrowserDeskRuntime();
  runtimeUsers++;
  return retainedRuntime;
}

function releaseRuntime(instance: Runtime): void {
  runtimeUsers = Math.max(0, runtimeUsers - 1);
  if (runtimeUsers !== 0) return;
  // StrictMode replays the effect immediately; avoid racing two writer leases.
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (runtimeUsers !== 0 || retainedRuntime !== instance) return;
    retainedRuntime = null;
    const closing = instance.close().catch(() => {});
    pendingClose = closing;
    void closing.finally(() => { if (pendingClose === closing) pendingClose = null; });
  }, 0);
}

export function DemoShell() {
  const runtime = useRef<Runtime | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(new Set<string>());
  const viewRef = useRef<View | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("setup");
  const [persistenceStatus, setPersistenceStatus] = useState<"idle" | "requesting" | "granted" | "denied" | "unsupported">("idle");
  const [offlineState, setOfflineState] = useState<OfflineState>("preparing");
  const [offlineRetry, setOfflineRetry] = useState(0);
  const [categoryBusy, setCategoryBusy] = useState(false);
  const categoryBusyRef = useRef(false);
  const setupCategoryNavigation = useRef<((request: DemoCategoryNavigationRequest) => Promise<boolean>) | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: offlineRetry is an intentional user-triggered rerun, not a value consumed by the effect.
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("caches" in window)) { setOfflineState("unavailable"); return; }
    const worker = navigator.serviceWorker;
    let mounted = true;
    setOfflineState("preparing");
    const checkPrecache = async (): Promise<boolean> => {
      const registration = await worker.getRegistration(location.href);
      const controller = worker.controller;
      if (!controller || new URL(controller.scriptURL).pathname !== DEMO_WORKER_PATH || !registration ||
          new URL(registration.scope).pathname.replace(/\/$/, "") !== "/demo" ||
          registration.active !== controller || registration.installing || registration.waiting) return false;
      const names = await caches.keys();
      const cachedPaths = new Set<string>();
      for (const name of names.filter((value) => value.startsWith(DEMO_CACHE_PREFIX))) {
        const entries = await (await caches.open(name)).keys();
        for (const entry of entries) cachedPaths.add(new URL(entry.url).pathname);
      }
      return essentialAssetPaths().every((path) => cachedPaths.has(path));
    };
    const start = async () => {
      const deadline = Date.now() + OFFLINE_READY_TIMEOUT_MS;
      try {
        // An already controlled offline reload needs no network registration.
        if (await checkPrecache()) { if (mounted) setOfflineState("ready"); return; }
        // Register here, not in the shared HTML: failures are visible and retryable.
        let registerTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            worker.register(DEMO_WORKER_PATH, { scope: "/demo/" }),
            new Promise<never>((_, reject) => {
              registerTimeout = setTimeout(() => reject(new Error("offline registration timeout")), OFFLINE_READY_TIMEOUT_MS);
            }),
          ]);
        } finally { clearTimeout(registerTimeout); }
        while (mounted && Date.now() < deadline) {
          if (await checkPrecache()) { setOfflineState("ready"); return; }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (mounted) setOfflineState("failed");
      } catch {
        if (mounted) setOfflineState("failed");
      }
    };
    void start();
    return () => { mounted = false; };
  }, [offlineRetry]);

  const updateView = useCallback((next: View) => {
    const current = viewRef.current;
    if (current && (next.generation < current.generation
      || (next.generation === current.generation && next.revision < current.revision))) return;
    if (!current) {
      if (next) purgeDemoPendingDrafts(next.generation);
    } else if (current.generation !== next.generation) {
      pending.current.clear();
      purgeDemoPendingDrafts();
    }
    viewRef.current = next;
    setView(next);
  }, []);

  useEffect(() => {
    let live = true;
    const instance = retainRuntime();
    runtime.current = instance;
    const unsubscribe = instance.subscribe((next) => { if (live) updateView(next); });
    void Promise.resolve(pendingClose).then(() => instance.open()).then((opened) => { if (live) updateView(opened); }, (cause: unknown) => {
      if (live) setError(cause instanceof Error ? cause.message : "No se pudo abrir la demo local.");
    });
    return () => { live = false; unsubscribe(); runtime.current = null; releaseRuntime(instance); };
  }, [updateView]);

  const dispatch = useCallback((command: DemoDeskCommand, commandId?: string): Promise<unknown> => {
    const instance = runtime.current;
    if (!instance) return Promise.reject(new Error("La demo todavía se está abriendo."));
    const generation = viewRef.current?.generation;
    if (generation === undefined) return Promise.reject(new Error("La demo todavía se está abriendo."));
    // Capture the generation now, not when this queued action eventually reaches storage.
    const actionId = commandId ?? makeDemoCommandId(generation);
    const lock = ["category/create", "category/start", "category/addCompetitor", "category/addGuestFight",
      "category/delete", "category/restart", "category/swapBracketSlots", "category/prepareNext",
      "category/preparePlayoff", "category/prepareFinal", "fight/load", "fight/confirmResult"].includes(command.type)
      ? `${generation}:${JSON.stringify(command)}` : "";
    if (lock && pending.current.has(lock)) return Promise.resolve(null);
    if (lock) pending.current.add(lock);
    const result = queue.current.then(async () => {
      const next = await instance.dispatch(command, actionId);
      updateView(next); setError(""); return next;
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar el cambio.");
      return null;
    }).finally(() => { if (lock) pending.current.delete(lock); });
    queue.current = result.catch(() => {});
    return result;
  }, [updateView]);

  const dataAction = useCallback(async <T,>(action: (instance: Runtime) => Promise<T>): Promise<T> => {
    const instance = runtime.current;
    if (!instance) throw new Error("La demo todavía se está abriendo.");
    const result = await action(instance);
    updateView(await instance.read());
    setError(""); return result;
  }, [updateView]);

  const registerCategoryNavigation = useCallback((handler: ((request: DemoCategoryNavigationRequest) => Promise<boolean>) | null) => {
    setupCategoryNavigation.current = handler;
  }, []);

  const navigateCategory = useCallback(async (request: DemoCategoryNavigationRequest) => {
    const current = viewRef.current;
    if (!current?.isWriter || categoryBusyRef.current) return;
    categoryBusyRef.current = true;
    setCategoryBusy(true);
    try {
      // An open setup editor must validate and finish its draft before navigation.
      const handler = setupCategoryNavigation.current;
      const saved = handler ? await handler(request)
        : tab === "setup" ? false : Boolean(await dispatch(request.kind === "create"
          ? { type: "category/create" } : { type: "category/select", categoryId: request.categoryId }));
      if (!saved) return;
      if (request.kind === "create") setTab("setup");
      else if (tab === "fight" && request.categoryId !== current.state.selectedCategoryId) setTab("standings");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cambiar de categoría.");
    } finally {
      categoryBusyRef.current = false;
      setCategoryBusy(false);
    }
  }, [dispatch, tab]);

  const conserveDemo = useCallback(async () => {
    setPersistenceStatus("requesting");
    setPersistenceStatus(await requestDemoStoragePersistence());
  }, []);

  const selectedCategory = view?.state.selectedCategoryId
    ? view.state.categories[view.state.selectedCategoryId] : null;
  const selectedCategoryIndex = view?.state.selectedCategoryId
    ? view.state.categoryOrder.indexOf(view.state.selectedCategoryId) : -1;
  const selectedCategoryName = selectedCategory?.config.categoryName
    || (selectedCategoryIndex >= 0 ? `Categoría ${selectedCategoryIndex + 1}` : "Sin categoría");
  const offlineMessage = offlineState === "ready" ? "Archivos de la app listos para abrir sin conexión en este navegador."
    : offlineState === "unavailable" ? "Este navegador no ofrece almacenamiento de la app para uso sin conexión."
      : offlineState === "failed" ? "No está lista para uso sin conexión; sigue disponible online. Comprobá la conexión y probá otra vez."
        : "Preparando archivos para uso sin conexión. Mantené esta página abierta con Internet.";
  const offlineShort = offlineState === "ready" ? "Offline listo"
    : offlineState === "preparing" ? "Preparando offline" : "Offline no disponible";
  const offlineTone = offlineState === "ready" ? "border-emerald-700/60 text-emerald-300"
    : offlineState === "preparing" ? "border-border text-muted-foreground" : "border-amber-700/60 text-amber-300";

  return <div className="flex h-[100dvh] min-w-0 flex-col overflow-hidden bg-background text-foreground md:block print:block print:h-auto print:overflow-visible">
    <header className="relative z-30 flex min-h-14 shrink-0 flex-col border-b border-border bg-background px-3 pt-[env(safe-area-inset-top,0px)] md:fixed md:left-0 md:top-0 md:h-14 md:w-56 md:justify-center md:border-r md:px-4 md:pt-0 print:hidden">
      <div className="flex min-h-11 w-full items-center gap-2 md:min-h-0">
        <Trophy aria-hidden="true" className="size-4 shrink-0 text-primary md:size-5" />
        <span className="text-sm font-bold uppercase tracking-wide">TKD Fight</span>
        <span className="ml-auto rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary md:hidden">LOCAL</span>
        <span role="status" aria-live="polite" title={offlineMessage}
          className={`flex min-h-8 shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] font-semibold md:hidden ${offlineTone}`}>
          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
          <span aria-hidden="true">{offlineShort}</span><span className="sr-only">{offlineMessage}</span>
        </span>
        <span className="ml-auto hidden rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary md:inline">LOCAL</span>
      </div>
      <p className="line-clamp-2 min-w-0 break-words px-1 pb-1 text-xs leading-snug text-muted-foreground md:hidden" title={selectedCategoryName}>{selectedCategoryName}</p>
    </header>

    {view && <nav aria-label="Secciones de la mesa" className="fixed inset-x-0 bottom-0 z-30 flex min-h-14 items-stretch border-t border-border bg-background pb-[env(safe-area-inset-bottom,0px)] md:inset-x-auto md:bottom-0 md:left-0 md:top-14 md:w-56 md:flex-col md:items-stretch md:gap-0.5 md:overflow-y-auto md:border-r md:border-t-0 md:px-2 md:py-3 print:hidden">
      <p className="mx-1 mb-2 hidden truncate rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground md:block" title={selectedCategoryName}>{selectedCategoryName}</p>
      {navigationGroups.map((group, groupIndex) => <div key={group.label} className="contents md:block">
        {groupIndex > 0 && <div className="mx-1 my-2 hidden border-t border-border md:block" />}
        <p className="hidden px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 md:block">{group.label}</p>
        <div className="contents md:block md:space-y-0.5">{group.items.map(({ key, label, short, icon: Icon }) => {
          const displayLabel = key === "fight" && selectedCategory?.config.matchType === "tul" ? "Formas"
            : key === "standings" && selectedCategory?.config.mode === "elimination" ? "Llave" : label;
          const displayShort = key === "fight" && selectedCategory?.config.matchType === "tul" ? "Formas"
            : key === "standings" && selectedCategory?.config.mode === "elimination" ? "Llave" : short;
          return <button key={key} type="button" aria-label={displayLabel}
            aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}
            className={`relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-muted-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary md:min-h-11 md:w-full md:flex-none md:flex-row md:justify-start md:gap-3 md:px-3 md:text-sm md:font-medium ${tab === key ? "text-primary md:bg-accent md:text-accent-foreground" : "hover:bg-secondary hover:text-foreground"}`}>
            <Icon aria-hidden="true" className={`size-5 shrink-0 ${tab === key ? "stroke-[2.5]" : ""}`} />
            <span className="max-w-full truncate px-0.5 text-[10px] font-medium leading-none md:text-sm md:leading-normal"><span className="md:hidden">{displayShort}</span><span className="hidden md:inline">{displayLabel}</span></span>
          </button>;
        })}</div>
      </div>)}
      <p className="mt-auto hidden border-t border-border px-3 pt-3 text-xs leading-relaxed text-muted-foreground md:block">
        <span role="status" aria-live="polite" className={offlineTone}>{offlineMessage}</span><br />Mesa individual · datos en este navegador
      </p>
    </nav>}

    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:h-[100dvh] md:pl-56 print:block print:h-auto print:overflow-visible print:pl-0">
      {view && <DemoCategoryStrip state={view.state} readOnly={!view.isWriter} busy={categoryBusy}
        onSelect={(categoryId) => { void navigateCategory({ kind: "select", categoryId }); }}
        onCreate={() => { void navigateCategory({ kind: "create" }); }} />}
      <main id="demo-category-panel" className={tab === "fight"
        ? "min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto px-0 pb-[calc(5rem+env(safe-area-inset-bottom,0px))] md:flex md:flex-col md:overflow-hidden md:pb-0 print:overflow-visible print:pb-0"
        : "mx-auto min-h-0 min-w-0 w-full max-w-7xl flex-1 space-y-4 overflow-y-auto px-3 py-4 pb-[calc(5rem+env(safe-area-inset-bottom,0px))] sm:px-6 md:py-6 md:pb-6 print:max-w-none print:overflow-visible print:px-0 print:py-0"}>
        <h1 className="sr-only">Mesa de prueba</h1>
        {(offlineState === "failed" || offlineState === "unavailable") && <details role="alert"
          className="mx-3 shrink-0 rounded-lg border border-amber-700/60 bg-amber-950/20 text-sm text-amber-200 print:hidden">
          <summary className="flex min-h-11 cursor-pointer items-center px-3 py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Sin uso offline; seguí online <span className="ml-2 text-xs underline">Detalles</span>
          </summary>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-amber-700/40 px-3 py-3">
            <span>{offlineMessage}</span>
            {offlineState === "failed" && <button type="button" className={button} onClick={() => setOfflineRetry((value) => value + 1)}>
              Reintentar descarga sin conexión
            </button>}
          </div>
        </details>}

        {view && !view.isWriter && <p role="alert" className="rounded-lg border border-amber-500 bg-amber-950/30 p-3 text-amber-200">
          Otra pestaña de este navegador opera esta demo. Esta pestaña es de solo lectura; cerrá la otra y recargá para tomar el control.
        </p>}
        {typeof indexedDB === "undefined" && <p className="rounded-lg border border-amber-500 p-3 text-amber-200" role="alert">Este navegador no admite IndexedDB; la mesa local no podrá guardar el torneo.</p>}
        {error && <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-foreground">
          <p className="font-bold">La demo no pudo completar la operación.</p><p>{error}</p>
          <p className="mt-1 text-sm text-muted-foreground">No borraremos datos automáticamente. Si el almacenamiento está lleno, exportá un respaldo antes de continuar.</p>
        </div>}
        {!view ? <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-xl font-bold">{error ? "Demo local no disponible" : "Abriendo demo local…"}</h2>
          <p className="mt-2 text-muted-foreground">No se consulta el servidor para cargar categorías o combates.</p>
        </section> : <>
          {tab === "setup" && <DemoSetup key={view.generation} state={view.state} generation={view.generation}
            readOnly={!view.isWriter} dispatch={dispatch} onFight={() => setTab("fight")}
            registerCategoryNavigation={registerCategoryNavigation} />}
          {tab === "fight" && <DemoFight key={view.generation} view={view} dispatch={dispatch} />}
          {tab === "standings" && <DemoStandings state={view.state} categoryId={view.state.selectedCategoryId} />}
          {tab === "history" && <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-bold">Historial local</h2>
              <button type="button" className={button} onClick={() => window.print()}>Imprimir</button></div>
            {view.state.history.length ? <ol className="mt-3 space-y-2">{view.state.history.map((entry) => <li key={entry.id} className="rounded-lg border border-border bg-secondary/20 p-3">
              <p className="text-sm text-muted-foreground">{new Date(entry.confirmedAt).toLocaleString("es-AR")} · {view.state.categories[entry.categoryId]?.config.categoryName
                ?? view.state.archives[entry.categoryId]?.config.categoryName ?? "Categoría archivada"}</p>
              <p className="text-lg font-semibold"><span className="text-red-400">{entry.red.name}</span> vs <span className="text-blue-400">{entry.blue.name}</span></p>
              <p>Ganador: {entry.winner === "draw" ? "Empate" : entry.winner === "red" ? entry.red.name : entry.blue.name} · {entry.reason}</p>
            </li>)}</ol> : <p className="mt-3 text-muted-foreground">Todavía no hay resultados confirmados en este navegador.</p>}
          </section>}
          {tab === "data" && <>
            <details className="rounded-lg border border-border bg-secondary/20 text-sm print:hidden">
              <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Info aria-hidden="true" className="size-4 shrink-0 text-primary" /> Demo individual · datos solo en este navegador
              </summary>
              <div className="space-y-3 border-t border-border px-3 py-3 text-muted-foreground">
                <p>Tus categorías, peleas y resultados no se mezclan con los de otra persona. No uses esta demo como único respaldo de un torneo real.</p>
                <p>En iPhone, abrí esta página en Safari y agregala a la pantalla de inicio. El navegador integrado de WhatsApp no garantiza el uso sin conexión.</p>
                <button type="button" className={button} disabled={persistenceStatus === "requesting"}
                  onClick={() => void conserveDemo()}>Conservar demo en este navegador</button>
                {persistenceStatus !== "idle" && <p role="status" className="text-sm">
                  {persistenceStatus === "requesting" ? "Solicitando almacenamiento persistente al navegador…"
                    : persistenceStatus === "granted" ? "El navegador aceptó conservar los datos locales. Exportá respaldos igualmente."
                      : persistenceStatus === "denied" ? "El navegador no garantizó conservar los datos. Exportá un respaldo para evitar pérdidas."
                        : "Este navegador no ofrece una solicitud de almacenamiento persistente. Exportá respaldos regularmente."}
                </p>}
              </div>
            </details>
            <DemoBackup key={view.generation} state={view.state} readOnly={!view.isWriter}
              exportBackup={() => dataAction((instance) => instance.exportBackup())}
              previewImport={(raw) => dataAction((instance) => instance.previewImport(raw))}
              importBackup={(preview) => dataAction((instance) => instance.importBackup(preview, { confirmOverwrite: true }))}
              reset={() => dataAction((instance) => instance.reset({ confirm: true }))} onError={setError} />
          </>}
        </>}
      </main>
    </div>
  </div>;
}
