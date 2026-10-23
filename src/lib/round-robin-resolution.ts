import type { CompetitorEntry, FightEntry, TournamentGroup } from "@/store/tournament";
import { generateTiebreakFights } from "./bracket";

export interface RankedCompetitor {
  id: string;
  points: number;
  flagsFor: number;
  foulsAgainst: number;
  warnings: number;
}

export interface FirstPlaceResolution {
  status: "none" | "needed" | "review" | "in_progress" | "resolved";
  tiedIds: string[];
  /** Only these competitors should participate in the next playoff. */
  nextIds: string[];
  fights: FightEntry[];
  resolvedOrder?: string[];
  goldenPoint?: boolean;
  /** Missing pairings in the current multi-person playoff cycle. */
  missingPairKeys?: string[];
  /** Historical extras without proof they were created after group closure. */
  legacyExtras?: FightEntry[];
  /** Proof that every regular pair had completed before this playoff was created. */
  playoffBasis?: string;
}

type PlayoffStat = Omit<RankedCompetitor, "id">;

/** Guest / cross-ring exhibition records remain in history, not in category rankings. */
export function isExternalGuestFight(fight: FightEntry): boolean {
  return fight.groupId?.startsWith("EXT:") ?? false;
}

export function rankedGroupIds(fights: FightEntry[]): string[] {
  return [
    ...new Set(
      fights
        .filter(
          (f) =>
            !f.isTiebreakExtra &&
            !f.isGoldenPointFight &&
            !f.isFinalFight &&
            !isExternalGuestFight(f)
        )
        .map((f) => f.groupId ?? "G1")
    ),
  ];
}

function compare(a: RankedCompetitor, b: RankedCompetitor): number {
  return (
    b.points - a.points ||
    b.flagsFor - a.flagsFor ||
    a.foulsAgainst - b.foulsAgainst ||
    a.warnings - b.warnings
  );
}

function sameRank(a: RankedCompetitor, b: RankedCompetitor): boolean {
  return compare(a, b) === 0;
}

/** Read-only reports use the exact same ranking priority as the operational resolver. */
export { compare as compareRoundRobinRank };

function winnerId(fight: FightEntry): string | null {
  return fight.winner === "red" ? fight.red.id : fight.winner === "blue" ? fight.blue.id : null;
}

type DirectSequence =
  | { status: "needed"; goldenPoint: boolean }
  | { status: "in_progress" }
  | { status: "review" }
  | { status: "resolved"; winner: string };

/** A direct playoff has at most two timed draws before its untimed stage. */
function resolveDirectSequence(
  fights: FightEntry[],
  startsWithDrawnFinal: boolean
): DirectSequence {
  let stage = startsWithDrawnFinal ? 1 : 0;
  for (let index = 0; index < fights.length; index++) {
    const fight = fights[index];
    const expectedGolden = stage === 2;
    if (
      fight.playoffKind !== "direct" ||
      Boolean(fight.isGoldenPointFight) !== expectedGolden ||
      Boolean(fight.isTiebreakExtra) === expectedGolden
    )
      return { status: "review" };
    if (!fight.completed || !fight.winner) {
      return index === fights.length - 1 ? { status: "in_progress" } : { status: "review" };
    }
    const winner = winnerId(fight);
    if (winner)
      return index === fights.length - 1 ? { status: "resolved", winner } : { status: "review" };
    if (!expectedGolden) stage++;
  }
  return { status: "needed", goldenPoint: stage === 2 };
}

/** Null until every distinct pair in the group has exactly one confirmed result. */
export function closedGroupBasis(
  groupId: string,
  allFights: FightEntry[],
  expectedIds?: string[]
): string | null {
  const regular = allFights.filter(
    (f) =>
      (f.groupId ?? "G1") === groupId &&
      !f.isTiebreakExtra &&
      !f.isGoldenPointFight &&
      !isExternalGuestFight(f)
  );
  if (!regular.length || regular.some((f) => !f.completed || !f.winner || f.red.id === f.blue.id))
    return null;
  const entrants = [...new Set(regular.flatMap((f) => [f.red.id, f.blue.id]))].sort();
  if (
    expectedIds &&
    (new Set(expectedIds).size !== entrants.length ||
      entrants.some((id) => !expectedIds.includes(id)))
  )
    return null;
  const pairs = new Set(regular.map((f) => [f.red.id, f.blue.id].sort().join("|")));
  if (
    pairs.size !== regular.length ||
    regular.length !== (entrants.length * (entrants.length - 1)) / 2
  )
    return null;
  if (groupId === "FINAL" && regular.some((f) => !f.isFinalFight)) return null;
  return JSON.stringify(
    regular
      .map((f) => [
        f.id,
        f.red.id,
        f.blue.id,
        f.winner,
        f.flagsRed ?? 0,
        f.flagsBlue ?? 0,
        f.foulsRed ?? 0,
        f.foulsBlue ?? 0,
        f.warningsRed ?? 0,
        f.warningsBlue ?? 0,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  );
}

/** An old or premature extra cannot become official merely by finishing later. */
export function isAuthorizedPlayoffFight(
  fight: FightEntry,
  allFights: FightEntry[],
  expectedIds?: string[]
): boolean {
  if (!fight.isTiebreakExtra && !fight.isGoldenPointFight) return true;
  const index = allFights.findIndex((candidate) => candidate.id === fight.id);
  if (
    index < 0 ||
    allFights.some((candidate, position) => position !== index && candidate.id === fight.id)
  )
    return false;
  const prior = allFights.slice(0, index);
  const groupId = fight.groupId ?? "G1";
  const basis = closedGroupBasis(groupId, prior, expectedIds);
  if (basis === null || fight.playoffBasis !== basis) return false;

  // Resolve the stage *before* this bout. This prevents an old or malformed
  // extra from authorizing itself through later results in the local queue.
  const stats = new Map<string, RankedCompetitor>();
  for (const regular of prior) {
    if (
      (regular.groupId ?? "G1") !== groupId ||
      regular.isTiebreakExtra ||
      regular.isGoldenPointFight ||
      isExternalGuestFight(regular)
    )
      continue;
    for (const competitor of [regular.red, regular.blue]) {
      if (!stats.has(competitor.id))
        stats.set(competitor.id, {
          id: competitor.id,
          points: 0,
          flagsFor: 0,
          foulsAgainst: 0,
          warnings: 0,
        });
    }
    const red = stats.get(regular.red.id);
    const blue = stats.get(regular.blue.id);
    if (!red || !blue) return false;
    red.flagsFor += regular.flagsRed ?? 0;
    blue.flagsFor += regular.flagsBlue ?? 0;
    red.foulsAgainst += regular.foulsRed ?? 0;
    blue.foulsAgainst += regular.foulsBlue ?? 0;
    red.warnings += regular.warningsRed ?? 0;
    blue.warnings += regular.warningsBlue ?? 0;
    if (regular.winner === "red") red.points += 3;
    else if (regular.winner === "blue") blue.points += 3;
    else if (regular.winner === "draw") {
      red.points++;
      blue.points++;
    }
  }
  const stage = resolveFirstPlace(groupId, [...stats.values()], prior, expectedIds);
  if (
    (stage.status !== "needed" && stage.status !== "review") ||
    (stage.fights.length > 0 && stage.status === "review") ||
    stage.playoffBasis !== basis
  )
    return false;
  const pair = [fight.red.id, fight.blue.id].sort().join("|");
  if (fight.playoffKind === "mini") {
    return Boolean(
      fight.isTiebreakExtra &&
        !fight.isGoldenPointFight &&
        stage.nextIds.length >= 3 &&
        stage.nextIds.includes(fight.red.id) &&
        stage.nextIds.includes(fight.blue.id) &&
        fight.red.id !== fight.blue.id &&
        (!stage.missingPairKeys || stage.missingPairKeys.includes(pair))
    );
  }
  if (
    fight.playoffKind !== "direct" ||
    stage.nextIds.length !== 2 ||
    pair !== [...stage.nextIds].sort().join("|")
  )
    return false;
  return stage.goldenPoint
    ? Boolean(fight.isGoldenPointFight && !fight.isTiebreakExtra)
    : Boolean(fight.isTiebreakExtra && !fight.isGoldenPointFight);
}

/**
 * Only a completed group can have a first-place playoff. Old ad-hoc extras
 * remain in the snapshot, but cannot affect a different pair of leaders.
 */
export function resolveFirstPlace(
  groupId: string,
  rows: RankedCompetitor[],
  allFights: FightEntry[],
  expectedIds?: string[]
): FirstPlaceResolution {
  const regular = allFights.filter(
    (f) => (f.groupId ?? "G1") === groupId && !f.isTiebreakExtra && !f.isGoldenPointFight
  );
  const empty: FirstPlaceResolution = { status: "none", tiedIds: [], nextIds: [], fights: [] };
  const playoffBasis = closedGroupBasis(groupId, allFights, expectedIds);
  if (playoffBasis === null) return empty;

  const ordered = [...rows].sort(compare);
  let leaders = ordered
    .filter((row) => ordered[0] && sameRank(row, ordered[0]))
    .map((row) => row.id);
  // A two-winner direct FINAL must be won on the mat, even when judges' flags
  // or penalties happen to differ after its normal round ends in a draw.
  if (groupId === "FINAL" && regular.length === 1 && regular[0].isFinalFight) {
    leaders = regular[0].winner === "draw" ? [regular[0].red.id, regular[0].blue.id] : [];
  }
  if (leaders.length < 2) return empty;

  const leaderSet = new Set(leaders);
  const relevantExtras = allFights.filter(
    (f) =>
      (f.groupId ?? "G1") === groupId &&
      (f.isTiebreakExtra || f.isGoldenPointFight) &&
      leaderSet.has(f.red.id) &&
      leaderSet.has(f.blue.id) &&
      f.red.id !== f.blue.id
  );
  const legacyExtras = relevantExtras.filter(
    (f) => !f.playoffKind || f.playoffBasis !== playoffBasis
  );
  const extras = relevantExtras.filter((f) => !!f.playoffKind && f.playoffBasis === playoffBasis);
  if (extras.length === 0 && legacyExtras.length > 0) {
    return {
      status: "review",
      tiedIds: leaders,
      nextIds: leaders,
      fights: [],
      legacyExtras,
      playoffBasis,
    };
  }
  if (extras.length === 0)
    return { status: "needed", tiedIds: leaders, nextIds: leaders, fights: [], playoffBasis };
  // A direct two-person playoff (and its timed/GP continuations) is resolved
  // only by an actual winning point, never by secondary standings statistics.
  if (leaders.length === 2) {
    const direct = resolveDirectSequence(extras, groupId === "FINAL");
    if (direct.status === "review") {
      return {
        status: "review",
        tiedIds: leaders,
        nextIds: leaders,
        fights: extras,
        legacyExtras: extras,
        playoffBasis,
      };
    }
    if (direct.status === "in_progress") {
      return { status: "in_progress", tiedIds: leaders, nextIds: [], fights: extras, playoffBasis };
    }
    if (direct.status === "resolved") {
      return {
        status: "resolved",
        tiedIds: leaders,
        nextIds: [],
        fights: extras,
        playoffBasis,
        resolvedOrder: [direct.winner, ...leaders.filter((id) => id !== direct.winner)],
      };
    }
    return {
      status: "needed",
      tiedIds: leaders,
      nextIds: leaders,
      fights: extras,
      playoffBasis,
      goldenPoint: direct.goldenPoint,
    };
  }

  if (extras.some((f) => !f.completed)) {
    return { status: "in_progress", tiedIds: leaders, nextIds: [], fights: extras, playoffBasis };
  }

  // Three or more first-place leaders play a mini round robin. If the mini
  // table remains tied, another complete mini table is required; partial old
  // extras may never crown a leader. If it narrows to two, their next direct
  // playoff (then GP after a draw) is decided by a winning point only.
  const pair = (a: string, b: string): string => [a, b].sort().join("|");
  let candidates = [...leaders];
  let cursor = 0;
  let ranked: RankedCompetitor[] = [];
  while (candidates.length >= 3) {
    const expected = new Set<string>();
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++)
        expected.add(pair(candidates[i], candidates[j]));
    }
    const cycle: FightEntry[] = [];
    const seen = new Set<string>();
    while (cursor < extras.length && seen.size < expected.size) {
      const f = extras[cursor];
      const key = pair(f.red.id, f.blue.id);
      // A new cycle must not borrow a missing bout from a later replay or
      // treat a direct extra as a mini-table result.
      if (f.playoffKind !== "mini" || !expected.has(key) || seen.has(key)) {
        return {
          status: "review",
          tiedIds: leaders,
          nextIds: candidates,
          fights: extras,
          legacyExtras: extras.slice(cursor),
          playoffBasis,
        };
      }
      cursor++;
      seen.add(key);
      cycle.push(f);
    }
    if (seen.size < expected.size) {
      return {
        status: "needed",
        tiedIds: leaders,
        nextIds: candidates,
        fights: extras,
        playoffBasis,
        missingPairKeys: [...expected].filter((key) => !seen.has(key)),
      };
    }
    const stats = new Map<string, PlayoffStat>(
      candidates.map((id) => [id, { points: 0, flagsFor: 0, foulsAgainst: 0, warnings: 0 }])
    );
    for (const f of cycle) {
      const red = stats.get(f.red.id);
      const blue = stats.get(f.blue.id);
      if (!red || !blue) continue;
      red.flagsFor += f.flagsRed ?? 0;
      blue.flagsFor += f.flagsBlue ?? 0;
      red.foulsAgainst += f.foulsRed ?? 0;
      blue.foulsAgainst += f.foulsBlue ?? 0;
      red.warnings += f.warningsRed ?? 0;
      blue.warnings += f.warningsBlue ?? 0;
      if (f.winner === "red") red.points += 3;
      else if (f.winner === "blue") blue.points += 3;
      else {
        red.points++;
        blue.points++;
      }
    }
    ranked = candidates
      .flatMap((id) => {
        const stat = stats.get(id);
        return stat ? [{ id, ...stat }] : [];
      })
      .sort(compare);
    candidates = ranked.filter((row) => sameRank(row, ranked[0])).map((row) => row.id);
    if (candidates.length === 1) {
      return {
        status: "resolved",
        tiedIds: leaders,
        nextIds: [],
        fights: extras,
        playoffBasis,
        resolvedOrder: ranked.map((row) => row.id),
      };
    }
  }

  const continuation = extras
    .slice(cursor)
    .filter((f) => candidates.includes(f.red.id) && candidates.includes(f.blue.id));
  const direct = resolveDirectSequence(continuation, false);
  if (direct.status === "review") {
    return {
      status: "review",
      tiedIds: leaders,
      nextIds: candidates,
      fights: extras,
      legacyExtras: continuation,
      playoffBasis,
    };
  }
  if (direct.status === "in_progress") {
    return { status: "in_progress", tiedIds: leaders, nextIds: [], fights: extras, playoffBasis };
  }
  if (direct.status === "resolved") {
    return {
      status: "resolved",
      tiedIds: leaders,
      nextIds: [],
      fights: extras,
      playoffBasis,
      resolvedOrder: [
        direct.winner,
        ...ranked.map((row) => row.id).filter((id) => id !== direct.winner),
      ],
    };
  }
  return {
    status: "needed",
    tiedIds: leaders,
    nextIds: candidates,
    fights: extras,
    playoffBasis,
    goldenPoint: direct.goldenPoint,
  };
}

/**
 * Predict the bout AFTER a confirmed draw in the current direct playoff.
 * The current fight need not yet be marked completed in the local snapshot.
 * Legacy/premature extras, other groups, other pairs and old bases do not count.
 */
export function nextDirectFightIsGoldenPoint(
  currentFight: FightEntry,
  fights: FightEntry[]
): boolean {
  if (currentFight.isGoldenPointFight) return true;
  if (!currentFight.isTiebreakExtra) return false;
  if (currentFight.playoffKind !== "direct" || !currentFight.playoffBasis) return false;
  const groupId = currentFight.groupId ?? "G1";
  if (!isAuthorizedPlayoffFight(currentFight, fights)) return false;
  if (groupId === "FINAL") return true;
  const samePair = (fight: FightEntry): boolean =>
    [fight.red.id, fight.blue.id].sort().join("|") ===
    [currentFight.red.id, currentFight.blue.id].sort().join("|");
  const earlierDraws = fights.filter(
    (fight) =>
      fight.id !== currentFight.id &&
      fight.groupId === currentFight.groupId &&
      fight.playoffKind === "direct" &&
      fight.playoffBasis === currentFight.playoffBasis &&
      fight.isTiebreakExtra &&
      fight.completed &&
      fight.winner === "draw" &&
      samePair(fight)
  );
  return earlierDraws.length >= 1;
}

export function groupWinnerId(
  groupId: string,
  rows: RankedCompetitor[],
  fights: FightEntry[],
  expectedIds?: string[]
): string | null {
  const info = resolveFirstPlace(groupId, rows, fights, expectedIds);
  if (info.status === "needed" || info.status === "review" || info.status === "in_progress")
    return null;
  if (info.status === "resolved") return info.resolvedOrder?.[0] ?? null;
  const regular = fights.filter(
    (f) => (f.groupId ?? "G1") === groupId && !f.isTiebreakExtra && !f.isGoldenPointFight
  );
  if (closedGroupBasis(groupId, fights, expectedIds) === null) return null;
  if (groupId === "FINAL" && regular.length === 1 && regular[0].isFinalFight) {
    return winnerId(regular[0]);
  }
  return [...rows].sort(compare)[0]?.id ?? null;
}

/** Build only the official next playoff bouts; never rewrite old results. */
export function preparePlayoffFights(
  competitors: CompetitorEntry[],
  groupId: string,
  resolution: FirstPlaceResolution,
  seconds: number
): FightEntry[] {
  if (resolution.status !== "needed" && resolution.status !== "review") return [];
  // A legacy unmarked bout may be bypassed with a fresh official proposal;
  // a malformed *official* sequence must instead be repaired explicitly.
  if (resolution.status === "review" && resolution.fights.length > 0) return [];
  const entrantIds = new Set(competitors.map((competitor) => competitor.id));
  if (
    entrantIds.size < 2 ||
    entrantIds.size !== resolution.nextIds.length ||
    competitors.length !== entrantIds.size ||
    resolution.nextIds.some((id) => !entrantIds.has(id))
  )
    return [];
  let next = generateTiebreakFights(competitors, groupId);
  if (!resolution.playoffBasis) return [];
  if (competitors.length > 2 && resolution.missingPairKeys) {
    const missing = new Set(resolution.missingPairKeys);
    next = next.filter((f) => missing.has([f.red.id, f.blue.id].sort().join("|")));
  }
  if (resolution.goldenPoint && next.length === 1) {
    const previous = resolution.fights.at(-1);
    return next.map((f) => ({
      ...f,
      isTiebreakExtra: false,
      isGoldenPointFight: true,
      isFinalFight: groupId === "FINAL",
      playoffKind: "direct",
      playoffBasis: resolution.playoffBasis,
      bracketMatchId: previous?.bracketMatchId ?? previous?.id,
    }));
  }
  return next.map((f) => ({
    ...f,
    isFinalFight: groupId === "FINAL",
    playoffKind: competitors.length === 2 ? "direct" : "mini",
    playoffBasis: resolution.playoffBasis,
    tiebreakerSeconds: seconds,
  }));
}

/** Complete bracket outcome, without promoting provisional table leaders. */
export function roundRobinOutcome(
  fights: FightEntry[],
  groups?: readonly TournamentGroup[]
): { championId: string | null; runnerUpId: string | null } {
  const groupIds = groups?.map((group) => group.id) ?? rankedGroupIds(fights);
  if (
    groupIds.length === 0 ||
    (groups && rankedGroupIds(fights).some((id) => !groupIds.includes(id)))
  ) {
    return { championId: null, runnerUpId: null };
  }
  const rank = (groupId: string): RankedCompetitor[] => {
    const stats = new Map<string, RankedCompetitor>();
    for (const f of fights) {
      if ((f.groupId ?? "G1") !== groupId || f.isTiebreakExtra || f.isGoldenPointFight) continue;
      for (const side of [f.red, f.blue]) {
        if (!stats.has(side.id))
          stats.set(side.id, { id: side.id, points: 0, flagsFor: 0, foulsAgainst: 0, warnings: 0 });
      }
      if (!f.completed) continue;
      const red = stats.get(f.red.id);
      const blue = stats.get(f.blue.id);
      if (!red || !blue) continue;
      red.flagsFor += f.flagsRed ?? 0;
      blue.flagsFor += f.flagsBlue ?? 0;
      red.foulsAgainst += f.foulsRed ?? 0;
      blue.foulsAgainst += f.foulsBlue ?? 0;
      red.warnings += f.warningsRed ?? 0;
      blue.warnings += f.warningsBlue ?? 0;
      if (f.winner === "red") red.points += 3;
      else if (f.winner === "blue") blue.points += 3;
      else {
        red.points++;
        blue.points++;
      }
    }
    return [...stats.values()].sort(compare);
  };

  const groupWinners = groupIds.map((gid) =>
    groupWinnerId(
      gid,
      rank(gid),
      fights,
      groups?.find((group) => group.id === gid)?.competitors.map((competitor) => competitor.id)
    )
  );
  if (groupWinners.some((id) => !id)) return { championId: null, runnerUpId: null };
  if (groupIds.length === 1) return { championId: groupWinners[0], runnerUpId: null };

  const final = fights.filter(
    (f) => f.groupId === "FINAL" && f.isFinalFight && !f.isTiebreakExtra && !f.isGoldenPointFight
  );
  if (final.length === 0 || final.some((f) => !f.completed))
    return { championId: null, runnerUpId: null };
  const entrants = new Set(groupWinners);
  if (final.some((f) => !entrants.has(f.red.id) || !entrants.has(f.blue.id))) {
    return { championId: null, runnerUpId: null };
  }
  const championId = groupWinnerId(
    "FINAL",
    rank("FINAL"),
    fights,
    groupWinners.filter((id): id is string => id !== null)
  );
  if (!championId) return { championId: null, runnerUpId: null };
  const runnerUpId =
    groupIds.length === 2 ? (groupWinners.find((id) => id !== championId) ?? null) : null;
  return { championId, runnerUpId };
}
