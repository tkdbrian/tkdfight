import type { FightEntry } from "@/store/tournament";

export interface LastConfirmedRestBout {
  fightId: string;
  categoryId: string;
  redId: string;
  blueId: string;
  confirmedAt: string;
}

export type LastConfirmedRestRead =
  | { kind: "known"; last: LastConfirmedRestBout | null }
  | { kind: "ambiguous" }
  | { kind: "unavailable" };

export type RoundRobinRestAdvisory =
  | { kind: "none" }
  | { kind: "suggest"; alternativeFightId: string; alternativeIndex: number }
  | { kind: "unavoidable" };

/** Do not infer a previous bout from local completion/order; only trust the durable ring reply. */
export function parseLastConfirmedRestReply(value: unknown): LastConfirmedRestRead {
  if (!value || typeof value !== "object") return { kind: "unavailable" };
  const reply = value as Record<string, unknown>;
  if (reply.ok !== true || typeof reply.ambiguous !== "boolean") return { kind: "unavailable" };
  if (reply.ambiguous) return { kind: "ambiguous" };
  if (reply.last === null) return { kind: "known", last: null };
  if (!reply.last || typeof reply.last !== "object") return { kind: "unavailable" };
  const last = reply.last as Record<string, unknown>;
  if (
    typeof last.fightId !== "string" ||
    typeof last.categoryId !== "string" ||
    typeof last.redId !== "string" ||
    typeof last.blueId !== "string" ||
    typeof last.confirmedAt !== "string" ||
    !last.fightId ||
    !last.categoryId ||
    !last.redId ||
    !last.blueId ||
    !last.confirmedAt
  )
    return { kind: "unavailable" };
  return { kind: "known", last: last as unknown as LastConfirmedRestBout };
}

export function isRegularRoundRobinFight(fight: FightEntry): boolean {
  return (
    !fight.importedFrom &&
    !fight.groupId?.startsWith("EXT:") &&
    !fight.isFinalFight &&
    !fight.isTiebreakExtra &&
    !fight.isGoldenPointFight
  );
}

/** Suggest a different selection, never reorder, duplicate, or edit saved fights. */
export function findRoundRobinRestAdvisory(
  fights: readonly FightEntry[],
  selectedFightId: string,
  last: LastConfirmedRestBout,
  isAuthorized: (fight: FightEntry) => boolean = () => true
): RoundRobinRestAdvisory {
  const selected = fights.find((fight) => fight.id === selectedFightId);
  if (
    !selected ||
    selected.completed ||
    selected.importedFrom ||
    selected.groupId?.startsWith("EXT:")
  )
    return { kind: "none" };
  const previousIds = new Set([last.redId, last.blueId]);
  if (!previousIds.has(selected.red.id) && !previousIds.has(selected.blue.id)) {
    return { kind: "none" };
  }
  const regularPending = fights.some(
    (fight) => !fight.completed && isRegularRoundRobinFight(fight)
  );
  const alternativeIndex = fights.findIndex(
    (fight) =>
      fight.id !== selectedFightId &&
      !fight.completed &&
      !fight.importedFrom &&
      !fight.groupId?.startsWith("EXT:") &&
      (!regularPending || isRegularRoundRobinFight(fight)) &&
      isAuthorized(fight) &&
      !previousIds.has(fight.red.id) &&
      !previousIds.has(fight.blue.id)
  );
  if (alternativeIndex < 0) return { kind: "unavoidable" };
  return { kind: "suggest", alternativeFightId: fights[alternativeIndex].id, alternativeIndex };
}

export function restReadKey(read: LastConfirmedRestRead): string {
  if (read.kind === "ambiguous") return "ambiguous";
  if (read.kind === "unavailable") return "unavailable";
  if (!read.last) return "none";
  return `${read.last.fightId}:${read.last.confirmedAt}:${read.last.redId}:${read.last.blueId}`;
}
