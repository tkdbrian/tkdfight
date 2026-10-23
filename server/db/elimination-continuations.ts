import type {
  CanonicalEliminationFight,
  EliminationContinuationRequest,
} from "../../src/lib/elimination-continuation-contract.js";
import db, { assertCategoryWritable } from "./index.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS category_elimination_continuations (
    category_id TEXT NOT NULL REFERENCES category_tournaments(category_id) ON DELETE RESTRICT,
    parent_fight_id TEXT NOT NULL REFERENCES fights(id) ON DELETE RESTRICT,
    parent_revision INTEGER NOT NULL CHECK (parent_revision >= 0),
    stage TEXT NOT NULL CHECK (stage IN ('timed-extra', 'golden-point')),
    canonical_fight_id TEXT NOT NULL UNIQUE REFERENCES fights(id) ON DELETE RESTRICT,
    red_id TEXT NOT NULL,
    blue_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (category_id, parent_fight_id)
  );
`);

interface ContinuationRow {
  category_id: string;
  parent_fight_id: string;
  parent_revision: number;
  stage: "timed-extra" | "golden-point";
  canonical_fight_id: string;
  red_id: string;
  blue_id: string;
}

function canonical(row: ContinuationRow): CanonicalEliminationFight {
  return {
    id: row.canonical_fight_id,
    red_id: row.red_id,
    blue_id: row.blue_id,
    stage: row.stage,
    parentFightId: row.parent_fight_id,
    parentRevision: row.parent_revision,
  };
}

export function getEliminationContinuation(
  categoryId: string,
  parentFightId: string
): CanonicalEliminationFight | null {
  const row = db
    .prepare(`
    SELECT * FROM category_elimination_continuations
    WHERE category_id = ? AND parent_fight_id = ?
  `)
    .get(categoryId, parentFightId) as ContinuationRow | undefined;
  return row ? canonical(row) : null;
}

export class ContinuationConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuationConflict";
  }
}

/** Must run inside the sync-fights transaction, after category association has been resolved. */
export function ensureEliminationContinuation(
  categoryId: string,
  tournamentId: number,
  request: EliminationContinuationRequest
): CanonicalEliminationFight {
  assertCategoryWritable(categoryId);
  const { parentFightId, parentRevision, proposedFight } = request;
  const parent = db
    .prepare(`
    SELECT f.red_id, f.blue_id, f.completed, f.result_revision,
      r.winner, r.status
    FROM fights f
    JOIN match_results r ON r.fight_id = f.id
    WHERE f.id = ? AND f.tournament_id = ? AND r.category_id = ?
      AND r.tournament_id = ?
  `)
    .get(parentFightId, tournamentId, categoryId, tournamentId) as
    | {
        red_id: string;
        blue_id: string;
        completed: number;
        result_revision: number;
        winner: string;
        status: string;
      }
    | undefined;
  if (
    !parent ||
    parent.completed !== 1 ||
    parent.status !== "confirmed" ||
    parent.winner !== "draw"
  ) {
    throw new ContinuationConflict("El combate padre debe tener un empate confirmado.");
  }
  if (parent.result_revision !== parentRevision) {
    throw new ContinuationConflict(
      "El resultado padre cambió de revisión; recargue antes de continuar."
    );
  }
  const parentContinuation = db
    .prepare(`
    SELECT stage FROM category_elimination_continuations
    WHERE category_id = ? AND canonical_fight_id = ?
  `)
    .get(categoryId, parentFightId) as { stage: "timed-extra" | "golden-point" } | undefined;
  const expectedStage =
    parentContinuation?.stage === "timed-extra" ? "golden-point" : "timed-extra";
  if (parentContinuation?.stage === "golden-point" || proposedFight.stage !== expectedStage) {
    throw new ContinuationConflict(
      "La etapa de desempate no sigue la secuencia original, extra y punto de oro."
    );
  }
  if (
    proposedFight.red_id !== parent.red_id ||
    proposedFight.blue_id !== parent.blue_id ||
    proposedFight.red_id === proposedFight.blue_id
  ) {
    throw new ContinuationConflict("La continuación debe conservar ambos competidores y colores.");
  }
  const existing = getEliminationContinuation(categoryId, parentFightId);
  if (existing) {
    if (
      existing.parentRevision !== parentRevision ||
      existing.stage !== proposedFight.stage ||
      existing.red_id !== proposedFight.red_id ||
      existing.blue_id !== proposedFight.blue_id
    ) {
      throw new ContinuationConflict("La continuación guardada no coincide con esta propuesta.");
    }
    return existing;
  }
  const collision = db.prepare("SELECT 1 FROM fights WHERE id = ?").get(proposedFight.id);
  if (collision) {
    throw new ContinuationConflict("El ID propuesto ya pertenece a otro combate.");
  }
  db.prepare(`
    INSERT INTO fights (id, tournament_id, red_id, blue_id, completed, flags_red, flags_blue)
    VALUES (?, ?, ?, ?, 0, 0, 0)
  `).run(proposedFight.id, tournamentId, proposedFight.red_id, proposedFight.blue_id);
  db.prepare(`
    INSERT INTO category_elimination_continuations
      (category_id, parent_fight_id, parent_revision, stage, canonical_fight_id, red_id, blue_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    categoryId,
    parentFightId,
    parentRevision,
    proposedFight.stage,
    proposedFight.id,
    proposedFight.red_id,
    proposedFight.blue_id
  );
  return {
    id: proposedFight.id,
    red_id: proposedFight.red_id,
    blue_id: proposedFight.blue_id,
    stage: proposedFight.stage,
    parentFightId,
    parentRevision,
  };
}
