import type { TimePreset } from "./tournament-presets";

export interface CategoryAgeSelection {
  ageFrom: string;
  ageTo: string;
  ageOpenEnded: boolean;
}

export function ageSelectionFromPreset(preset: TimePreset): CategoryAgeSelection | null {
  if (preset.ageFrom === undefined) return null;
  return {
    ageFrom: String(preset.ageFrom),
    ageTo: preset.ageTo === undefined ? "" : String(preset.ageTo),
    ageOpenEnded: preset.ageTo === undefined,
  };
}

export function customAgeSelection(current: CategoryAgeSelection): CategoryAgeSelection {
  return { ...current };
}

export function isMatchingAgePreset(preset: TimePreset, current: CategoryAgeSelection): boolean {
  const presetAge = ageSelectionFromPreset(preset);
  return !!presetAge
    && presetAge.ageFrom === current.ageFrom
    && presetAge.ageTo === current.ageTo
    && presetAge.ageOpenEnded === current.ageOpenEnded;
}

export function formatCategoryAge(age: CategoryAgeSelection): string {
  if (age.ageOpenEnded && age.ageFrom) return `${age.ageFrom}+ a\u00f1os`;
  if (age.ageFrom || age.ageTo) return `${age.ageFrom || "?"}-${age.ageTo || "?"} a\u00f1os`;
  return "";
}

export function ageSelectionFromCategoryName(categoryName: string): CategoryAgeSelection | null {
  const normalized = categoryName.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const openEnded = normalized.match(/(\d+)\s*\+\s*anos\b/i);
  if (openEnded) return { ageFrom: openEnded[1], ageTo: "", ageOpenEnded: true };
  const bounded = normalized.match(/(\d+)\s*-\s*(\d+)\s*anos\b/i);
  if (!bounded) return null;
  return { ageFrom: bounded[1], ageTo: bounded[2], ageOpenEnded: false };
}

export function categoryNameMatchesAgePreset(preset: TimePreset, categoryName: string): boolean {
  const age = ageSelectionFromCategoryName(categoryName);
  return age !== null && isMatchingAgePreset(preset, age);
}

export function isTimePresetActive(
  preset: TimePreset,
  current: Pick<TimePreset, "roundCount" | "durationSeconds" | "finalRounds" | "finalSeconds" | "tiebreakerSeconds" | "maxTiebreakers">,
  categoryName: string,
): boolean {
  return current.roundCount === preset.roundCount
    && current.durationSeconds === preset.durationSeconds
    && current.finalRounds === preset.finalRounds
    && current.finalSeconds === preset.finalSeconds
    && current.tiebreakerSeconds === preset.tiebreakerSeconds
    && current.maxTiebreakers === preset.maxTiebreakers
    && (preset.ageFrom === undefined || categoryNameMatchesAgePreset(preset, categoryName));
}
