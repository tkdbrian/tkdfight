import { createHash } from "node:crypto";
import {
  type CategoryDeletionCounts,
  type CategoryDeletionError as CategoryDeletionErrorBody,
  type CategoryDeletionPreview,
  type CategoryDeletionReceipt,
  type CategoryDeletionRequest,
  type CategoryDeletionTombstone,
  categoryDeletionRequestSchema,
} from "../../src/lib/category-deletion-contract.js";
import {
  type CategoryRestartSnapshot,
  categoryRestartSnapshotSchema,
} from "../../src/lib/category-restart-contract.js";
import { assertCategoryWritable } from "./category-executions.js";
import db, { getActiveMatchLock, getCategoryTournamentId } from "./index.js";

type ErrorCode = CategoryDeletionErrorBody["error"];
type IdentityKind = "competitor" | "fight" | "bracket";
export class CategoryDeletionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly categoryId?: string,
    readonly deletion?: CategoryDeletionReceipt
  ) {
    super(message);
  }
}
interface DeletionRow {
  category_id: string;
  request_id: string;
  tournament_id: number | null;
  deleted_at: string;
  counts: string;
  request_fingerprint: string;
}
function receipt(row: DeletionRow): CategoryDeletionReceipt {
  return {
    ok: true,
    requestId: row.request_id,
    categoryId: row.category_id,
    tournamentId: row.tournament_id,
    deletedAt: row.deleted_at,
    counts: JSON.parse(row.counts) as CategoryDeletionCounts,
  };
}
export function getCategoryDeletion(categoryId: string): CategoryDeletionReceipt | null {
  const row = db
    .prepare("SELECT * FROM category_execution_deletions WHERE category_id = ?")
    .get(categoryId) as DeletionRow | undefined;
  return row ? receipt(row) : null;
}
export function getCategoryDeletionTombstones(): CategoryDeletionTombstone[] {
  return db
    .prepare(`SELECT category_id AS categoryId, request_id AS requestId,
    deleted_at AS deletedAt FROM category_execution_deletions ORDER BY deleted_at, category_id`)
    .all() as CategoryDeletionTombstone[];
}
export function isDeletedTournament(tournamentId: number): boolean {
  return !!db
    .prepare("SELECT 1 FROM category_execution_deletions WHERE tournament_id = ?")
    .get(tournamentId);
}
export function assertCategoryNotDeleted(categoryId: string): void {
  const deleted = getCategoryDeletion(categoryId);
  if (deleted)
    throw new CategoryDeletionError(
      "category_deleted",
      "Esta ejecución fue eliminada definitivamente.",
      categoryId,
      deleted
    );
}
export function assertTournamentNotDeleted(tournamentId: number): void {
  const row = db
    .prepare("SELECT category_id FROM category_execution_deletions WHERE tournament_id = ?")
    .get(tournamentId) as { category_id: string } | undefined;
  if (row) assertCategoryNotDeleted(row.category_id);
}
export function assertIdentityNotDeleted(kind: IdentityKind, identityId: string): void {
  // A real foreign owner must not be captured by a historical alias reservation.
  const owner =
    kind === "bracket"
      ? undefined
      : (db
          .prepare(
            kind === "fight"
              ? "SELECT tournament_id FROM fights WHERE id = ?"
              : "SELECT tournament_id FROM competitors WHERE id = ?"
          )
          .get(identityId) as { tournament_id: number } | undefined);
  if (owner) {
    assertTournamentNotDeleted(owner.tournament_id);
    return;
  }
  const row = db
    .prepare(
      "SELECT category_id FROM category_deletion_identities WHERE kind = ? AND identity_id = ?"
    )
    .get(kind, identityId) as { category_id: string } | undefined;
  if (row) assertCategoryNotDeleted(row.category_id);
}
export function getDeletedCategoryReplacement(categoryId: string): CategoryDeletionReceipt | null {
  const visited = new Set<string>();
  let current = categoryId;
  while (!visited.has(current)) {
    visited.add(current);
    const row = db
      .prepare(
        "SELECT replacement_category_id FROM category_execution_archives WHERE category_id = ?"
      )
      .get(current) as { replacement_category_id: string } | undefined;
    if (!row) return null;
    const deleted = getCategoryDeletion(row.replacement_category_id);
    if (deleted) return deleted;
    current = row.replacement_category_id;
  }
  return null;
}
export function assertReplacementNotDeleted(categoryId: string): void {
  const deleted = getDeletedCategoryReplacement(categoryId);
  if (deleted)
    throw new CategoryDeletionError(
      "replacement_deleted",
      "La ejecución de reemplazo fue eliminada; no se recuperó su copia inicial.",
      categoryId,
      deleted
    );
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
export function fingerprintCategoryRequest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function ambiguous(categoryId: string): never {
  throw new CategoryDeletionError(
    "deletion_scope_ambiguous",
    "No se pudo demostrar que todos los datos pertenecen solo a esta ejecución. Revisá el historial sin borrar.",
    categoryId
  );
}
function stale(categoryId: string): never {
  throw new CategoryDeletionError(
    "snapshot_conflict",
    "La ejecución cambió; revisá los datos y confirmá nuevamente.",
    categoryId
  );
}
export interface CategoryDeletionOptions {
  hasUnconfirmedMatch?: boolean;
}
function requireFree(options: CategoryDeletionOptions): void {
  if (options.hasUnconfirmedMatch || getActiveMatchLock())
    throw new CategoryDeletionError(
      "active_match",
      "El tatami tiene un combate pendiente; confirmá su resultado antes de eliminar."
    );
}
interface FightRow {
  id: string;
  tournament_id: number;
  red_id: string;
  blue_id: string;
  completed: number;
  winner: string | null;
  reason: string | null;
  flags_red: number;
  flags_blue: number;
}
interface ResultRow {
  fight_id: string;
  category_id: string;
  tournament_id: number;
  winner: string;
  reason: string;
  flags_red: number;
  flags_blue: number;
  warnings_red: number;
  warnings_blue: number;
  fouls_red: number;
  fouls_blue: number;
  status: string;
}
interface CompetitorRow {
  id: string;
  tournament_id: number;
  name: string;
}
interface DeletionScope {
  tournamentId: number | null;
  competitors: CompetitorRow[];
  fights: FightRow[];
  results: ResultRow[];
  identities: Array<{ kind: IdentityKind; id: string }>;
  preview: CategoryDeletionPreview;
}
function scope(snapshot: CategoryRestartSnapshot): DeletionScope {
  const categoryId = snapshot.config.id;
  assertCategoryWritable(categoryId);
  const tournamentId = getCategoryTournamentId(categoryId);
  const competitors =
    tournamentId === null
      ? []
      : (db
          .prepare("SELECT * FROM competitors WHERE tournament_id = ? ORDER BY id")
          .all(tournamentId) as CompetitorRow[]);
  const fights =
    tournamentId === null
      ? []
      : (db
          .prepare("SELECT * FROM fights WHERE tournament_id = ? ORDER BY id")
          .all(tournamentId) as FightRow[]);
  const results =
    tournamentId === null
      ? []
      : (db
          .prepare(`SELECT r.* FROM match_results r
    LEFT JOIN fights f ON f.id = r.fight_id WHERE r.tournament_id = ? OR f.tournament_id = ? ORDER BY r.fight_id`)
          .all(tournamentId, tournamentId) as ResultRow[]);
  const entrants = new Set([
    ...snapshot.competitors.map((entry) => entry.id),
    ...snapshot.groups.flatMap((group) => group.competitors.map((entry) => entry.id)),
    ...snapshot.fights.flatMap((fight) => [fight.red.id, fight.blue.id]),
    ...snapshot.bracketMatches.flatMap((match) =>
      [match.red.competitor?.id, match.blue.competitor?.id].filter(
        (id): id is string => typeof id === "string"
      )
    ),
  ]);
  const graph = new Map(snapshot.fights.map((fight) => [fight.id, fight]));
  const storedIds = new Set(fights.map((fight) => fight.id));
  if (
    results.some(
      (result) =>
        result.category_id !== categoryId ||
        result.tournament_id !== tournamentId ||
        !storedIds.has(result.fight_id)
    )
  )
    ambiguous(categoryId);
  if (
    competitors.some((entry) => !entrants.has(entry.id)) ||
    fights.some((fight) => !graph.has(fight.id))
  )
    ambiguous(categoryId);
  for (const id of entrants) {
    assertIdentityNotDeleted("competitor", id);
    const owner = db.prepare("SELECT tournament_id FROM competitors WHERE id = ?").get(id) as
      | { tournament_id: number }
      | undefined;
    if (owner && (tournamentId === null || owner.tournament_id !== tournamentId))
      ambiguous(categoryId);
    if (
      db
        .prepare(`SELECT 1 FROM fights WHERE (red_id = ? OR blue_id = ?)
          AND (tournament_id IS NULL OR tournament_id != ?)`)
        .get(id, id, tournamentId ?? -1)
    )
      ambiguous(categoryId);
  }
  for (const fight of snapshot.fights) {
    assertIdentityNotDeleted("fight", fight.id);
    const owner = db.prepare("SELECT tournament_id FROM fights WHERE id = ?").get(fight.id) as
      | { tournament_id: number }
      | undefined;
    if (owner && (tournamentId === null || owner.tournament_id !== tournamentId))
      ambiguous(categoryId);
  }
  for (const fight of fights) {
    const local = graph.get(fight.id);
    if (!local || local.red.id !== fight.red_id || local.blue.id !== fight.blue_id)
      ambiguous(categoryId);
    if (fight.completed === 1 && (!local.completed || local.winner !== fight.winner))
      stale(categoryId);
  }
  for (const result of results) {
    if (
      result.category_id !== categoryId ||
      result.tournament_id !== tournamentId ||
      !storedIds.has(result.fight_id)
    )
      ambiguous(categoryId);
    const local = graph.get(result.fight_id);
    if (
      !local?.completed ||
      local.winner !== result.winner ||
      (local.winReason !== undefined && local.winReason !== result.reason)
    )
      stale(categoryId);
    const pairs = [
      [local.flagsRed, result.flags_red],
      [local.flagsBlue, result.flags_blue],
      [local.warningsRed, result.warnings_red],
      [local.warningsBlue, result.warnings_blue],
      [local.foulsRed, result.fouls_red],
      [local.foulsBlue, result.fouls_blue],
    ];
    if (pairs.some(([a, b]) => a !== undefined && a !== b)) stale(categoryId);
  }
  const identities: DeletionScope["identities"] = [...entrants].map((id) => ({
    kind: "competitor",
    id,
  }));
  for (const fight of snapshot.fights) identities.push({ kind: "fight", id: fight.id });
  for (const match of snapshot.bracketMatches) {
    assertIdentityNotDeleted("bracket", match.id);
    identities.push({ kind: "bracket", id: match.id });
  }
  const completed = new Set([
    ...snapshot.fights.filter((fight) => fight.completed).map((fight) => fight.id),
    ...fights.filter((fight) => fight.completed === 1).map((fight) => fight.id),
  ]);
  const counts: CategoryDeletionCounts = {
    competitors: entrants.size,
    fights: graph.size,
    completedFights: completed.size,
    confirmedResults: results.filter((row) => row.status === "confirmed").length,
    localOnlyFights: snapshot.fights.filter((fight) => !storedIds.has(fight.id)).length,
  };
  return {
    tournamentId,
    competitors,
    fights,
    results,
    identities,
    preview: {
      ok: true,
      categoryId,
      revision: fingerprintCategoryRequest({
        snapshot,
        tournamentId,
        competitors,
        fights,
        results,
      }),
      counts,
      warnings: counts.localOnlyFights
        ? ["Los combates solo locales también se quitarán; no se crearán resultados oficiales."]
        : [],
      requiresConfirmationText:
        snapshot.phase !== "setup" ||
        snapshot.fights.length > 0 ||
        snapshot.bracketMatches.length > 0 ||
        fights.length > 0 ||
        results.length > 0,
    },
  };
}
export function previewCategoryDeletion(
  snapshot: CategoryRestartSnapshot,
  options: CategoryDeletionOptions = {}
): CategoryDeletionPreview {
  return db.transaction(() => {
    requireFree(options);
    if (!categoryRestartSnapshotSchema.safeParse(snapshot).success)
      throw new CategoryDeletionError("invalid_payload", "Snapshot inválido.");
    return scope(snapshot).preview;
  })();
}
export function deleteCategoryExecution(
  input: CategoryDeletionRequest,
  options: CategoryDeletionOptions = {}
): CategoryDeletionReceipt {
  return db.transaction(() => {
    if (!categoryDeletionRequestSchema.safeParse(input).success)
      throw new CategoryDeletionError("invalid_payload", "Solicitud inválida.");
    if (
      db
        .prepare(`SELECT 1 FROM category_execution_archives WHERE request_id = ?
      UNION ALL SELECT 1 FROM category_execution_deleted_restarts WHERE request_id = ?`)
        .get(input.requestId, input.requestId)
    )
      throw new CategoryDeletionError(
        "request_id_conflict",
        "El requestId ya se usó para otra operación."
      );
    const hash = fingerprintCategoryRequest(input);
    const prior = db
      .prepare("SELECT * FROM category_execution_deletions WHERE request_id = ?")
      .get(input.requestId) as DeletionRow | undefined;
    if (prior) {
      if (prior.request_fingerprint !== hash)
        throw new CategoryDeletionError(
          "request_id_conflict",
          "El requestId ya se usó con otros datos."
        );
      return receipt(prior);
    }
    assertCategoryNotDeleted(input.localSnapshot.config.id);
    requireFree(options);
    const current = scope(input.localSnapshot);
    if (current.preview.revision !== input.expectedRevision) stale(input.localSnapshot.config.id);
    if (current.tournamentId !== null) {
      // Recovery is SQL data too: delete only this proven confirmed remnant in the same transaction.
      // Any cleanup failure rolls back its receipt, rows and selection; memory clears after commit.
      db.prepare(`DELETE FROM match_snapshot WHERE category_id = ? AND tournament_id = ?
        AND EXISTS (SELECT 1 FROM match_results r WHERE r.fight_id = match_snapshot.fight_id
          AND r.category_id = match_snapshot.category_id AND r.tournament_id = match_snapshot.tournament_id
          AND r.status = 'confirmed')`).run(input.localSnapshot.config.id, current.tournamentId);
      db.prepare("DELETE FROM fights WHERE tournament_id = ?").run(current.tournamentId);
      db.prepare("DELETE FROM competitors WHERE tournament_id = ?").run(current.tournamentId);
      db.prepare("UPDATE tournaments SET name = '', category = '' WHERE id = ?").run(
        current.tournamentId
      );
      db.prepare(
        "UPDATE ring_selection SET tournament_id = NULL, explicitly_cleared = 1 WHERE tournament_id = ?"
      ).run(current.tournamentId);
    }
    const categoryId = input.localSnapshot.config.id;
    db.prepare(`INSERT INTO category_execution_deletions
      (category_id, request_id, tournament_id, deleted_at, counts, request_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      categoryId,
      input.requestId,
      current.tournamentId,
      new Date().toISOString(),
      JSON.stringify(current.preview.counts),
      hash
    );
    const reserve = db.prepare(
      "INSERT INTO category_deletion_identities (kind, identity_id, category_id) VALUES (?, ?, ?)"
    );
    for (const identity of current.identities) reserve.run(identity.kind, identity.id, categoryId);
    const deleted = getCategoryDeletion(categoryId);
    if (!deleted) throw new Error("Deletion receipt was not persisted");
    return deleted;
  })();
}
