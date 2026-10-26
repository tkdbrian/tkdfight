import { describe, expect, it } from "vitest";
import patternsBaseline from "../rules/rules/rules_patterns_itf_baseline.json";
import sparringBaseline from "../rules/rules/rules_sparring_itf_baseline.json";
import {
  categoryDeletionPreviewRequestSchema,
  categoryDeletionRequestSchema,
} from "./category-deletion-contract";
import {
  categoryRestartSnapshotSchema,
  restartCategoryRequestSchema,
  restartCategorySuccessSchema,
} from "./category-restart-contract";
import { preparePlayoffFights } from "./round-robin-resolution";
import { COPA_DANES_26, getPresetForCategoryFormat } from "./tournament-presets";

const red = { id: "red", name: "Rojo", team: "Club", weight: 54 };
const blue = { id: "blue", name: "Azul" };
const snapshot = {
  phase: "fighting",
  config: {
    id: "old",
    eventId: "event",
    tournamentName: "Torneo",
    categoryName: "Categoría",
    tableChief: "Mesa",
    ruleSet: {
      mode: "sparring",
      judgesCount: 3,
      rounds: { count: 1, duration_seconds: 60, rest_seconds: 10, golden_point: true },
      points: { custom: 7 },
      deductions: { custom: "DQ" },
      judgingMode: "flags",
    },
    judgesCount: 3,
    mode: "round-robin",
    matchType: "sparring",
    profileId: "yusan-2026",
    profileApplied: true,
    nameGenerated: true,
    requiresGradeSelection: false,
    finalRounds: 2,
    finalSeconds: 90,
    tiebreakerSeconds: 30,
    maxTiebreakers: 2,
    weightLabel: "-54 kg",
    ageDivision: "adultos",
    categoryAgeFrom: "18",
    categoryAgeTo: "35",
    categoryAgeOpenEnded: false,
    sexDivision: "Mixto",
    gradeSystem: "DAN",
    danFrom: 1,
    danTo: 2,
    gupBand: "all",
  },
  competitors: [red, blue],
  groups: [{ id: "G1", competitors: [red, blue], size: 2 }],
  fights: [
    {
      id: "fight",
      red,
      blue,
      completed: true,
      winner: "red",
      winReason: "points",
      groupId: "G1",
      flagsRed: 3,
      flagsBlue: 0,
      warningsRed: 1,
      warningsBlue: 0,
      foulsRed: 0,
      foulsBlue: 1,
      isTiebreakExtra: true,
      playoffKind: "direct",
      playoffBasis: "recorded",
      tiebreakerSeconds: 30,
      isFinalFight: true,
      isGoldenPointFight: false,
      importedFrom: "T2",
    },
  ],
  currentFightIndex: 0,
  bracketMatches: [],
  bracketSeeds: [],
  setupStarted: true,
};

it("accepts either explicit RR order policy but rejects unknown values", () => {
  for (const rrOrderMode of ["rest-optimized", "group-blocks"] as const) {
    const withPolicy = { ...snapshot, config: { ...snapshot.config, rrOrderMode } };
    expect(categoryRestartSnapshotSchema.parse(withPolicy)).toEqual(withPolicy);
  }
  expect(categoryRestartSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(categoryRestartSnapshotSchema.safeParse({
    ...snapshot, config: { ...snapshot.config, rrOrderMode: "random" },
  }).success).toBe(false);
});

function expectRulesRoundTrip(ruleSet: unknown): void {
  const previous = { ...snapshot, config: { ...snapshot.config, ruleSet } };
  const replacement = { ...previous, config: { ...previous.config, id: "replacement" } };
  const requestId = "419db9bd-fd17-4569-9136-85614bc8f889";
  expect(categoryRestartSnapshotSchema.parse(previous)).toEqual(previous);
  expect(
    restartCategoryRequestSchema.parse({
      requestId,
      categoryId: "old",
      previousSnapshot: previous,
      replacementSnapshot: replacement,
    })
  ).toEqual({
    requestId,
    categoryId: "old",
    previousSnapshot: previous,
    replacementSnapshot: replacement,
  });
  expect(
    restartCategorySuccessSchema.parse({
      ok: true,
      requestId,
      categoryId: "old",
      replacementCategoryId: "replacement",
      replacementSnapshot: replacement,
      archive: {
        categoryId: "old",
        replacementCategoryId: "replacement",
        requestId,
        archivedAt: "2026-10-22T15:00:00.000Z",
        sourceTournamentId: 1,
        replacementTournamentId: 2,
        provenance: "as-recorded",
        warnings: [],
      },
    }).replacementSnapshot
  ).toEqual(replacement);
  expect(categoryDeletionPreviewRequestSchema.parse({ localSnapshot: previous })).toEqual({
    localSnapshot: previous,
  });
  expect(
    categoryDeletionRequestSchema.parse({
      requestId,
      expectedRevision: "a".repeat(64),
      localSnapshot: previous,
    })
  ).toEqual({ requestId, expectedRevision: "a".repeat(64), localSnapshot: previous });
}

describe("category restart wire contract", () => {
  it.each([
    sparringBaseline,
    patternsBaseline,
  ])("preserves the real bundled $mode rule-set metadata in restart and deletion envelopes", (rules) => {
    expectRulesRoundTrip(rules);
  });

  it.each(
    COPA_DANES_26.flatMap((preset) =>
      (["round-robin", "elimination"] as const).map((format) => ({
        preset,
        format,
        name: preset.name,
      }))
    )
  )("preserves bundled metadata after Settings preset $name / $format", ({ preset, format }) => {
    const effective = getPresetForCategoryFormat(preset, format);
    // Settings spreads the complete imported JSON, not only the narrower engine interface.
    expectRulesRoundTrip({
      ...sparringBaseline,
      rounds: {
        ...sparringBaseline.rounds,
        count: effective.roundCount,
        duration_seconds: effective.durationSeconds,
      },
    });
  });

  it.each([
    sparringBaseline,
    patternsBaseline,
  ])("preserves absent and empty optional metadata for $mode", (rules) => {
    const legacyRules = structuredClone(rules);
    for (const key of ["version", "notes", "fouls_examples"]) {
      Reflect.deleteProperty(legacyRules, key);
    }
    expectRulesRoundTrip(legacyRules);
    expectRulesRoundTrip({
      ...legacyRules,
      version: "",
      notes: "",
      ...(rules.mode === "sparring" ? { fouls_examples: [] } : {}),
    });
  });

  it.each([
    { name: "sparring numeric version", rules: { ...sparringBaseline, version: 1 } },
    { name: "sparring null notes", rules: { ...sparringBaseline, notes: null } },
    { name: "patterns numeric version", rules: { ...patternsBaseline, version: 1 } },
    { name: "patterns array notes", rules: { ...patternsBaseline, notes: [] } },
    { name: "string foul examples", rules: { ...sparringBaseline, fouls_examples: "foul" } },
    { name: "mixed foul examples", rules: { ...sparringBaseline, fouls_examples: ["foul", 1] } },
    { name: "null foul examples", rules: { ...sparringBaseline, fouls_examples: null } },
    { name: "patterns foul examples", rules: { ...patternsBaseline, fouls_examples: [] } },
    { name: "unknown sparring key", rules: { ...sparringBaseline, hidden: true } },
    { name: "unknown patterns key", rules: { ...patternsBaseline, hidden: true } },
    {
      name: "unknown sparring rounds key",
      rules: { ...sparringBaseline, rounds: { ...sparringBaseline.rounds, hidden: true } },
    },
    {
      name: "unknown patterns scale key",
      rules: {
        ...patternsBaseline,
        scoringScale: { ...patternsBaseline.scoringScale, hidden: true },
      },
    },
    { name: "oversized version", rules: { ...sparringBaseline, version: "v".repeat(4097) } },
    { name: "oversized notes", rules: { ...patternsBaseline, notes: "n".repeat(4097) } },
    {
      name: "oversized foul example",
      rules: { ...sparringBaseline, fouls_examples: ["f".repeat(4097)] },
    },
  ])("rejects malformed or unrecognized metadata: $name", ({ rules }) => {
    expect(
      categoryRestartSnapshotSchema.safeParse({
        ...snapshot,
        config: { ...snapshot.config, ruleSet: rules },
      }).success
    ).toBe(false);
  });

  it("round-trips every existing RR/config field without stripping local-only results", () => {
    expect(categoryRestartSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("accepts elimination future slots and automatic byes, plus patterns rules", () => {
    const bracket = {
      ...snapshot,
      config: {
        ...snapshot.config,
        mode: "elimination",
        ruleSet: {
          mode: "patterns",
          judgesCount: 3,
          scoringScale: { min: 0, max: 10, step: 1 },
          criteria: [{ key: "technical", label: "Técnica", weight: 1 }],
          decision: "flags",
        },
      },
      fights: [],
      bracketSeeds: [red.id, null, blue.id, null],
      bracketMatches: [
        {
          id: "bye",
          round: 0,
          position: 0,
          red: { competitor: red },
          blue: { competitor: null },
          completed: true,
          winnerId: red.id,
        },
        {
          id: "future",
          round: 1,
          position: 0,
          red: { competitor: red, fromMatchId: "bye" },
          blue: { competitor: null },
          completed: false,
          bracketGroup: "A",
        },
      ],
    };
    expect(categoryRestartSnapshotSchema.parse(bracket)).toEqual(bracket);
  });

  it("rejects unknown nested keys, broken linkage, duplicate identities, and excessive IDs", () => {
    expect(categoryRestartSnapshotSchema.safeParse({ ...snapshot, unknown: true }).success).toBe(
      false
    );
    expect(
      categoryRestartSnapshotSchema.safeParse({
        ...snapshot,
        config: { ...snapshot.config, hidden: true },
      }).success
    ).toBe(false);
    expect(
      categoryRestartSnapshotSchema.safeParse({
        ...snapshot,
        fights: [{ ...snapshot.fights[0], bracketMatchId: "missing" }],
      }).success
    ).toBe(false);
    expect(
      categoryRestartSnapshotSchema.safeParse({ ...snapshot, competitors: [red, red] }).success
    ).toBe(false);
    expect(
      categoryRestartSnapshotSchema.safeParse({
        ...snapshot,
        config: { ...snapshot.config, id: "x".repeat(129) },
      }).success
    ).toBe(false);
  });

  it("preserves legitimate RR Golden Point fight provenance without an elimination bracket", () => {
    const previous = {
      ...snapshot.fights[0],
      winner: "draw" as const,
      isFinalFight: false,
      isGoldenPointFight: false,
    };
    const golden = preparePlayoffFights(
      [red, blue],
      "G1",
      {
        status: "needed",
        fights: [previous],
        nextIds: [red.id, blue.id],
        playoffBasis: "recorded",
        goldenPoint: true,
      } as Parameters<typeof preparePlayoffFights>[2],
      30
    );
    expect(golden[0].bracketMatchId).toBe(previous.id);
    expect(
      categoryRestartSnapshotSchema.parse({ ...snapshot, fights: [previous, ...golden] })
    ).toMatchObject({ fights: [previous, ...golden] });
  });

  it("validates exact request/success envelopes and snapshot category linkage", () => {
    const replacement = { ...snapshot, config: { ...snapshot.config, id: "replacement" } };
    const request = {
      requestId: crypto.randomUUID(),
      categoryId: "old",
      previousSnapshot: snapshot,
      replacementSnapshot: replacement,
    };
    expect(restartCategoryRequestSchema.parse(request)).toEqual(request);
    expect(
      restartCategoryRequestSchema.safeParse({ ...request, categoryId: "wrong" }).success
    ).toBe(false);
    expect(restartCategoryRequestSchema.safeParse({ ...request, requestId: "no" }).success).toBe(
      false
    );
    const success = {
      ok: true,
      requestId: request.requestId,
      categoryId: "old",
      replacementCategoryId: "replacement",
      replacementSnapshot: replacement,
      archive: {
        categoryId: "old",
        replacementCategoryId: "replacement",
        requestId: request.requestId,
        archivedAt: "2026-10-22T15:00:00.000Z",
        sourceTournamentId: 1,
        replacementTournamentId: 2,
        provenance: "as-recorded",
        warnings: [],
      },
    };
    expect(restartCategorySuccessSchema.parse(success)).toEqual(success);
    expect(
      restartCategorySuccessSchema.safeParse({ ...success, replacementCategoryId: "wrong" }).success
    ).toBe(false);
  });
});
