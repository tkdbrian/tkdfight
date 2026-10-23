import type { FightEntry } from "@/store/tournament";

export interface FightPageNavigationIntent {
  kind: "category-continue";
  categoryId: string;
  fightId: string;
}

export type FightPageEntry =
  | { mode: "normal" }
  | { mode: "passive"; intent: FightPageNavigationIntent }
  | { mode: "invalid" };

/** Browser history is untrusted; an intent never authorizes a server operation. */
export function getFightPageEntry(
  value: unknown,
  categoryId: string,
  fights: readonly FightEntry[]
): FightPageEntry {
  if (value === null || value === undefined) return { mode: "normal" };
  if (typeof value !== "object" || Array.isArray(value)) return { mode: "invalid" };
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).length !== 3 ||
    state.kind !== "category-continue" ||
    state.categoryId !== categoryId ||
    typeof state.fightId !== "string" ||
    !state.fightId.trim() ||
    !fights.some((fight) => fight.id === state.fightId)
  ) {
    return { mode: "invalid" };
  }
  return {
    mode: "passive",
    intent: { kind: "category-continue", categoryId, fightId: state.fightId },
  };
}
