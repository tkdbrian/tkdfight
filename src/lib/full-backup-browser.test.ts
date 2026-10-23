import { expect, it } from "vitest";
import { assertBrowserIdle, assertPristineBrowser, readBrowserKeys } from "./full-backup-browser";

function storage(values: Record<string, string>): Storage {
  const data = new Map(Object.entries(values));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

it("reads only four browser authorities and rejects pending journals", () => {
  const local = storage({
    "tkd-tournament": JSON.stringify({ version: 1, state: {} }),
    "irrelevant-cache": "private",
  });
  expect(Object.keys(readBrowserKeys(local))).toHaveLength(4);
  expect(() => assertBrowserIdle(local)).not.toThrow();
  local.setItem("tkd-pending-fight-v1:one", "{}");
  expect(() => assertBrowserIdle(local)).toThrow();
});

it("permits only a generated empty draft as a restore target", () => {
  const local = storage({
    "tkd-tournament": JSON.stringify({
      version: 1,
      state: {
        phase: "setup",
        config: { id: "draft", tournamentName: "", categoryName: "" },
        competitors: [],
        fights: [],
        groups: [],
        bracketMatches: [],
      },
    }),
  });
  expect(() => assertPristineBrowser(local)).not.toThrow();
  local.setItem(
    "tkd-tournament",
    JSON.stringify({
      version: 1,
      state: {
        phase: "setup",
        config: { id: "draft", tournamentName: "", categoryName: "" },
        competitors: [{ id: "a" }],
        fights: [],
        groups: [],
        bracketMatches: [],
      },
    })
  );
  expect(() => assertPristineBrowser(local)).toThrow();
});

it("permits a generated deletion draft but refuses archives or event profiles", () => {
  const draft = {
    phase: "setup",
    setupStarted: true,
    config: { id: "draft", tournamentName: "Torneo", categoryName: "" },
    competitors: [],
    fights: [],
    groups: [],
    bracketMatches: [],
    bracketSeeds: [],
    currentFightIndex: 0,
  };
  const local = storage({
    "tkd-tournament": JSON.stringify({ version: 1, state: { ...draft, eventProfiles: {} } }),
    "tkd-tournament-categories": JSON.stringify({
      version: 2,
      categories: { draft },
      visibleCategoryIds: [],
      selectedCategoryId: null,
      draftCategoryId: null,
      draftReturnCategoryId: null,
    }),
  });
  expect(() => assertPristineBrowser(local)).not.toThrow();
  local.setItem(
    "tkd-tournament-categories",
    JSON.stringify({
      version: 2,
      categories: { draft },
      visibleCategoryIds: [],
      selectedCategoryId: null,
      draftCategoryId: null,
      draftReturnCategoryId: null,
      archives: { old: { categoryId: "old" } },
    })
  );
  expect(() => assertPristineBrowser(local)).toThrow();
  local.setItem(
    "tkd-tournament-categories",
    JSON.stringify({
      version: 2,
      categories: { draft },
      visibleCategoryIds: [],
      selectedCategoryId: null,
      draftCategoryId: null,
      draftReturnCategoryId: null,
    })
  );
  local.setItem(
    "tkd-tournament",
    JSON.stringify({ version: 1, state: { ...draft, eventProfiles: { old: "yusan-2026" } } })
  );
  expect(() => assertPristineBrowser(local)).toThrow();
});
