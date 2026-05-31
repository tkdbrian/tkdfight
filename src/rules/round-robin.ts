/**
 * ══════════════════════════════════════════════════════════════════════════
 *  ROUND-ROBIN — REGLAS CANÓNICAS
 *  Fuente de verdad para el modo round-robin (una o varias llaves).
 *  NO modificar sin entender el impacto en StandingsPage, ResultsPage
 *  y FightPage. Estas constantes son importadas por toda la app.
 * ══════════════════════════════════════════════════════════════════════════
 */

// ── Puntuación regular ─────────────────────────────────────────────────────

/** Puntos otorgados al GANADOR de una pelea regular. */
export const POINTS_WIN = 3;

/** Puntos otorgados a CADA competidor en caso de empate (winner === "draw"). */
export const POINTS_DRAW = 1;

/** Puntos otorgados al PERDEDOR. */
export const POINTS_LOSS = 0;

// ── Peleas por grupo ───────────────────────────────────────────────────────

/**
 * Número de peleas regulares que genera un grupo de n competidores.
 * Fórmula: n * (n - 1) / 2  (cada par pelea exactamente 1 vez)
 *
 * n=3 → 3 · n=4 → 6 · n=5 → 10
 */
export function fightCountForGroup(n: number): number {
  return (n * (n - 1)) / 2;
}

// ── Tamaños de grupo soportados ────────────────────────────────────────────

export const SUPPORTED_GROUP_SIZES = [3, 4, 5] as const;
export type SupportedGroupSize = (typeof SUPPORTED_GROUP_SIZES)[number];

// ── Desempate (Tiebreak) ───────────────────────────────────────────────────

/**
 * CUÁNDO se activa el desempate:
 * Cuando 2+ competidores comparten el PRIMER LUGAR al terminar todas
 * las peleas regulares del grupo, igualados en:
 *   1. Puntos · 2. Banderas a favor · 3. Faltas en contra · 4. Advertencias
 *
 * Solo se desempata el primer lugar. No hay desempate para otras posiciones.
 */
export const TIEBREAK_DETECTS_ONLY_FIRST_PLACE = true;

/**
 * Formato: mini round-robin entre los empatados (isTiebreakExtra = true).
 * Mismas reglas de puntuación que las peleas regulares.
 */
export const TIEBREAK_FORMAT = "mini-round-robin" as const;

/**
 * REGLA CRÍTICA — cómo cuentan las peleas de desempate en estadísticas:
 *
 * - Toda la secuencia (par + grupo) = 1 "Jugado" adicional (deduplicado).
 * - NO suman a Ganados / Empates / Perdidos / Puntos.
 * - NO suman a Banderas, Faltas ni Advertencias.
 *
 * Razón: el desempate es un mecanismo ADMINISTRATIVO para resolver la posición,
 * no un resultado competitivo. Incluirlo distorsionaría el rendimiento real.
 */
export const TIEBREAK_STATS_RULE = {
  countsAsJugado: 1,
  countsAsWin: false,
  countsAsLoss: false,
  countsDraw: false,
  countsPoints: false,
  countsFlags: false,
  countsFouls: false,
  countsWarnings: false,
} as const;

// ── Punto de Oro (Golden Point) ────────────────────────────────────────────

/**
 * CUÁNDO se activa:
 * Cuando una pelea de desempate termina en EMPATE y el desempate sigue sin
 * resolverse. La siguiente pelea del mismo par → isGoldenPointFight = true.
 *
 * En FightPage: el primer punto anotado termina la pelea (no se espera el tiempo).
 * Las peleas GP heredan las mismas reglas estadísticas que el desempate.
 */
export const GOLDEN_POINT_TRIGGER = "tiebreak-ends-in-draw" as const;
export const GOLDEN_POINT_STATS_RULE = TIEBREAK_STATS_RULE;

// ── Orden de criterios para resolver empatados ─────────────────────────────

/**
 * Aplicados en cascada usando SOLO estadísticas de las peleas isTiebreakExtra
 * del mismo grupo:
 *   1. Puntos desc  2. Banderas a favor desc
 *   3. Faltas en contra asc  4. Advertencias asc
 *   5. Si todo sigue igual → Punto de Oro
 */
export const TIEBREAK_SORT_ORDER = [
  "points-desc",
  "flagsFor-desc",
  "foulsAgainst-asc",
  "warnings-asc",
  "golden-point",
] as const;

// ── Llave única (Single Group) ─────────────────────────────────────────────

/**
 * Con UNA SOLA LLAVE no existe Fase Final.
 * El campeón es el 1° del ranking tras resolver todos los desempates.
 * isFinalReady() requiere 2+ grupos por diseño — esta regla no es configurable.
 */
export const SINGLE_GROUP_HAS_NO_FINAL = true;

// ══════════════════════════════════════════════════════════════════════════
//  MULTI-LLAVE — REGLAS CANÓNICAS (2+ grupos)
//  Se activa automáticamente cuando hay 6–12 competidores.
//  Todas las reglas anteriores (puntuación, desempate, GP) aplican igual
//  a cada llave de forma INDEPENDIENTE.
// ══════════════════════════════════════════════════════════════════════════

// ── Distribución de competidores en grupos ─────────────────────────────────

/**
 * Tabla fija: n competidores → tamaños de cada grupo.
 * Refleja exactamente GROUP_DISTRIBUTION en bracket.ts.
 *
 *   6 → [3, 3]    7 → [3, 4]    8 → [4, 4]
 *   9 → [5, 4]   10 → [5, 5]
 *  11 → [3, 4, 4]   12 → [4, 4, 4]
 *
 * Diseño: grupos de 3–5. Nunca grupos de 2 (inútil) ni de 6+ (demasiadas peleas).
 */
export const GROUP_DISTRIBUTION: Record<number, readonly number[]> = {
  6:  [3, 3],
  7:  [3, 4],
  8:  [4, 4],
  9:  [5, 4],
  10: [5, 5],
  11: [3, 4, 4],
  12: [4, 4, 4],
} as const;

// ── Distribución serpentina (Serpentine Seeding) ───────────────────────────

/**
 * Los competidores se asignan a grupos en patrón SERPENTINA, no en bloques.
 *
 * Ejemplo con 6 competidores, grupos [3, 3]:
 *   Registro:  C1  C2  C3  C4  C5  C6
 *   G1 recibe: C1,         C4, C5
 *   G2 recibe:     C2, C3,         C6
 *
 * Por qué: los competidores suelen inscribirse por club o nivel. La serpentina
 * los mezcla entre grupos para igualar el nivel y hacer la Final más competitiva.
 *
 * Implementado en: bracket.ts → distributeSerpentine()
 */
export const SEEDING_MODE = "serpentine" as const;

// ── Orden de peleas entre grupos ───────────────────────────────────────────

/**
 * Las peleas se organizan EN BLOQUE por llave, no intercaladas.
 * Primero se juegan TODAS las peleas de G1, luego todas las de G2, etc.
 *
 * Ejemplo G1 y G2 con 3 competidores cada uno (3 peleas por grupo):
 *   Cola: G1-P1, G1-P2, G1-P3 → G2-P1, G2-P2, G2-P3
 *
 * Por qué: permite enviar una llave entera a otro cuadrilátero sin
 * interrumpir el flujo. Si un tatami queda libre, recibe el bloque completo
 * de G2 y lo resuelve de forma independiente.
 *
 * Implementado en: bracket.ts → groupFightsList.flat()
 */
export const FIGHT_ORDER = "grouped" as const;

// ── Aislamiento de grupos ──────────────────────────────────────────────────

/**
 * REGLA CRÍTICA: cada llave es COMPLETAMENTE INDEPENDIENTE.
 *
 * - Un competidor de G1 NUNCA pelea contra uno de G2 en la fase de grupos.
 * - El ranking de G1 no afecta al de G2 y viceversa.
 * - El desempate de G1 no bloquea ni afecta al de G2.
 * - Las estadísticas son locales a cada grupo.
 *
 * La única interacción entre grupos ocurre en la Fase Final.
 */
export const GROUPS_ARE_ISOLATED = true;

// ── Fase Final ─────────────────────────────────────────────────────────────

/**
 * CONDICIONES para habilitar "Iniciar Fase Final" (TODAS deben cumplirse):
 *   1. Existen 2+ grupos
 *   2. Todas las peleas regulares de TODOS los grupos están completadas
 *   3. Ningún grupo tiene desempate pendiente (status !== "needed" | "in_progress")
 *   4. La Fase Final no fue iniciada aún (no existe ninguna pelea con isFinalFight = true)
 *
 * Si UNO SOLO de estos puntos falla → el botón no aparece.
 * Implementado en: StandingsPage.tsx → isFinalReady()
 */
export const FINAL_PHASE_CONDITIONS = [
  "min-2-groups",
  "all-regular-fights-complete",
  "no-pending-tiebreaks",
  "final-not-started-yet",
] as const;

/**
 * FORMATO de la Fase Final según cantidad de grupos:
 *   2 grupos → 1 pelea directa entre los 2 ganadores (winner-takes-all)
 *   3 grupos → mini round-robin: 3 peleas entre los 3 ganadores
 *
 * Las peleas de la Fase Final pueden tener su propio desempate
 * (isTiebreakExtra, groupId "FINAL"), y ese desempate también puede
 * escalar a Punto de Oro si termina empatado.
 *
 * Implementado en: bracket.ts → generateFinalFights()
 */
export const FINAL_PHASE_FORMAT = {
  2: "1-fight-direct",
  3: "mini-round-robin-3-fights",
} as const;

/**
 * El campeón en multi-llave ES el ganador del grupo "FINAL",
 * tras resolver todos sus posibles desempates.
 * No existe "campeón de llave" — el título siempre va al ganador de la Final.
 */
export const MULTI_GROUP_CHAMPION_SOURCE = "FINAL" as const;
