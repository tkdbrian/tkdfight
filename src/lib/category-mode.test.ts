import { describe, expect, it } from "vitest";
import { availableCategoryFormats, defaultCategoryFormat, isCategoryFormatAllowed } from "./category-mode";

describe("category formats by discipline", () => {
  it("allows only elimination for Tul", () => {
    expect(availableCategoryFormats("tul")).toEqual(["elimination"]);
    expect(isCategoryFormatAllowed("tul", "round-robin")).toBe(false);
    expect(defaultCategoryFormat("tul")).toBe("elimination");
  });
  it("keeps both formats for Sparring", () => {
    expect(availableCategoryFormats("sparring")).toEqual(["round-robin", "elimination"]);
    expect(isCategoryFormatAllowed("sparring", "round-robin")).toBe(true);
    expect(defaultCategoryFormat("sparring")).toBe("round-robin");
  });
});
