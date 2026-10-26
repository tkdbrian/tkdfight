import db from "./index.js";
import "./elimination-continuations.js";
import "./match-postpone.js";
import "./match-swap.js";

export const BACKUP_TABLE_COLUMNS = {
  tournaments: ["id", "name", "category", "created_at"],
  competitors: ["id", "tournament_id", "name", "team", "weight", "belt"],
  fights: [
    "id",
    "tournament_id",
    "red_id",
    "blue_id",
    "completed",
    "winner",
    "reason",
    "round_index",
    "group_id",
    "flags_red",
    "flags_blue",
    "source_ring",
    "source_category_id",
    "result_revision",
  ],
  presets: [
    "id",
    "name",
    "round_count",
    "duration_seconds",
    "final_rounds",
    "final_seconds",
    "tiebreaker_seconds",
    "max_tiebreakers",
    "created_at",
  ],
  category_tournaments: ["category_id", "tournament_id", "legacy_history_unassigned", "created_at"],
  match_results: [
    "fight_id",
    "category_id",
    "tournament_id",
    "winner",
    "reason",
    "flags_red",
    "flags_blue",
    "warnings_red",
    "warnings_blue",
    "fouls_red",
    "fouls_blue",
    "status",
    "created_at",
    "confirmed_at",
  ],
  ring_selection: ["id", "tournament_id", "explicitly_cleared"],
  category_execution_archives: [
    "category_id",
    "request_id",
    "replacement_category_id",
    "source_tournament_id",
    "replacement_tournament_id",
    "archived_at",
    "previous_snapshot",
    "replacement_snapshot",
    "warnings",
    "request_fingerprint",
  ],
  category_execution_deletions: [
    "category_id",
    "request_id",
    "tournament_id",
    "deleted_at",
    "counts",
    "request_fingerprint",
  ],
  category_deletion_identities: ["kind", "identity_id", "category_id"],
  category_execution_deleted_restarts: [
    "category_id",
    "request_id",
    "replacement_category_id",
    "replacement_snapshot",
    "request_fingerprint",
    "mode",
  ],
  match_snapshot: ["id", "fight_id", "tournament_id", "data", "saved_at", "category_id"],
  category_elimination_continuations: [
    "category_id",
    "parent_fight_id",
    "parent_revision",
    "stage",
    "canonical_fight_id",
    "red_id",
    "blue_id",
    "created_at",
  ],
} as const;

export type BackupTable = keyof typeof BACKUP_TABLE_COLUMNS;
export type SqlRow = Record<string, string | number | null>;
export interface SqlBackup {
  tables: Record<BackupTable, SqlRow[]>;
  sequences: Record<string, number>;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS restore_receipts (
    backup_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    browser_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'complete')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export function getRestoreReceipt(): {
  backup_id: string;
  payload_hash: string;
  browser_hash: string;
  status: "pending" | "complete";
} | null {
  const row = db
    .prepare("SELECT backup_id, payload_hash, browser_hash, status FROM restore_receipts LIMIT 1")
    .get() as Exclude<ReturnType<typeof getRestoreReceipt>, null> | undefined;
  return row ?? null;
}

export function isSqlIdle(): boolean {
  const lock = db.prepare("SELECT COUNT(*) AS n FROM match_snapshot").get() as { n: number };
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM match_results WHERE status = 'pending_confirmation'")
    .get() as { n: number };
  return lock.n === 0 && pending.n === 0;
}

export function bootSqlAuthority(): { hasTournamentData: boolean; activeCategoryIds: string[] } {
  const activeCategoryIds = (
    db
      .prepare(`
    SELECT category_id FROM category_tournaments
    WHERE category_id NOT IN (SELECT category_id FROM category_execution_archives)
      AND category_id NOT IN (SELECT category_id FROM category_execution_deletions)
  `)
      .all() as Array<{ category_id: string }>
  ).map((row) => row.category_id);
  const populated = Object.keys(BACKUP_TABLE_COLUMNS).some((table) => {
    if (table === "tournaments" || table === "ring_selection") return false;
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n > 0;
  });
  const nonPristineTournament =
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM tournaments WHERE name <> 'Torneo' OR category <> ''")
        .get() as { n: number }
    ).n > 0;
  return { hasTournamentData: populated || nonPristineTournament, activeCategoryIds };
}

export function captureSqlBackup(): SqlBackup {
  return db.transaction(() => {
    const tables = {} as SqlBackup["tables"];
    for (const [table, columns] of Object.entries(BACKUP_TABLE_COLUMNS)) {
      const actual = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
        (row) => row.name
      );
      if (actual.length !== columns.length || actual.some((name, index) => name !== columns[index]))
        throw new Error(`Unexpected database schema: ${table}`);
      tables[table as BackupTable] = db
        .prepare(`SELECT ${columns.join(", ")} FROM ${table}`)
        .all() as SqlRow[];
    }
    const sequences: Record<string, number> = {};
    for (const row of db.prepare("SELECT name, seq FROM sqlite_sequence").all() as Array<{
      name: string;
      seq: number;
    }>) {
      if (row.name in BACKUP_TABLE_COLUMNS) sequences[row.name] = row.seq;
    }
    return { tables, sequences };
  })();
}

function validateSqlBackup(snapshot: SqlBackup): void {
  if (!snapshot || typeof snapshot !== "object" || !snapshot.tables || !snapshot.sequences)
    throw new Error("Invalid SQL backup");
  const expectedTables = Object.keys(BACKUP_TABLE_COLUMNS);
  if (
    Object.keys(snapshot.tables).length !== expectedTables.length ||
    expectedTables.some((table) => !Array.isArray(snapshot.tables[table as BackupTable]))
  )
    throw new Error("Backup table whitelist mismatch");
  for (const [table, columns] of Object.entries(BACKUP_TABLE_COLUMNS)) {
    for (const row of snapshot.tables[table as BackupTable]) {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).length !== columns.length ||
        columns.some((column) => !(column in row)) ||
        Object.values(row).some(
          (value) =>
            value !== null &&
            typeof value !== "string" &&
            (typeof value !== "number" || !Number.isFinite(value))
        )
      )
        throw new Error(`Invalid SQL row: ${table}`);
      assertSqlDomains(table as BackupTable, row);
    }
  }
  for (const [name, seq] of Object.entries(snapshot.sequences)) {
    if (!(name in BACKUP_TABLE_COLUMNS) || !Number.isSafeInteger(seq) || seq < 0)
      throw new Error("Invalid SQL sequence");
  }
}

function assertSqlDomains(table: BackupTable, row: SqlRow): void {
  const nonnegative = (column: string, nullable = false): void => {
    const value = row[column];
    if (value === null && nullable) return;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error(`Invalid SQL domain: ${table}.${column}`);
  };
  const binary = (column: string): void => {
    if (row[column] !== 0 && row[column] !== 1)
      throw new Error(`Invalid SQL domain: ${table}.${column}`);
  };
  const oneOf = (column: string, choices: readonly (string | null)[]): void => {
    if (!choices.includes(row[column] as string | null))
      throw new Error(`Invalid SQL domain: ${table}.${column}`);
  };
  switch (table) {
    case "fights":
      binary("completed");
      oneOf("winner", ["red", "blue", "draw", null]);
      for (const column of ["flags_red", "flags_blue", "result_revision"]) nonnegative(column);
      nonnegative("round_index", true);
      break;
    case "match_results":
      oneOf("winner", ["red", "blue", "draw"]);
      oneOf("status", ["pending_confirmation", "confirmed"]);
      for (const column of [
        "flags_red",
        "flags_blue",
        "warnings_red",
        "warnings_blue",
        "fouls_red",
        "fouls_blue",
      ])
        nonnegative(column);
      break;
    case "category_tournaments":
      binary("legacy_history_unassigned");
      break;
    case "ring_selection":
      binary("explicitly_cleared");
      break;
    case "presets":
      for (const column of ["round_count", "duration_seconds"]) nonnegative(column);
      for (const column of [
        "final_rounds",
        "final_seconds",
        "tiebreaker_seconds",
        "max_tiebreakers",
      ])
        nonnegative(column, true);
      break;
    case "category_elimination_continuations":
      nonnegative("parent_revision");
      oneOf("stage", ["timed-extra", "golden-point"]);
      break;
  }
}

function assertPristineTarget(): void {
  if (getRestoreReceipt()) throw new Error("Target already restored");
  for (const table of Object.keys(BACKUP_TABLE_COLUMNS)) {
    if (table === "tournaments" || table === "ring_selection") continue;
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    if (n !== 0) throw new Error(`Target is not empty: ${table}`);
  }
  const tournaments = db.prepare("SELECT name, category FROM tournaments").all() as Array<{
    name: string;
    category: string;
  }>;
  if (
    tournaments.length > 1 ||
    tournaments.some((row) => row.name !== "Torneo" || row.category !== "")
  )
    throw new Error("Target tournament is not pristine");
  const selection = db.prepare("SELECT id FROM ring_selection").all() as Array<{ id: number }>;
  if (selection.length > 1 || selection.some((row) => row.id !== 1))
    throw new Error("Target ring selection is not pristine");
}

export function restoreSqlBackup(
  snapshot: SqlBackup,
  backupId: string,
  payloadHash: string,
  browserHash: string
): void {
  validateSqlBackup(snapshot);
  db.transaction(() => {
    assertPristineTarget();
    // Runtime retry receipts are intentionally not restored: load-generation CAS
    // makes old postpone/swap requests fail closed against a different load.
    db.prepare("DELETE FROM match_postpone_receipts").run();
    db.prepare("DELETE FROM match_swap_receipts").run();
    db.prepare("DELETE FROM ring_selection").run();
    db.prepare("DELETE FROM tournaments").run();
    for (const [table, columns] of Object.entries(BACKUP_TABLE_COLUMNS)) {
      const insert = db.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
      );
      for (const row of snapshot.tables[table as BackupTable])
        insert.run(...columns.map((column) => row[column]));
    }
    for (const [name, seq] of Object.entries(snapshot.sequences)) {
      db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(name);
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(name, seq);
    }
    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length) throw new Error("Backup foreign key violation");
    db.prepare(
      "INSERT INTO restore_receipts (backup_id, payload_hash, browser_hash, status) VALUES (?, ?, ?, 'pending')"
    ).run(backupId, payloadHash, browserHash);
  })();
}

export function completeSqlRestore(
  backupId: string,
  payloadHash: string,
  browserHash: string
): void {
  const receipt = getRestoreReceipt();
  if (
    !receipt ||
    receipt.backup_id !== backupId ||
    receipt.payload_hash !== payloadHash ||
    receipt.browser_hash !== browserHash
  )
    throw new Error("Restore receipt mismatch");
  db.prepare("UPDATE restore_receipts SET status = 'complete' WHERE backup_id = ?").run(backupId);
}
