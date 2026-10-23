import {
  generateDoubleBracket,
  generateEliminationBracket,
  generateGroupsTournament,
} from "@/lib/bracket";
import { isAuthorizedPlayoffFight, roundRobinOutcome } from "@/lib/round-robin-resolution";
import { validateCategoryTimingForStart } from "@/lib/yusan-profile";
import type { BracketMatch, FightEntry, TournamentCategorySnapshot } from "@/store/tournament";

export interface CategoryLifecycleServerState {
  match?: { id: string; categoryId?: string } | null;
  categoryId?: string | null;
  activeMatchLock?: {
    fightId: string;
    categoryId: string | null;
    resultStatus?: string | null;
  } | null;
  resultConfirmed?: boolean;
  matchState?: { phase: string; result?: unknown } | null;
}

export interface CategoryPrimaryActionContext {
  snapshot: TournamentCategorySnapshot;
  connected: boolean;
  stateReady: boolean;
  serverState: CategoryLifecycleServerState;
  resultsVerified?: boolean;
}

export interface CategoryPrimaryAction {
  kind: "start" | "continue" | "fight" | "review" | "results";
  label: string;
  route: "/standings" | "/bracket" | "/fight" | "/results" | null;
  disabled: boolean;
  reason?: string;
  fightId?: string;
}

/** New identities, never copied competitive results or advancement. */
export function createRestartReplacement(
  previous: TournamentCategorySnapshot
): TournamentCategorySnapshot {
  const config = structuredClone(previous.config);
  config.id = crypto.randomUUID();
  const competitors = previous.competitors.map((competitor) => ({
    ...structuredClone(competitor),
    id: crypto.randomUUID(),
  }));
  const base: TournamentCategorySnapshot = {
    config,
    competitors,
    fights: [],
    groups: [],
    bracketMatches: [],
    bracketSeeds: [],
    currentFightIndex: 0,
    phase: "fighting",
    setupStarted: true,
  };
  if (competitors.length < (config.mode === "elimination" ? 2 : 3)) {
    return { ...base, phase: "setup", setupStarted: false };
  }
  if (config.mode === "elimination") {
    const generated =
      competitors.length > 16
        ? generateDoubleBracket(competitors)
        : generateEliminationBracket(competitors);
    return { ...base, bracketMatches: generated.matches, bracketSeeds: generated.seeds };
  }
  return { ...base, ...generateGroupsTournament(competitors) };
}

export function isCategoryInitialized(snapshot: TournamentCategorySnapshot): boolean {
  return snapshot.fights.length > 0 || snapshot.bracketMatches.length > 0;
}

export interface EliminationOutcome {
  status: "pending" | "review" | "resolved";
  championId: string | null;
  runnerUpId: string | null;
  decisiveFightId: string | null;
  requiredResultIds: string[];
}

function unresolved(status: "pending" | "review"): EliminationOutcome {
  return { status, championId: null, runnerUpId: null, decisiveFightId: null,
    requiredResultIds: [] };
}

function winnerId(fight: FightEntry): string | null {
  if (!fight.completed) return null;
  if (fight.winner === "red") return fight.red.id;
  if (fight.winner === "blue") return fight.blue.id;
  return null;
}

function matchFinal(matches: BracketMatch[]): BracketMatch | null {
  if (!matches.length) return null;
  const referenced = new Set(matches.flatMap((match) =>
    [match.red.fromMatchId, match.blue.fromMatchId].filter((id): id is string => Boolean(id))));
  const terminals = matches.filter((match) => !referenced.has(match.id));
  return terminals.length === 1 ? terminals[0] : null;
}

function resolveFinalSequence(
  original: FightEntry,
  fights: FightEntry[],
  requiredResultIds: string[]
): EliminationOutcome {
  const siblings = fights.filter((fight) => fight.id !== original.id &&
    fight.red.id === original.red.id && fight.blue.id === original.blue.id &&
    fight.groupId === original.groupId &&
    (fight.bracketMatchId === original.bracketMatchId ||
      fight.bracketMatchId === original.id) &&
    (fight.isTiebreakExtra || fight.isGoldenPointFight));
  const extras = siblings.filter((fight) => fight.isTiebreakExtra && !fight.isGoldenPointFight &&
    (fight.continuationParentFightId === original.id ||
      (!fight.continuationParentFightId &&
        (fight.bracketMatchId === original.bracketMatchId ||
          fight.bracketMatchId === original.id))));
  const golden = siblings.filter((fight) => fight.isGoldenPointFight);
  if (!original.completed || !original.winner) return unresolved("pending");
  if (original.winner !== "draw") {
    if (extras.length || golden.length) return unresolved("review");
    return { status: "resolved", championId: winnerId(original),
      runnerUpId: original.winner === "red" ? original.blue.id : original.red.id,
      decisiveFightId: original.id, requiredResultIds: [...requiredResultIds, original.id] };
  }
  if (extras.length === 0) return unresolved(siblings.length ? "review" : "pending");
  if (extras.length !== 1) return unresolved("review");
  const extra = extras[0];
  if (!extra.completed || !extra.winner)
    return unresolved(golden.length ? "review" : "pending");
  if (extra.winner !== "draw") {
    if (golden.length) return unresolved("review");
    return { status: "resolved", championId: winnerId(extra),
      runnerUpId: extra.winner === "red" ? extra.blue.id : extra.red.id,
      decisiveFightId: extra.id, requiredResultIds: [...requiredResultIds, original.id, extra.id] };
  }
  const linkedGolden = golden.filter((fight) =>
    fight.continuationParentFightId === extra.id ||
    (!fight.continuationParentFightId && fight.bracketMatchId === extra.bracketMatchId));
  if (linkedGolden.length === 0) return unresolved(golden.length ? "review" : "pending");
  if (linkedGolden.length !== 1 || golden.length !== 1) return unresolved("review");
  const gp = linkedGolden[0];
  if (!gp.completed || !gp.winner) return unresolved("pending");
  if (gp.winner === "draw") return unresolved("review");
  return { status: "resolved", championId: winnerId(gp),
    runnerUpId: gp.winner === "red" ? gp.blue.id : gp.red.id,
    decisiveFightId: gp.id, requiredResultIds: [...requiredResultIds, original.id, extra.id, gp.id] };
}

/** Pure, conservative authority for elimination placement; server verification is separate. */
export function resolveEliminationOutcome(
  snapshot: TournamentCategorySnapshot
): EliminationOutcome {
  const { bracketMatches: matches, fights } = snapshot;
  if (!matches.length) return unresolved("pending");
  if (matches.some((match) => !match.completed || !match.winnerId)) return unresolved("pending");
  const byId = new Map(matches.map((match) => [match.id, match]));
  if (matches.some((match) => {
    const ids = [match.red.competitor?.id, match.blue.competitor?.id];
    if (!ids.includes(match.winnerId)) return true;
    return [match.red, match.blue].some((slot) => slot.fromMatchId &&
      byId.get(slot.fromMatchId)?.winnerId !== slot.competitor?.id);
  })) return unresolved("review");
  const requiredResultIds: string[] = [];
  for (const match of matches) {
    if (!match.red.competitor || !match.blue.competitor) {
      if (fights.some((fight) => fight.bracketMatchId === match.id))
        return unresolved("review");
      continue; // structural bye needs no fabricated result
    }
    const originals = fights.filter((fight) => fight.bracketMatchId === match.id &&
      !fight.isTiebreakExtra && !fight.isGoldenPointFight);
    if (originals.length !== 1) return unresolved("review");
    const fight = originals[0];
    const sequence = resolveFinalSequence(fight, fights, []);
    if (sequence.status === "pending") return unresolved("pending");
    if (fight.red.id !== match.red.competitor.id ||
      fight.blue.id !== match.blue.competitor.id ||
      sequence.status !== "resolved" || sequence.championId !== match.winnerId)
      return unresolved("review");
    requiredResultIds.push(...sequence.requiredResultIds);
  }
  const double = matches.some((match) => match.bracketGroup === "B");
  if (double) {
    const a = matchFinal(matches.filter((match) => match.bracketGroup === "A"));
    const b = matchFinal(matches.filter((match) => match.bracketGroup === "B"));
    if (!a || !b || !a.winnerId || !b.winnerId || a.winnerId === b.winnerId)
      return unresolved("review");
    const finals = fights.filter((fight) => fight.groupId === "FINAL_AB" &&
      fight.isFinalFight && !fight.isTiebreakExtra && !fight.isGoldenPointFight);
    if (!finals.length) return unresolved("pending");
    if (finals.length !== 1) return unresolved("review");
    const final = finals[0];
    if (final.red.id !== a.winnerId || final.blue.id !== b.winnerId)
      return unresolved("review");
    return resolveFinalSequence(final, fights, requiredResultIds);
  }
  const final = matchFinal(matches);
  if (!final || !final.winnerId) return unresolved("review");
  const contestants = [final.red.competitor?.id, final.blue.competitor?.id];
  if (!contestants.includes(final.winnerId)) return unresolved("review");
  const finalFights = fights.filter((fight) => fight.bracketMatchId === final.id &&
    !fight.isTiebreakExtra && !fight.isGoldenPointFight);
  if (!finalFights.length) return unresolved("review");
  if (finalFights.length !== 1) return unresolved("review");
  const resolved = resolveFinalSequence(finalFights[0], fights, []);
  if (resolved.status === "resolved" && resolved.championId !== final.winnerId)
    return unresolved("review");
  return { ...resolved, requiredResultIds: [...new Set([
    ...requiredResultIds, ...resolved.requiredResultIds,
  ])] };
}

export function hasCategoryChampion(snapshot: TournamentCategorySnapshot): boolean {
  if (snapshot.config.mode !== "elimination") {
    return Boolean(
      roundRobinOutcome(snapshot.fights, snapshot.groups.length ? snapshot.groups : undefined)
        .championId
    );
  }
  return resolveEliminationOutcome(snapshot).status === "resolved";
}

export function getCategoryPrimaryAction(
  context: CategoryPrimaryActionContext
): CategoryPrimaryAction {
  const { snapshot, serverState } = context;
  const lock = serverState.activeMatchLock;
  const loaded = serverState.match && !serverState.resultConfirmed ? serverState.match : null;
  const categoryId = lock?.categoryId ?? serverState.categoryId ?? loaded?.categoryId;
  const fightId = lock?.fightId ?? loaded?.id;
  if (fightId && categoryId === snapshot.config.id) {
    const review =
      lock?.resultStatus === "pending_confirmation" ||
      (loaded &&
        serverState.matchState?.phase === "finished" &&
        Boolean(serverState.matchState.result));
    return {
      kind: review ? "review" : "fight",
      label: review ? "Revisar resultado pendiente" : "Volver al combate",
      route: "/fight",
      disabled: false,
      fightId,
    };
  }
  if (isCategoryInitialized(snapshot)) {
    if (
      context.connected &&
      context.stateReady &&
      context.resultsVerified &&
      hasCategoryChampion(snapshot)
    ) {
      return { kind: "results", label: "Ver resultados", route: "/results", disabled: false };
    }
    const eligible = (fight: TournamentCategorySnapshot["fights"][number] | undefined): boolean => {
      if (!fight || fight.completed) return false;
      if (snapshot.config.mode === "elimination") return true;
      const expectedIds = snapshot.groups.find((group) => group.id === (fight.groupId ?? "G1"))
        ?.competitors.map((competitor) => competitor.id);
      return isAuthorizedPlayoffFight(fight, snapshot.fights, expectedIds);
    };
    const selected = snapshot.fights[snapshot.currentFightIndex];
    const pending = eligible(selected) ? selected : snapshot.fights.find(eligible);
    if (pending) return { kind: "continue", label: "Ir a Combate", route: "/fight",
      fightId: pending.id, disabled: false };
    const elimination = snapshot.config.mode === "elimination";
    return {
      kind: "continue",
      label: elimination ? "Revisar llave" : "Revisar clasificación",
      route: elimination ? "/bracket" : "/standings",
      reason: elimination
        ? "No hay un combate pendiente preparado. Revisá la llave para preparar la siguiente ronda o la Final A+B."
        : hasCategoryChampion(snapshot)
          ? "Los combates terminaron; falta verificar sus resultados en Clasificación."
          : "No hay un combate pendiente preparado. Revisá Clasificación para resolver desempates o preparar la Fase Final.",
      disabled: false,
    };
  }
  const count = snapshot.competitors.length;
  const reason = !snapshot.config.categoryName.trim()
    ? "Seleccioná la categoría primero"
    : count < (snapshot.config.mode === "elimination" ? 2 : 3)
      ? `Mínimo ${snapshot.config.mode === "elimination" ? 2 : 3} competidores`
      : snapshot.config.mode !== "elimination" && count > 12
        ? "Máximo 12 competidores"
        : (validateCategoryTimingForStart(snapshot.config) ??
          (!context.connected || !context.stateReady
            ? "Esperá la conexión y el estado del servidor"
            : undefined));
  return {
    kind: "start",
    label: "Iniciar categoría",
    route: null,
    disabled: Boolean(reason),
    reason,
  };
}

export function categoryRestartBlockedReason(
  context: Pick<CategoryPrimaryActionContext, "connected" | "stateReady" | "serverState">
): string | null {
  if (!context.connected || !context.stateReady)
    return "Esperá la conexión y el estado del servidor antes de reiniciar.";
  if (
    context.serverState.activeMatchLock ||
    (context.serverState.match && !context.serverState.resultConfirmed)
  ) {
    return "Confirmá y cerrá el combate cargado en el tatami antes de reiniciar cualquier categoría.";
  }
  return null;
}
