import { describe, expect, it } from "vitest";
import { categoryTabSummary } from "./category-tab-summary";

describe("categoryTabSummary", () => {
  it("includes tournament, discipline and format", () => {
    expect(categoryTabSummary({ tournamentName: "Copa 2026", matchType: "sparring", mode: "round-robin" })).toBe("Copa 2026 \u00b7 Sparring \u00b7 Round Robin");
    expect(categoryTabSummary({ tournamentName: "Copa 2026", matchType: "tul", mode: "elimination" })).toBe("Copa 2026 \u00b7 Tul \u00b7 Eliminaci\u00f3n");
  });
  it("uses defaults for legacy snapshots", () => {
    expect(categoryTabSummary({ tournamentName: "Anterior" })).toBe("Anterior \u00b7 Sparring \u00b7 Round Robin");
  });
});
