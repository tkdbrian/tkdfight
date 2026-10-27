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

const buttonBase = "min-h-11 rounded-xl border px-4 py-2 text-base font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50";
const button = `${buttonBase} border-slate-500 bg-slate-800 hover:border-cyan-300`;
const danger = `${buttonBase} border-red-700 bg-red-950 text-red-100 hover:bg-red-900`;
const mainButton = `${buttonBase} border-cyan-300 bg-cyan-700 py-4 text-lg font-bold hover:bg-cyan-600`;
const card = "rounded-2xl border border-slate-700 bg-slate-900 p-4 sm:p-5";
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

  return <section className="space-y-4" aria-label="Combate de la demo">
    <header className={card}>
      <h2 className="text-2xl font-bold">Combate</h2>
      <p className="mt-1 break-words text-slate-200">{category.config.categoryName || "Categoría sin nombre"} · {category.config.mode === "round-robin" ? "Round Robin" : "Eliminación"} · {tul ? "Tul" : "Lucha"}</p>
      <p className="mt-2 text-sm text-slate-300">Mesa local: una sola persona registra los votos J1–J{category.config.judgesCount || 4}. No hay jueces conectados.</p>
    </header>
    {actionError && <p role="alert" className="rounded-xl border border-red-500 bg-red-950 p-3 text-red-100">{actionError}</p>}
    {pendingAction && <p role="status" className="text-sm text-cyan-200">{pendingAction}…</p>}
    {category.phase !== "fighting" ? <div className={card}><p>La categoría todavía no se inició. Volvé a Categorías para iniciarla.</p></div>
      : active ? <>
        {active.categoryId !== categoryId && <p role="alert" className={`${card} border-amber-500 text-amber-200`}>Hay un combate cargado de otra categoría. Seleccionala para continuar.</p>}
        <div className={card}>
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-cyan-200" aria-live="polite">{phaseLabel(active, Boolean(tul))}</p>
            <p className="text-sm text-slate-300">Pelea {Math.max(1, category.fights.findIndex((fight) => fight.id === active.fightId) + 1)} / {category.fights.length}</p></div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3">
            <div className="min-w-0 rounded-xl border border-red-700 bg-red-950/70 p-3 text-center"><p className="font-bold uppercase text-red-200">Rojo · izquierda</p><p className="mt-2 break-words text-lg font-black text-white sm:text-2xl">{active.red.name}</p><p className="mt-2 text-4xl font-black tabular-nums text-red-300">{mode === "points" ? score.red : roundWins.red}</p></div>
            <div className="min-w-0 rounded-xl border border-blue-700 bg-blue-950/70 p-3 text-center"><p className="font-bold uppercase text-blue-200">Azul · derecha</p><p className="mt-2 break-words text-lg font-black text-white sm:text-2xl">{active.blue.name}</p><p className="mt-2 text-4xl font-black tabular-nums text-blue-300">{mode === "points" ? score.blue : roundWins.blue}</p></div>
          </div>
          <p className="mt-2 text-center text-sm text-slate-300">{mode === "points" ? "Puntos acumulados provisionales; ver desglose por juez" : "Rounds ganados; votos del round abajo"}</p>
          {!assignmentsMatch && <p role="alert" className="mt-3 rounded-lg border border-red-500 p-3 text-red-200">Las asignaciones ya no coinciden con la pelea guardada. Iniciar está bloqueado.</p>}
          {active.state.phase !== "golden_point" && !tul && <div className="mt-4 rounded-xl border border-slate-600 bg-slate-950 p-3 text-center">
            <p className="text-sm text-slate-300">Tiempo restante</p><p role="timer" className="text-5xl font-black tabular-nums sm:text-6xl">{formatTime(active.state.timeLeft)}</p>
            {clockFault && <p role="alert" className="mt-2 text-amber-200">El reloj no se pudo guardar. Pausá el combate y revisá el estado.</p>}
          </div>}
          {active.state.phase === "idle" && <div className="mt-4 space-y-3">
            {canSwap && <button type="button" className={`${button} w-full`} disabled={disabled} onClick={() => send({ type: "fight/swap", ...context, assignmentRevision: active.assignmentRevision,
              expectedRedId: active.red.id, expectedBlueId: active.blue.id }, "Intercambiando competidores")}>Intercambiar competidores</button>}
            {canSwap && <p className="text-center text-sm text-slate-300">Rojo permanece a la izquierda · Azul a la derecha</p>}
            <button type="button" className={`${mainButton} w-full`} disabled={disabled || !assignmentsMatch} onClick={() => sendActive("fight/start", "Iniciando combate")}>{tul ? "Iniciar votación de Tul" : "Iniciar combate"}</button>
            {canSkipToFlags && <button type="button" className={`${button} w-full`} disabled={disabled} onClick={() => {
              if (window.confirm("¿Saltar el cronómetro de este round e ir directo a registrar banderas?"))
                sendActive("fight/skipToFlags", "Abriendo banderas");
            }}>Registrar banderas sin cronómetro</button>}
            {canPostpone && <button type="button" className={`${button} w-full`} disabled={disabled || pending.length < 2} onClick={() => sendActive("fight/postpone", "Postergando pelea")}>Postergar pelea</button>}
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
          {active.state.phase === "rest" && active.state.currentRound < active.rules.rounds.count && <div className="mt-4 grid gap-2">
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
          {canReset && <div className="mt-5 border-t border-slate-700 pt-4">
            <p id="demo-reset-warning" className="mb-2 text-sm text-amber-200">Reiniciar borra el tiempo, puntos, sanciones, banderas y votos de este combate sin confirmar.</p>
            <button type="button" className={`${danger} w-full`} aria-describedby="demo-reset-warning" disabled={disabled}
              onClick={() => {
                if (!window.confirm("¿Reiniciar este combate? Se borrarán el tiempo, los puntos, las sanciones, las banderas y los votos sin confirmar. Los resultados ya confirmados no se borran.")) return;
                void run({ type: "fight/reset", ...context }, "Reiniciando combate").then((ok) => { if (ok) setClockFault(false); });
              }}>Reiniciar combate</button>
          </div>}
        </div>
        {active.state.phase !== "idle" && active.state.phase !== "finished" && <>
          {active.state.phase === "golden_point" ? <div className={card}><h3 className="text-xl font-bold">Votos de Punto de Oro</h3>
            <p className="mt-1 text-slate-300">Intento {active.state.goldenPoint?.attempt ?? 1}. Se necesita mayoría; si empatan todos, confirmar abre otro intento.</p>
            {judges.map((id) => <fieldset key={id} className="mt-3 rounded-lg border border-slate-700 p-2"><legend className="px-1 font-bold">Juez {id}</legend>
              <div className="grid grid-cols-2 gap-2">{(["red", "blue"] as const).map((side) => <button key={side} type="button" aria-pressed={active.state.goldenPoint?.votes[id] === side}
                className={`${button} ${side === "red" ? "border-red-600" : "border-blue-600"} ${active.state.goldenPoint?.votes[id] === side ? "ring-2 ring-white" : ""}`}
                disabled={disabled || active.state.goldenPoint?.votes[id] === side} onClick={() => send({ type: "fight/goldenVote", ...context, judgeId: id,
                  competitor: side, attempt: active.state.goldenPoint?.attempt ?? 1 }, `Guardando voto ${id}`)}>{voteName(side)}</button>)}</div></fieldset>)}
            <button type="button" className={`${mainButton} mt-4 w-full`} disabled={disabled || !active.state.goldenPoint || (() => { const votes = Object.values(active.state.goldenPoint.votes);
              const red = votes.filter((item) => item === "red").length; const blue = votes.filter((item) => item === "blue").length;
              return red < Math.floor(judges.length / 2) + 1 && blue < Math.floor(judges.length / 2) + 1 && votes.length < judges.length;
            })()} onClick={() => send({ type: "fight/confirmGolden", ...context, attempt: active.state.goldenPoint?.attempt ?? 1 }, "Confirmando Punto de Oro")}>Confirmar intento</button>
          </div> : <>
            {mode === "flags" || tul ? <div className={card}><h3 className="text-xl font-bold">{tul ? "Votos de Tul" : `Banderas del round ${active.roundFlags.length + 1}`}</h3>
              <p className="mt-1 text-slate-300">Registrá cada juez por separado. {tul ? "Tul requiere ganador rojo o azul." : "Rojo, empate o azul."}</p>
              {active.roundFlags.length > 0 && <p className="mt-2 text-sm text-slate-200">Rounds confirmados: {active.roundFlags.map((item, index) => `R${index + 1} ${item.red}–${item.blue} (${voteName(item.winner)})`).join(" · ")}</p>}
              <p className="mt-3 font-semibold" aria-live="polite">Votos actuales: {provisional.red} rojo · {provisional.draw} empate · {provisional.blue} azul</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">{judges.map((id) => <fieldset key={id} className="rounded-xl border border-slate-700 p-2"><legend className="px-1 font-bold">Juez {id}</legend>
                <div className={`grid gap-2 ${tul ? "grid-cols-2" : "grid-cols-3"}`}>{(tul ? ["red", "blue"] : ["red", "draw", "blue"]).map((vote) => <button key={vote} type="button"
                  aria-pressed={active.judgeVotes[id] === vote} className={`${button} min-w-0 px-1 text-sm ${vote === "red" ? "border-red-600" : vote === "blue" ? "border-blue-600" : ""} ${active.judgeVotes[id] === vote ? "ring-2 ring-white" : ""}`}
                  disabled={disabled || active.judgeVotes[id] === vote || (!tul && !["round", "rest"].includes(active.state.phase))}
                  onClick={() => send({ type: "fight/vote", ...context, judgeId: id, vote: vote as Vote }, `Guardando voto ${id}`)}>{voteName(vote as Vote)}</button>)}</div>
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
                className={`${button} ${judge === id ? "border-cyan-300 bg-cyan-950" : ""}`} onClick={() => setJudge(id)}>{id}</button>)}</fieldset>
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
      </> : <div className={card}>
        <h3 className="text-xl font-bold">Próxima pelea</h3>
        {selectedPending ? <>
          <p className="mt-2 text-sm text-slate-300">Pelea {category.fights.findIndex((fight) => fight.id === selectedPending.id) + 1} / {category.fights.length}{selectedPending.groupId ? ` · Grupo ${selectedPending.groupId}` : ""}</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-center"><p className="min-w-0 break-words rounded-lg border border-red-700 bg-red-950 p-3 text-lg font-bold">Rojo · {selectedPending.red.name}</p><p className="min-w-0 break-words rounded-lg border border-blue-700 bg-blue-950 p-3 text-lg font-bold">Azul · {selectedPending.blue.name}</p></div>
          {advisory.kind === "suggest" && restOverride !== advisoryKey && <div className="mt-3 rounded-lg border border-amber-500 bg-amber-950/50 p-3" role="status"><p>Esta pelea repite un competidor de la última pelea confirmada. Hay otra habilitada que le da más descanso.</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2"><button type="button" className={mainButton} disabled={disabled} onClick={() => send({ type: "fight/select", categoryId, fightId: advisory.alternativeFightId }, "Seleccionando pelea sugerida")}>Usar sugerida: {category.fights[advisory.alternativeIndex]?.red.name} vs {category.fights[advisory.alternativeIndex]?.blue.name}</button>
              <button type="button" className={button} disabled={disabled} onClick={() => setRestOverride(advisoryKey)}>Mantener prevista</button></div></div>}
          {advisory.kind === "unavoidable" && restOverride !== advisoryKey && <div className="mt-3 rounded-lg border border-amber-500 bg-amber-950/50 p-3" role="status"><p>No hay otra pelea disponible; dar descanso manualmente.</p>
            <button type="button" className={`${button} mt-2 w-full`} onClick={() => setRestOverride(advisoryKey)}>Continuar expresamente con esta pelea</button></div>}
          {(advisory.kind === "none" || restOverride === advisoryKey) && <button type="button" className={`${mainButton} mt-4 w-full`} disabled={disabled} onClick={() => send({ type: "fight/load", categoryId, fightId: selectedPending.id }, "Cargando pelea")}>Cargar pelea</button>}
        </> : <p className="mt-2 text-slate-300">No hay peleas pendientes habilitadas en esta categoría.</p>}
        {pending.length > 1 && <details className="mt-4"><summary className="min-h-11 cursor-pointer font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">Elegir otra pelea pendiente ({pending.length})</summary>
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
      </div>}
    <div className={card}><button type="button" className={button} onClick={() => window.print()}>Imprimir vista del combate</button><p className="mt-2 text-sm text-slate-300">Los resultados confirmados aparecen en Historial. Exportá un respaldo completo desde Respaldo.</p></div>
  </section>;
}
