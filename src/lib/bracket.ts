import type { CompetitorEntry, FightEntry } from "@/store/tournament";

/**
 * Genera fixture round-robin para una lista de competidores.
 * Si la cantidad es impar, añade un "bye" que se descarta.
 */
export function generateRoundRobin(competitors: CompetitorEntry[]): FightEntry[] {
  const list = [...competitors];
  // Algoritmo estándar round-robin (polygon rotation)
  const n = list.length % 2 === 0 ? list.length : list.length + 1;
  const fights: FightEntry[] = [];

  for (let round = 0; round < n - 1; round++) {
    for (let i = 0; i < n / 2; i++) {
      const red = list[i];
      const blue = list[n - 1 - i];
      if (red && blue) {
        fights.push({
          id: crypto.randomUUID(),
          red,
          blue,
          completed: false,
        });
      }
    }
    // Rotate: keep list[0] fixed, rotate the rest
    const last = list.at(-1);
    list.pop();
    if (last !== undefined) list.splice(1, 0, last);
  }

  return fights;
}
