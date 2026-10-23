import { createHash } from "node:crypto";
import { z } from "zod";
import {
  generateDoubleBracket,
  generateEliminationBracket,
  generateGroupsTournament,
} from "../../src/lib/bracket.js";
import {
  restartCategoryRequestSchema,
  type ArchivedCategoryHistoryFields,
  type CategoryArchiveMetadata,
  type CategoryRestartSnapshot,
  type RestartCategoryError,
  type RestartCategoryRequest,
  type RestartCategorySuccess,
} from "../../src/lib/category-restart-contract.js";
import db, {
  createTournament,
  getActiveMatchLock,
  getCategoryTournamentId,
  getSelectedTournamentId,
  resolveCategoryTournament,
  setSelectedTournamentId,
  upsertCompetitor,
  upsertFight,
} from "./index.js";
import {
  assertCategoryNotDeleted, assertTournamentNotDeleted, assertIdentityNotDeleted,
  assertReplacementNotDeleted, isDeletedTournament,
} from "./category-deletions.js";

type ErrorCode = RestartCategoryError["error"];
export class CategoryExecutionError extends Error {
  readonly code: ErrorCode;
  readonly categoryId?: string;
  readonly replacementCategoryId?: string;
  constructor(
    code: ErrorCode,
    message: string,
    categoryId?: string,
    replacementCategoryId?: string
  ) {
    super(message);
    this.code = code;
    this.categoryId = categoryId;
    this.replacementCategoryId = replacementCategoryId;
  }
}
interface ArchiveRow {
  category_id: string;
  request_id: string;
  replacement_category_id: string;
  source_tournament_id: number;
  replacement_tournament_id: number;
  archived_at: string;
  previous_snapshot: string;
  replacement_snapshot: string;
  warnings: string;
  request_fingerprint: string;
}
function metadata(row: ArchiveRow): CategoryArchiveMetadata {
  return {
    categoryId: row.category_id,
    replacementCategoryId: row.replacement_category_id,
    requestId: row.request_id,
    archivedAt: row.archived_at,
    sourceTournamentId: row.source_tournament_id,
    replacementTournamentId: row.replacement_tournament_id,
    provenance: "as-recorded",
    warnings: JSON.parse(row.warnings) as string[],
  };
}
function success(row: ArchiveRow): RestartCategorySuccess {
  return {
    ok: true,
    requestId: row.request_id,
    categoryId: row.category_id,
    replacementCategoryId: row.replacement_category_id,
    archive: metadata(row),
    replacementSnapshot: JSON.parse(row.replacement_snapshot) as CategoryRestartSnapshot,
  };
}
export function getCategoryReplacement(categoryId: string): RestartCategorySuccess | null {
  assertReplacementNotDeleted(categoryId);
  assertCategoryNotDeleted(categoryId);
  const row = db
    .prepare("SELECT * FROM category_execution_archives WHERE category_id = ?")
    .get(categoryId) as ArchiveRow | undefined;
  return row ? success(row) : null;
}
export function getCategoryArchive(tournamentId: number): ArchivedCategoryHistoryFields | null {
  const row = db
    .prepare("SELECT * FROM category_execution_archives WHERE source_tournament_id = ?")
    .get(tournamentId) as ArchiveRow | undefined;
  return row
    ? {
        readOnly: true,
        archive: metadata(row),
        fullSnapshot: JSON.parse(row.previous_snapshot) as CategoryRestartSnapshot,
      }
    : null;
}
export function assertCategoryWritable(categoryId: string): void {
  assertCategoryNotDeleted(categoryId);
  const archive = db.prepare("SELECT replacement_category_id FROM category_execution_archives WHERE category_id = ?")
    .get(categoryId) as { replacement_category_id: string } | undefined;
  if (archive)
    throw new CategoryExecutionError(
      "category_archived",
      "Esta ejecución está archivada y es de solo lectura.",
      categoryId,
      archive.replacement_category_id
    );
}
export function assertTournamentWritable(tournamentId: number): void {
  assertTournamentNotDeleted(tournamentId);
  const row = db
    .prepare("SELECT category_id FROM category_execution_archives WHERE source_tournament_id = ?")
    .get(tournamentId) as { category_id: string } | undefined;
  if (row) assertCategoryWritable(row.category_id);
}
export function assertFightWritable(fightId: string): void {
  assertIdentityNotDeleted("fight", fightId);
  const row = db.prepare("SELECT tournament_id FROM fights WHERE id = ?").get(fightId) as
    | { tournament_id: number }
    | undefined;
  if (row) {
    assertTournamentWritable(row.tournament_id);
    return;
  }
  // Local-only archived fights have no SQL owner, but must not be resurrected by stale clients.
  for (const archive of archivedRows()) {
    const graph = JSON.parse(archive.previous_snapshot) as CategoryRestartSnapshot;
    if (graph.fights.some((fight) => fight.id === fightId))
      assertCategoryWritable(archive.category_id);
  }
}
export function assertCompetitorWritable(competitorId: string): void {
  assertIdentityNotDeleted("competitor", competitorId);
  const row = db.prepare("SELECT tournament_id FROM competitors WHERE id = ?").get(competitorId) as
    | { tournament_id: number }
    | undefined;
  if (row) {
    assertTournamentWritable(row.tournament_id);
    return;
  }
  for (const archive of archivedRows()) {
    const graph = JSON.parse(archive.previous_snapshot) as CategoryRestartSnapshot;
    if (participants(graph).has(competitorId)) assertCategoryWritable(archive.category_id);
  }
}
export function isProtectedHistoryTournament(tournamentId: number): boolean {
  if (isDeletedTournament(tournamentId)) return true;
  return !!db
    .prepare(`SELECT 1 FROM category_execution_archives
    WHERE source_tournament_id = ? OR replacement_tournament_id = ?`)
    .get(tournamentId, tournamentId);
}
function archivedRows(): ArchiveRow[] {
  return db.prepare("SELECT * FROM category_execution_archives").all() as ArchiveRow[];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function conflict(message: string): never {
  throw new CategoryExecutionError("snapshot_conflict", message);
}
function participants(graph: CategoryRestartSnapshot): Set<string> {
  return new Set([
    ...graph.competitors.map((entry) => entry.id),
    ...graph.groups.flatMap((group) => group.competitors.map((entry) => entry.id)),
    ...graph.fights.flatMap((fight) => [fight.red.id, fight.blue.id]),
    ...graph.bracketMatches.flatMap((match) =>
      [match.red.competitor?.id, match.blue.competitor?.id].filter(
        (id): id is string => typeof id === "string"
      )
    ),
  ]);
}
function identities(graph: CategoryRestartSnapshot): string[] {
  return [
    graph.config.id,
    ...participants(graph),
    ...graph.fights.map((fight) => fight.id),
    ...graph.bracketMatches.map((match) => match.id),
  ];
}
function bracketShape(graph: CategoryRestartSnapshot): unknown {
  const entrant = new Map(graph.competitors.map((entry, i) => [entry.id, i]));
  const matchIndex = new Map(graph.bracketMatches.map((entry, i) => [entry.id, i]));
  const side = (slot: CategoryRestartSnapshot["bracketMatches"][number]["red"]): unknown => ({
    competitor: slot.competitor ? entrant.get(slot.competitor.id) : null,
    from: slot.fromMatchId ? matchIndex.get(slot.fromMatchId) : undefined,
  });
  return {
    seeds: graph.bracketSeeds.map((id) => (id ? entrant.get(id) : null)),
    matches: graph.bracketMatches.map((match) => ({
      round: match.round,
      position: match.position,
      red: side(match.red),
      blue: side(match.blue),
      completed: match.completed,
      winner: match.winnerId ? entrant.get(match.winnerId) : undefined,
      group: match.bracketGroup,
    })),
  };
}
export function validateCategoryReplacement(input: RestartCategoryRequest): void {
  const old = input.previousSnapshot;
  const next = input.replacementSnapshot;
  if (canonical({ ...old.config, id: null }) !== canonical({ ...next.config, id: null })) {
    conflict("La configuración de la categoría cambió.");
  }
  if (
    canonical(old.competitors.map(({ id: _id, ...entry }) => entry)) !==
    canonical(next.competitors.map(({ id: _id, ...entry }) => entry))
  ) {
    conflict("Los participantes o su orden cambiaron.");
  }
  const entrants = new Map(next.competitors.map((entry) => [entry.id, entry]));
  const embedded = [
    ...next.groups.flatMap((group) => group.competitors),
    ...next.fights.flatMap((fight) => [fight.red, fight.blue]),
    ...next.bracketMatches.flatMap((match) => [match.red.competitor, match.blue.competitor]),
  ];
  if (
    embedded.some(
      (entry) => entry !== null && canonical(entry) !== canonical(entrants.get(entry.id))
    )
  ) {
    conflict("Los datos de participantes vinculados no coinciden con el registro nuevo.");
  }
  const reserved = new Set(identities(old));
  for (const row of archivedRows()) {
    for (const field of [row.previous_snapshot, row.replacement_snapshot]) {
      for (const identity of identities(JSON.parse(field) as CategoryRestartSnapshot))
        reserved.add(identity);
    }
  }
  const fresh = identities(next);
  if (
    new Set(fresh).size !== fresh.length ||
    fresh.some((identity) => reserved.has(identity) || !z.uuid().safeParse(identity).success)
  )
    conflict("La nueva ejecución necesita identidades nuevas.");
  for (const identity of fresh) {
    // Deleted bracket nodes have no live SQL graph row; their tombstones still reserve UUIDs.
    for (const kind of ["competitor", "fight", "bracket"] as const)
      assertIdentityNotDeleted(kind, identity);
    if (
      db
        .prepare(`SELECT 1 FROM category_tournaments WHERE category_id = ? UNION ALL
      SELECT 1 FROM competitors WHERE id = ? UNION ALL SELECT 1 FROM fights WHERE id = ?`)
        .get(identity, identity, identity)
    )
      conflict("Una identidad nueva ya tiene propietario.");
  }
  if (next.phase !== "fighting" || !next.setupStarted || next.currentFightIndex !== 0) {
    conflict("La ejecución nueva debe comenzar sin progreso.");
  }
  for (const fight of next.fights) {
    if (
      fight.completed ||
      fight.winner !== undefined ||
      fight.winReason !== undefined ||
      [
        fight.flagsRed,
        fight.flagsBlue,
        fight.warningsRed,
        fight.warningsBlue,
        fight.foulsRed,
        fight.foulsBlue,
      ].some((value) => value !== undefined && value !== 0) ||
      fight.isTiebreakExtra ||
      fight.playoffKind ||
      fight.playoffBasis ||
      fight.isGoldenPointFight ||
      fight.importedFrom
    )
      conflict("La nueva ejecución contiene resultados previos.");
  }
  // Validate the standard graph only; no standings, winner or scheduling rule is reimplemented.
  if (next.config.mode === "elimination") {
    const generated =
      next.competitors.length > 16
        ? generateDoubleBracket(next.competitors)
        : generateEliminationBracket(next.competitors);
    const expected = { ...next, bracketMatches: generated.matches, bracketSeeds: generated.seeds };
    if (
      next.fights.length ||
      next.groups.length ||
      canonical(bracketShape(next)) !== canonical(bracketShape(expected)) ||
      next.bracketMatches.some((match) => match.fightId !== undefined)
    ) {
      conflict("La llave nueva contiene avance competitivo o vínculos inválidos.");
    }
  } else {
    if (
      next.fights.some(
        (fight) =>
          fight.isFinalFight ||
          fight.tiebreakerSeconds !== undefined ||
          fight.bracketRound !== undefined ||
          fight.bracketPosition !== undefined ||
          fight.bracketMatchId !== undefined
      )
    )
      conflict("El fixture regular contiene etapas ajenas.");
    let fixture: ReturnType<typeof generateGroupsTournament>;
    try {
      fixture = generateGroupsTournament(next.competitors);
    } catch {
      conflict("No se pudo validar el fixture nuevo.");
    }
    const shape = (fights: CategoryRestartSnapshot["fights"]): unknown =>
      fights.map((fight) => ({
        red: fight.red,
        blue: fight.blue,
        group: fight.groupId,
      }));
    if (
      next.bracketMatches.length ||
      next.bracketSeeds.length ||
      canonical(next.groups) !== canonical(fixture.groups) ||
      canonical(shape(next.fights)) !== canonical(shape(fixture.fights))
    ) {
      conflict("El fixture nuevo no corresponde a los participantes registrados.");
    }
  }
}
interface DurableFight {
  id: string;
  tournament_id: number;
  red_id: string;
  blue_id: string;
  completed: number;
  winner: string | null;
  reason: string | null;
  flags_red: number;
  flags_blue: number;
  status: string | null;
  result_category_id: string | null;
  warnings_red: number | null;
  warnings_blue: number | null;
  fouls_red: number | null;
  fouls_blue: number | null;
}
function validatePrevious(input: RestartCategoryRequest, sourceId: number): string[] {
  const warnings: string[] = [];
  const stored = db
    .prepare(`SELECT f.*, r.status, r.category_id AS result_category_id,
    r.warnings_red, r.warnings_blue, r.fouls_red, r.fouls_blue FROM fights f
    LEFT JOIN match_results r ON r.fight_id = f.id WHERE f.tournament_id = ?`)
    .all(sourceId) as DurableFight[];
  const graph = new Map(input.previousSnapshot.fights.map((fight) => [fight.id, fight]));
  let unlinked = 0;
  let local = 0;
  for (const fight of stored) {
    const recorded = graph.get(fight.id);
    if (!recorded) {
      unlinked++;
      continue;
    }
    if (recorded.red.id !== fight.red_id || recorded.blue.id !== fight.blue_id) {
      conflict("Los participantes del combate no coinciden con el registro durable.");
    }
    if (fight.status === "confirmed" || fight.completed === 1) {
      if (
        !recorded.completed ||
        recorded.winner !== fight.winner ||
        (recorded.winReason !== undefined && recorded.winReason !== fight.reason) ||
        (fight.result_category_id !== null && fight.result_category_id !== input.categoryId)
      ) {
        conflict("Un resultado durable cambió; actualizá la categoría antes de reiniciar.");
      }
      const pairs = [
        [recorded.flagsRed, fight.flags_red],
        [recorded.flagsBlue, fight.flags_blue],
        [recorded.warningsRed, fight.warnings_red],
        [recorded.warningsBlue, fight.warnings_blue],
        [recorded.foulsRed, fight.fouls_red],
        [recorded.foulsBlue, fight.fouls_blue],
      ];
      if (
        pairs.some(
          ([value, durable]) => value !== undefined && durable !== null && value !== durable
        )
      ) {
        conflict("Las métricas del resultado durable cambiaron.");
      }
    } else if (recorded.completed) local++;
  }
  for (const fight of input.previousSnapshot.fights) {
    const owner = db.prepare("SELECT tournament_id FROM fights WHERE id = ?").get(fight.id) as
      | { tournament_id: number }
      | undefined;
    if (owner && owner.tournament_id !== sourceId)
      conflict("Un combate pertenece a otra ejecución.");
    if (!owner) local++;
  }
  if (local)
    warnings.push(
      `${local} combates locales/remotos se conservan tal como fueron registrados; no se inventaron resultados oficiales SQL.`
    );
  if (unlinked)
    warnings.push(
      `${unlinked} combates SQL de historial anterior no están vinculados al gráfico archivado y se conservaron separados.`
    );
  if (input.previousSnapshot.bracketMatches.some((match) => match.completed && !match.fightId)) {
    warnings.push(
      "La llave conserva avances/byes tal como fueron registrados; un bye no equivale a un resultado oficial SQL."
    );
  }
  return warnings;
}
export interface RestartExecutionOptions {
  hasUnconfirmedMatch?: boolean;
  selectedTournamentId?: number;
}
export function createCategoryReplacement(next: CategoryRestartSnapshot): number {
  const { tournamentId } = resolveCategoryTournament({
    categoryId: next.config.id,
    tournamentName: next.config.tournamentName,
    categoryName: next.config.categoryName,
  });
  for (const entry of next.competitors) upsertCompetitor({ ...entry, tournament_id: tournamentId });
  for (const [order, fight] of next.fights.entries())
    upsertFight({
      id: fight.id,
      tournament_id: tournamentId,
      red_id: fight.red.id,
      blue_id: fight.blue.id,
      group_id: fight.groupId,
      round_index: order,
    });
  return tournamentId;
}
export function restartCategoryExecution(
  input: RestartCategoryRequest,
  options: RestartExecutionOptions = {}
): RestartCategorySuccess {
  return db.transaction(() => {
    assertReplacementNotDeleted(input.categoryId);
    assertCategoryNotDeleted(input.categoryId);
    if (db.prepare("SELECT 1 FROM category_execution_deletions WHERE request_id = ?")
      .get(input.requestId))
      throw new CategoryExecutionError("request_id_conflict", "El requestId ya se usó para otra operación.");
    const fingerprint = createHash("sha256").update(canonical(input)).digest("hex");
    const prior = db
      .prepare("SELECT * FROM category_execution_archives WHERE request_id = ?")
      .get(input.requestId) as ArchiveRow | undefined;
    if (prior) {
      if (prior.request_fingerprint !== fingerprint)
        throw new CategoryExecutionError(
          "request_id_conflict",
          "Este requestId ya fue utilizado con otros datos."
        );
      return success(prior);
    }
    assertCategoryWritable(input.categoryId);
    if (options.hasUnconfirmedMatch || getActiveMatchLock())
      throw new CategoryExecutionError(
        "active_match",
        "El tatami tiene un combate pendiente; volvé y confirmá su resultado primero."
      );
    if (!restartCategoryRequestSchema.safeParse(input).success)
      conflict("El snapshot de la categoría no es válido.");
    validateCategoryReplacement(input);
    let sourceId = getCategoryTournamentId(input.categoryId);
    const wasUnregistered = sourceId === null;
    if (sourceId === null) {
      sourceId = createTournament(
        input.previousSnapshot.config.tournamentName,
        input.previousSnapshot.config.categoryName
      );
      db.prepare("INSERT INTO category_tournaments (category_id, tournament_id) VALUES (?, ?)").run(
        input.categoryId,
        sourceId
      );
    }
    const warnings = validatePrevious(input, sourceId);
    if (wasUnregistered)
      warnings.unshift(
        "Categoría local archivada como fue registrada, sin asociar historial por nombre ni crear resultados oficiales."
      );
    const next = input.replacementSnapshot;
    const replacementId = createCategoryReplacement(next);
    db.prepare(`INSERT INTO category_execution_archives (category_id, request_id,
      replacement_category_id, source_tournament_id, replacement_tournament_id,
      archived_at, previous_snapshot, replacement_snapshot, warnings, request_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.categoryId,
      input.requestId,
      next.config.id,
      sourceId,
      replacementId,
      new Date().toISOString(),
      JSON.stringify(input.previousSnapshot),
      JSON.stringify(next),
      JSON.stringify(warnings),
      fingerprint
    );
    if ((options.selectedTournamentId ?? getSelectedTournamentId()) === sourceId) {
      setSelectedTournamentId(replacementId);
    }
    return getCategoryReplacement(input.categoryId)!;
  })();
}
