import { describe, expect, it } from "vitest";
import { getFightPageEntry } from "@/lib/fight-navigation";
import { recordedCategory } from "@/test/category-restart-fixtures";

describe("validated ephemeral combat navigation", () => {
  const snapshot = recordedCategory();
  const intent = {
    kind: "category-continue",
    categoryId: snapshot.config.id,
    fightId: snapshot.fights[0].id,
  };
  it("accepts only an exact local category/fight identity without modifying persisted data", () => {
    expect(getFightPageEntry(intent, snapshot.config.id, snapshot.fights)).toEqual({
      mode: "passive",
      intent,
    });
    expect(getFightPageEntry(undefined, snapshot.config.id, snapshot.fights)).toEqual({
      mode: "normal",
    });
  });
  it.each([
    { ...intent, categoryId: "foreign" },
    { ...intent, fightId: "missing" },
    { ...intent, fightId: "" },
    { ...intent, autoLoad: true },
  ])("keeps stale/foreign/malformed intent non-operative", (state) => {
    expect(getFightPageEntry(state, snapshot.config.id, snapshot.fights)).toEqual({
      mode: "invalid",
    });
  });
});
