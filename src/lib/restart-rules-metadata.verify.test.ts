import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewCategoryDeletion, requestCategoryDeletion } from "@/lib/category-deletion-client";
import {
  categoryDeletionPreviewRequestSchema,
  categoryDeletionRequestSchema,
} from "@/lib/category-deletion-contract";
import { createRestartReplacement } from "@/lib/category-lifecycle";
import { lookupCategoryReplacement, requestCategoryRestart } from "@/lib/category-restart-client";
import {
  categoryRestartSnapshotSchema,
  type RestartCategoryRequest,
  type RestartCategorySuccess,
  restartCategoryRequestSchema,
  restartCategorySuccessSchema,
} from "@/lib/category-restart-contract";
import { beginCategoryRestart } from "@/lib/category-restart-controller";
import patternsRules from "@/rules/rules/rules_patterns_itf_baseline.json";
import sparringRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import { useCategoryDeletionState } from "@/store/category-deletion-state";
import {
  PENDING_CATEGORY_RESTART_KEY,
  useCategoryRestartState,
} from "@/store/category-restart-state";
import {
  TOURNAMENT_CATEGORY_STORAGE_KEY,
  type TournamentCategorySnapshot,
  useTournamentStore,
} from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

const initial = useTournamentStore.getState();
const presets = [
  { name: "sparring", rules: sparringRules, matchType: "sparring" as const },
  { name: "patterns", rules: patternsRules, matchType: "tul" as const },
];
const free = {
  connected: true,
  stateReady: true,
  serverState: { match: null, activeMatchLock: null },
};
const counts = {
  competitors: 3,
  fights: 3,
  completedFights: 0,
  confirmedResults: 0,
  localOnlyFights: 3,
};

function prepareRequest(
  rules: unknown,
  matchType: "sparring" | "tul" = "sparring"
): RestartCategoryRequest {
  const previous = recordedCategory();
  const previousSnapshot = categoryRestartSnapshotSchema.parse({
    ...previous,
    config: { ...previous.config, ruleSet: structuredClone(rules), matchType },
  });
  return {
    requestId: crypto.randomUUID(),
    categoryId: previousSnapshot.config.id,
    previousSnapshot,
    replacementSnapshot: createRestartReplacement(previousSnapshot),
  };
}

function acknowledgement(request: RestartCategoryRequest): RestartCategorySuccess {
  return {
    ok: true,
    requestId: request.requestId,
    categoryId: request.categoryId,
    replacementCategoryId: request.replacementSnapshot.config.id,
    replacementSnapshot: request.replacementSnapshot,
    archive: {
      requestId: request.requestId,
      categoryId: request.categoryId,
      replacementCategoryId: request.replacementSnapshot.config.id,
      sourceTournamentId: 1,
      replacementTournamentId: 2,
      archivedAt: "2026-10-22T18:00:00.000Z",
      provenance: "as-recorded",
      warnings: [],
    },
  };
}

function metadataBytes(value: unknown): Uint8Array {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a rules object");
  }
  const rules = value as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  for (const key of ["version", "notes", "fouls_examples"]) {
    if (key in rules) metadata[key] = rules[key];
  }
  return new TextEncoder().encode(JSON.stringify(metadata));
}

beforeEach(() => {
  localStorage.clear();
  useCategoryRestartState.setState({ pending: false, recoveryRequired: false, message: null });
  useCategoryDeletionState.setState({
    pending: false,
    recoveryRequired: false,
    message: null,
    observed: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  useTournamentStore.setState(initial, true);
  useCategoryRestartState.setState({ pending: false, recoveryRequired: false, message: null });
  useCategoryDeletionState.setState({
    pending: false,
    recoveryRequired: false,
    message: null,
    observed: [],
  });
  localStorage.clear();
});

describe("independent real runtime rules metadata regression", () => {
  it.each(
    presets
  )("preserves the complete bundled $name preset in both snapshots and ACK", (preset) => {
    const request = prepareRequest(preset.rules, preset.matchType);
    const parsed = restartCategoryRequestSchema.parse(request);
    expect(parsed.previousSnapshot.config.ruleSet).toEqual(preset.rules);
    expect(parsed.replacementSnapshot.config.ruleSet).toEqual(preset.rules);
    expect(metadataBytes(parsed.previousSnapshot.config.ruleSet)).toEqual(
      metadataBytes(preset.rules)
    );
    expect(metadataBytes(parsed.replacementSnapshot.config.ruleSet)).toEqual(
      metadataBytes(preset.rules)
    );
    expect(parsed.replacementSnapshot.config.id).not.toBe(parsed.previousSnapshot.config.id);
    const success = restartCategorySuccessSchema.parse(acknowledgement(parsed));
    expect(success.replacementSnapshot.config.ruleSet).toEqual(preset.rules);
  });

  it("sends the actual Setup BASE spread unchanged and reads its canonical replacement", async () => {
    const runtimeRules = {
      ...sparringRules,
      judgesCount: 3,
      judgingMode: "points",
      rounds: { ...sparringRules.rounds, count: 2, duration_seconds: 90 },
    };
    const request = prepareRequest(runtimeRules);
    const before = JSON.stringify(request);
    const success = acknowledgement(request);
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        const received = restartCategoryRequestSchema.parse(JSON.parse(String(options.body)));
        expect(received).toEqual(request);
        expect(received.previousSnapshot.config.ruleSet).toEqual(runtimeRules);
        expect(metadataBytes(received.replacementSnapshot.config.ruleSet)).toEqual(
          metadataBytes(sparringRules)
        );
      }
      return new Response(JSON.stringify(success));
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await requestCategoryRestart(request)).toEqual(success);
    expect(await lookupCategoryReplacement(request.categoryId)).toEqual(success);
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "GET"]);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(before);
    expect(JSON.stringify(request)).toBe(before);
  });

  it.each(
    presets
  )("accepts complete $name metadata in the shared deletion boundary and sent body", async (preset) => {
    const restart = prepareRequest(preset.rules, preset.matchType);
    const snapshot = restart.previousSnapshot;
    const preview = {
      ok: true,
      categoryId: snapshot.config.id,
      revision: "a".repeat(64),
      counts,
      warnings: [],
      requiresConfirmationText: true,
    };
    const request = {
      requestId: crypto.randomUUID(),
      expectedRevision: preview.revision,
      localSnapshot: snapshot,
    };
    const receipt = {
      ok: true,
      categoryId: snapshot.config.id,
      requestId: request.requestId,
      tournamentId: null,
      deletedAt: "2026-10-22T18:00:00.000Z",
      counts,
    };
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      const body: unknown = JSON.parse(String(options?.body));
      const received = url.endsWith("deletion-preview")
        ? categoryDeletionPreviewRequestSchema.parse(body)
        : categoryDeletionRequestSchema.parse(body);
      expect(received.localSnapshot.config.ruleSet).toEqual(preset.rules);
      expect(metadataBytes(received.localSnapshot.config.ruleSet)).toEqual(
        metadataBytes(preset.rules)
      );
      return new Response(JSON.stringify(url.endsWith("deletion-preview") ? preview : receipt));
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await previewCategoryDeletion(snapshot)).toEqual(preview);
    expect(await requestCategoryDeletion(snapshot.config.id, request)).toEqual(receipt);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(request);
  });

  it.each([
    { name: "numeric version", extra: { version: 1 } },
    { name: "object notes", extra: { notes: { private: true } } },
    { name: "non-text foul example", extra: { fouls_examples: ["contacto", 7] } },
    { name: "unknown rules key", extra: { arbitraryRule: true } },
    {
      name: "unknown nested rounds key",
      extra: { rounds: { ...sparringRules.rounds, arbitrary: true } },
    },
  ])("rejects $name rather than stripping or loosening validation", ({ extra }) => {
    const request = prepareRequest(sparringRules);
    const invalid = {
      ...request.previousSnapshot,
      config: { ...request.previousSnapshot.config, ruleSet: { ...sparringRules, ...extra } },
    };
    expect(categoryRestartSnapshotSchema.safeParse(invalid).success).toBe(false);
    expect(categoryDeletionPreviewRequestSchema.safeParse({ localSnapshot: invalid }).success).toBe(
      false
    );
    expect(
      restartCategoryRequestSchema.safeParse({ ...request, previousSnapshot: invalid }).success
    ).toBe(false);
  });

  it("rejects malformed local metadata before creating a journal or sending a command", async () => {
    const snapshot: TournamentCategorySnapshot = prepareRequest(sparringRules).previousSnapshot;
    if (!snapshot.config.ruleSet) throw new Error("Expected rules for corrupt metadata fixture");
    // Simulate persisted runtime corruption without weakening the production snapshot type.
    Object.assign(snapshot.config.ruleSet, { notes: 42 });
    useTournamentStore.setState(snapshot);
    const main = localStorage.getItem("tkd-tournament");
    const registry = localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await beginCategoryRestart(snapshot, free)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_CATEGORY_RESTART_KEY)).toBeNull();
    expect(localStorage.getItem("tkd-tournament")).toBe(main);
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toBe(registry);
    expect(useCategoryRestartState.getState().pending).toBe(false);
    expect(useCategoryRestartState.getState().recoveryRequired).toBe(false);
    expect(useCategoryRestartState.getState().message).not.toMatch(
      /unrecognized_keys|invalid_type|\[\s*\{/
    );
  });
});
