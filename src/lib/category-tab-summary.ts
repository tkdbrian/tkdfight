export type CategoryTabDiscipline = "sparring" | "tul";
export type CategoryTabMode = "round-robin" | "elimination" | "groups";

export function categoryTabSummary(input: {
  tournamentName?: string;
  matchType?: CategoryTabDiscipline;
  mode?: CategoryTabMode;
}): string {
  const discipline = input.matchType === "tul" ? "Tul" : "Sparring";
  const format = input.mode === "elimination" ? "Eliminaci\u00f3n" : "Round Robin";
  return [input.tournamentName?.trim(), discipline, format].filter(Boolean).join(" \u00b7 ");
}
