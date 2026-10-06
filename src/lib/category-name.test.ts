import { describe, expect, it } from "vitest";
import { buildCategoryName, GUP_GRADE_OPTIONS, type CategoryNameFields } from "./category-name";

const baseCategory: CategoryNameFields = {
  weight: "Mediano B",
  gradeSystem: "DAN",
  beltFrom: "1",
  beltTo: "3",
  gupBand: "",
  gender: "M",
  ageFrom: "18",
  ageTo: "35",
};

describe("buildCategoryName", () => {
  it("preserves the existing DAN category name", () => {
    expect(buildCategoryName(baseCategory)).toBe("Mediano B \u00b7 1-3 Dan \u00b7 M \u00b7 18-35 a\u00f1os");
  });

  it.each(GUP_GRADE_OPTIONS)("includes the selected GUPS band %s", (gupBand) => {
    expect(
      buildCategoryName({
        ...baseCategory,
        gradeSystem: "GUPS",
        gupBand,
      }),
    ).toBe("Mediano B \u00b7 " + gupBand + " \u00b7 M \u00b7 18-35 a\u00f1os");
  });

  it.each(["Masculino", "Femenino", "Mixto"])("includes the sex division %s in the name", (gender) => {
    expect(buildCategoryName({ ...baseCategory, gender })).toContain(" · " + gender + " · ");
  });

  it("does not leak a previous DAN range into a GUPS category", () => {
    expect(
      buildCategoryName({
        ...baseCategory,
        gradeSystem: "GUPS",
        gupBand: GUP_GRADE_OPTIONS[0],
      }),
    ).not.toContain("Dan");
  });

  it("allows categories without a selected grade band", () => {
    expect(
      buildCategoryName({
        ...baseCategory,
        gradeSystem: "GUPS",
        gupBand: "",
      }),
    ).toBe("Mediano B \u00b7 M \u00b7 18-35 a\u00f1os");
  });
});