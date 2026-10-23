import { expect, it } from "vitest";
import { assertBrowserSqlCoherent } from "./full-backup-coherence.js";

it("permits a locally prepared, unstarted category without SQL ownership", () => {
  // createCategory() sets setupStarted=true before the operator starts/syncs the category.
  const browser = JSON.stringify({
    version: 2,
    categories: {
      draft: {
        phase: "setup",
        setupStarted: true,
        config: { id: "draft", categoryName: "Infantiles", tournamentName: "Torneo" },
        competitors: [{ id: "athlete-1", name: "Ana" }],
        fights: [],
        groups: [],
        bracketMatches: [],
        bracketSeeds: [],
        currentFightIndex: 0,
      },
    },
  });
  const sql = {
    tables: {
      category_tournaments: [],
      fights: [],
      competitors: [],
    },
  };
  expect(() => assertBrowserSqlCoherent(sql, browser)).not.toThrow();
});
