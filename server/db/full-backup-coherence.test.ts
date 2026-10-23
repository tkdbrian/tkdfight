import { expect, it } from "vitest";
import { assertBrowserSqlCoherent } from "./full-backup-coherence.js";

const sql = {
  tables: {
    category_tournaments: [{ category_id: "cat", tournament_id: 7 }],
    fights: [
      {
        id: "f1",
        tournament_id: 7,
        red_id: "red",
        blue_id: "blue",
        completed: 0,
        result_revision: 0,
      },
    ],
    competitors: [
      { id: "red", tournament_id: 7 },
      { id: "blue", tournament_id: 7 },
    ],
  },
  sequences: {},
};
const registry = {
  version: 2,
  categories: {
    cat: {
      setupStarted: true,
      config: { id: "cat" },
      competitors: [{ id: "red" }, { id: "blue" }],
      fights: [{ id: "f1", red: { id: "red" }, blue: { id: "blue" }, completed: false }],
    },
  },
};

it("cross-checks started browser fights against SQL ownership and participants", () => {
  expect(() => assertBrowserSqlCoherent(sql, JSON.stringify(registry))).not.toThrow();
  const altered = structuredClone(registry);
  altered.categories.cat.fights[0].blue.id = "other";
  expect(() => assertBrowserSqlCoherent(sql, JSON.stringify(altered))).toThrow();
  const stale = structuredClone(registry);
  stale.categories.cat.fights[0].completed = true;
  expect(() => assertBrowserSqlCoherent(sql, JSON.stringify(stale))).toThrow();
});

it("rejects a started browser category without a SQL owner", () => {
  expect(() =>
    assertBrowserSqlCoherent(
      { ...sql, tables: { ...sql.tables, category_tournaments: [] } },
      JSON.stringify(registry)
    )
  ).toThrow();
});
