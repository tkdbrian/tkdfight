import { expect, it } from "vitest";
import {
  categoryDeletionPreviewRequestSchema,
  categoryDeletionPreviewSchema,
  categoryDeletionReceiptSchema,
  categoryDeletionRequestSchema,
  categoryDeletionTombstoneSchema,
} from "./category-deletion-contract";

const localSnapshot = {
  phase: "setup",
  config: {
    id: "local",
    eventId: "event",
    tournamentName: "Evento",
    categoryName: "Prueba",
    tableChief: "Mesa",
    ruleSet: null,
    judgesCount: 3,
    mode: "round-robin",
    matchType: "sparring",
  },
  competitors: [],
  fights: [],
  groups: [],
  currentFightIndex: 0,
  bracketMatches: [],
  bracketSeeds: [],
  setupStarted: true,
};
const counts = {
  competitors: 0,
  fights: 0,
  completedFights: 0,
  confirmedResults: 0,
  localOnlyFights: 0,
};

it("validates exact snapshot-based preview and immutable request envelopes", () => {
  expect(categoryDeletionPreviewRequestSchema.parse({ localSnapshot })).toEqual({ localSnapshot });
  const request = {
    requestId: crypto.randomUUID(),
    expectedRevision: "a".repeat(64),
    localSnapshot,
  };
  expect(categoryDeletionRequestSchema.parse(request)).toEqual(request);
  expect(
    categoryDeletionRequestSchema.safeParse({ ...request, requestId: "not-a-uuid" }).success
  ).toBe(false);
  expect(
    categoryDeletionRequestSchema.safeParse({ ...request, expectedRevision: "short" }).success
  ).toBe(false);
  expect(
    categoryDeletionPreviewRequestSchema.safeParse({ localSnapshot, force: true }).success
  ).toBe(false);
});

it("preserves canonical counts/started condition and rejects missing, negative or extra counts", () => {
  const preview = {
    ok: true,
    categoryId: "local",
    revision: "b".repeat(64),
    counts,
    warnings: [],
    requiresConfirmationText: false,
  };
  expect(categoryDeletionPreviewSchema.parse(preview)).toEqual(preview);
  expect(
    categoryDeletionPreviewSchema.safeParse({ ...preview, requiresConfirmationText: undefined })
      .success
  ).toBe(false);
  expect(
    categoryDeletionPreviewSchema.safeParse({ ...preview, counts: { ...counts, fights: -1 } })
      .success
  ).toBe(false);
  expect(
    categoryDeletionPreviewSchema.safeParse({ ...preview, counts: { ...counts, hidden: 3 } })
      .success
  ).toBe(false);
});

it("supports local-only/null-tournament receipt and technical tombstones without private graph", () => {
  const receipt = {
    ok: true,
    requestId: crypto.randomUUID(),
    categoryId: "local",
    tournamentId: null,
    deletedAt: new Date().toISOString(),
    counts,
  };
  expect(categoryDeletionReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(categoryDeletionReceiptSchema.parse({ ...receipt, tournamentId: 4 }).tournamentId).toBe(4);
  const { categoryId, requestId, deletedAt } = receipt;
  expect(categoryDeletionTombstoneSchema.parse({ categoryId, requestId, deletedAt })).toEqual({
    categoryId,
    requestId,
    deletedAt,
  });
  expect(
    categoryDeletionTombstoneSchema.safeParse({ categoryId, requestId, deletedAt, localSnapshot })
      .success
  ).toBe(false);
});
