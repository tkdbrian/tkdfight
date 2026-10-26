import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { generateGroupsTournament } from "../../src/lib/bracket";
import type { CategoryRestartSnapshot } from "../../src/lib/category-restart-contract";

let directory: string | null = null;
let database: typeof import("./index.js") | null = null;
afterEach(() => {
  database?.default.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
  database = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function setup(): Promise<typeof import("./index.js")> {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-replacement-order-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  database = await import("./index.js");
  return database;
}

function snapshot(
  names: string[],
  rrOrderMode?: "rest-optimized" | "group-blocks",
): CategoryRestartSnapshot {
  const competitors = names.map((name) => ({ id: randomUUID(), name }));
  return {
    phase: "fighting",
    config: {
      id: randomUUID(), eventId: "event", tournamentName: "Event", categoryName: "Category",
      tableChief: "Desk", ruleSet: null, judgesCount: 3, mode: "round-robin",
      matchType: "sparring", ...(rrOrderMode ? { rrOrderMode } : {}),
    },
    competitors,
    ...generateGroupsTournament(competitors, "SERPENTINE", rrOrderMode ?? "group-blocks"),
    currentFightIndex: 0,
    bracketMatches: [],
    bracketSeeds: [],
    setupStarted: true,
  };
}

it.each([
  ["archive", undefined],
  ["archive", "rest-optimized"],
  ["delete-and-restart", undefined],
  ["delete-and-restart", "rest-optimized"],
] as const)("accepts %s replacement with %s eight-entrant fixture", async (mode, rrOrderMode) => {
  const db = await setup();
  const names = Array.from({ length: 8 }, (_, index) => `Entrant ${index + 1}`);
  const previousSnapshot = snapshot(names, rrOrderMode);
  const replacementSnapshot = snapshot(names, rrOrderMode);
  const requestId = randomUUID();
  if (mode === "archive") {
    const result = db.restartCategoryExecution({
      requestId, categoryId: previousSnapshot.config.id, previousSnapshot, replacementSnapshot,
    });
    expect(result.replacementSnapshot).toEqual(replacementSnapshot);
  } else {
    const expectedRevision = db.previewCategoryDeletion(previousSnapshot).revision;
    const result = db.deleteAndRestartCategoryExecution({
      requestId, expectedRevision, previousSnapshot, replacementSnapshot,
    });
    expect(result.replacementSnapshot).toEqual(replacementSnapshot);
  }
  expect(db.getCategoryTournamentId(replacementSnapshot.config.id)).not.toBeNull();
});
