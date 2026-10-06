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
