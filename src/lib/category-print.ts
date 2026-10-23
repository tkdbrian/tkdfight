import type { BracketMatch, CompetitorEntry, FightEntry, TournamentCategorySnapshot, TournamentConfig } from "@/store/tournament";
import { resolveEliminationOutcome } from "./category-lifecycle";
import { compareRoundRobinRank, isExternalGuestFight, rankedGroupIds, resolveFirstPlace, roundRobinOutcome } from "./round-robin-resolution";
import { POINTS_DRAW, POINTS_LOSS, POINTS_WIN } from "@/rules/round-robin";
import { AGE_DIVISIONS, validateDanRange } from "./yusan-profile";

export interface CategoryPrintVerification {
  categoryId: string;
  verified: boolean;
  confirmedResultIds: readonly string[];
  tatami?: string;
}
export interface CategoryPrintEligibility { eligible: boolean; reason: string | null; requiredResultIds: string[] }
export interface PrintCompetitor { id: string; name: string; club?: string }
export interface CategoryPrintStanding extends PrintCompetitor {
  position: number; played: number; wins: number; draws: number; losses: number;
  points: number; flagsFor: number; foulsAgainst: number; warnings: number;
}
export interface CategoryPrintGroup { id: string; label: string; rows: CategoryPrintStanding[] }
export interface CategoryPrintSlot {
  name: string; club?: string; sourceMatchId?: string; sourcePanelId?: string;
  competitorId?: string; entryNumber?: number; inputPosition?: number;
}
export interface CategoryPrintMatch {
  id: string; label: string; red: CategoryPrintSlot; blue: CategoryPrintSlot; winnerName: string; isBye: boolean;
  nextMatchId?: string; nextPanelId?: string;
  winnerId?: string;
}
export interface CategoryPrintPanel {
  id: string; label: string; group: "A" | "B" | null; inputSlots: number;
  rounds: { round: number; label: string; matches: CategoryPrintMatch[] }[];
}
export interface CategoryPrintFight {
  id: string; label: string; redName: string; blueName: string; winnerName: string;
  flagsRed: number | null; flagsBlue: number | null;
}
export interface CategoryPrintRosterEntry extends PrintCompetitor { entryNumber: number }
export interface CategoryPrintClassicSheet extends CategoryPrintPanel {
  roster: CategoryPrintRosterEntry[];
  isInterGroupFinal?: boolean;
}
export interface CategoryPrintMetadata {
  discipline: "Formas" | "Lucha";
  grade: string | null; age: string | null;
  sex: "Masculino" | "Femenino" | "Mixto" | null; weight: string | null;
}
export interface CategoryPrintReport {
  categoryId: string; title: string; eventName: string | null; tatami: string | null;
  discipline: "Sparring" | "Tul / Formas"; generatedAt: string; format: "round-robin" | "elimination";
  champion: PrintCompetitor; runnerUp: PrintCompetitor | null;
  groups: CategoryPrintGroup[]; panels: CategoryPrintPanel[]; appendix: CategoryPrintFight[]; details: CategoryPrintFight[];
  classicSheets?: CategoryPrintClassicSheet[]; classicExtras?: CategoryPrintFight[]; tableChief?: string | null;
  categoryMetadata?: CategoryPrintMetadata;
}

function formattedAge(from: number, to?: number): string {
  return to === undefined ? `${from}+ años` : from === to ? `${from} años` : `${from}-${to} años`;
}

function ageNumber(value: string): number | null {
  const number = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** Structured dimensions only: a free-text category caption is never evidence of a selected field. */
export function createCategoryPrintMetadata(config: TournamentConfig): CategoryPrintMetadata {
  let grade: string | null = null;
  if (config.gradeSystem === "GUPS") grade = config.gupBand?.trim() ? `GUPS · ${config.gupBand.trim()}` : null;
  if (config.gradeSystem === "DAN" && !validateDanRange(String(config.danFrom),String(config.danTo)))
    grade = config.danFrom === config.danTo ? `${config.danFrom} Dan` : `${config.danFrom}-${config.danTo} Dan`;
  const from = config.categoryAgeFrom?.trim() ?? "", to = config.categoryAgeTo?.trim() ?? "";
  let age: string | null = null;
  if (from || to || config.categoryAgeOpenEnded) {
    const first = ageNumber(from), last = ageNumber(to);
    if (first !== null && config.categoryAgeOpenEnded) age = formattedAge(first);
    else if (first !== null && last !== null && first <= last) age = formattedAge(first,last);
  } else {
    const division = AGE_DIVISIONS.find((entry) => entry.id === config.ageDivision);
    if (division) age = formattedAge(division.from,division.to);
  }
  const sex = config.sexDivision;
  return { discipline: config.matchType === "tul" ? "Formas" : "Lucha", grade, age,
    sex: sex === "Masculino" || sex === "Femenino" || sex === "Mixto" ? sex : null,
    weight: config.matchType === "tul" ? null : config.weightLabel?.trim() || null };
}

function categoryFights(snapshot: TournamentCategorySnapshot): FightEntry[] {
  return snapshot.fights.filter((fight) => !isExternalGuestFight(fight));
}

function outcome(snapshot: TournamentCategorySnapshot): { championId: string | null; runnerUpId: string | null; requiredResultIds: string[] } {
  if (snapshot.config.mode === "elimination") {
    const resolved = resolveEliminationOutcome(snapshot);
    return resolved.status === "resolved" ? resolved : { championId: null, runnerUpId: null, requiredResultIds: [] };
  }
  const resolved = roundRobinOutcome(categoryFights(snapshot), snapshot.groups.length ? snapshot.groups : undefined);
  return { ...resolved, requiredResultIds: categoryFights(snapshot).map((fight) => fight.id) };
}

/** Completion is canonical, never inferred from the current UI phase or table leader. */
export function getCategoryPrintEligibility(snapshot: TournamentCategorySnapshot, verification: CategoryPrintVerification): CategoryPrintEligibility {
  const result = outcome(snapshot);
  const requiredResultIds = [...new Set(result.requiredResultIds)];
  const fail = (reason: string): CategoryPrintEligibility => ({ eligible: false, reason, requiredResultIds });
  if (verification.categoryId !== snapshot.config.id) return fail("La categoría cambió; volvé a verificar los resultados.");
  if (!result.championId || requiredResultIds.length === 0) return fail("Faltan combates, una final o un desempate por resolver.");
  if (categoryFights(snapshot).some((fight) => !fight.completed || !fight.winner))
    return fail("Hay combates pendientes; no se imprimió una clasificación definitiva.");
  if (!verification.verified || requiredResultIds.some((id) => !verification.confirmedResultIds.includes(id)))
    return fail("Falta verificar los resultados confirmados en el servidor.");
  if (!snapshot.competitors.some((competitor) => competitor.id === result.championId))
    return fail("No se pudo identificar al ganador de esta categoría.");
  return { eligible: true, reason: null, requiredResultIds };
}

function competitor(entry: CompetitorEntry): PrintCompetitor {
  return { id: entry.id, name: entry.name, ...(entry.team ? { club: entry.team } : {}) };
}

function groupRows(snapshot: TournamentCategorySnapshot, id: string): CategoryPrintStanding[] {
  const all = categoryFights(snapshot);
  const regular = all.filter((fight) => (fight.groupId ?? "G1") === id && !fight.isFinalFight && !fight.isTiebreakExtra && !fight.isGoldenPointFight);
  const entrants = snapshot.groups.find((group) => group.id === id)?.competitors ??
    [...new Map(regular.flatMap((fight) => [fight.red, fight.blue]).map((entry) => [entry.id, entry])).values()];
  const rows = new Map(entrants.map((entry) => [entry.id, { ...competitor(entry), position: 0, played: 0, wins: 0, draws: 0, losses: 0,
    points: 0, flagsFor: 0, foulsAgainst: 0, warnings: 0 }]));
  for (const fight of regular) {
    if (!fight.completed) continue;
    const red = rows.get(fight.red.id), blue = rows.get(fight.blue.id);
    if (!red || !blue) continue;
    red.played++; blue.played++;
    red.flagsFor += fight.flagsRed ?? 0; blue.flagsFor += fight.flagsBlue ?? 0;
    red.foulsAgainst += fight.foulsRed ?? 0; blue.foulsAgainst += fight.foulsBlue ?? 0;
    red.warnings += fight.warningsRed ?? 0; blue.warnings += fight.warningsBlue ?? 0;
    if (fight.winner === "red") { red.wins++; blue.losses++; red.points += POINTS_WIN; blue.points += POINTS_LOSS; }
    else if (fight.winner === "blue") { blue.wins++; red.losses++; blue.points += POINTS_WIN; red.points += POINTS_LOSS; }
    else { red.draws++; blue.draws++; red.points += POINTS_DRAW; blue.points += POINTS_DRAW; }
  }
  const ordered = [...rows.values()].sort(compareRoundRobinRank);
  const resolution = resolveFirstPlace(id, ordered, all, entrants.map((entry) => entry.id));
  if (resolution.status === "resolved" && resolution.resolvedOrder) {
    const positions = ordered.flatMap((row, index) => resolution.tiedIds.includes(row.id) ? [index] : []);
    for (const [index, competitorId] of resolution.resolvedOrder.entries()) {
      const row = rows.get(competitorId), position = positions[index];
      if (row && position !== undefined) ordered[position] = row;
    }
  }
  return ordered.map((row, index) => ({ ...row, position: index + 1 }));
}

function roundLabel(round: number, maxRound: number): string {
  const remaining = maxRound - round;
  return remaining === 0 ? "Final de llave" : remaining === 1 ? "Semifinal" : remaining === 2 ? "Cuartos" : `Ronda ${round + 1}`;
}

/** Two-round bands leave room for wrapped names/clubs at a legible printed font size. */
function bracketPanels(matches: BracketMatch[], bandSize = 2): CategoryPrintPanel[] {
  const panels: CategoryPrintPanel[] = [];
  const assignments = new Map<string, string>();
  const labels = new Map(matches.map((match,index) => [match.id,`Combate ${index + 1}`]));
  const nextById = new Map<string, BracketMatch>();
  for (const match of matches) for (const slot of [match.red, match.blue]) if (slot.fromMatchId) nextById.set(slot.fromMatchId, match);
  for (const group of [null, "A", "B"] as const) {
    const cohort = matches.filter((match) => (match.bracketGroup ?? null) === group);
    if (!cohort.length) continue;
    const maxRound = Math.max(...cohort.map((match) => match.round));
    const buckets = new Map<string, BracketMatch[]>();
    for (const match of cohort) {
      const lastRound = Math.min(maxRound, Math.floor(match.round / bandSize) * bandSize + bandSize - 1);
      let root = match;
      while (root.round < lastRound) { const next = nextById.get(root.id); if (!next) break; root = next; }
      const key = `${Math.floor(match.round / bandSize)}:${root.id}`;
      const bucket = buckets.get(key) ?? []; bucket.push(match); buckets.set(key, bucket);
    }
    const sorted = [...buckets.values()].sort((a,b) => Math.min(...a.map((m) => m.round)) - Math.min(...b.map((m) => m.round)) || Math.min(...a.map((m) => m.position)) - Math.min(...b.map((m) => m.position)));
    for (const bucket of sorted) {
      const id = `panel-${panels.length + 1}`;
      bucket.forEach((match) => assignments.set(match.id, id));
      const firstRound = Math.min(...bucket.map((match) => match.round));
      const roundNumbers = [...new Set(bucket.map((match) => match.round))].sort((a,b) => a-b);
      const slot = (entry: BracketMatch["red"]): CategoryPrintSlot => ({ name: entry.competitor?.name ?? (entry.fromMatchId ? "Ganador por referencia" : "Pase libre (BYE)"),
        ...(entry.competitor?.team ? { club: entry.competitor.team } : {}), ...(entry.fromMatchId ? { sourceMatchId: entry.fromMatchId } : {}) });
      panels.push({ id, label: `${group ? `Llave ${group}` : "Llave"} · Panel ${panels.length + 1}`, group,
        inputSlots: bucket.filter((match) => match.round === firstRound).length * 2,
        rounds: roundNumbers.map((round) => ({ round, label: roundLabel(round,maxRound), matches: bucket.filter((match) => match.round === round).sort((a,b) => a.position-b.position).map((match) => ({
          id: match.id, label: labels.get(match.id) ?? "Combate",
          red: slot(match.red), blue: slot(match.blue),
          winnerName: [match.red.competitor,match.blue.competitor].find((entry) => entry?.id === match.winnerId)?.name ?? "Pendiente de revisión",
          isBye: !match.red.competitor || !match.blue.competitor,
          ...(nextById.has(match.id) ? { nextMatchId: nextById.get(match.id)!.id } : {}),
        })) })) });
    }
  }
  for (const panel of panels) for (const round of panel.rounds) for (const match of round.matches) {
    for (const slot of [match.red,match.blue]) {
      const source = slot.sourceMatchId ? assignments.get(slot.sourceMatchId) : undefined;
      if (source && source !== panel.id) slot.sourcePanelId = source;
    }
    const next = match.nextMatchId ? assignments.get(match.nextMatchId) : undefined;
    if (next && next !== panel.id) match.nextPanelId = next;
    if (match.isBye) match.label = `Pase libre ${match.label.replace("Combate ", "")} (sin combate)`;
  }
  return panels;
}

/** Four-round bands preserve the complete classic sixteen-position tree on one sheet. */
function classicSheets(snapshot: TournamentCategorySnapshot, championId: string): CategoryPrintClassicSheet[] {
  const entries = snapshot.competitors.map((entry,index) => ({ ...competitor(entry), entryNumber: index + 1 }));
  const rosterById = new Map(entries.map((entry) => [entry.id,entry]));
  const matchesById = new Map(snapshot.bracketMatches.map((match) => [match.id,match]));
  const references = new Map(snapshot.bracketMatches.map((match,index) => [match.id,`Cruce ${index + 1}`]));
  const sheets: CategoryPrintClassicSheet[] = bracketPanels(snapshot.bracketMatches,4).map((panel) => {
    const ids = new Set<string>();
    for (const round of panel.rounds) for (const match of round.matches) {
      const original = matchesById.get(match.id)!;
      match.label = references.get(match.id) ?? "Cruce";
      match.winnerId = original.winnerId ?? undefined;
      for (const [side,offset] of [["red",0],["blue",1]] as const) {
        const slot = match[side], entry = original[side].competitor;
        delete slot.club;
        if (entry) {
          ids.add(entry.id); slot.competitorId = entry.id;
          slot.entryNumber = rosterById.get(entry.id)?.entryNumber;
        }
        if (original.round === 0) slot.inputPosition = original.position * 2 + offset + 1;
      }
    }
    return { ...panel, roster: entries.filter((entry) => ids.has(entry.id)) };
  });
  const final = categoryFights(snapshot).find((fight) => fight.groupId === "FINAL_AB" && fight.isFinalFight && !fight.isTiebreakExtra && !fight.isGoldenPointFight);
  if (final) {
    const id = `panel-${sheets.length + 1}`;
    const slot = (entry: CompetitorEntry): CategoryPrintSlot => {
      const sourceSheet = sheets.find((sheet) => sheet.rounds.at(-1)?.matches.some((match) => !match.nextMatchId && match.winnerId === entry.id));
      const source = sourceSheet?.rounds.at(-1)?.matches.find((match) => match.winnerId === entry.id);
      if (source) { source.nextMatchId = final.id; source.nextPanelId = id; }
      return { name: entry.name, competitorId: entry.id, entryNumber: rosterById.get(entry.id)?.entryNumber,
        ...(source ? { sourceMatchId: source.id, sourcePanelId: sourceSheet!.id } : {}) };
    };
    sheets.push({ id, label: "Final entre llaves", group: null, inputSlots: 2, isInterGroupFinal: true,
      roster: entries.filter((entry) => entry.id === final.red.id || entry.id === final.blue.id),
      rounds: [{ round: 0, label: "Final entre llaves", matches: [{ id: final.id, label: "Final entre llaves",
        red: slot(final.red), blue: slot(final.blue), winnerId: championId,
        winnerName: rosterById.get(championId)?.name ?? "Pendiente de revisión", isBye: false }] }] });
  }
  return sheets;
}

function fightDetails(fight: FightEntry, bracketFinal = false): CategoryPrintFight {
  const phase = fight.isGoldenPointFight ? "Punto de Oro" : fight.isTiebreakExtra ? "Desempate" : fight.isFinalFight ? "Final" : bracketFinal ? "Final de llave" : "Combate";
  return { id: fight.id, label: `${phase}${fight.groupId ? ` · ${fight.groupId}` : ""}`,
    redName: fight.red.name, blueName: fight.blue.name,
    winnerName: fight.winner === "red" ? fight.red.name : fight.winner === "blue" ? fight.blue.name : "Empate",
    flagsRed: fight.flagsRed ?? null, flagsBlue: fight.flagsBlue ?? null };
}

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

/** Derive once from a detached snapshot; printing cannot mutate the tournament or execute commands. */
export function createCategoryPrintReport(snapshot: TournamentCategorySnapshot, verification: CategoryPrintVerification, generatedAt = new Date()): CategoryPrintReport | null {
  const frozen = structuredClone(snapshot);
  if (!getCategoryPrintEligibility(frozen,verification).eligible || !Number.isFinite(generatedAt.getTime())) return null;
  const resolved = outcome(frozen);
  const champion = frozen.competitors.find((entry) => entry.id === resolved.championId);
  if (!champion) return null;
  const runnerUp = frozen.competitors.find((entry) => entry.id === resolved.runnerUpId);
  const fights = categoryFights(frozen);
  const feeders = new Set(frozen.bracketMatches.flatMap((match) => [match.red.fromMatchId,match.blue.fromMatchId]));
  const terminalIds = new Set(frozen.bracketMatches.filter((match) => !feeders.has(match.id)).map((match) => match.id));
  const appendixFight = (fight: FightEntry): boolean => Boolean(fight.isTiebreakExtra || fight.isGoldenPointFight || fight.isFinalFight ||
    (frozen.config.mode === "elimination" && fight.bracketMatchId && terminalIds.has(fight.bracketMatchId)));
  const report: CategoryPrintReport = {
    categoryId: frozen.config.id, title: frozen.config.categoryName.trim() || "Categoría",
    eventName: frozen.config.tournamentName.trim() || null, tatami: verification.tatami?.trim() || null,
    discipline: frozen.config.matchType === "tul" ? "Tul / Formas" : "Sparring", generatedAt: generatedAt.toISOString(),
    format: frozen.config.mode === "elimination" ? "elimination" : "round-robin", champion: competitor(champion), runnerUp: runnerUp ? competitor(runnerUp) : null,
    groups: frozen.config.mode === "elimination" ? [] : (frozen.groups.length ? frozen.groups.map((group) => group.id) : rankedGroupIds(fights)).map((id) => ({ id, label: `Llave ${id}`, rows: groupRows(frozen,id) })),
    panels: frozen.config.mode === "elimination" ? bracketPanels(frozen.bracketMatches) : [],
    classicSheets: frozen.config.mode === "elimination" ? classicSheets(frozen,champion.id) : [],
    classicExtras: frozen.config.mode === "elimination" ? fights.filter((fight) => fight.isTiebreakExtra || fight.isGoldenPointFight).map((fight) => fightDetails(fight)) : [],
    tableChief: frozen.config.tableChief.trim() || null,
    categoryMetadata: createCategoryPrintMetadata(frozen.config),
    appendix: fights.filter(appendixFight).map((fight) => fightDetails(fight, Boolean(fight.bracketMatchId && terminalIds.has(fight.bracketMatchId)))),
    details: fights.filter((fight) => frozen.config.mode === "elimination" ? !fight.isTiebreakExtra && !fight.isGoldenPointFight : !appendixFight(fight))
      .map((fight) => fightDetails(fight, Boolean(fight.bracketMatchId && terminalIds.has(fight.bracketMatchId)))),
  };
  freeze(report);
  return report;
}
