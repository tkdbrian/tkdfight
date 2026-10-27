import {
  generateDoubleBracket, generateEliminationBracket, generateFinalFights, generateGroupsTournament,
  getActiveBracketFights,
} from "@/lib/bracket";
import { validateCategoryTimingForStart } from "@/lib/yusan-profile";
import { swapInitialBracketSlots } from "@/lib/bracket-seeding";
import { createRestartReplacement } from "@/lib/category-lifecycle";
import { applyFightTiming, withoutRegularRoundRobinTiebreak } from "@/lib/fight-timing";
import { closedGroupBasis, groupWinnerId, isAuthorizedPlayoffFight, isExternalGuestFight,
  nextDirectFightIsGoldenPoint, preparePlayoffFights, rankRoundRobinGroup,
  resolveFirstPlace } from "@/lib/round-robin-resolution";
import {
  addMatchEvent, confirmTableGoldenOutcome, createGoldenPointMatch, createMatch,
  endPhase, getSanctionCount, resolveJury, setSanctionCount, setTableGoldenPointVote,
  startPhase, tick, undoLastEvent,
} from "@/engine/match-machine";
import {
  confirmFlagRound, finishPointsFromJudgeTotals, finishTulVoting,
  hasPreFightActivity, reopenTulVoting, resultFlagCounts, startTulVoting,
} from "@/engine/desk-operations";
import { computeJudgeTotalsForMatch, computePenaltyCountsForMatch } from "@/engine/judge-totals";
import type { RuleSetSparring } from "@/engine/types";
import type { FightEntry, TournamentCategorySnapshot, TournamentConfig } from "@/store/tournament";
import itfRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import type { DemoActiveMatch, DemoDeskCommand, DemoDeskState } from "./types";
import { DemoRuntimeError } from "./types";

const baseRules = itfRules as RuleSetSparring;

function fail(code: ConstructorParameters<typeof DemoRuntimeError>[0], message: string): never {
  throw new DemoRuntimeError(code, message);
}

export function emptyDemoDeskState(eventId: string = crypto.randomUUID()): DemoDeskState {
  return { version: 1, eventId, tournamentName: "Demo", categories: {}, archives: {},
    categoryOrder: [], selectedCategoryId: null, active: null, history: [] };
}

function category(state: DemoDeskState, id: string): TournamentCategorySnapshot {
  return state.categories[id] ?? fail("not-found", "La categoría ya no existe en esta demo.");
}

function activeMatch(state: DemoDeskState, command: {categoryId:string; fightId:string; loadId:string}): DemoActiveMatch {
  const active = state.active;
  if (!active || active.categoryId !== command.categoryId || active.fightId !== command.fightId
    || active.loadId !== command.loadId || active.resultConfirmed)
    fail("stale", "El combate cargado cambió. Revisá la pantalla antes de continuar.");
  return active;
}

function fightOf(snapshot: TournamentCategorySnapshot, fightId: string): FightEntry {
  return snapshot.fights.find((item) => item.id === fightId)
    ?? fail("not-found", "La pelea ya no existe en esta categoría.");
}

function ensureSetup(state: DemoDeskState, id: string): TournamentCategorySnapshot {
  const snapshot = category(state, id);
  if (snapshot.phase !== "setup" || state.active?.categoryId === id)
    fail("locked", "La categoría ya comenzó o tiene una pelea cargada.");
  return snapshot;
}

function ensurePreFight(active: DemoActiveMatch): void {
  if (active.started || active.paused || hasPreFightActivity(active.state, active.rules,
    active.roundFlags, active.judgeVotes) || active.tulPhase !== "idle")
    fail("wrong-phase", "Solo se puede cambiar antes del inicio y sin actividad.");
}

function ensureCleanIdle(active: DemoActiveMatch): void {
  // Reset keeps `started` sticky after activity to prevent another colour swap,
  // but the same bout must still be startable from a clean idle state.
  if (hasPreFightActivity(active.state, active.rules, active.roundFlags, active.judgeVotes)
    || active.tulPhase !== "idle")
    fail("wrong-phase", "Hay actividad previa; reiniciá el combate antes de iniciarlo.");
}

function requireJudge(id: string, rules: RuleSetSparring): void {
  if (!Array.from({ length: rules.judgesCount }, (_, index) => `J${index + 1}`).includes(id))
    fail("invalid", "El juez no pertenece a este combate.");
}

function prepareBracket(snapshot: TournamentCategorySnapshot): number {
  const fights = getActiveBracketFights(snapshot.bracketMatches, snapshot.fights);
  snapshot.fights.push(...fights);
  if (fights.length) snapshot.currentFightIndex = snapshot.fights.length - fights.length;
  return fights.length;
}

function markBracketWinner(snapshot: TournamentCategorySnapshot, fight: FightEntry, winnerId: string): void {
  const match = snapshot.bracketMatches.find((entry) => entry.id === fight.bracketMatchId);
  if (!match) return;
  if (match.completed) fail("locked", "La llave ya tiene ganador confirmado.");
  const competitor = fight.red.id === winnerId ? fight.red : fight.blue.id === winnerId ? fight.blue : null;
  if (!competitor) fail("invalid", "El ganador no participa de la llave.");
  match.completed = true;
  match.winnerId = winnerId;
  for (const next of snapshot.bracketMatches) {
    if (next.red.fromMatchId === match.id) next.red = { ...next.red, competitor };
    if (next.blue.fromMatchId === match.id) next.blue = { ...next.blue, competitor };
  }
}

function loadRules(snapshot: TournamentCategorySnapshot, fight: FightEntry): RuleSetSparring {
  const configured = snapshot.config.ruleSet?.mode === "sparring"
    ? snapshot.config.ruleSet : baseRules;
  const judgesCount = snapshot.config.judgesCount;
  if (!Number.isSafeInteger(judgesCount) || judgesCount < 1 || judgesCount > 5)
    fail("invalid", "La categoría necesita entre uno y cinco jueces.");
  // The category-level selection survives creating another category even when
  // its optional ruleSet is null or still carries an older judge count.
  const effective = configured.judgesCount === judgesCount
    ? configured : { ...configured, judgesCount };
  const timed = applyFightTiming(effective, snapshot.config, fight, snapshot.bracketMatches);
  return withoutRegularRoundRobinTiebreak(timed, snapshot.config.mode, fight);
}

function canLoad(snapshot: TournamentCategorySnapshot, fight: FightEntry): boolean {
  if (fight.completed) return false;
  if (isExternalGuestFight(fight)) return true;
  if (snapshot.config.mode === "elimination") return true;
  const expected = snapshot.groups.find((group) => group.id === (fight.groupId ?? "G1"))
    ?.competitors.map((competitor) => competitor.id);
  return isAuthorizedPlayoffFight(fight, snapshot.fights, expected);
}

function categoryDraft(config: TournamentConfig): TournamentCategorySnapshot {
  return { phase: "setup", config, competitors: [], fights: [], groups: [],
    currentFightIndex: 0, bracketMatches: [], bracketSeeds: [], setupStarted: true };
}

function assertAllConfirmed(state: DemoDeskState, categoryId: string, fights: FightEntry[]): void {
  for (const fight of fights) {
    if (!fight.completed || !state.history.some((entry) => entry.categoryId === categoryId
      && entry.fightId === fight.id && entry.winner === fight.winner))
      fail("locked", "Faltan resultados confirmados antes de preparar la próxima pelea.");
  }
}

function contestEntrant(snapshot: TournamentCategorySnapshot, id: string) {
  return snapshot.competitors.find((competitor) => competitor.id === id)
    ?? snapshot.fights.flatMap((fight) => [fight.red, fight.blue])
      .find((competitor) => competitor.id === id)
    ?? fail("not-found", "No se encontró un competidor clasificado.");
}

/** Pure command reducer. Persistence and idempotency are handled by BrowserDeskRuntime. */
export function reduceDemoDeskState(previous: DemoDeskState, command: DemoDeskCommand, now = new Date()): DemoDeskState {
  const next = structuredClone(previous);
  switch (command.type) {
    case "category/create": {
      if (next.active) fail("locked", "Confirmá o postergá la pelea cargada antes de crear otra categoría.");
      const id = command.categoryId ?? crypto.randomUUID();
      if (!id.trim() || next.categories[id]) fail("invalid", "Identidad de categoría repetida.");
      const previousConfig = next.selectedCategoryId ? category(next, next.selectedCategoryId).config : null;
      const config: TournamentConfig = {
        id, eventId: next.eventId, tournamentName: next.tournamentName, categoryName: "",
        tableChief: "", ruleSet: null, judgesCount: previousConfig?.judgesCount ?? 4,
        mode: "round-robin", rrOrderMode: "rest-optimized", matchType: "sparring",
        nameGenerated: true, requiresGradeSelection: false,
        ...(previousConfig?.profileId ? { profileId: previousConfig.profileId, profileApplied: true } : {}),
      };
      next.categories[id] = categoryDraft(config);
      next.categoryOrder.push(id);
      next.selectedCategoryId = id;
      return next;
    }
    case "category/select": {
      category(next, command.categoryId);
      next.selectedCategoryId = command.categoryId;
      return next;
    }
    case "category/configure": {
      const snapshot = ensureSetup(next, command.categoryId);
      const { id: _ignoredId, eventId: _ignoredEventId, ...patch } = command.patch;
      if (patch.ruleSet !== undefined && patch.ruleSet !== null && patch.ruleSet.mode !== "sparring")
        fail("invalid", "Este editor requiere reglas de lucha válidas.");
      snapshot.config = { ...snapshot.config, ...patch };
      if (snapshot.config.matchType === "tul") delete snapshot.config.weightLabel;
      return next;
    }
    case "category/addCompetitor": {
      const snapshot = ensureSetup(next, command.categoryId);
      const id = command.competitorId ?? crypto.randomUUID();
      if (!id.trim() || !command.competitor.name.trim() || snapshot.competitors.some((item) => item.id === id))
        fail("invalid", "El competidor necesita nombre e identidad únicos.");
      snapshot.competitors.push({ ...command.competitor, name: command.competitor.name.trim(), id });
      return next;
    }
    case "category/updateCompetitor": {
      const snapshot = ensureSetup(next, command.categoryId);
      const item = snapshot.competitors.find((entry) => entry.id === command.competitorId)
        ?? fail("not-found", "El competidor ya no está en la lista.");
      Object.assign(item, command.patch);
      if (!item.name.trim()) fail("invalid", "El nombre del competidor es obligatorio.");
      return next;
    }
    case "category/removeCompetitor": {
      const snapshot = ensureSetup(next, command.categoryId);
      if (!snapshot.competitors.some((entry) => entry.id === command.competitorId))
        fail("not-found", "El competidor ya no está en la lista.");
      snapshot.competitors = snapshot.competitors.filter((entry) => entry.id !== command.competitorId);
      return next;
    }
    case "category/start": {
      const snapshot = ensureSetup(next, command.categoryId);
      if (!snapshot.config.categoryName.trim()) fail("invalid", "Elegí un nombre de categoría.");
      const timingError = validateCategoryTimingForStart(snapshot.config);
      if (timingError) fail("invalid", timingError);
      const count = snapshot.competitors.length;
      if (snapshot.config.mode === "elimination") {
        if (count < 2) fail("invalid", "Eliminación requiere al menos dos competidores.");
        const fixture = count > 16 ? generateDoubleBracket(snapshot.competitors)
          : generateEliminationBracket(snapshot.competitors);
        snapshot.bracketMatches = fixture.matches;
        snapshot.bracketSeeds = fixture.seeds;
        prepareBracket(snapshot);
      } else if (snapshot.config.mode === "round-robin") {
        if (count < 3 || count > 12) fail("invalid", "Round Robin requiere entre 3 y 12 competidores.");
        const fixture = generateGroupsTournament(snapshot.competitors, "SERPENTINE",
          snapshot.config.rrOrderMode ?? "group-blocks");
        snapshot.fights = fixture.fights;
        snapshot.groups = fixture.groups;
      } else fail("invalid", "Este formato no está disponible en la demo.");
      snapshot.phase = "fighting";
      snapshot.currentFightIndex = 0;
      return next;
    }
    case "category/prepareNext": {
      const snapshot = category(next, command.categoryId);
      if (next.active || snapshot.phase !== "fighting" || snapshot.config.mode !== "elimination")
        fail("wrong-phase", "No se puede preparar otra ronda ahora.");
      if (!prepareBracket(snapshot)) fail("wrong-phase", "La llave todavía no tiene otra ronda lista.");
      return next;
    }
    case "category/preparePlayoff": {
      const snapshot = category(next, command.categoryId);
      if (next.active || snapshot.phase !== "fighting" || snapshot.config.mode !== "round-robin")
        fail("wrong-phase", "No se puede preparar un desempate ahora.");
      const expectedIds = command.groupId === "FINAL"
        ? snapshot.groups.map((group) => {
          const rows = rankRoundRobinGroup(group.id, snapshot.fights);
          return groupWinnerId(group.id, rows, snapshot.fights,
            group.competitors.map((competitor) => competitor.id));
        })
        : snapshot.groups.find((group) => group.id === command.groupId)
          ?.competitors.map((competitor) => competitor.id);
      if (!expectedIds || expectedIds.some((id) => !id))
        fail("wrong-phase", "El grupo o sus ganadores aún no están confirmados.");
      const rows = rankRoundRobinGroup(command.groupId, snapshot.fights);
      const resolution = resolveFirstPlace(command.groupId, rows, snapshot.fights,
        expectedIds.filter((id): id is string => id !== null));
      if ((resolution.status !== "needed" && resolution.status !== "review")
        || resolution.nextIds.length < 2 || resolution.fights.some((fight) => !fight.completed))
        fail("wrong-phase", "No hay un desempate oficial pendiente para preparar.");
      const dependencies = snapshot.fights.filter((fight) =>
        (fight.groupId ?? "G1") === command.groupId && !fight.importedFrom);
      assertAllConfirmed(next, command.categoryId, dependencies);
      const entrants = resolution.nextIds.map((id) => contestEntrant(snapshot, id));
      const seconds = snapshot.config.tiebreakerSeconds
        ?? (snapshot.config.ruleSet?.mode === "sparring"
          ? snapshot.config.ruleSet.rounds.overtime_seconds : undefined) ?? 30;
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600)
        fail("invalid", "La duración del desempate debe estar entre 1 y 3600 segundos.");
      const prepared = preparePlayoffFights(entrants, command.groupId, resolution, seconds);
      if (!prepared.length) fail("wrong-phase", "No se pudo preparar este desempate sin cambiar el historial.");
      snapshot.currentFightIndex = snapshot.fights.length;
      snapshot.fights.push(...prepared);
      return next;
    }
    case "category/prepareFinal": {
      const snapshot = category(next, command.categoryId);
      if (next.active || snapshot.phase !== "fighting" || snapshot.config.mode !== "round-robin"
        || snapshot.groups.length < 2 || snapshot.fights.some((fight) => fight.isFinalFight))
        fail("wrong-phase", "La fase final no está disponible.");
      const regular = snapshot.fights.filter((fight) => !fight.isTiebreakExtra
        && !fight.isGoldenPointFight && !fight.isFinalFight && !isExternalGuestFight(fight));
      assertAllConfirmed(next, command.categoryId, regular);
      const winners = snapshot.groups.map((group) => {
        const expectedIds = group.competitors.map((competitor) => competitor.id);
        const rows = rankRoundRobinGroup(group.id, snapshot.fights);
        const info = resolveFirstPlace(group.id, rows, snapshot.fights, expectedIds);
        if (["needed", "review", "in_progress"].includes(info.status))
          fail("wrong-phase", "Primero resolvé el desempate del grupo.");
        const winnerId = groupWinnerId(group.id, rows, snapshot.fights, expectedIds);
        return winnerId ? contestEntrant(snapshot, winnerId) : null;
      });
      if (winners.some((competitor) => !competitor)
        || new Set(winners.map((competitor) => competitor?.id)).size !== winners.length)
        fail("wrong-phase", "No hay ganadores de grupo únicos para la final.");
      const finalFights = generateFinalFights(winners.filter((competitor) => competitor !== null));
      if (!finalFights.length) fail("wrong-phase", "No se pudo preparar la final.");
      snapshot.currentFightIndex = snapshot.fights.length;
      snapshot.fights.push(...finalFights);
      return next;
    }
    case "category/swapBracketSlots": {
      const snapshot = category(next, command.categoryId);
      if (next.active || snapshot.phase !== "fighting" || snapshot.config.mode !== "elimination"
        || snapshot.fights.some((fight) => fight.completed || !fight.bracketMatchId
          || fight.isTiebreakExtra || fight.isGoldenPointFight)
        || next.history.some((entry) => entry.categoryId === command.categoryId))
        fail("locked", "La llave solo se edita antes de cargar o terminar su primera pelea.");
      // The browser has no remote copy of merely prepared bouts. Discard only
      // untouched generated IDs, use the shared balanced-BYE seed transform,
      // then atomically prepare the new first round.
      const swapped = swapInitialBracketSlots(snapshot.bracketMatches, [],
        command.aMatchId, command.aSlot, command.bMatchId, command.bSlot);
      if (!swapped) fail("invalid", "No se pueden intercambiar esas posiciones de la llave.");
      snapshot.bracketMatches = swapped.bracketMatches;
      snapshot.bracketSeeds = swapped.bracketSeeds;
      snapshot.fights = [];
      prepareBracket(snapshot);
      return next;
    }
    case "category/addGuestFight": {
      const snapshot = category(next, command.categoryId);
      if (next.active || snapshot.phase !== "fighting")
        fail("wrong-phase", "Primero cerrá el combate activo.");
      const redName = command.redName.trim();
      const blueName = command.blueName.trim();
      const categoryName = command.categoryName.trim();
      const originRing = command.originRing.trim();
      if (!redName || !blueName || !categoryName || !originRing)
        fail("invalid", "Completá los nombres y el origen del combate invitado.");
      const slug = categoryName.toLowerCase().replace(/\s+/g, "-");
      snapshot.fights.push({ id: crypto.randomUUID(),
        red: { id: crypto.randomUUID(), name: redName },
        blue: { id: crypto.randomUUID(), name: blueName },
        completed: false, groupId: `EXT:${slug}`, importedFrom: originRing });
      snapshot.currentFightIndex = snapshot.fights.length - 1;
      return next;
    }
    case "category/delete": {
      if (command.confirm !== true) fail("invalid", "Confirmá el borrado de la categoría.");
      if (next.active) fail("locked", "Cerrá el combate cargado antes de borrar.");
      category(next, command.categoryId);
      delete next.categories[command.categoryId];
      next.categoryOrder = next.categoryOrder.filter((id) => id !== command.categoryId);
      next.history = next.history.filter((entry) => entry.categoryId !== command.categoryId);
      if (next.selectedCategoryId === command.categoryId)
        next.selectedCategoryId = next.categoryOrder[0] ?? null;
      return next;
    }
    case "category/restart": {
      if (command.confirm !== true) fail("invalid", "Confirmá el reinicio de la categoría.");
      if (next.active) fail("locked", "Cerrá el combate cargado antes de reiniciar.");
      const source = category(next, command.categoryId);
      const replacement = createRestartReplacement(source);
      const replacementId = replacement.config.id;
      if (next.categories[replacementId] || next.archives[replacementId])
        fail("invalid", "La identidad de la nueva ejecución ya existe.");
      if (command.mode === "archive") next.archives[command.categoryId] = source;
      else next.history = next.history.filter((entry) => entry.categoryId !== command.categoryId);
      delete next.categories[command.categoryId];
      next.categories[replacementId] = replacement;
      next.categoryOrder = next.categoryOrder.map((id) => id === command.categoryId ? replacementId : id);
      next.selectedCategoryId = replacementId;
      return next;
    }
    case "fight/select": {
      const snapshot = category(next, command.categoryId);
      const index = snapshot.fights.findIndex((item) => item.id === command.fightId);
      if (index < 0) fail("not-found", "La pelea ya no está en la lista.");
      if (next.active && (next.active.categoryId !== command.categoryId || next.active.fightId !== command.fightId))
        fail("locked", "Hay otro combate cargado.");
      snapshot.currentFightIndex = index;
      next.selectedCategoryId = command.categoryId;
      return next;
    }
    case "fight/load": {
      const snapshot = category(next, command.categoryId);
      if (snapshot.phase !== "fighting") fail("wrong-phase", "Primero iniciá la categoría.");
      const fight = fightOf(snapshot, command.fightId);
      if (!canLoad(snapshot, fight)) fail("locked", "La pelea no está habilitada o ya terminó.");
      if (next.active) {
        if (next.active.categoryId === command.categoryId && next.active.fightId === command.fightId)
          return next;
        fail("locked", "Confirmá o postergá el combate cargado antes de abrir otro.");
      }
      const rules = loadRules(snapshot, fight);
      const active: DemoActiveMatch = {
        categoryId: command.categoryId, fightId: fight.id, red: fight.red, blue: fight.blue,
        rules, state: fight.isGoldenPointFight ? createGoldenPointMatch(rules) : createMatch(rules),
        paused: false, started: false, loadId: crypto.randomUUID(), assignmentRevision: 0,
        judgeVotes: {}, roundFlags: [], tulPhase: "idle", resultConfirmed: false,
      };
      next.active = active;
      snapshot.currentFightIndex = snapshot.fights.indexOf(fight);
      next.selectedCategoryId = command.categoryId;
      return next;
    }
    case "fight/swap": {
      const active = activeMatch(next, command);
      const snapshot = category(next, command.categoryId);
      const fight = fightOf(snapshot, command.fightId);
      if (snapshot.config.matchType !== "sparring" || fight.isGoldenPointFight
        || fight.isTiebreakExtra || fight.continuationStage)
        fail("wrong-phase", "Este tipo de pelea no admite intercambio.");
      if (active.assignmentRevision !== command.assignmentRevision || active.red.id !== command.expectedRedId
        || active.blue.id !== command.expectedBlueId) fail("stale", "Los competidores cambiaron; actualizá la pelea.");
      ensurePreFight(active);
      [active.red, active.blue] = [active.blue, active.red];
      [fight.red, fight.blue] = [fight.blue, fight.red];
      active.assignmentRevision++;
      return next;
    }
    case "fight/postpone": {
      const active = activeMatch(next, command);
      ensurePreFight(active);
      const snapshot = category(next, command.categoryId);
      const index = snapshot.fights.findIndex((item) => item.id === command.fightId);
      const nextIndex = snapshot.fights.findIndex((item, at) => at > index && !item.completed);
      if (nextIndex < 0) fail("wrong-phase", "No hay otra pelea pendiente para postergar.");
      [snapshot.fights[index], snapshot.fights[nextIndex]] = [snapshot.fights[nextIndex], snapshot.fights[index]];
      snapshot.currentFightIndex = index;
      next.active = null;
      return next;
    }
    case "fight/start": {
      const active = activeMatch(next, command);
      const fight = fightOf(category(next, command.categoryId), command.fightId);
      if (fight.red.id !== active.red.id || fight.blue.id !== active.blue.id)
        fail("stale", "Las asignaciones del combate no coinciden.");
      if (category(next, command.categoryId).config.matchType === "tul") {
        if (active.tulPhase !== "idle") fail("wrong-phase", "La votación ya comenzó.");
        ensureCleanIdle(active);
        active.state = startTulVoting(active.state);
        active.tulPhase = "voting";
        active.started = true;
        return next;
      }
      if (active.paused || !["idle", "rest"].includes(active.state.phase))
        fail("wrong-phase", "No se puede iniciar este round.");
      if (active.state.phase === "idle") ensureCleanIdle(active);
      active.state = startPhase(active.state, active.rules);
      active.started = true;
      return next;
    }
    case "fight/pause": {
      const active = activeMatch(next, command);
      if (active.paused || !["round", "overtime"].includes(active.state.phase))
        fail("wrong-phase", "El reloj no está corriendo.");
      active.paused = true;
      return next;
    }
    case "fight/resume": {
      const active = activeMatch(next, command);
      if (!active.paused || !["round", "overtime"].includes(active.state.phase))
        fail("wrong-phase", "No hay un reloj pausado.");
      active.paused = false;
      return next;
    }
    case "fight/tick": {
      const active = activeMatch(next, command);
      if (active.paused || !["round", "overtime"].includes(active.state.phase))
        fail("wrong-phase", "El reloj no está corriendo.");
      active.state = tick(active.state, active.rules);
      return next;
    }
    case "fight/adjustTimer": {
      const active = activeMatch(next, command);
      if (!active.paused || !["round", "overtime", "rest"].includes(active.state.phase)
        || !Number.isSafeInteger(command.seconds) || Math.abs(command.seconds) > 3600)
        fail("wrong-phase", "Pausá el reloj para ajustarlo.");
      active.state = { ...active.state, timeLeft: Math.max(0, active.state.timeLeft + command.seconds) };
      return next;
    }
    case "fight/skipToFlags": {
      const active = activeMatch(next, command);
      if (active.state.phase === "golden_point" || category(next, command.categoryId).config.matchType === "tul")
        fail("wrong-phase", "Este combate no tiene banderas cronometradas.");
      let matchState = active.state;
      if (matchState.phase === "idle") {
        ensureCleanIdle(active);
        const fight = fightOf(category(next, command.categoryId), command.fightId);
        if (fight.red.id !== active.red.id || fight.blue.id !== active.blue.id)
          fail("stale", "Las asignaciones del combate no coinciden.");
      }
      if (matchState.phase === "idle" || matchState.phase === "rest") {
        matchState = startPhase(matchState, active.rules);
        active.started = true;
      }
      if (matchState.phase !== "round") fail("wrong-phase", "No hay round para cerrar.");
      active.state = endPhase({ ...matchState, timeLeft: 0 }, active.rules);
      active.paused = false;
      return next;
    }
    case "fight/finishRound": {
      const active = activeMatch(next, command);
      if (!["round", "overtime"].includes(active.state.phase))
        fail("wrong-phase", "No hay un round para finalizar.");
      active.state = endPhase({ ...active.state, timeLeft: 0 }, active.rules);
      active.paused = false;
      return next;
    }
    case "fight/vote": {
      const active = activeMatch(next, command);
      requireJudge(command.judgeId, active.rules);
      if (active.state.phase === "golden_point") fail("wrong-phase", "Usá votos de Punto de Oro.");
      if (category(next, command.categoryId).config.matchType === "tul") {
        if (active.tulPhase !== "voting") fail("wrong-phase", "La votación de Tul no está abierta.");
      } else if (!["round", "rest"].includes(active.state.phase))
        fail("wrong-phase", "No se pueden registrar banderas ahora.");
      active.judgeVotes[command.judgeId] = command.vote;
      return next;
    }
    case "fight/confirmRound": {
      const active = activeMatch(next, command);
      const snapshot = category(next, command.categoryId);
      if (snapshot.config.matchType !== "sparring" || active.rules.judgingMode === "points")
        fail("wrong-phase", "Esta pelea no usa banderas de mesa.");
      const fight = fightOf(snapshot, command.fightId);
      const decision = confirmFlagRound({ matchState: active.state, rules: active.rules,
        roundFlags: active.roundFlags, judgeVotes: active.judgeVotes,
        requireIndividualFlags: snapshot.config.mode === "round-robin" && !fight.isTiebreakExtra
          && !fight.isGoldenPointFight && !fight.isFinalFight });
      if (!decision) fail("wrong-phase", "Faltan votos o no se puede confirmar este round.");
      active.state = decision.matchState;
      active.roundFlags = decision.roundFlags;
      active.judgeVotes = {};
      return next;
    }
    case "fight/undoRound": {
      const active = activeMatch(next, command);
      if (category(next, command.categoryId).config.matchType !== "sparring"
        || active.rules.judgingMode === "points" || !active.roundFlags.length
        || ["round", "overtime", "golden_point"].includes(active.state.phase))
        fail("wrong-phase", "No hay banderas pendientes para corregir.");
      const last = active.roundFlags.at(-1)!;
      active.roundFlags = active.roundFlags.slice(0, -1);
      if (active.state.phase === "finished") {
        if (active.state.result?.reason !== "points")
          fail("wrong-phase", "Este resultado no admite corrección de banderas.");
        const votes: DemoActiveMatch["judgeVotes"] = {};
        for (let index = 1; index <= active.rules.judgesCount; index++) {
          const id = `J${index}`;
          const vote = last.votes[id];
          if (vote === "red" || vote === "blue" || vote === "draw") votes[id] = vote;
        }
        active.judgeVotes = votes;
        active.state = { ...active.state, phase: "rest", timeLeft: 0,
          pendingJuryDecision: false, result: null };
        active.paused = true;
      } else {
        active.judgeVotes = {};
      }
      return next;
    }
    case "fight/event": {
      const active = activeMatch(next, command);
      if (category(next, command.categoryId).config.matchType !== "sparring"
        || active.state.phase === "golden_point") fail("wrong-phase", "No se puntúa este combate así.");
      if (command.judgeId !== "arbiter") requireJudge(command.judgeId, active.rules);
      if (!Object.hasOwn(active.rules.points, command.eventType)
        && !Object.hasOwn(active.rules.deductions, command.eventType))
        fail("invalid", "Evento de puntuación desconocido.");
      const updated = addMatchEvent(active.state, { judgeId: command.judgeId,
        competitor: command.competitor, type: command.eventType }, active.rules);
      if (updated === active.state) fail("wrong-phase", "No se pueden registrar puntos ahora.");
      active.state = updated;
      return next;
    }
    case "fight/undo": {
      const active = activeMatch(next, command);
      if (active.state.result || active.state.phase === "golden_point")
        fail("wrong-phase", "Un resultado pendiente no admite deshacer puntos.");
      const updated = undoLastEvent(active.state, command.judgeId);
      if (updated === active.state) fail("wrong-phase", "No hay evento para deshacer.");
      active.state = updated;
      return next;
    }
    case "fight/dq": {
      const active = activeMatch(next, command);
      if (active.state.phase === "golden_point" || category(next, command.categoryId).config.matchType === "tul")
        fail("wrong-phase", "No se puede descalificar esta pelea así.");
      const updated = addMatchEvent(active.state, { judgeId: "arbiter",
        competitor: command.competitor, type: "disqualify" }, active.rules);
      if (updated === active.state) fail("wrong-phase", "La pelea no está activa.");
      active.state = updated;
      active.paused = false;
      return next;
    }
    case "fight/medical": {
      const active = activeMatch(next, command);
      if (!["round", "overtime"].includes(active.state.phase))
        fail("wrong-phase", "No hay un round activo.");
      active.paused = true;
      return next;
    }
    case "fight/reset": {
      const active = activeMatch(next, command);
      if (active.state.result) fail("locked", "El resultado pendiente no puede reiniciarse.");
      if (hasPreFightActivity(active.state, active.rules, active.roundFlags, active.judgeVotes))
        active.started = true;
      active.state = category(next, command.categoryId).fights.find((fight) => fight.id === command.fightId)
        ?.isGoldenPointFight ? createGoldenPointMatch(active.rules) : createMatch(active.rules);
      active.roundFlags = [];
      active.judgeVotes = {};
      active.tulPhase = "idle";
      active.paused = false;
      // Reset fences requests queued against the previous in-memory bout generation.
      active.loadId = crypto.randomUUID();
      return next;
    }
    case "fight/setSanction": {
      const active = activeMatch(next, command);
      if (active.state.result?.reason === "dq" || category(next, command.categoryId).config.matchType !== "sparring")
        fail("wrong-phase", "No se puede corregir esta sanción.");
      if (getSanctionCount(active.state, command.competitor, command.kind) !== command.expectedCount)
        fail("stale", "La cantidad de sanciones cambió.");
      const updated = setSanctionCount(active.state, command.competitor, command.kind,
        command.count, active.rules);
      if (updated === active.state) fail("wrong-phase", "No se aplicó la corrección.");
      active.state = updated;
      return next;
    }
    case "fight/confirmPenalties": {
      const active = activeMatch(next, command);
      if (active.state.phase !== "penalties") fail("wrong-phase", "No hay sanciones por confirmar.");
      active.state = finishPointsFromJudgeTotals(active.state, computeJudgeTotalsForMatch(active.state));
      return next;
    }
    case "fight/resolveJury": {
      const active = activeMatch(next, command);
      if (!active.state.pendingJuryDecision) fail("wrong-phase", "No hay decisión de jurado pendiente.");
      active.state = resolveJury(active.state, command.winner);
      return next;
    }
    case "fight/goldenVote": {
      const active = activeMatch(next, command);
      requireJudge(command.judgeId, active.rules);
      if (active.state.phase !== "golden_point") fail("wrong-phase", "Punto de Oro no está activo.");
      const updated = setTableGoldenPointVote(active.state, command.judgeId,
        command.competitor, command.attempt, active.rules.judgesCount);
      if (updated === active.state) fail("stale", "Voto duplicado o intento anterior.");
      active.state = updated;
      return next;
    }
    case "fight/confirmGolden": {
      const active = activeMatch(next, command);
      if (active.state.phase !== "golden_point") fail("wrong-phase", "Punto de Oro no está activo.");
      const updated = confirmTableGoldenOutcome(active.state, command.attempt, active.rules.judgesCount);
      if (updated === active.state) fail("wrong-phase", "Todavía no hay mayoría para confirmar.");
      active.state = updated;
      return next;
    }
    case "fight/tulFinish": {
      const active = activeMatch(next, command);
      if (category(next, command.categoryId).config.matchType !== "tul" || active.tulPhase !== "voting")
        fail("wrong-phase", "La votación de Tul no está abierta.");
      const updated = finishTulVoting(active.state, active.judgeVotes, active.rules.judgesCount);
      if (!updated) fail("wrong-phase", "Tul requiere ganador rojo o azul; corregí los votos.");
      active.state = updated;
      active.tulPhase = "finished";
      return next;
    }
    case "fight/tulRetry": {
      const active = activeMatch(next, command);
      if (category(next, command.categoryId).config.matchType !== "tul" || active.tulPhase !== "voting")
        fail("wrong-phase", "La votación de Tul no está abierta.");
      active.judgeVotes = {};
      return next;
    }
    case "fight/tulUndoFinish": {
      const active = activeMatch(next, command);
      if (category(next, command.categoryId).config.matchType !== "tul" || active.tulPhase !== "finished"
        || active.state.phase !== "finished" || active.state.result?.reason !== "points")
        fail("wrong-phase", "No hay fallo de Tul pendiente para corregir.");
      active.state = reopenTulVoting(active.state);
      active.tulPhase = "voting";
      return next;
    }
    case "fight/continueDraw": {
      if (next.active) fail("locked", "Confirmá la pelea cargada antes del desempate.");
      const snapshot = category(next, command.categoryId);
      const parent = fightOf(snapshot, command.fightId);
      if (!parent.completed || parent.winner !== "draw"
        || !next.history.some((entry) => entry.categoryId === command.categoryId
          && entry.fightId === parent.id && entry.winner === "draw"))
        fail("wrong-phase", "Primero confirmá el empate.");
      if (snapshot.config.mode !== "elimination" && (!(parent.isFinalFight || parent.isTiebreakExtra)
        || parent.playoffKind !== "direct"))
        fail("wrong-phase", "Este empate no necesita una continuación directa.");
      if (snapshot.fights.some((fight) => fight.continuationParentFightId === parent.id))
        fail("locked", "La continuación ya fue preparada.");
      const parentIndex = snapshot.fights.findIndex((fight) => fight.id === parent.id);
      if (snapshot.fights.some((fight, index) => index > parentIndex && fight.groupId === parent.groupId
        && fight.playoffKind === "direct"
        && [fight.red.id, fight.blue.id].sort().join("|") ===
          [parent.red.id, parent.blue.id].sort().join("|")))
        fail("locked", "La continuación oficial de este empate ya existe.");
      const golden = snapshot.config.mode === "elimination"
        ? Boolean(parent.isTiebreakExtra || parent.isGoldenPointFight)
        : nextDirectFightIsGoldenPoint(parent, snapshot.fights);
      const playoffBasis = snapshot.config.mode === "elimination" ? undefined
        : parent.playoffBasis ?? closedGroupBasis(parent.groupId ?? "G1", snapshot.fights,
          snapshot.groups.find((group) => group.id === parent.groupId)
            ?.competitors.map((competitor) => competitor.id));
      if (snapshot.config.mode !== "elimination" && !playoffBasis)
        fail("wrong-phase", "El grupo todavía no está cerrado.");
      const continuation: FightEntry = {
        id: crypto.randomUUID(), red: parent.red, blue: parent.blue, completed: false,
        isTiebreakExtra: !golden, isGoldenPointFight: golden || undefined,
        playoffKind: "direct", playoffBasis: playoffBasis ?? undefined,
        bracketMatchId: parent.bracketMatchId ?? parent.id,
        tiebreakerSeconds: golden ? undefined : snapshot.config.tiebreakerSeconds ?? 60,
        groupId: parent.groupId, isFinalFight: parent.isFinalFight || undefined,
        continuationParentFightId: parent.id,
        continuationStage: golden ? "golden-point" : "timed-extra",
      };
      snapshot.currentFightIndex = snapshot.fights.length;
      snapshot.fights.push(continuation);
      return next;
    }
    case "fight/confirmResult": {
      const active = activeMatch(next, command);
      const result = active.state.result;
      if (active.state.phase !== "finished" || !result)
        fail("wrong-phase", "El resultado todavía no está listo.");
      const snapshot = category(next, command.categoryId);
      const fight = fightOf(snapshot, command.fightId);
      if (fight.completed || next.history.some((entry) => entry.categoryId === command.categoryId
        && entry.fightId === command.fightId)) fail("locked", "El resultado ya fue confirmado.");
      const flags = resultFlagCounts({ matchMode: snapshot.config.matchType,
        goldenPoint: fight.isGoldenPointFight, matchState: active.state,
        roundFlags: active.roundFlags, judgeVotes: active.judgeVotes,
        judgesCount: active.rules.judgesCount });
      const penalties = computePenaltyCountsForMatch(active.state);
      Object.assign(fight, { completed: true, winner: result.winner, winReason: result.reason,
        flagsRed: flags.red, flagsBlue: flags.blue,
        warningsRed: penalties.warnings.red, warningsBlue: penalties.warnings.blue,
        foulsRed: penalties.fouls.red, foulsBlue: penalties.fouls.blue });
      if (snapshot.config.mode === "elimination" && result.winner !== "draw") {
        const winnerId = result.winner === "red" ? active.red.id : active.blue.id;
        markBracketWinner(snapshot, fight, winnerId);
      }
      next.history.push({ id: crypto.randomUUID(), categoryId: command.categoryId,
        fightId: command.fightId, confirmedAt: now.toISOString(), red: active.red,
        blue: active.blue, winner: result.winner, reason: result.reason,
        flagsRed: flags.red, flagsBlue: flags.blue,
        warningsRed: penalties.warnings.red, warningsBlue: penalties.warnings.blue,
        foulsRed: penalties.fouls.red, foulsBlue: penalties.fouls.blue });
      snapshot.currentFightIndex = Math.min(snapshot.fights.length - 1,
        Math.max(0, snapshot.fights.findIndex((item) => !item.completed)));
      next.active = null;
      return next;
    }
  }
}
