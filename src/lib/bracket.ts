import type { CompetitorEntry, FightEntry, BracketMatch, TournamentGroup } from "@/store/tournament";

// ── Group distribution ─────────────────────────────────────────────────────
// Fixed table: n competitors → array of group sizes (3-12)
const GROUP_DISTRIBUTION: Record<number, number[]> = {
  3: [3],
  4: [4],
  5: [5],
  6: [3, 3],
  7: [3, 4],
  8: [4, 4],
  9: [5, 4],
  10: [5, 5],
  11: [3, 4, 4],
  12: [4, 4, 4],
};

// ── Optimal fight schedules per group size ─────────────────────────────────
// Letters map to competitor positions (A=0, B=1, C=2, D=3, E=4)
// Ordered to maximize rest between consecutive fights for each competitor.
const SCHEDULE_3: [string, string][] = [
  ["B", "C"], ["A", "C"], ["A", "B"],
];
const SCHEDULE_4: [string, string][] = [
  ["A", "B"], ["C", "D"], ["A", "C"], ["B", "D"], ["A", "D"], ["B", "C"],
];
const SCHEDULE_5: [string, string][] = [
  ["A", "B"], ["C", "D"], ["A", "E"], ["B", "C"], ["D", "E"],
  ["A", "C"], ["B", "D"], ["C", "E"], ["A", "D"], ["B", "E"],
];

const BASE_SCHEDULES: Record<number, [string, string][]> = {
  3: SCHEDULE_3,
  4: SCHEDULE_4,
  5: SCHEDULE_5,
};

export type SeedingMode = "REGISTRATION_ORDER" | "RANDOM" | "SERPENTINE";

// ── Serpentine distribution ────────────────────────────────────────────────
// Distributes competitors across groups using a snake pattern so that
// consecutive registration seats are spread across different groups.
// Example: sizes=[3,4] → G0:[0,3,4], G1:[1,2,5,6]
function distributeSerpentine(competitors: CompetitorEntry[], sizes: number[]): CompetitorEntry[][] {
  const groups: CompetitorEntry[][] = sizes.map(() => []);
  const maxSize = Math.max(...sizes);
  let ci = 0;

  for (let round = 0; round < maxSize && ci < competitors.length; round++) {
    const numGroups = groups.length;
    const order = round % 2 === 0
      ? Array.from({ length: numGroups }, (_, i) => i)
      : Array.from({ length: numGroups }, (_, i) => numGroups - 1 - i);

    for (const gi of order) {
      if (ci >= competitors.length) break;
      if (groups[gi].length >= sizes[gi]) continue;
      groups[gi].push(competitors[ci]);
      ci++;
    }
  }

  return groups;
}

// ── Fight interleaving ─────────────────────────────────────────────────────
// Takes one fight from each group queue in round-robin order.
// When a queue runs out, continues with remaining queues.
function interleaveGroupFights(groupFights: FightEntry[][]): FightEntry[] {
  const queues = groupFights.map((fights) => [...fights]);
  const result: FightEntry[] = [];

  while (queues.some((q) => q.length > 0)) {
    for (const queue of queues) {
      if (queue.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: queue.length > 0 checked above
        result.push(queue.shift()!);
      }
    }
  }

  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function getGroupDistribution(n: number): number[] | undefined {
  return GROUP_DISTRIBUTION[n];
}

/**
 * Genera peleas de desempate (mini round-robin) para 3–5 competidores
 * empatados en primer lugar dentro de un grupo.
 * Para 2 empatados genera 1 pelea directa.
 */
export function generateTiebreakFights(
  tiedCompetitors: CompetitorEntry[],
  groupId: string,
): FightEntry[] {
  const n = tiedCompetitors.length;
  if (n < 2) return [];

  if (n === 2) {
    return [{
      id: crypto.randomUUID(),
      red: tiedCompetitors[0],
      blue: tiedCompetitors[1],
      completed: false,
      groupId,
      isTiebreakExtra: true,
    }];
  }

  const schedule = BASE_SCHEDULES[n];
  if (!schedule) {
    throw new Error(`Desempate no soportado para ${n} competidores (máx 5)`);
  }

  const LETTERS = ["A", "B", "C", "D", "E"];
  const letterMap = new Map<string, CompetitorEntry>(
    tiedCompetitors.map((c, i) => [LETTERS[i], c]),
  );

  return schedule.map(([la, lb]) => ({
    id: crypto.randomUUID(),
    // biome-ignore lint/style/noNonNullAssertion: letterMap built from same LETTERS slice, keys guaranteed to exist
    red: letterMap.get(la)!,
    // biome-ignore lint/style/noNonNullAssertion: letterMap built from same LETTERS slice, keys guaranteed to exist
    blue: letterMap.get(lb)!,
    completed: false,
    groupId,
    isTiebreakExtra: true,
  }));
}

/**
 * Genera las peleas de la fase final entre los ganadores de cada llave.
 * 2 ganadores → 1 pelea directa.
 * 3 ganadores → mini round-robin (3 peleas).
 */
export function generateFinalFights(winners: CompetitorEntry[]): FightEntry[] {
  const n = winners.length;
  if (n < 2) return [];

  if (n === 2) {
    return [{
      id: crypto.randomUUID(),
      red: winners[0],
      blue: winners[1],
      completed: false,
      groupId: "FINAL",
      isFinalFight: true,
    }];
  }

  const schedule = BASE_SCHEDULES[n];
  if (!schedule) {
    throw new Error(`Fase final no soportada para ${n} ganadores (máx 3)`);
  }

  const LETTERS = ["A", "B", "C", "D", "E"];
  const letterMap = new Map<string, CompetitorEntry>(
    winners.map((c, i) => [LETTERS[i], c]),
  );

  return schedule.map(([la, lb]) => ({
    id: crypto.randomUUID(),
    // biome-ignore lint/style/noNonNullAssertion: letterMap is built from the same LETTERS slice — keys always exist
    red: letterMap.get(la)!,
    // biome-ignore lint/style/noNonNullAssertion: letterMap is built from the same LETTERS slice — keys always exist
    blue: letterMap.get(lb)!,
    completed: false,
    groupId: "FINAL",
    isFinalFight: true,
  }));
}

/**
 * Generates groups + interleaved fights for 3–12 competitors.
 * Each group uses the optimal fight schedule for its size.
 * Competitors are distributed via serpentine seeding by default.
 */
export function generateGroupsTournament(
  competitors: CompetitorEntry[],
  seedingMode: SeedingMode = "SERPENTINE",
): { groups: TournamentGroup[]; fights: FightEntry[] } {
  const n = competitors.length;
  const sizes = GROUP_DISTRIBUTION[n];
  if (!sizes) {
    throw new Error(`Distribución no soportada para ${n} competidores (soportado: 3–12)`);
  }

  let seeded = [...competitors];
  if (seedingMode === "RANDOM") {
    seeded = seeded.sort(() => Math.random() - 0.5);
  }

  const groupCompetitors = seedingMode === "SERPENTINE"
    ? distributeSerpentine(seeded, sizes)
    : sizes.reduce<{ groups: CompetitorEntry[][]; ci: number }>(
        (acc, size) => {
          acc.groups.push(seeded.slice(acc.ci, acc.ci + size));
          acc.ci += size;
          return acc;
        },
        { groups: [], ci: 0 },
      ).groups;

  const LETTERS = ["A", "B", "C", "D", "E"];
  const groups: TournamentGroup[] = [];
  const groupFightsList: FightEntry[][] = [];

  for (let gi = 0; gi < sizes.length; gi++) {
    const groupId = `G${gi + 1}`;
    const comp = groupCompetitors[gi];
    const size = sizes[gi];
    const schedule = BASE_SCHEDULES[size];

    const letterMap = new Map<string, CompetitorEntry>(
      comp.map((c, i) => [LETTERS[i], c]),
    );

    const gFights: FightEntry[] = schedule.map(([la, lb]) => ({
      id: crypto.randomUUID(),
      // biome-ignore lint/style/noNonNullAssertion: letterMap is built from same LETTERS slice — keys always exist
      red: letterMap.get(la)!,
      // biome-ignore lint/style/noNonNullAssertion: letterMap is built from same LETTERS slice — keys always exist
      blue: letterMap.get(lb)!,
      completed: false,
      groupId,
    }));

    groups.push({ id: groupId, competitors: comp, size });
    groupFightsList.push(gFights);
  }

  // Peleas agrupadas en bloque por llave: primero todas las de G1, luego G2, etc.
  // Esto permite enviar una llave entera a otro cuadrilátero sin mezclar peleas.
  const fights = groupFightsList.flat();

  return { groups, fights };
}

/**
 * Calcula la siguiente potencia de 2 >= n.
 */
function nextPowerOf2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Genera la estructura de bracket de eliminación directa.
 * Soporta cualquier cantidad de competidores; añade byes automáticamente.
 */
export function generateEliminationBracket(
  competitors: CompetitorEntry[]
): { matches: BracketMatch[]; seeds: (string | null)[] } {
  const size = nextPowerOf2(Math.max(competitors.length, 2));
  const totalRounds = Math.log2(size);
  const seeds = buildSeeds(size, competitors);
  const matchIds = buildMatchIds(size, totalRounds);
  const round0 = buildFirstRound(competitors, seeds, matchIds);
  const laterRounds = buildLaterRounds(totalRounds, matchIds);
  const matches = advanceByes([...round0, ...laterRounds], competitors);
  return { matches, seeds };
}

function buildSeeds(size: number, competitors: CompetitorEntry[]): (string | null)[] {
  const n = competitors.length;
  const realR1Fights = n - size / 2;
  const seeds: (string | null)[] = new Array(size).fill(null);
  // Competitors that fight in R1 occupy the first realR1Fights*2 slots
  for (let i = 0; i < realR1Fights * 2; i++) {
    seeds[i] = competitors[i].id;
  }
  // Competitors with a BYE go into every other slot after that
  let ci = realR1Fights * 2;
  for (let slot = realR1Fights * 2; slot < size && ci < n; slot += 2) {
    seeds[slot] = competitors[ci].id;
    ci++;
  }
  return seeds;
}

function buildMatchIds(size: number, totalRounds: number): string[][] {
  return Array.from({ length: totalRounds }, (_, round) =>
    Array.from({ length: size / 2 ** (round + 1) }, () => crypto.randomUUID())
  );
}

function buildFirstRound(
  competitors: CompetitorEntry[],
  seeds: (string | null)[],
  matchIds: string[][]
): BracketMatch[] {
  const r0ids = matchIds[0];
  return r0ids.map((id, pos) => {
    const redId = seeds[pos * 2];
    const blueId = seeds[pos * 2 + 1];
    return {
      id,
      round: 0,
      position: pos,
      red: { competitor: competitors.find((c) => c.id === redId) ?? null },
      blue: { competitor: competitors.find((c) => c.id === blueId) ?? null },
      completed: false,
    };
  });
}

function buildLaterRounds(totalRounds: number, matchIds: string[][]): BracketMatch[] {
  const matches: BracketMatch[] = [];
  for (let round = 1; round < totalRounds; round++) {
    for (let pos = 0; pos < matchIds[round].length; pos++) {
      matches.push({
        id: matchIds[round][pos],
        round,
        position: pos,
        red: { competitor: null, fromMatchId: matchIds[round - 1][pos * 2] },
        blue: { competitor: null, fromMatchId: matchIds[round - 1][pos * 2 + 1] },
        completed: false,
      });
    }
  }
  return matches;
}

/**
 * Auto-avanza byes en la primera ronda:
 * Si un competidor tiene bye (oponente null), avanza automáticamente.
 */
function advanceByes(
  matches: BracketMatch[],
  competitors: CompetitorEntry[]
): BracketMatch[] {
  let result = [...matches];

  for (const match of result.filter((m) => m.round === 0)) {
    const hasRed = match.red.competitor !== null;
    const hasBlue = match.blue.competitor !== null;

    if (hasRed && !hasBlue) {
      // Red advances automatically
      // biome-ignore lint/style/noNonNullAssertion: hasRed asserts competitor !== null above
      result = advanceWinner(result, match.id, match.red.competitor!.id, competitors);
    } else if (!hasRed && hasBlue) {
      // Blue advances automatically
      // biome-ignore lint/style/noNonNullAssertion: hasBlue asserts competitor !== null above
      result = advanceWinner(result, match.id, match.blue.competitor!.id, competitors);
    }
  }

  return result;
}

function advanceWinner(
  matches: BracketMatch[],
  matchId: string,
  winnerId: string,
  competitors: CompetitorEntry[]
): BracketMatch[] {
  const winner = competitors.find((c) => c.id === winnerId) ?? null;
  return matches.map((m) => {
    if (m.id === matchId) return { ...m, winnerId, completed: true };
    if (m.red.fromMatchId === matchId) return { ...m, red: { ...m.red, competitor: winner } };
    if (m.blue.fromMatchId === matchId) return { ...m, blue: { ...m.blue, competitor: winner } };
    return m;
  });
}

/**
 * Genera los FightEntry del bracket para la ronda actual activa
 * (es decir, los matches de la ronda más baja que no estén completos y tengan 2 competidores).
 */
export function getActiveBracketFights(
  matches: BracketMatch[],
  fights: FightEntry[]
): FightEntry[] {
  const existingBracketIds = new Set(fights.map((f) => f.bracketMatchId).filter(Boolean));

  const activeMatches = matches
    .filter(
      (m) =>
        !m.completed &&
        m.red.competitor !== null &&
        m.blue.competitor !== null &&
        !existingBracketIds.has(m.id)
    )
    .sort((a, b) => a.round - b.round || a.position - b.position);

  // Only generate fights for the current minimum round
  const minRound = activeMatches[0]?.round ?? 0;
  return activeMatches
    .filter((m) => m.round === minRound)
    .map((m) => ({
      id: crypto.randomUUID(),
      // biome-ignore lint/style/noNonNullAssertion: activeMatches filtered to only matches with both competitors
      red: m.red.competitor!,
      // biome-ignore lint/style/noNonNullAssertion: activeMatches filtered to only matches with both competitors
      blue: m.blue.competitor!,
      completed: false,
      bracketRound: m.round,
      bracketPosition: m.position,
      bracketMatchId: m.id,
    }));
}

/**
 * Genera dos brackets independientes (Grilla A y Grilla B) para más de 16 competidores.
 * Distribuye en serpentina: 1→A, 2→B, 3→A, 4→B, ...
 * Los matches de cada grilla se taguean con bracketGroup 'A' o 'B'.
 */
export function generateDoubleBracket(
  competitors: CompetitorEntry[]
): { matches: BracketMatch[]; seeds: (string | null)[] } {
  const groupA: CompetitorEntry[] = [];
  const groupB: CompetitorEntry[] = [];

  competitors.forEach((c, i) => {
    if (i % 2 === 0) groupA.push(c);
    else groupB.push(c);
  });

  const { matches: rawA, seeds: seedsA } = generateEliminationBracket(groupA);
  const { matches: rawB, seeds: seedsB } = generateEliminationBracket(groupB);

  const matchesA: BracketMatch[] = rawA.map((m) => ({ ...m, bracketGroup: "A" as const }));
  const matchesB: BracketMatch[] = rawB.map((m) => ({ ...m, bracketGroup: "B" as const }));

  return {
    matches: [...matchesA, ...matchesB],
    seeds: [...seedsA, ...seedsB],
  };
}
