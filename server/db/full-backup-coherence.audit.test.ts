import { expect, it } from "vitest";
import { assertBrowserSqlCoherent } from "./full-backup-coherence.js";

it("refuses an active SQL category missing from the browser registry", () => {
  const sql = {
    tables: {
      category_tournaments: [{ category_id: "active-cat", tournament_id: 7 }],
      fights: [
        {
          id: "f1",
          tournament_id: 7,
          red_id: "red",
          blue_id: "blue",
          completed: 0,
        },
      ],
      competitors: [
        { id: "red", tournament_id: 7 },
        { id: "blue", tournament_id: 7 },
      ],
    },
  };
  const browser = JSON.stringify({ version: 2, categories: {} });
  expect(() => assertBrowserSqlCoherent(sql, browser)).toThrow(/missing|owner|category/i);
});
