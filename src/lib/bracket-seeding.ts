import type { BracketMatch, FightEntry } from "@/store/tournament";

/** Automatic first-round advancement is not a played result. */
export function isAutomaticBracketBye(match: BracketMatch): boolean {
  const competitor = match.red.competitor ?? match.blue.competitor;
  return match.round === 0 && !match.fightId
    && Boolean(match.red.competitor) !== Boolean(match.blue.competitor)
    && (!match.completed || match.winnerId === competitor?.id);
}

/** Once any fight is prepared it may already exist on the server: never rewrite it locally. */
export function canReseedBracket(matches: BracketMatch[], fights: FightEntry[]): boolean {
  return fights.length === 0 && !matches.some((match) => match.fightId
    || ((match.completed || match.winnerId) && !isAutomaticBracketBye(match)));
}

export function swapInitialBracketSlots(
  matches: BracketMatch[], fights: FightEntry[],
  aMatchId: string, aSlot: "red" | "blue", bMatchId: string, bSlot: "red" | "blue",
): { bracketMatches: BracketMatch[]; bracketSeeds: (string | null)[] } | null {
  if (!canReseedBracket(matches, fights) || (aMatchId === bMatchId && aSlot === bSlot)) return null;
  const a = matches.find((match) => match.id === aMatchId);
  const b = matches.find((match) => match.id === bMatchId);
  if (!a || !b || a.round !== 0 || b.round !== 0 || a.bracketGroup !== b.bracketGroup) return null;
  // Keep the balanced BYE positions. Moving within the same BYE is safe; moving
  // across matches exchanges competitors, not empty branches of the bracket.
  if (a.id !== b.id && (!a[aSlot].competitor || !b[bSlot].competitor)) return null;
  const competitorA = a[aSlot].competitor;
  const competitorB = b[bSlot].competitor;
  let updated = matches.map((match): BracketMatch => {
    let red = match.round === 0 ? match.red.competitor : null;
    let blue = match.round === 0 ? match.blue.competitor : null;
    if (match.id === a.id) { if (aSlot === "red") red = competitorB; else blue = competitorB; }
    if (match.id === b.id) { if (bSlot === "red") red = competitorA; else blue = competitorA; }
    return { ...match, red: { ...match.red, competitor: red }, blue: { ...match.blue, competitor: blue },
      completed: false, winnerId: undefined };
  });
  for (const bye of updated.filter((match) => isAutomaticBracketBye(match))) {
    const competitor = bye.red.competitor ?? bye.blue.competitor;
    if (!competitor) continue;
    updated = updated.map((match): BracketMatch => {
      if (match.id === bye.id) return { ...match, completed: true, winnerId: competitor.id };
      return { ...match,
        red: match.red.fromMatchId === bye.id ? { ...match.red, competitor } : match.red,
        blue: match.blue.fromMatchId === bye.id ? { ...match.blue, competitor } : match.blue };
    });
  }
  const firstRound = updated.filter((match) => match.round === 0).sort((left, right) =>
    (left.bracketGroup ?? "A").localeCompare(right.bracketGroup ?? "A") || left.position - right.position);
  return { bracketMatches: updated,
    bracketSeeds: firstRound.flatMap((match) => [match.red.competitor?.id ?? null, match.blue.competitor?.id ?? null]) };
}
