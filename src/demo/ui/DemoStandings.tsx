import { useState } from "react";
import { Trophy } from "lucide-react";
import { CategoryPrintPreview } from "@/components/CategoryPrintPreview";
import { createCategoryPrintReport } from "@/lib/category-print";
import { projectRoundRobinStandings, type RoundRobinStanding } from "@/lib/round-robin-resolution";
import type { BracketMatch, BracketSlot, TournamentCategorySnapshot } from "@/store/tournament";
import { getDemoCategoryOutcome, getDemoPendingFights } from "../runtime/selectors";
import type { DemoDeskState } from "../runtime/types";

const button = "min-h-11 rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-medium text-foreground hover:border-primary/60 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function buildDemoStandingsCsv(groups: Map<string, RoundRobinStanding[]>): string {
  const rows = [["Llave", "Posición provisional", "Competidor", "Club", "PJ", "PG", "PE", "PP", "Pts", "Banderas", "P. contra", "Adv"].map(csvCell).join(",")];
  for (const [groupId, standings] of groups) {
    for (const [index, row] of standings.entries()) {
      rows.push([groupId, index + 1, row.name, row.team ?? "", row.played, row.wins, row.draws,
        row.losses, row.points, row.flagsFor, row.foulsAgainst, row.warnings].map(csvCell).join(","));
    }
  }
  return `\uFEFF${rows.join("\r\n")}`;
}

function exportStandingsCsv(categoryName: string, groups: Map<string, RoundRobinStanding[]>): void {
  const url = URL.createObjectURL(new Blob([buildDemoStandingsCsv(groups)], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `clasificacion-demo-${categoryName.trim().replace(/[^\p{L}\p{N}-]+/gu, "-") || "categoria"}.csv`;
  document.body.append(anchor);
  anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function roundLabel(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - 1 - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semifinal";
  if (fromEnd === 2) return "Cuartos";
  return `R${round + 1}`;
}

function slotName(slot: BracketSlot): string {
  if (slot.competitor) return slot.competitor.name;
  return slot.fromMatchId ? "Ganador pendiente" : "Pase libre";
}

function BracketMatchCard({ match, label }: Readonly<{ match: BracketMatch; label: string }>) {
  return <article className="min-w-0 rounded-lg border border-border bg-card p-3" aria-label={`${label}, combate ${match.position + 1}`}>
    <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>Combate {match.position + 1}</span>
      <span>{match.completed ? "Finalizado" : "Pendiente"}</span>
    </div>
    {(["red", "blue"] as const).map((color) => {
      const slot = match[color];
      const won = match.completed && !!slot.competitor && match.winnerId === slot.competitor.id;
      return <div key={color} className={`flex min-w-0 items-center gap-2 border-t border-border py-2 ${won ? "font-bold text-green-400" : "text-foreground"}`}>
        <span className={`size-2 shrink-0 rounded-full ${color === "red" ? "bg-red-400" : "bg-blue-400"}`} aria-hidden="true" />
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{slotName(slot)}</span>
        {won && <span className="sr-only">Ganador</span>}
      </div>;
    })}
  </article>;
}

function EliminationBracket({ category }: Readonly<{ category: TournamentCategorySnapshot }>) {
  const matches = category.bracketMatches;
  if (matches.length === 0) return <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
    Todavía no hay una llave generada para esta categoría.
  </p>;
  const groups = [...new Set(matches.map((match) => match.bracketGroup ?? ""))];
  const finalAB = category.fights.find((fight) => fight.isFinalFight && fight.groupId === "FINAL_AB"
    && !fight.isTiebreakExtra && !fight.isGoldenPointFight);
  return <section className="space-y-5" aria-label="Llave de eliminación">
    {groups.map((group) => {
      const groupMatches = matches.filter((match) => (match.bracketGroup ?? "") === group);
      const rounds = Math.max(...groupMatches.map((match) => match.round)) + 1;
      return <section key={group || "unica"} aria-label={group ? `Grilla ${group}` : "Llave principal"}>
        {group && <h3 className="mb-3 text-base font-bold">Grilla {group}</h3>}
        <div className="grid gap-3 md:flex md:items-start md:overflow-x-auto md:pb-2">
          {Array.from({ length: rounds }, (_, round) => {
            const label = roundLabel(round, rounds);
            const roundMatches = groupMatches.filter((match) => match.round === round)
              .sort((a, b) => a.position - b.position);
            return <div key={label} className="min-w-0 space-y-2 md:w-56 md:shrink-0">
              <h4 className="text-sm font-semibold text-muted-foreground">{label}</h4>
              {roundMatches.map((match) => <BracketMatchCard key={match.id} match={match} label={label} />)}
            </div>;
          })}
        </div>
      </section>;
    })}
    {finalAB && <section aria-label="Final entre grillas" className="rounded-lg border border-border p-3">
      <h3 className="mb-2 text-sm font-bold">Final entre grillas</h3>
      <p className="break-words text-sm"><span className="font-semibold text-red-400">{finalAB.red.name}</span> vs <span className="font-semibold text-blue-400">{finalAB.blue.name}</span></p>
      <p className="mt-1 text-xs text-muted-foreground">{finalAB.completed ? "Finalizada" : "Pendiente"}</p>
    </section>}
  </section>;
}

/** Conservative local classification: never presents provisional group leaders as champions. */
export function DemoStandings({ state, categoryId }: Readonly<{ state: DemoDeskState; categoryId: string | null }>) {
  const [showOfficialReport, setShowOfficialReport] = useState(false);
  const category = categoryId ? state.categories[categoryId] : undefined;
  if (!category || !categoryId) return <section className="rounded-xl border border-border bg-card p-5">
    <h2 className="text-xl font-bold">Tabla y clasificación</h2><p className="mt-2 text-muted-foreground">Primero seleccioná una categoría.</p>
  </section>;
  const outcome = getDemoCategoryOutcome(state, categoryId);
  const pending = getDemoPendingFights(state, categoryId);
  const championId = outcome?.championId;
  const runnerUpId = outcome?.runnerUpId;
  const champion = category.competitors.find((person) => person.id === championId);
  const runnerUp = category.competitors.find((person) => person.id === runnerUpId);
  const resultCount = category.fights.filter((fight) => fight.completed).length;
  const isReview = category.config.mode === "elimination" && outcome && "status" in outcome && outcome.status === "review";
  const groupIds = category.groups.length ? category.groups.map((group) => group.id) : [];
  const projected = projectRoundRobinStandings(category.fights);
  const matchingHistory = category.fights.filter((fight) => fight.completed).every((fight) =>
    state.history.some((entry) => entry.categoryId === categoryId && entry.fightId === fight.id
      && entry.red.id === fight.red.id && entry.blue.id === fight.blue.id && entry.winner === fight.winner
      && (fight.flagsRed === undefined || entry.flagsRed === fight.flagsRed)
      && (fight.flagsBlue === undefined || entry.flagsBlue === fight.flagsBlue)
      && (fight.warningsRed === undefined || entry.warningsRed === fight.warningsRed)
      && (fight.warningsBlue === undefined || entry.warningsBlue === fight.warningsBlue)
      && (fight.foulsRed === undefined || entry.foulsRed === fight.foulsRed)
      && (fight.foulsBlue === undefined || entry.foulsBlue === fight.foulsBlue)));
  const report = createCategoryPrintReport(category, { categoryId, verified: matchingHistory,
    confirmedResultIds: state.history.filter((entry) => entry.categoryId === categoryId).map((entry) => entry.fightId) });

  const isRoundRobin = category.config.mode === "round-robin";
  const isTul = category.config.matchType === "tul";
  return <section className="space-y-4" aria-label={isRoundRobin ? "Tabla de la categoría" : "Llave de la categoría"}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-bold">{isRoundRobin ? "Clasificación" : "Bracket de Eliminación"}</h2>
        <p className="text-sm text-muted-foreground">{category.config.categoryName || "Categoría sin nombre"} · {isRoundRobin ? "Round Robin" : "Eliminación"}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-border bg-secondary px-3 py-1.5 text-xs text-muted-foreground">{resultCount} / {category.fights.length} combates</span>
        <button type="button" className={button} onClick={() => window.print()}>Imprimir vista</button>
        {isRoundRobin && projected.size > 0 && <button type="button" className={button}
          onClick={() => exportStandingsCsv(category.config.categoryName, projected)}>Exportar CSV</button>}
        {report && <button type="button" className={button} onClick={() => setShowOfficialReport(true)}>Planilla oficial / PDF</button>}
      </div>
    </header>
    {category.phase === "setup" ? <p className="rounded-lg border border-border bg-card p-3 text-sm">
      La categoría aún no comenzó; la vista previa está en Competidores.
    </p> : <>
      {champion && <div className="flex flex-wrap items-center gap-4 rounded-xl border border-yellow-700/40 bg-gradient-to-r from-yellow-950/40 via-yellow-900/20 to-card p-4">
        <Trophy className="size-9 shrink-0 text-yellow-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-yellow-400">Oro · Campeón</p>
          <p className="break-words text-xl font-black text-yellow-200">{champion.name}</p>
        </div>
        {runnerUp && <div className="min-w-0 border-l border-yellow-700/40 pl-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-300">Plata · Subcampeón</p>
          <p className="break-words text-lg font-bold">{runnerUp.name}</p>
        </div>}
      </div>}
      {!champion && <p className="rounded-lg border border-amber-500/60 bg-amber-500/5 p-3 text-sm text-amber-200" role="status">
        {isReview ? "La llave requiere revisión; no se asigna campeón automáticamente."
          : pending.length ? isRoundRobin
            ? "Hay combates pendientes. Los líderes parciales no son campeones confirmados."
            : "Hay combates pendientes. La llave aún no define un campeón confirmado."
            : "No hay campeón confirmado. Puede faltar un desempate, una final o revisar la llave."}
      </p>}
      {isRoundRobin ? groupIds.length > 0 && <>
        <p className="text-sm text-muted-foreground">Tabla provisional por llave. La posición puede cambiar con desempates; el campeón solo se muestra cuando se resuelva.</p>
        <div className="space-y-4">{groupIds.map((groupId) => <section key={groupId} className="min-w-0 rounded-xl border border-border bg-card p-3" aria-label={`Llave ${groupId}`}>
          <h3 className="mb-3 flex items-center gap-2 font-bold"><Trophy className="size-4" aria-hidden="true" />Llave {groupId}</h3>
          <table className="w-full table-fixed text-left text-sm sm:table-auto">
            <thead><tr className="border-b border-border text-muted-foreground">
              <th scope="col" className="w-9 p-1.5 sm:p-2">Pos</th>
              <th scope="col" className="p-1.5 sm:p-2">Nombre</th>
              {!isTul && <>
                <th scope="col" className="hidden p-2 text-center sm:table-cell">PJ</th>
                <th scope="col" className="w-14 p-1 text-center text-xs sm:w-auto sm:p-2 sm:text-sm">Ganados</th>
                <th scope="col" className="hidden p-2 text-center sm:table-cell">Empates</th>
                <th scope="col" className="hidden p-2 text-center sm:table-cell">Perdidos</th>
                <th scope="col" className="w-12 p-1 text-center font-bold text-foreground sm:w-auto sm:p-2">Puntos</th>
                <th scope="col" className="hidden p-2 text-center sm:table-cell">Banderas</th>
                <th scope="col" className="hidden p-2 text-center sm:table-cell">P. contra</th>
                <th scope="col" className="hidden p-2 text-center sm:table-cell">Adv</th>
              </>}
            </tr></thead>
            <tbody>{(projected.get(groupId) ?? []).map((row, index) => <tr key={row.id} className="border-b border-border/70 last:border-b-0">
              <td className="p-1.5 align-top font-bold sm:p-2">{index + 1}</td>
              <th scope="row" className="min-w-0 break-words p-1.5 align-top font-medium [overflow-wrap:anywhere] sm:p-2">
                {row.name}{row.team && <small className="block font-normal text-muted-foreground">{row.team}</small>}
              </th>
              {!isTul && <>
                <td className="hidden p-2 text-center sm:table-cell">{row.played}</td>
                <td className="p-1 text-center sm:p-2">{row.wins}</td>
                <td className="hidden p-2 text-center sm:table-cell">{row.draws}</td>
                <td className="hidden p-2 text-center sm:table-cell">{row.losses}</td>
                <td className="p-1 text-center font-bold sm:p-2">{row.points}</td>
                <td className="hidden p-2 text-center sm:table-cell">{row.flagsFor}</td>
                <td className="hidden p-2 text-center sm:table-cell">{row.foulsAgainst}</td>
                <td className="hidden p-2 text-center sm:table-cell">{row.warnings}</td>
              </>}
            </tr>)}</tbody>
          </table>
        </section>)}</div>
      </> : <EliminationBracket category={category} />}
      <section className="rounded-xl border border-border bg-card p-3">
        <h3 className="text-base font-bold">Combates registrados</h3>
        <ol className="mt-2 space-y-2">{category.fights.map((fight, index) => <li key={fight.id}
          className="rounded-lg border border-border p-3 text-sm">
          <span className="mr-2 text-muted-foreground">{index + 1}{fight.groupId ? ` · ${fight.groupId}` : ""}</span>
          <span className="font-semibold text-red-400">{fight.red.name}</span> vs <span className="font-semibold text-blue-400">{fight.blue.name}</span>
          <span className="block text-muted-foreground sm:ml-2 sm:inline">{fight.completed
            ? "Ganador: " + (fight.winner === "red" ? fight.red.name : fight.winner === "blue" ? fight.blue.name : "Empate") +
              (fight.flagsRed !== undefined || fight.flagsBlue !== undefined ? ` · Banderas ${fight.flagsRed ?? 0}-${fight.flagsBlue ?? 0}` : "")
            : "Pendiente"}</span>
        </li>)}</ol>
      </section>
    </>}
    {showOfficialReport && report && <CategoryPrintPreview report={report} onBack={() => setShowOfficialReport(false)} />}
  </section>;
}
