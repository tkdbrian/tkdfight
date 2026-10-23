import type { FightEntry } from '@/store/tournament'

/** A mini round robin can draw individual bouts; only a direct two-person playoff needs a winner. */
export function isMiniRoundRobinBout(fight: FightEntry, fights: FightEntry[]): boolean {
  if (fight.playoffKind === 'mini') return true
  if (fight.playoffKind === 'direct' || fight.isGoldenPointFight) return false
  if (!fight.groupId) return false
  const cohort = fight.isTiebreakExtra
    ? fights.filter((other) => other.groupId === fight.groupId && other.isTiebreakExtra && !other.bracketMatchId)
    : fight.isFinalFight
      ? fights.filter((other) => other.groupId === 'FINAL' && other.isFinalFight && !other.isTiebreakExtra && !other.isGoldenPointFight)
      : []
  return new Set(cohort.flatMap((other) => [other.red.id, other.blue.id])).size > 2
}
