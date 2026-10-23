import { describe, expect, it } from "vitest";
import patternsRules from "../rules/rules/rules_patterns_itf_baseline.json";
import sparringRules from "../rules/rules/rules_sparring_itf_baseline.json";
import { generateEliminationBracket } from "./bracket";
import { categoryRestartSnapshotSchema } from "./category-restart-contract";
import {
  categoryDeleteAndRestartErrorSchema,
  categoryDeleteAndRestartRequestSchema,
  categoryDeleteAndRestartSuccessSchema,
} from "./category-restart-modes-contract";

function fixture(ruleSet: unknown) {
  const competitors = ["Uno", "Dos", "Tres"].map((name) => ({ id: crypto.randomUUID(), name }));
  const bracket = generateEliminationBracket(competitors);
  return categoryRestartSnapshotSchema.parse({
    phase: "fighting",
    config: {
      id: crypto.randomUUID(),
      eventId: "event",
      tournamentName: "Torneo",
      categoryName: "Prueba",
      tableChief: "Mesa",
      ruleSet,
      judgesCount: 3,
      mode: "elimination",
      matchType: "sparring",
    },
    competitors,
    fights: [],
    groups: [],
    currentFightIndex: 0,
    bracketMatches: bracket.matches,
    bracketSeeds: bracket.seeds,
    setupStarted: true,
  });
}
function operation(ruleSet: unknown = sparringRules) {
  const previousSnapshot = fixture(ruleSet);
  const replacementSnapshot = fixture(ruleSet);
  const request = {
    requestId: crypto.randomUUID(),
    expectedRevision: "a".repeat(64),
    previousSnapshot,
    replacementSnapshot,
  };
  const deletion = {
    ok: true as const,
    requestId: request.requestId,
    categoryId: previousSnapshot.config.id,
    tournamentId: 1,
    deletedAt: "2026-10-22T15:00:00.000Z",
    counts: {
      competitors: 3,
      fights: 0,
      completedFights: 0,
      confirmedResults: 0,
      localOnlyFights: 0,
    },
  };
  return {
    request,
    success: {
      ok: true as const,
      requestId: request.requestId,
      categoryId: previousSnapshot.config.id,
      replacementCategoryId: replacementSnapshot.config.id,
      deletion,
      replacementSnapshot,
    },
  };
}

describe("atomic destructive restart wire contract", () => {
  it.each([
    sparringRules,
    patternsRules,
  ])("preserves real $mode metadata without fake archive", (rules) => {
    const { request, success } = operation(rules);
    expect(categoryDeleteAndRestartRequestSchema.parse(request)).toEqual(request);
    expect(categoryDeleteAndRestartSuccessSchema.parse(success)).toEqual(success);
  });

  it("rejects unknown keys, invalid revision and same source/replacement identity", () => {
    const { request } = operation();
    for (const invalid of [
      { ...request, mode: "archive" },
      { ...request, expectedRevision: "stale" },
      { ...request, replacementSnapshot: request.previousSnapshot },
    ]) {
      expect(categoryDeleteAndRestartRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("binds success to source deletion, operation request and actual new category", () => {
    const { success } = operation();
    for (const invalid of [
      { ...success, archive: {} },
      { ...success, categoryId: "wrong" },
      { ...success, requestId: crypto.randomUUID() },
      { ...success, replacementCategoryId: "wrong" },
    ]) {
      expect(categoryDeleteAndRestartSuccessSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps source commit proof distinct from later archived or deleted replacement", () => {
    const { success } = operation();
    const archived = {
      ok: false,
      error: "category_archived",
      message: "El reinicio se confirmó, pero su reemplazo ya fue archivado.",
      categoryId: success.categoryId,
      requestId: success.requestId,
      deletion: success.deletion,
      archivedCategoryId: success.replacementCategoryId,
      replacementCategoryId: crypto.randomUUID(),
    };
    expect(categoryDeleteAndRestartErrorSchema.parse(archived)).toEqual(archived);
    const terminal = {
      ok: false,
      error: "replacement_deleted",
      message: "El reemplazo fue eliminado.",
      categoryId: success.categoryId,
      requestId: success.requestId,
      deletion: success.deletion,
      replacementDeletion: {
        ...success.deletion,
        requestId: crypto.randomUUID(),
        categoryId: success.replacementCategoryId,
      },
    };
    expect(categoryDeleteAndRestartErrorSchema.parse(terminal)).toEqual(terminal);
    expect(
      categoryDeleteAndRestartErrorSchema.safeParse({ ...terminal, archive: {} }).success
    ).toBe(false);
    expect(
      categoryDeleteAndRestartErrorSchema.safeParse({ ...terminal, error: "invented" }).success
    ).toBe(false);
  });
});
