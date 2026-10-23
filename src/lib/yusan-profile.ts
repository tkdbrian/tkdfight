import type { RuleSetSparring } from "@/engine/types";
import type { TournamentConfig, TournamentMode } from "@/store/tournament";
import type { TimePreset } from "./tournament-presets";

export const YUSAN_PROFILE_ID = "yusan-2026" as const;

export const AGE_DIVISIONS = [
  { id: "kids", label: "KIDS", from: 3, to: 5 },
  { id: "infantiles-a", label: "INFANTILES A", from: 6, to: 7 },
  { id: "infantiles-b", label: "INFANTILES B", from: 8, to: 9 },
  { id: "infantiles-c", label: "INFANTILES C", from: 10, to: 11 },
  { id: "pre-juniors", label: "PRE-JUNIORS", from: 12, to: 14 },
  { id: "juniors", label: "JUNIORS", from: 15, to: 17 },
  { id: "adultos", label: "ADULTOS", from: 18, to: 35 },
  { id: "seniors", label: "SENIORS", from: 36, to: 45 },
  { id: "veteranos", label: "VETERANOS", from: 46, to: undefined },
] as const;

export type AgeDivision = (typeof AGE_DIVISIONS)[number]["id"];
export type SexDivision = "Masculino" | "Femenino" | "Mixto";
export type GradeSystem = "GUPS" | "DAN";

export interface CategoryDimensions {
  weightLabel?: string;
  ageDivision?: AgeDivision;
  categoryAgeFrom?: string;
  categoryAgeTo?: string;
  categoryAgeOpenEnded?: boolean;
  sexDivision?: SexDivision;
  gradeSystem?: GradeSystem;
  gupBand?: string;
  danFrom?: number;
  danTo?: number;
}

export function validateDanRange(from: string, to: string): string | null {
  const first = Number(from);
  const last = Number(to);
  if (!/^\d+$/.test(from) || !/^\d+$/.test(to)
    || !Number.isSafeInteger(first) || !Number.isSafeInteger(last)
    || first < 1 || last < 1) {
    return "Ingresá ambos grados Dan como números enteros positivos.";
  }
  if (first > last) return "El grado Dan inicial no puede superar el final.";
  return null;
}

export function ageDivisionForRange(from: string, to: string, openEnded: boolean): AgeDivision | undefined {
  const match = AGE_DIVISIONS.find((age) => String(age.from) === from
    && (age.to === undefined ? openEnded : !openEnded && String(age.to) === to));
  return match?.id;
}

export function resolveYusanPreset(
  dimensions: CategoryDimensions,
  mode: TournamentMode,
): TimePreset | null {
  const age = AGE_DIVISIONS.find((division) => division.id === dimensions.ageDivision);
  if (!age || !dimensions.gradeSystem) return null;
  if (dimensions.gradeSystem === "GUPS" && !dimensions.gupBand) return null;
  if (dimensions.gradeSystem === "DAN" && (!Number.isSafeInteger(dimensions.danFrom)
    || !Number.isSafeInteger(dimensions.danTo)
    || (dimensions.danFrom ?? 0) < 1
    || (dimensions.danTo ?? 0) < (dimensions.danFrom ?? 0))) return null;
  const white = dimensions.gradeSystem === "GUPS"
    && dimensions.gupBand === "Blancos y Puntas Amarillas";
  const durationSeconds = white ? 40 : mode === "round-robin" ? 60
    : age.from <= 11 ? 60 : age.from <= 35 ? 120 : 90;
  // The group phase stays at one minute, but winners of separate groups meet
  // in a direct-elimination final with the age-specific final duration.
  const finalSeconds = white ? 40 : age.id === "kids" ? 60 : 120;
  return {
    name: "Yusan 2026",
    ageFrom: age.from,
    ageTo: age.to,
    roundCount: 1,
    durationSeconds,
    finalRounds: 1,
    finalSeconds,
    tiebreakerSeconds: white ? 40 : 60,
  };
}

export function yusanConfigPatch(
  config: TournamentConfig,
  dimensions: CategoryDimensions,
  mode: TournamentMode,
  base: RuleSetSparring,
): Partial<TournamentConfig> | null {
  const preset = resolveYusanPreset(dimensions, mode);
  if (!preset) return null;
  const rules = config.ruleSet?.mode === "sparring" ? config.ruleSet : base;
  return {
    ...dimensions,
    mode,
    profileId: YUSAN_PROFILE_ID,
    profileApplied: true,
    finalRounds: preset.finalRounds,
    finalSeconds: preset.finalSeconds,
    tiebreakerSeconds: preset.tiebreakerSeconds,
    ruleSet: {
      ...rules,
      rounds: {
        ...rules.rounds,
        count: preset.roundCount,
        duration_seconds: preset.durationSeconds,
      },
    },
  };
}

/** Shared by normal start and restart so a confirmation cannot bypass validation. */
export function validateCategoryTimingForStart(config: TournamentConfig): string | null {
  if (config.requiresGradeSelection) {
    if (!config.gradeSystem) return "Elegí GUPS o DANES.";
    if (config.gradeSystem === "GUPS" && !config.gupBand) return "Elegí una banda GUP.";
    if (config.gradeSystem === "DAN") {
      const danError = validateDanRange(
        config.danFrom === undefined ? "" : String(config.danFrom),
        config.danTo === undefined ? "" : String(config.danTo),
      );
      if (danError) return danError;
    }
  }
  if (config.profileId === YUSAN_PROFILE_ID && config.profileApplied
    && !resolveYusanPreset(config, config.mode)) {
    return "Elegí una franja de edad y un grado válidos para los tiempos Yusan 2026.";
  }
  return null;
}
