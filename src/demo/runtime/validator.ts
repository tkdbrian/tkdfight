import type { DemoDeskState } from "./types";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const side = (value: unknown): value is "red" | "blue" => value === "red" || value === "blue";
const winner = (value: unknown): boolean => side(value) || value === "draw";

function competitor(value: unknown): boolean {
  return record(value) && nonempty(value.id) && nonempty(value.name)
    && (value.team === undefined || typeof value.team === "string")
    && (value.weight === undefined || typeof value.weight === "number" && Number.isFinite(value.weight));
}

function rules(value: unknown): boolean {
  if (!record(value) || value.mode !== "sparring" || !count(value.judgesCount)
    || (value.judgesCount as number) < 1 || (value.judgesCount as number) > 5
    || !record(value.rounds) || !count(value.rounds.count) || (value.rounds.count as number) < 1
    || !count(value.rounds.duration_seconds) || (value.rounds.duration_seconds as number) < 1
    || !count(value.rounds.rest_seconds) || !record(value.points) || !record(value.deductions)) return false;
  return Object.values(value.points).every((point) => typeof point === "number" && Number.isFinite(point))
    && Object.values(value.deductions).every((deduction) => deduction === "DQ"
      || typeof deduction === "number" && Number.isFinite(deduction));
}

function event(value: unknown): boolean {
  return record(value) && nonempty(value.id) && typeof value.ts === "number"
    && Number.isFinite(value.ts) && nonempty(value.judgeId) && side(value.competitor)
    && nonempty(value.type) && typeof value.value === "number" && Number.isFinite(value.value)
    && (value.isDQ === undefined || typeof value.isDQ === "boolean");
}

function totals(value: unknown): boolean {
  return record(value) && typeof value.red === "number" && Number.isFinite(value.red)
    && typeof value.blue === "number" && Number.isFinite(value.blue);
}

function matchState(value: unknown): boolean {
  if (!record(value) || !["idle", "round", "rest", "overtime", "golden_point", "penalties", "finished"].includes(String(value.phase))
    || !count(value.currentRound) || !count(value.timeLeft) || !Array.isArray(value.rounds)
    || !value.rounds.every((round: unknown) => record(round) && count(round.number)
      && totals(round.totals) && totals(round.deductions) && totals(round.fouls)
      && Array.isArray(round.events) && round.events.every(event))
    || !(value.firstPoint === null || side(value.firstPoint))
    || typeof value.pendingJuryDecision !== "boolean") return false;
  if (value.result !== null && (!record(value.result) || !winner(value.result.winner)
    || !["points", "dq", "jury", "golden_point", "overtime_points"].includes(String(value.result.reason)))) return false;
  if (value.goldenPoint !== undefined && (!record(value.goldenPoint) || !count(value.goldenPoint.attempt)
    || !record(value.goldenPoint.votes) || !Object.entries(value.goldenPoint.votes)
      .every(([id, vote]) => /^J[1-5]$/.test(id) && side(vote)))) return false;
  return true;
}

function fight(value: unknown): boolean {
  return record(value) && nonempty(value.id) && competitor(value.red) && competitor(value.blue)
    && (value.red as Record<string, unknown>).id !== (value.blue as Record<string, unknown>).id
    && typeof value.completed === "boolean"
    && (value.winner === undefined || winner(value.winner));
}

function category(value: unknown, id: string): boolean {
  if (!record(value) || !["setup", "fighting", "results"].includes(String(value.phase))
    || !record(value.config) || value.config.id !== id
    || typeof value.config.tournamentName !== "string" || typeof value.config.categoryName !== "string"
    || typeof value.config.tableChief !== "string"
    || !["round-robin", "elimination", "groups"].includes(String(value.config.mode))
    || !["sparring", "tul"].includes(String(value.config.matchType))
    || !count(value.config.judgesCount) || (value.config.judgesCount as number) < 1
    || (value.config.judgesCount as number) > 5
    || value.config.ruleSet !== null && !rules(value.config.ruleSet)
    || !Array.isArray(value.competitors) || !value.competitors.every(competitor)
    || !Array.isArray(value.fights) || !value.fights.every(fight)
    || !Array.isArray(value.groups) || !value.groups.every((group: unknown) =>
      record(group) && nonempty(group.id) && count(group.size) && Array.isArray(group.competitors)
      && group.competitors.every(competitor))
    || !Array.isArray(value.bracketMatches) || !value.bracketMatches.every((match: unknown) =>
      record(match) && nonempty(match.id) && count(match.round) && count(match.position)
      && record(match.red) && record(match.blue) && typeof match.completed === "boolean")
    || !Array.isArray(value.bracketSeeds) || !value.bracketSeeds.every((seed: unknown) => seed === null || nonempty(seed))
    || !count(value.currentFightIndex) || typeof value.setupStarted !== "boolean") return false;
  const competitorIds = (value.competitors as Array<{id:string}>).map((entry) => entry.id);
  const fightIds = (value.fights as Array<{id:string}>).map((entry) => entry.id);
  return new Set(competitorIds).size === competitorIds.length
    && new Set(fightIds).size === fightIds.length;
}

export function isDemoDeskState(value: unknown): value is DemoDeskState {
  if (!record(value) || value.version !== 1 || !nonempty(value.eventId)
    || typeof value.tournamentName !== "string" || !record(value.categories)
    || !record(value.archives)
    || !Array.isArray(value.categoryOrder) || !value.categoryOrder.every(nonempty)
    || new Set(value.categoryOrder).size !== value.categoryOrder.length
    || Object.keys(value.categories).length !== value.categoryOrder.length
    || !Object.entries(value.categories).every(([id, item]) => category(item, id))
    || !Object.entries(value.archives).every(([id, item]) => category(item, id)
      && !Object.hasOwn(value.categories as object, id))
    || !value.categoryOrder.every((id: string) => Object.hasOwn(value.categories as object, id))
    || !(value.selectedCategoryId === null || typeof value.selectedCategoryId === "string"
      && Object.hasOwn(value.categories, value.selectedCategoryId))
    || !Array.isArray(value.history)) return false;
  if (value.active !== null) {
    const active = value.active;
    if (!record(active) || !nonempty(active.categoryId) || !nonempty(active.fightId)
      || !nonempty(active.loadId) || !count(active.assignmentRevision)
      || !competitor(active.red) || !competitor(active.blue) || !rules(active.rules)
      || !matchState(active.state) || typeof active.paused !== "boolean"
      || typeof active.started !== "boolean" || active.resultConfirmed !== false
      || !record(active.judgeVotes) || !Object.entries(active.judgeVotes)
        .every(([id, vote]) => /^J[1-5]$/.test(id) && winner(vote))
      || !Array.isArray(active.roundFlags) || !active.roundFlags.every((round: unknown) =>
        record(round) && count(round.red) && count(round.blue) && count(round.draw)
        && winner(round.winner) && record(round.votes))
      || !["idle", "voting", "finished"].includes(String(active.tulPhase))) return false;
    const selected = value.categories[active.categoryId];
    const loadedFight = record(selected) && Array.isArray(selected.fights)
      ? selected.fights.find((entry: unknown) => record(entry) && entry.id === active.fightId) : null;
    if (!record(loadedFight) || loadedFight.completed !== false
      || !record(loadedFight.red) || !record(loadedFight.blue)
      || loadedFight.red.id !== (active.red as Record<string, unknown>).id
      || loadedFight.blue.id !== (active.blue as Record<string, unknown>).id) return false;
  }
  const categories = value.categories as Record<string, unknown>;
  const seen = new Set<string>();
  const seenFights = new Set<string>();
  return value.history.every((entry: unknown) => {
    if (!record(entry) || !nonempty(entry.id) || !nonempty(entry.categoryId)
      || !nonempty(entry.fightId) || !nonempty(entry.confirmedAt)
      || !Number.isFinite(Date.parse(entry.confirmedAt)) || !competitor(entry.red)
      || !competitor(entry.blue) || !winner(entry.winner) || !nonempty(entry.reason)
      || ![entry.flagsRed, entry.flagsBlue, entry.warningsRed, entry.warningsBlue,
        entry.foulsRed, entry.foulsBlue].every(count) || seen.has(entry.id)) return false;
    const fightKey = `${entry.categoryId}:${entry.fightId}`;
    if (seenFights.has(fightKey)) return false;
    seen.add(entry.id);
    seenFights.add(fightKey);
    const storedCategory = categories[entry.categoryId]
      ?? (value.archives as Record<string, unknown>)[entry.categoryId];
    if (!record(storedCategory) || !Array.isArray(storedCategory.fights)) return false;
    const storedFight = storedCategory.fights.find((fight: unknown) => record(fight) && fight.id === entry.fightId);
    return record(storedFight) && storedFight.completed === true
      && storedFight.winner === entry.winner && record(storedFight.red) && record(storedFight.blue)
      && storedFight.red.id === (entry.red as Record<string, unknown>).id
      && storedFight.blue.id === (entry.blue as Record<string, unknown>).id;
  });
}
