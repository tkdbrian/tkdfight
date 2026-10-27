import { useState } from "react";
import { CategoryPrintPreview } from "@/components/CategoryPrintPreview";
import { createCategoryPrintReport } from "@/lib/category-print";
import { projectRoundRobinStandings, type RoundRobinStanding } from "@/lib/round-robin-resolution";
import { getDemoCategoryOutcome, getDemoPendingFights } from "../runtime/selectors";
import type { DemoDeskState } from "../runtime/types";

const button = "min-h-11 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-base hover:border-cyan-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300";

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

/** Conservative local classification: never presents provisional group leaders as champions. */
export function DemoStandings({ state, categoryId }: Readonly<{ state: DemoDeskState; categoryId: string | null }>) {
  const [showOfficialReport, setShowOfficialReport] = useState(false);
  const category = categoryId ? state.categories[categoryId] : undefined;
  if (!category || !categoryId) return <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
    <h2 className="text-xl font-bold">Tabla y clasificación</h2><p className="mt-2 text-slate-300">Primero seleccioná una categoría.</p>
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

  return <section className="rounded-2xl border border-slate-700 bg-slate-900 p-4 sm:p-5" aria-label="Tabla de la categoría">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="text-xl font-bold">Tabla y clasificación</h2>
      <p className="text-slate-300">{category.config.categoryName || "Categoría sin nombre"} · {category.config.mode === "round-robin" ? "Round Robin" : "Eliminación"}</p></div>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={() => window.print()}>Imprimir vista</button>
        {category.config.mode === "round-robin" && projected.size > 0 && <button type="button" className={button}
          onClick={() => exportStandingsCsv(category.config.categoryName, projected)}>Exportar CSV</button>}
        {report && <button type="button" className={`${button} border-cyan-400`} onClick={() => setShowOfficialReport(true)}>Planilla oficial / PDF</button>}
      </div></div>
    {category.phase === "setup" ? <p className="mt-4 rounded-lg border border-slate-600 p-3">La categoría aún no comenzó; la vista previa está en Categorías.</p>
      : <>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-600 p-3"><p className="text-sm text-slate-300">Resultados</p><p className="text-2xl font-bold">{resultCount} / {category.fights.length}</p></div>
          <div className="rounded-lg border border-slate-600 p-3"><p className="text-sm text-slate-300">Peleas pendientes habilitadas</p><p className="text-2xl font-bold">{pending.length}</p></div>
          <div className="rounded-lg border border-slate-600 p-3"><p className="text-sm text-slate-300">Campeón confirmado</p><p className="break-words text-lg font-bold">{champion?.name ?? "Pendiente"}</p></div>
        </div>
        {runnerUp && <p className="mt-3 rounded-lg border border-slate-600 p-3">Subcampeón: <strong>{runnerUp.name}</strong></p>}
        {!champion && <p className="mt-3 rounded-lg border border-amber-500 p-3 text-amber-200" role="status">
          {isReview ? "La llave requiere revisión; no se asigna campeón automáticamente."
            : pending.length ? "Hay combates pendientes. Los líderes parciales no son campeones confirmados."
              : "No hay campeón confirmado. Puede faltar un desempate, una final o revisar la llave."}
        </p>}
        {category.config.mode === "round-robin" && groupIds.length > 0 && <>
          <p className="mt-3 text-sm text-slate-300">Tabla provisional por llave. La posición puede cambiar con desempates; el campeón solo se muestra cuando la autoridad deportiva lo resuelve.</p>
          <div className="mt-3 space-y-4">{groupIds.map((groupId) => <div key={groupId} className="overflow-x-auto rounded-lg border border-slate-700 p-2">
            <h3 className="mb-2 font-bold">Llave {groupId}</h3>
            <table className="min-w-[38rem] w-full text-left text-sm"><thead><tr className="border-b border-slate-600 text-slate-300">
              <th scope="col" className="p-2">Pos. prov.</th><th scope="col" className="p-2">Competidor</th><th scope="col" className="p-2">PJ</th>
              <th scope="col" className="p-2">PG</th><th scope="col" className="p-2">PE</th><th scope="col" className="p-2">PP</th>
              <th scope="col" className="p-2">Pts</th><th scope="col" className="p-2">Banderas</th><th scope="col" className="p-2">P. contra</th><th scope="col" className="p-2">Adv</th>
            </tr></thead><tbody>{(projected.get(groupId) ?? []).map((row, index) => <tr key={row.id} className="border-b border-slate-800">
              <td className="p-2">{index + 1}</td><th scope="row" className="p-2">{row.name}{row.team && <small className="block font-normal text-slate-400">{row.team}</small>}</th>
              <td className="p-2">{row.played}</td><td className="p-2">{row.wins}</td><td className="p-2">{row.draws}</td><td className="p-2">{row.losses}</td>
              <td className="p-2 font-bold">{row.points}</td><td className="p-2">{row.flagsFor}</td><td className="p-2">{row.foulsAgainst}</td><td className="p-2">{row.warnings}</td>
            </tr>)}</tbody></table>
          </div>)}</div>
        </>}
        <h3 className="mt-5 text-lg font-bold">Combates registrados</h3>
        <ol className="mt-2 space-y-2">{category.fights.map((fight, index) => <li key={fight.id}
          className="rounded-lg border border-slate-700 p-3 text-base">
          <span className="mr-2 text-sm text-slate-400">{index + 1}{fight.groupId ? ` · ${fight.groupId}` : ""}</span>
          <span className="font-semibold text-red-400">{fight.red.name}</span> vs <span className="font-semibold text-blue-400">{fight.blue.name}</span>
          <span className="ml-2 block text-sm text-slate-300 sm:inline">{fight.completed
            ? `Ganador: ${fight.winner === "red" ? fight.red.name : fight.winner === "blue" ? fight.blue.name : "Empate"}${fight.flagsRed !== undefined || fight.flagsBlue !== undefined ? ` · Banderas ${fight.flagsRed ?? 0}-${fight.flagsBlue ?? 0}` : ""}`
            : "Pendiente"}</span>
        </li>)}</ol>
      </>}
    {showOfficialReport && report && <CategoryPrintPreview report={report} onBack={() => setShowOfficialReport(false)} />}
  </section>;
}
