import type { MatchPhase } from "@/engine/types";

export const PHASE_LABELS: Record<MatchPhase, string> = {
  idle: "Listo",
  round: "Ronda",
  rest: "Descanso",
  overtime: "Tiempo Extra",
  golden_point: "Punto de Oro",
  penalties: "Penalizaciones",
  finished: "Terminado",
};

export const WIN_REASON_LABELS: Record<string, string> = {
  points: "Puntos",
  dq: "Descalificación",
  jury: "Decisión de jurado",
  golden_point: "Punto de oro",
  overtime_points: "Puntos en tiempo extra",
  draw: "Empate",
};

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function sumJudgeTotals(
  judgeTotals: Record<string, { red: number; blue: number }>
): { red: number; blue: number } {
  let red = 0;
  let blue = 0;
  for (const t of Object.values(judgeTotals)) {
    red += t.red;
    blue += t.blue;
  }
  return { red, blue };
}
