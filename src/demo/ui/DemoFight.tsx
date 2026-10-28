import { useCallback, useEffect, useRef, useState } from "react";
import { hasPreFightActivity, tallyFlagWinner } from "@/engine/desk-operations";
import { computeJudgeTotalsForMatch, computePenaltyCountsForMatch } from "@/engine/judge-totals";
import { getSanctionCount } from "@/engine/match-machine";
import { makeDemoCommandId } from "@/demo/storage";
import { getDemoCategoryOutcome, getDemoPendingFights, getDemoRestAdvisory, getDemoRoundRobinActions } from "../runtime/selectors";
import type { DeskRuntimeView } from "../runtime/browser-runtime";
import type { DemoActiveMatch, DemoDeskCommand } from "../runtime/types";

export interface DemoFightProps {
  view: DeskRuntimeView;
  /** Forward commandId unchanged to the runtime so a lost reply cannot apply twice. */
  dispatch: (command: DemoDeskCommand, commandId?: string) => Promise<unknown>;
}

const buttonBase = "min-h-11 rounded-lg border px-4 py-2 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";
const button = `${buttonBase} border-border bg-secondary text-secondary-foreground hover:bg-accent`;
const danger = `${buttonBase} border-red-700 bg-red-950 text-red-100 hover:bg-red-900`;
const mainButton = `${buttonBase} border-green-600 bg-green-700 py-4 text-lg font-bold text-white hover:bg-green-600`;
const card = "rounded-xl border border-border bg-card p-4 sm:p-5";
const arena = "grid min-w-0 shrink-0 grid-cols-2 border-b border-border md:min-h-[55vh] md:shrink md:flex-1 md:grid-cols-[minmax(0,1fr)_minmax(18rem,30%)_minmax(0,1fr)] md:overflow-hidden";
const compactVoteButton = "flex min-h-11 min-w-0 flex-col items-center justify-center rounded-lg border px-0.5 py-1 text-[11px] font-semibold leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm";
type Side = "red" | "blue";
type Vote = Side | "draw";

function formatTime(seconds: number): string {
  return `${Math.floor(Math.max(0, seconds) / 60).toString().padStart(2, "0")}:${(Math.max(0, seconds) % 60).toString().padStart(2, "0")}`;
}

function phaseLabel(active: DemoActiveMatch, tul: boolean): string {
  if (active.state.result) return "Resultado pendiente de confirmación";
  if (tul) return active.tulPhase === "voting" ? "Votación de Tul" : "Tul listo";
  if (active.state.phase === "golden_point") return `Punto de Oro · intento ${active.state.goldenPoint?.attempt ?? 1}`;
  if (active.state.phase === "idle") return "Antes del combate";
  if (active.state.phase === "round") return `Round ${active.state.currentRound} de ${active.rules.rounds.count}${active.paused ? " · pausado" : " · en curso"}`;
  if (active.state.phase === "overtime") return active.paused ? "Desempate pausado" : "Desempate en curso";
  if (active.state.phase === "rest") return `Round ${active.state.currentRound} finalizado`;
  if (active.state.phase === "penalties") return "Sanciones pendientes de confirmar";
  return "Combate finalizado";
}

function voteName(vote: Vote): string { return vote === "draw" ? "Empate" : vote === "red" ? "Rojo" : "Azul"; }

function ColorStation({ side, name, score }: Readonly<{ side: Side; name: string; score: number }>) {
  const red = side === "red";
  return <div data-testid={`demo-${side}-station`} className={`flex min-h-40 min-w-0 flex-col items-center justify-center gap-1.5 px-2 py-3 text-center md:min-h-0 md:gap-5 md:px-4 md:py-5 ${red
    ? "order-2 border-r border-red-900/40 bg-red-950/50 md:order-1"
    : "order-3 bg-blue-950/50 md:order-3 md:border-l md:border-blue-900/40"}`}>
    <span className={`text-[11px] font-bold uppercase tracking-widest md:hidden ${red ? "text-red-300" : "text-blue-300"}`}>{red ? "Rojo" : "Azul"}</span>
    <p className={`w-full text-base font-black uppercase leading-tight [overflow-wrap:anywhere] md:text-xl lg:text-3xl ${red ? "text-red-200 md:text-red-400" : "text-blue-200 md:text-blue-400"}`}>{name}</p>
    <p className={`max-w-full font-black leading-none tabular-nums text-[clamp(3.25rem,16vw,5rem)] md:rounded-2xl md:px-[clamp(1.5rem,3vw,3.5rem)] md:py-[clamp(1rem,2vh,2rem)] md:text-[clamp(4rem,11vh,10rem)] ${red
      ? "text-red-400 md:bg-red-950/30 md:ring-1 md:ring-red-900/40"
      : "text-blue-400 md:bg-blue-950/30 md:ring-1 md:ring-blue-900/40"}`}>{score}</p>
  </div>;
}

export function DemoFight({ view, dispatch }: Readonly<DemoFightProps>) {
  const { state } = view;
  const categoryId = state.selectedCategoryId;
  const category = categoryId ? state.categories[categoryId] : undefined;
  const active = state.active;
  const selected = category?.fights[category.currentFightIndex];
  const pending = categoryId ? getDemoPendingFights(state, categoryId) : [];
  const selectedPending = selected && pending.some((fight) => fight.id === selected.id) ? selected : pending[0];
  const advisory = categoryId && selectedPending && !active
    ? getDemoRestAdvisory(state, categoryId, selectedPending.id) : { kind: "none" } as const;
  const lastResult = categoryId ? [...state.history].reverse().find((item) => item.categoryId === categoryId) : undefined;
  const advisoryKey = `${categoryId}:${selectedPending?.id}:${lastResult?.id ?? "none"}`;
  const [restOverride, setRestOverride] = useState("");
  const [judge, setJudge] = useState("J1");
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [clockFault, setClockFault] = useState(false);
  const busy = useRef<string | null>(null);
  const retry = useRef<{ key: string; id: string } | null>(null);
  const latest = useRef({ active, writer: view.isWriter, categoryId, generation: view.generation });
  latest.current = { active, writer: view.isWriter, categoryId, generation: view.generation };
  const previousGeneration = useRef(view.generation);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const pauseRequested = useRef(false);

  useEffect(() => {
    if (previousGeneration.current === view.generation) return;
    previousGeneration.current = view.generation;
    // Old in-flight requests retain their old IDs and will be fenced by storage.
    // A new explicit click is a new action, never a retag of that old request.
    retry.current = null;
    busy.current = null;
    setPendingAction("");
    setClockFault(false);
    setActionError("La demo se reinició o importó. Revisá el estado actualizado antes de repetir una acción.");
  }, [view.generation]);

  const run = useCallback(async (command: DemoDeskCommand, label: string): Promise<boolean> => {
    if (!view.isWriter || busy.current) return false;
    const generation = view.generation;
    const key = JSON.stringify(command);
    const reusable = retry.current?.key === key && retry.current.id.startsWith(`g${generation}:`);
    const commandId = reusable && retry.current ? retry.current.id : makeDemoCommandId(generation);
    retry.current = { key, id: commandId };
    busy.current = commandId;
    if (command.type !== "fight/tick") { setPendingAction(label); setActionError(""); }
    try {
      const result = await dispatch(command, commandId);
      if (latest.current.generation !== generation) return false;
      // DemoShell returns null if it already displayed the exact runtime error.
      if (result === null) {
        setActionError("No se aplicó el cambio. Revisá el mensaje de error y reintentá si corresponde.");
        return false;
      }
      if (retry.current?.id === commandId) retry.current = null;
      return true;
    } catch (error) {
      if (latest.current.generation === generation)
        setActionError(error instanceof Error ? error.message : "No se pudo completar la operación. Reintentá.");
      return false;
    } finally {
      if (busy.current === commandId) {
        busy.current = null;
        if (command.type !== "fight/tick") setPendingAction("");
      }
    }
  }, [dispatch, view.isWriter, view.generation]);

  // A browser-hidden or unmounted desk must never claim a running clock. The persisted
  // clock is authoritative, not Date.now(), and reopening the runtime also pauses it.
  useEffect(() => {
    const stopIfRunning = () => {
      const current = latest.current;
      if (!current.writer || !current.active || current.active.paused || pauseRequested.current
        || !["round", "overtime"].includes(current.active.state.phase)) return;
      pauseRequested.current = true;
      const command: DemoDeskCommand = { type: "fight/pause", categoryId: current.active.categoryId,
        fightId: current.active.fightId, loadId: current.active.loadId };
      void dispatchRef.current(command, makeDemoCommandId(current.generation)).catch(() => { pauseRequested.current = false; });
    };
    const onVisibility = () => { if (document.hidden) stopIfRunning(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); stopIfRunning(); };
  }, []);

  const clockKey = active && !active.paused && ["round", "overtime"].includes(active.state.phase)
    ? `${view.generation}:${active.loadId}:${active.state.phase}` : null;
  useEffect(() => {
    if (!clockKey) {
      pauseRequested.current = false;
      return;
    }
    if (!view.isWriter || clockFault) return;
    const id = window.setInterval(() => {
      const current = latest.current.active;
      if (document.hidden || busy.current || !current || current.paused || pauseRequested.current
        || !["round", "overtime"].includes(current.state.phase)) return;
      const generation = view.generation;
      void run({ type: "fight/tick", categoryId: current.categoryId, fightId: current.fightId,
        loadId: current.loadId }, "Actualizando reloj").then((ok) => {
        if (!ok && latest.current.generation === generation) {
          setClockFault(true);
          setActionError("El reloj dejó de actualizarse. Pausá y revisá el estado guardado antes de continuar.");
        }
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [clockKey, view.isWriter, view.generation, clockFault, run]);

  const disabled = !view.isWriter || Boolean(pendingAction);
  const context = { categoryId: active?.categoryId ?? categoryId ?? "", fightId: active?.fightId ?? "", loadId: active?.loadId ?? "" };
  const send = (command: DemoDeskCommand, label: string) => { void run(command, label); };
  const sendActive = (type: DemoDeskCommand["type"], label: string) => {
    if (!active) return;
    send({ type, ...context } as DemoDeskCommand, label);
  };
  const tul = category?.config.matchType === "tul";
  const mode = active?.rules.judgingMode ?? "flags";
  const currentFight = category?.fights.find((fight) => fight.id === active?.fightId);
  const canSwap = Boolean(active && !tul && !currentFight?.isGoldenPointFight && !currentFight?.isTiebreakExtra
    && !currentFight?.continuationStage && !active.started && !active.paused
    && !hasPreFightActivity(active.state, active.rules, active.roundFlags, active.judgeVotes));
  const canPostpone = Boolean(active && !active.started && !active.paused
    && !hasPreFightActivity(active.state, active.rules, active.roundFlags, active.judgeVotes));
  const assignmentsMatch = Boolean(active && currentFight?.red.id === active.red.id && currentFight?.blue.id === active.blue.id);
  const judges = active ? Array.from({ length: active.rules.judgesCount }, (_, index) => `J${index + 1}`) : [];
  const totals = computeJudgeTotalsForMatch(active?.state ?? null);
  const score = active?.state.rounds.reduce((sum, round) => ({ red: sum.red + round.totals.red,
    blue: sum.blue + round.totals.blue }), { red: 0, blue: 0 }) ?? { red: 0, blue: 0 };
  const roundWins = active?.roundFlags.reduce((sum, flags) => ({ red: sum.red + Number(flags.winner === "red"),
    blue: sum.blue + Number(flags.winner === "blue") }), { red: 0, blue: 0 }) ?? { red: 0, blue: 0 };
  const provisional = tallyFlagWinner(active?.judgeVotes ?? {}, active?.rules.judgesCount ?? 0);
  const allVoted = judges.every((id) => Boolean(active?.judgeVotes[id]));
  const penalties = computePenaltyCountsForMatch(active?.state ?? null);
  const outcome = categoryId ? getDemoCategoryOutcome(state, categoryId) : null;
  const rrActions = categoryId ? getDemoRoundRobinActions(state, categoryId) : { playoffs: [], canPrepareFinal: false };
  const pointEntries = Object.entries(active?.rules.points ?? {});
  const pointEvents = pointEntries.some(([key]) => !key.startsWith("pts_"))
    ? pointEntries.filter(([key]) => !key.startsWith("pts_")) : pointEntries;
  const canSkipToFlags = Boolean(active && !tul && mode === "flags" && !currentFight?.isGoldenPointFight
    && (active.state.phase === "idle" || (active.state.phase === "rest"
      && active.state.currentRound < active.rules.rounds.count)) && assignmentsMatch);
  const canReset = Boolean(active && !active.state.result && (
    ["round", "rest", "overtime", "penalties"].includes(active.state.phase)
    || active.state.pendingJuryDecision || active.tulPhase === "voting"
    || Object.keys(active.state.goldenPoint?.votes ?? {}).length
    || active.roundFlags.length || Object.keys(active.judgeVotes).length
    || active.state.rounds.some((round) => round.events.length)));

  if (!category || !categoryId) return <section className={card} aria-label="Combate de la demo">
    <h2 className="text-2xl font-bold">Combate</h2><p className="mt-2">Primero creá y seleccioná una categoría.</p>
  </section>;
  if (active && active.categoryId !== categoryId) return <section className={card} aria-label="Combate de la demo">
    <h2 className="text-2xl font-bold">Hay otro combate cargado</h2>
    <p className="mt-2">Pertenece a {state.categories[active.categoryId]?.config.categoryName || "otra categoría"}. Confirmalo o postergalo antes de cargar otra pelea.</p>
    <button type="button" className={`${mainButton} mt-3 w-full`} disabled={disabled}
      onClick={() => send({ type: "category/select", categoryId: active.categoryId }, "Volviendo al combate")}>Volver al combate cargado</button>
  </section>;

  const displayedFightId = active?.fightId ?? selectedPending?.id;
  const displayedFightIndex = Math.max(0, category.fights.findIndex((fight) => fight.id === displayedFightId));
  return <section className="flex min-w-0 flex-col md:h-full md:min-h-0 md:overflow-y-auto" aria-label="Combate de la demo">
    <h2 className="sr-only">Combate</h2>
    <header className="shrink-0 border-b border-border bg-background">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5">
        <p className="min-w-0 flex-1 truncate text-xs font-semibold text-amber-300 sm:text-sm">{category.config.categoryName || "Categoría sin nombre"}</p>
        {category.fights.length > 0 && <span className="shrink-0 text-xs font-semibold">Pelea {displayedFightIndex + 1} de {category.fights.length}</span>}
        {canPostpone && <button type="button" className={`${button} border-amber-700 px-3 text-sm text-amber-200`} disabled={disabled || pending.length < 2}
          onClick={() => sendActive("fight/postpone", "Postergando pelea")}>Postergar pelea</button>}
        <span className="hidden text-xs text-muted-foreground sm:inline">{tul ? "Tul / Formas" : "Lucha"} · {category.config.mode === "round-robin" ? "Round Robin" : "Eliminación"}</span>
      </div>
      {category.fights.length > 0 && <nav className="flex min-w-0 items-center gap-1 overflow-x-auto border-t border-border/50 px-2 py-1.5 [scrollbar-width:thin]" aria-label="Orden de peleas">
        {category.fights.map((fight, index) => <div key={fight.id} className="flex shrink-0 items-center gap-1">
          {(index === 0 || fight.groupId !== category.fights[index - 1]?.groupId) && fight.groupId && <span className="px-1 text-[10px] uppercase text-muted-foreground">Llave {fight.groupId}</span>}
          <button type="button" aria-label={`Pelea ${index + 1}: ${fight.red.name} vs ${fight.blue.name}`} aria-current={fight.id === displayedFightId ? "step" : undefined}
            disabled={disabled || Boolean(active) || fight.completed || fight.id === displayedFightId}
            onClick={() => { setRestOverride(""); send({ type: "fight/select", categoryId, fightId: fight.id }, "Seleccionando pelea"); }}
            className={`flex size-11 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${fight.id === displayedFightId
              ? "border-foreground bg-foreground text-background"
              : fight.completed ? "border-border text-muted-foreground/50" : "border-border text-muted-foreground hover:border-primary hover:text-foreground"}`}>{index + 1}</button>
        </div>)}
      </nav>}
    </header>
    {actionError && <p role="alert" className="rounded-xl border border-red-500 bg-red-950 p-3 text-red-100">{actionError}</p>}
    {pendingAction && <p role="status" className="text-sm text-primary">{pendingAction}…</p>}
    {category.phase !== "fighting" ? <div className={card}><p>La categoría todavía no se inició. Volvé a Categorías para iniciarla.</p></div>
      : active ? <>
        {active.categoryId !== categoryId && <p role="alert" className={`${card} border-amber-500 text-amber-200`}>Hay un combate cargado de otra categoría. Seleccionala para continuar.</p>}
        {canSwap && <div className="shrink-0 border-b border-border px-3 py-1.5 text-center">
          <button type="button" className={`${button} w-full border-cyan-700 text-cyan-200 sm:w-auto`} disabled={disabled} onClick={() => send({ type: "fight/swap", ...context, assignmentRevision: active.assignmentRevision,
            expectedRedId: active.red.id, expectedBlueId: active.blue.id }, "Intercambiando competidores")}>Intercambiar competidores</button>
          <span className="ml-2 hidden text-xs text-muted-foreground md:inline">Rojo permanece a la izquierda · Azul a la derecha</span>
        </div>}
        <div className={arena} data-testid="demo-fight-station">
          <ColorStation side="red" name={active.red.name} score={mode === "points" ? score.red : roundWins.red} />
          <div className="contents md:order-2 md:flex md:min-h-0 md:flex-col md:items-center md:justify-center md:gap-3 md:overflow-y-auto md:px-4 md:py-4">
          <div className="order-1 col-span-2 flex min-h-11 items-center justify-center gap-2 border-b border-border bg-background px-2 py-1.5 text-center md:order-none md:min-h-0 md:flex-col md:border-0 md:p-0">
            <p className="text-xs font-semibold text-primary md:text-sm" aria-live="polite">{phaseLabel(active, Boolean(tul))}</p>
            {active.state.phase === "golden_point" ? <p className="text-lg font-black text-yellow-300">SIN RELOJ</p>
              : !tul && <p role="timer" className="font-mono text-2xl font-black leading-none tabular-nums md:text-[clamp(3rem,9vh,8rem)]">{formatTime(active.state.timeLeft)}</p>}
            {clockFault && <p role="alert" className="text-xs text-amber-200">El reloj no se pudo guardar. Pausá y revisá el estado.</p>}
          </div>
          <div className="order-4 col-span-2 w-full space-y-3 px-3 py-3 md:order-none md:max-w-lg md:px-0 md:py-0">
          <p className="text-center text-xs text-muted-foreground">{mode === "points" ? "Puntos acumulados provisionales; ver desglose por juez" : "Rounds ganados; votos del round abajo"}</p>
          {!assignmentsMatch && <p role="alert" className="mt-3 rounded-lg border border-red-500 p-3 text-red-200">Las asignaciones ya no coinciden con la pelea guardada. Iniciar está bloqueado.</p>}
          {active.state.phase === "idle" && <div className="mt-4 space-y-3">
            <button type="button" className={`${mainButton} w-full`} disabled={disabled || !assignmentsMatch} onClick={() => sendActive("fight/start", "Iniciando combate")}>{tul ? "Iniciar votación de Tul" : "Iniciar combate"}</button>
            {canSkipToFlags && <button type="button" className={`${button} w-full`} disabled={disabled} onClick={() => {
              if (window.confirm("¿Saltar el cronómetro de este round e ir directo a registrar banderas?"))
                sendActive("fight/skipToFlags", "Abriendo banderas");
            }}>Registrar banderas sin cronómetro</button>}
          </div>}
          {active.state.phase === "golden_point" && <p className="mt-3 text-center text-amber-200">Sin reloj: registrá un voto por juez y confirmá el intento.</p>}
          {["round", "overtime"].includes(active.state.phase) && <div className="mt-4 grid grid-cols-2 gap-2">
            <button type="button" className={mainButton} disabled={disabled || active.paused} onClick={() => { setClockFault(false); sendActive("fight/pause", "Pausando reloj"); }}>Pausar</button>
            <button type="button" className={mainButton} disabled={disabled || !active.paused} onClick={() => { pauseRequested.current = false; setClockFault(false); sendActive("fight/resume", "Reanudando reloj"); }}>Reanudar</button>
            <button type="button" className={`${button} col-span-2`} disabled={disabled || active.paused} onClick={() => sendActive("fight/medical", "Pausando por atención médica")}>Pausa médica · detener reloj</button>
            <button type="button" className={`${button} col-span-2`} disabled={disabled} onClick={() => sendActive("fight/finishRound", "Finalizando round")}>Finalizar {active.state.phase === "overtime" ? "desempate" : "round"}</button>
            {active.paused && <div className="col-span-2 grid grid-cols-2 gap-2">
              <button type="button" className={button} disabled={disabled} onClick={() => send({ type: "fight/adjustTimer", ...context, seconds: -10 }, "Ajustando reloj")}>− 10 segundos</button>
              <button type="button" className={button} disabled={disabled} onClick={() => send({ type: "fight/adjustTimer", ...context, seconds: 10 }, "Ajustando reloj")}>+ 10 segundos</button>
            </div>}
          </div>}
          {!tul && active.state.phase === "rest" && active.state.currentRound < active.rules.rounds.count && <div className="mt-4 grid gap-2">
            <button type="button" className={`${mainButton} w-full`} disabled={disabled || !assignmentsMatch} onClick={() => sendActive("fight/start", "Iniciando siguiente round")}>Iniciar round {active.state.currentRound + 1}</button>
            {canSkipToFlags && <button type="button" className={`${button} w-full`} disabled={disabled} onClick={() => {
              if (window.confirm("¿Saltar el cronómetro del próximo round e ir directo a registrar banderas?"))
                sendActive("fight/skipToFlags", "Abriendo banderas");
            }}>Registrar banderas sin cronómetro</button>}
          </div>}
          {active.state.phase === "finished" && active.state.result && <div className="mt-4 rounded-xl border border-emerald-500 bg-emerald-950 p-4">
            <p className="text-xl font-bold">{active.state.result.winner === "draw" ? "Empate" : `Ganó ${active.state.result.winner === "red" ? active.red.name : active.blue.name}`}</p>
            <p className="text-sm text-emerald-100">Motivo: {active.state.result.reason}. Revisá el resultado antes de confirmarlo.</p>
            {!tul && mode === "flags" && active.roundFlags.length > 0 && <button type="button" className={`${button} mt-3 w-full`} disabled={disabled}
              onClick={() => sendActive("fight/undoRound", "Corrigiendo banderas")}>Corregir banderas del último round</button>}
            {tul && <button type="button" className={`${button} mt-3 w-full`} disabled={disabled}
              onClick={() => sendActive("fight/tulUndoFinish", "Corrigiendo votación de Tul")}>Corregir votos de Tul</button>}
            <button type="button" className={`${mainButton} mt-3 w-full`} disabled={disabled} onClick={() => sendActive("fight/confirmResult", "Confirmando resultado")}>Confirmar resultado y cerrar pelea</button>
          </div>}
          {active.state.pendingJuryDecision && !active.state.result && <div className="mt-4 rounded-xl border border-amber-500 bg-amber-950/50 p-3">
            <p className="font-bold">Decisión de jurado pendiente</p><div className="mt-2 grid grid-cols-2 gap-2">{(["red", "blue"] as const).map((side) => <button key={side} type="button" className={button} disabled={disabled}
              onClick={() => send({ type: "fight/resolveJury", ...context, winner: side }, "Resolviendo jurado")}>Gana {voteName(side)}</button>)}</div>
          </div>}
          {canReset && <div className="mt-5 border-t border-border pt-4">
            <p id="demo-reset-warning" className="mb-2 text-sm text-amber-200">Reiniciar borra el tiempo, puntos, sanciones, banderas y votos de este combate sin confirmar.</p>
            <button type="button" className={`${danger} w-full`} aria-describedby="demo-reset-warning" disabled={disabled}
              onClick={() => {
                if (!window.confirm("¿Reiniciar este combate? Se borrarán el tiempo, los puntos, las sanciones, las banderas y los votos sin confirmar. Los resultados ya confirmados no se borran.")) return;
                void run({ type: "fight/reset", ...context }, "Reiniciando combate").then((ok) => { if (ok) setClockFault(false); });
              }}>Reiniciar combate</button>
          </div>}
          </div>
          </div>
          <ColorStation side="blue" name={active.blue.name} score={mode === "points" ? score.blue : roundWins.blue} />
        </div>
        {active.state.phase !== "idle" && active.state.phase !== "finished" && <>
          {active.state.phase === "golden_point" ? <div className={card}><h3 className="text-xl font-bold">Votos de Punto de Oro</h3>
            <p className="mt-1 text-slate-300">Intento {active.state.goldenPoint?.attempt ?? 1}. Se necesita mayoría; si empatan todos, confirmar abre otro intento.</p>
            <div className="mt-3 grid grid-cols-2 gap-2">{judges.map((id) => <fieldset key={id} className="min-w-0 rounded-lg border border-border p-2"><legend className="px-1 font-bold">Juez {id}</legend>
              <div className="grid grid-cols-2 gap-2">{(["red", "blue"] as const).map((side) => <button key={side} type="button" aria-pressed={active.state.goldenPoint?.votes[id] === side}
                className={`${compactVoteButton} ${side === "red" ? "border-red-800 bg-red-950/60 text-red-200" : "border-blue-800 bg-blue-950/60 text-blue-200"} ${active.state.goldenPoint?.votes[id] === side ? "ring-2 ring-primary" : ""}`}
                disabled={disabled || active.state.goldenPoint?.votes[id] === side} onClick={() => send({ type: "fight/goldenVote", ...context, judgeId: id,
                  competitor: side, attempt: active.state.goldenPoint?.attempt ?? 1 }, `Guardando voto ${id}`)}>{voteName(side)}</button>)}</div></fieldset>)}</div>
            <button type="button" className={`${mainButton} mt-4 w-full`} disabled={disabled || !active.state.goldenPoint || (() => { const votes = Object.values(active.state.goldenPoint.votes);
              const red = votes.filter((item) => item === "red").length; const blue = votes.filter((item) => item === "blue").length;
              return red < Math.floor(judges.length / 2) + 1 && blue < Math.floor(judges.length / 2) + 1 && votes.length < judges.length;
            })()} onClick={() => send({ type: "fight/confirmGolden", ...context, attempt: active.state.goldenPoint?.attempt ?? 1 }, "Confirmando Punto de Oro")}>Confirmar intento</button>
          </div> : <>
            {mode === "flags" || tul ? <div className={card}><h3 className="text-xl font-bold">{tul ? "Votos de Tul" : `Banderas del round ${active.roundFlags.length + 1}`}</h3>
              <p className="mt-1 text-slate-300">Registrá cada juez por separado. {tul ? "Tul requiere ganador rojo o azul." : "Rojo, empate o azul."}</p>
              {active.roundFlags.length > 0 && <p className="mt-2 text-sm text-slate-200">Rounds confirmados: {active.roundFlags.map((item, index) => `R${index + 1} ${item.red}–${item.blue} (${voteName(item.winner)})`).join(" · ")}</p>}
              <p className="mt-3 font-semibold" aria-live="polite">Votos actuales: {provisional.red} rojo · {provisional.draw} empate · {provisional.blue} azul</p>
              <div className="mt-3 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:gap-3">{judges.map((id) => <fieldset key={id} className="min-w-0 rounded-lg border border-border bg-background/50 p-2"><legend className="px-1 text-sm font-bold">Juez {id}</legend>
                <div className={`grid gap-1 ${tul ? "grid-cols-2" : "grid-cols-3"}`}>{(tul ? ["red", "blue"] : ["red", "draw", "blue"]).map((vote) => <button key={vote} type="button"
                  aria-label={voteName(vote as Vote)} aria-pressed={active.judgeVotes[id] === vote} className={`${compactVoteButton} ${vote === "red" ? "border-red-900/70 bg-red-950/60 text-red-200" : vote === "blue" ? "border-blue-900/70 bg-blue-950/60 text-blue-200" : "border-border bg-secondary/70 text-foreground"} ${active.judgeVotes[id] === vote ? "ring-2 ring-primary" : ""}`}
                  disabled={disabled || active.judgeVotes[id] === vote || (!tul && !["round", "rest"].includes(active.state.phase))}
                  onClick={() => send({ type: "fight/vote", ...context, judgeId: id, vote: vote as Vote }, `Guardando voto ${id}`)}><span aria-hidden="true" className="block text-base leading-none">{vote === "red" ? "🔴" : vote === "blue" ? "🔵" : "⚖"}</span>{voteName(vote as Vote)}</button>)}</div>
              </fieldset>)}</div>
              {tul && <button type="button" className={`${mainButton} mt-4 w-full`} disabled={disabled || !allVoted || provisional.winner === "draw"}
                onClick={() => sendActive("fight/tulFinish", "Cerrando votación de Tul")}>Cerrar votación de Tul</button>}
              {tul && Object.keys(active.judgeVotes).length > 0 && <button type="button" className={`${button} mt-2 w-full`} disabled={disabled}
                onClick={() => sendActive("fight/tulRetry", "Reiniciando votación de Tul")}>Repetir votación de Tul</button>}
              {!tul && active.state.phase === "rest" && <button type="button" className={`${mainButton} mt-4 w-full`} disabled={disabled || !allVoted}
                onClick={() => sendActive("fight/confirmRound", "Confirmando banderas")}>Confirmar banderas del round</button>}
              {!tul && active.roundFlags.length > 0 && active.state.phase === "rest" && <button type="button" className={`${button} mt-2 w-full`} disabled={disabled}
                onClick={() => sendActive("fight/undoRound", "Corrigiendo banderas")}>Deshacer último round confirmado</button>}
              {!tul && active.state.phase === "round" && <p className="mt-3 text-sm text-amber-200">Podés anotar votos ahora; terminá el round para confirmarlos.</p>}
            </div> : <div className={card}><h3 className="text-xl font-bold">Puntos por juez</h3>
              <p className="mt-1 text-slate-300">Elegí juez, competidor y técnica. Las sanciones de árbitro se registran aparte.</p>
              <fieldset className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><legend className="mb-2 font-semibold">Juez que puntúa</legend>{judges.map((id) => <button key={id} type="button" aria-pressed={judge === id}
                className={`${button} ${judge === id ? "border-primary bg-accent ring-2 ring-primary" : ""}`} onClick={() => setJudge(id)}>{id}</button>)}</fieldset>
              <div className="mt-3 grid grid-cols-2 gap-2">{(["red", "blue"] as const).map((side) => <div key={side} className={`min-w-0 rounded-xl border p-2 ${side === "red" ? "border-red-700" : "border-blue-700"}`}>
                <h4 className="break-words font-bold">{side === "red" ? active.red.name : active.blue.name} · {voteName(side)}</h4>
                <p className="text-sm">Juez {judge}: {totals[judge]?.[side] ?? 0} puntos</p>
                <div className="mt-2 grid gap-2">{pointEvents.map(([key, value]) => <button key={key} type="button" className={`${button} min-w-0 break-words px-2 text-sm`}
                  disabled={disabled || !["round", "overtime"].includes(active.state.phase)} onClick={() => send({ type: "fight/event", ...context, judgeId: judge, competitor: side, eventType: key }, `Sumando ${value} puntos`)}>
                  {key.replaceAll("_", " ")} · +{value}</button>)}</div></div>)}</div>
              <button type="button" className={`${button} mt-3 w-full`} disabled={disabled || !active.state.rounds.some((round) => round.events.some((event) => event.judgeId === judge))}
                onClick={() => send({ type: "fight/undo", ...context, judgeId: judge }, `Deshaciendo último evento de ${judge}`)}>Deshacer último evento de {judge}</button>
              {active.state.phase === "penalties" && <button type="button" className={`${mainButton} mt-3 w-full`} disabled={disabled}
                onClick={() => sendActive("fight/confirmPenalties", "Confirmando puntuación")}>Confirmar puntos y sanciones</button>}
            </div>}
            {!tul && active.state.rounds.length > 0 && <details className={card}><summary className="min-h-11 cursor-pointer text-lg font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">Sanciones y decisiones especiales</summary>
              <p className="mt-2 text-sm text-slate-300">Correcciones de sanciones disponibles después de terminar el round. Descalificación disponible durante combate o revisión de sanciones.</p>
              <div className="mt-3 grid grid-cols-2 gap-3">{(["red", "blue"] as const).map((side) => <div key={side} className="min-w-0 rounded-lg border border-slate-700 p-2">
                <h4 className="break-words font-bold">{voteName(side)} · {side === "red" ? active.red.name : active.blue.name}</h4>
                {(["warning", "minus_point"] as const).map((kind) => { const count = getSanctionCount(active.state, side, kind); return <div key={kind} className="mt-2">
                  <p className="text-sm">{kind === "warning" ? "Advertencias" : "Puntos menos"}: {count}</p>
                  <div className="mt-1 grid grid-cols-2 gap-1"><button type="button" className={button} disabled={disabled || count < 1 || !["rest", "penalties", "finished"].includes(active.state.phase)} aria-label={`Quitar ${kind === "warning" ? "advertencia" : "punto menos"} a ${side === "red" ? active.red.name : active.blue.name}`}
                    onClick={() => send({ type: "fight/setSanction", ...context, competitor: side, kind, expectedCount: count, count: count - 1 }, "Corrigiendo sanción")}>−</button>
                  <button type="button" className={button} disabled={disabled || !["rest", "penalties", "finished"].includes(active.state.phase)} aria-label={`Agregar ${kind === "warning" ? "advertencia" : "punto menos"} a ${side === "red" ? active.red.name : active.blue.name}`}
                    onClick={() => send({ type: "fight/setSanction", ...context, competitor: side, kind, expectedCount: count, count: count + 1 }, "Corrigiendo sanción")}>+</button></div>
                </div>; })}
                <p className="mt-2 text-xs text-slate-300">Oficial: {penalties.warnings[side]} advertencias · {penalties.fouls[side]} puntos menos</p>
                {["round", "overtime"].includes(active.state.phase) && <div className="mt-2 grid gap-2">
                  {Object.hasOwn(active.rules.deductions, "warning_minor") && <button type="button" className={button} disabled={disabled} onClick={() => send({ type: "fight/event", ...context, judgeId: "arbiter", competitor: side, eventType: "warning_minor" }, "Registrando advertencia")}>+ Advertencia</button>}
                  {Object.hasOwn(active.rules.deductions, "minus_point") && <button type="button" className={button} disabled={disabled} onClick={() => send({ type: "fight/event", ...context, judgeId: "arbiter", competitor: side, eventType: "minus_point" }, "Registrando punto menos")}>+ Punto menos</button>}
                </div>}
                {["round", "overtime", "penalties"].includes(active.state.phase) && <button type="button" className={`${danger} mt-3 w-full`} disabled={disabled}
                  onClick={() => { if (window.confirm(`¿Descalificar a ${side === "red" ? active.red.name : active.blue.name}?`)) send({ type: "fight/dq", ...context, competitor: side }, "Registrando descalificación"); }}>Descalificar {voteName(side)}</button>}
              </div>)}</div>
            </details>}
          </>}
        </>}
      </> : <div className="flex min-w-0 flex-col md:min-h-0 md:flex-1">
        {selectedPending ? <div className={arena} data-testid="demo-fight-station">
          <ColorStation side="red" name={selectedPending.red.name} score={0} />
          <div className="contents md:order-2 md:flex md:min-h-0 md:flex-col md:items-center md:justify-center md:gap-4 md:overflow-y-auto md:px-4 md:py-4">
            <div className="order-1 col-span-2 flex min-h-11 items-center justify-center gap-2 border-b border-border bg-background px-2 py-1.5 md:order-none md:flex-col md:border-0 md:p-0">
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">Listo</span>
              <span role="timer" className="font-mono text-2xl font-black tabular-nums md:text-[clamp(3rem,9vh,8rem)]">0:00</span>
            </div>
            <div className="order-4 col-span-2 w-full space-y-3 px-3 py-3 md:order-none md:max-w-lg md:px-0 md:py-0">
              {advisory.kind === "suggest" && restOverride !== advisoryKey && <div className="rounded-lg border border-amber-500 bg-amber-950/50 p-3" role="status"><p>Esta pelea repite un competidor de la última pelea confirmada. Hay otra habilitada que le da más descanso.</p>
                <div className="mt-2 grid gap-2"><button type="button" className={mainButton} disabled={disabled} onClick={() => send({ type: "fight/select", categoryId, fightId: advisory.alternativeFightId }, "Seleccionando pelea sugerida")}>Usar sugerida: {category.fights[advisory.alternativeIndex]?.red.name} vs {category.fights[advisory.alternativeIndex]?.blue.name}</button>
                  <button type="button" className={button} disabled={disabled} onClick={() => setRestOverride(advisoryKey)}>Mantener prevista</button></div></div>}
              {advisory.kind === "unavoidable" && restOverride !== advisoryKey && <div className="rounded-lg border border-amber-500 bg-amber-950/50 p-3" role="status"><p>No hay otra pelea disponible; dar descanso manualmente.</p>
                <button type="button" className={`${button} mt-2 w-full`} onClick={() => setRestOverride(advisoryKey)}>Continuar expresamente con esta pelea</button></div>}
              {(advisory.kind === "none" || restOverride === advisoryKey) && <button type="button" className={`${mainButton} w-full`} disabled={disabled} onClick={() => send({ type: "fight/load", categoryId, fightId: selectedPending.id }, "Cargando pelea")}>Cargar pelea</button>}
            </div>
          </div>
          <ColorStation side="blue" name={selectedPending.blue.name} score={0} />
        </div> : <div className={`${card} m-3`}><h3 className="text-xl font-bold">Próxima pelea</h3><p className="mt-2 text-muted-foreground">No hay peleas pendientes habilitadas en esta categoría.</p></div>}
        <div className="space-y-3 px-3 py-3">
        {pending.length > 1 && <details><summary className="min-h-11 cursor-pointer font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Elegir otra pelea pendiente ({pending.length})</summary>
          <ol className="mt-2 space-y-2">{pending.map((fight) => <li key={fight.id}><button type="button" className={`${button} w-full break-words text-left`} disabled={disabled || fight.id === selectedPending?.id}
            onClick={() => { setRestOverride(""); send({ type: "fight/select", categoryId, fightId: fight.id }, "Seleccionando pelea"); }}>{category.fights.indexOf(fight) + 1}. {fight.red.name} vs {fight.blue.name}{fight.groupId ? ` · ${fight.groupId}` : ""}</button></li>)}</ol>
        </details>}
        {category.config.mode === "elimination" && category.fights.filter((fight) => fight.completed && fight.winner === "draw"
          && !category.fights.some((item) => item.continuationParentFightId === fight.id)).map((fight) => <button key={fight.id} type="button" className={`${button} mt-3 w-full`} disabled={disabled}
            onClick={() => send({ type: "fight/continueDraw", categoryId, fightId: fight.id }, "Preparando continuación")}>Continuar empate: {fight.red.name} vs {fight.blue.name}</button>)}
        {!pending.length && !outcome?.championId && <div className="mt-4 space-y-2 border-t border-slate-700 pt-4"><p className="text-amber-200">Puede faltar preparar una ronda, desempate o final. No se asigna campeón provisional.</p>
          {category.config.mode === "elimination" && <button type="button" className={`${button} w-full`} disabled={disabled} onClick={() => send({ type: "category/prepareNext", categoryId }, "Preparando siguiente ronda")}>Preparar siguiente ronda de la llave</button>}
          {rrActions.playoffs.filter((item) => item.canPrepare).map((item) => <button key={item.groupId} type="button" className={`${button} w-full`} disabled={disabled}
            onClick={() => send({ type: "category/preparePlayoff", categoryId, groupId: item.groupId }, `Preparando desempate ${item.groupId}`)}>Preparar desempate {item.groupId === "FINAL" ? "de la final" : `del grupo ${item.groupId}`}</button>)}
          {rrActions.canPrepareFinal && <button type="button" className={`${button} w-full`} disabled={disabled}
            onClick={() => send({ type: "category/prepareFinal", categoryId }, "Preparando fase final")}>Preparar fase final</button>}
        </div>}
        {outcome?.championId && <p className="mt-3 rounded-lg border border-emerald-500 p-3 text-emerald-200">Categoría completada. Campeón: {category.competitors.find((item) => item.id === outcome.championId)?.name ?? "ver tabla"}.</p>}
        </div>
      </div>}
    <div className={card}><button type="button" className={button} onClick={() => window.print()}>Imprimir vista del combate</button><p className="mt-2 text-sm text-slate-300">Los resultados confirmados aparecen en Historial. Exportá un respaldo completo desde Respaldo.</p></div>
  </section>;
}
