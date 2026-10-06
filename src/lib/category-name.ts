export const GUP_GRADE_OPTIONS = [
  "Blancos y Puntas Amarillas",
  "Amarillos a Puntas Azules",
  "Azules a Puntas Negras",
] as const;

export type GradeSystem = "DAN" | "GUPS";

export interface CategoryNameFields {
  weight: string;
  gradeSystem: GradeSystem;
  beltFrom: string;
  beltTo: string;
  gupBand: string;
  gender: string;
  ageFrom: string;
  ageTo: string;
  ageOpenEnded?: boolean;
}

export function buildCategoryName(category: CategoryNameFields): string {
  const parts: string[] = [];
  if (category.weight) parts.push(category.weight);

  if (category.gradeSystem === "GUPS") {
    if (category.gupBand) parts.push(category.gupBand);
  } else if (category.beltFrom || category.beltTo) {
    parts.push((category.beltFrom || "?") + "-" + (category.beltTo || "?") + " Dan");
  }

  if (category.gender) parts.push(category.gender);
  if (category.ageOpenEnded && category.ageFrom) {
    parts.push(category.ageFrom + "+ a\u00f1os");
  } else if (category.ageFrom || category.ageTo) {
    parts.push((category.ageFrom || "?") + "-" + (category.ageTo || "?") + " a\u00f1os");
  }

  return parts.join(" \u00b7 ");
}