import { resolveEliminationOutcome } from "@/lib/category-lifecycle";
import { groupWinnerId, isAuthorizedPlayoffFight, rankRoundRobinGroup,
  resolveFirstPlace, roundRobinOutcome,
  type FirstPlaceResolution } from "@/lib/round-robin-resolution";
import { findRoundRobinRestAdvisory,
  type RoundRobinRestAdvisory } from "@/lib/rr-rest-advisory";
import type { FightEntry, TournamentCategorySnapshot } from "@/store/tournament";
import type { DemoDeskState } from "./types";

function authorized(snapshot: TournamentCategorySnapshot, fight: FightEntry): boolean {
  if (fight.completed) return false;
  if (fight.importedFrom || fight.groupId?.startsWith("EXT:")) return true;
  if (snapshot.config.mode === "elimination") return true;
  const expectedIds = snapshot.groups.find((group) => group.id === (fight.groupId ?? "G1"))
    ?.competitors.map((competitor) => competitor.id);
  return isAuthorizedPlayoffFight(fight, snapshot.fights, expectedIds);
}

export function getDemoPendingFights(state: DemoDeskState, categoryId: string): FightEntry[] {
  const snapshot = state.categories[categoryId];
  if (!snapshot) return [];
  return snapshot.fights.filter((fight) => authorized(snapshot, fight));
}

export function getDemoCategoryOutcome(state: DemoDeskState, categoryId: string) {
  const snapshot = state.categories[categoryId];
  if (!snapshot) return null;
  return snapshot.config.mode === "elimination"
    ? resolveEliminationOutcome(snapshot)
    : roundRobinOutcome(snapshot.fights, snapshot.groups);
}

/** The history array is persisted in confirmation order; no wall-clock tie inference. */
export function getDemoRestAdvisory(
  state: DemoDeskState, categoryId: string, selectedFightId: string,
): RoundRobinRestAdvisory {
  const snapshot = state.categories[categoryId];
  if (!snapshot || snapshot.config.mode !== "round-robin") return { kind: "none" };
  const last = [...state.history].reverse().find((result) => result.categoryId === categoryId);
  if (!last) return { kind: "none" };
  return findRoundRobinRestAdvisory(snapshot.fights, selectedFightId, {
    fightId: last.fightId, categoryId, redId: last.red.id,
    blueId: last.blue.id, confirmedAt: last.confirmedAt,
  }, (fight) => authorized(snapshot, fight));
}

export interface DemoRoundRobinAction {
  groupId: string;
  resolution: FirstPlaceResolution;
  canPrepare: boolean;
}

/** UI-ready, read-only stage authority; dispatch revalidates before any write. */
export function getDemoRoundRobinActions(state: DemoDeskState, categoryId: string): {
  playoffs: DemoRoundRobinAction[];
  canPrepareFinal: boolean;
} {
  const snapshot = state.categories[categoryId];
  if (!snapshot || snapshot.phase !== "fighting" || snapshot.config.mode !== "round-robin")
    return { playoffs: [], canPrepareFinal: false };
  const confirmed = (fight: FightEntry) => fight.completed && state.history.some((entry) =>
    entry.categoryId === categoryId && entry.fightId === fight.id && entry.winner === fight.winner);
  const regular = snapshot.fights.filter((fight) => !fight.isTiebreakExtra
    && !fight.isGoldenPointFight && !fight.isFinalFight
    && !fight.importedFrom && !fight.groupId?.startsWith("EXT:"));
  const playoffs: DemoRoundRobinAction[] = snapshot.groups.map((group) => {
    const resolution = resolveFirstPlace(group.id, rankRoundRobinGroup(group.id, snapshot.fights),
      snapshot.fights, group.competitors.map((person) => person.id));
    const dependencies = snapshot.fights.filter((fight) => fight.groupId === group.id
      && !fight.importedFrom);
    return { groupId: group.id, resolution,
      canPrepare: !state.active && (resolution.status === "needed" || resolution.status === "review")
        && resolution.nextIds.length >= 2 && resolution.fights.every((fight) => fight.completed)
        && dependencies.every(confirmed) };
  });
  const winnerIds = snapshot.groups.map((group) => groupWinnerId(group.id,
    rankRoundRobinGroup(group.id, snapshot.fights), snapshot.fights,
    group.competitors.map((person) => person.id)));
  const canPrepareFinal = !state.active && snapshot.groups.length >= 2
    && !snapshot.fights.some((fight) => fight.isFinalFight) && regular.every(confirmed)
    && winnerIds.every((id) => id !== null) && new Set(winnerIds).size === winnerIds.length
    && playoffs.every((item) => !["needed", "review", "in_progress"].includes(item.resolution.status));
  if (snapshot.fights.some((fight) => fight.isFinalFight) && winnerIds.every((id) => id !== null)) {
    const resolution = resolveFirstPlace("FINAL", rankRoundRobinGroup("FINAL", snapshot.fights),
      snapshot.fights, winnerIds.filter((id): id is string => id !== null));
    const dependencies = snapshot.fights.filter((fight) => fight.groupId === "FINAL"
      && !fight.importedFrom);
    playoffs.push({ groupId: "FINAL", resolution,
      canPrepare: !state.active && (resolution.status === "needed" || resolution.status === "review")
        && resolution.nextIds.length >= 2 && resolution.fights.every((fight) => fight.completed)
        && dependencies.every(confirmed) });
  }
  return { playoffs, canPrepareFinal };
}
