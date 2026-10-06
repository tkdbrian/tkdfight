export type CategoryDiscipline = "sparring" | "tul";
export type CategoryFormat = "round-robin" | "elimination";

export function availableCategoryFormats(discipline: CategoryDiscipline): readonly CategoryFormat[] {
  return discipline === "tul" ? ["elimination"] : ["round-robin", "elimination"];
}

export function isCategoryFormatAllowed(discipline: CategoryDiscipline, format: CategoryFormat): boolean {
  return availableCategoryFormats(discipline).includes(format);
}

export function defaultCategoryFormat(discipline: CategoryDiscipline): CategoryFormat {
  return discipline === "tul" ? "elimination" : "round-robin";
}
