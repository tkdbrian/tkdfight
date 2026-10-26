import { useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useSocket } from "@/hooks/useSocket";
import { CATEGORY_START_REASON, CATEGORY_START_RECOVERY_REASON, useTournamentStore, type BracketMatch, type CompetitorEntry } from "@/store/tournament";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as XLSX from "xlsx";
import { Pencil, Trash2, Swords, AlertCircle, Plus, Wifi, Smartphone, Zap, ArrowRight, Trophy, FileSpreadsheet, X, ChevronDown, Check } from "lucide-react";
import { generateGroupsTournament, generateEliminationBracket, getGroupDistribution } from "@/lib/bracket";
import type { RrOrderMode } from "@/lib/bracket";
import { cn } from "@/lib/utils";
import { buildCategoryName, GUP_GRADE_OPTIONS, type GradeSystem } from "@/lib/category-name";
import { availableCategoryFormats, defaultCategoryFormat, isCategoryFormatAllowed } from "@/lib/category-mode";
import { ageSelectionFromPreset, formatCategoryAge, isTimePresetActive } from "@/lib/category-age";
import { AGE_DIVISIONS, ageDivisionForRange, validateDanRange, yusanConfigPatch } from "@/lib/yusan-profile";
import itfRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import type { RuleSetSparring } from "@/engine/types";
import { fetchPresets, getPresetForCategoryFormat, type TimePreset } from "@/lib/tournament-presets";
import { CategoryRestartButton } from "@/components/CategoryRestartButton";
import { CategoryDeleteButton } from "@/components/CategoryDeleteButton";
import { useCategoryInteractionBlocked } from "@/hooks/useCategoryInteractionBlocked";
import { isCategoryInitialized } from "@/lib/category-lifecycle";
import { useCategoryPrimaryAction } from "@/hooks/useCategoryPrimaryAction";

const BASE = itfRules as RuleSetSparring;

type FormData = { name: string; team: string; weight: string };
const EMPTY_FORM: FormData = { name: "", team: "", weight: "" };

// ── Excel import ─────────────────────────────────────────────────────────────

interface ParsedCategory {
  name: string;
  section: string;       // e.g. "PRE-JUNIOR", "JUNIOR"
  discipline: "combate" | "formas";
  competitors: string[];
}

function _normalizeAge(raw: string): string {
  return raw.trim().replace(/^EDAD\s+/i, "").replace(/\s+/g, " ").trim();
}

function _normalizeGender(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (s === "MASC") return "Masc";
  if (s === "FEM") return "Fem";
  return s;
}

function _normalizeWeight(raw: string): string {
  return raw.trim().replace(/^PESO\s+/i, "").trim();
}

function parseTxtFile(text: string): ParsedCategory[] {
  const categories: ParsedCategory[] = [];
  let current: ParsedCategory | null = null;
  let currentSection = "";
  let currentDiscipline: "combate" | "formas" = "combate";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^[=\-]{3,}/.test(line)) continue;

    // Category header: "EDAD PRE-JUNIOR - MASC - PESO LIVIANO A"
    const catMatch = line.match(
      /^EDAD\s+(.+?)\s+-\s+(MASC|FEM|MASCULINO|FEMENINO)\s+-\s+PESO\s+(.+)$/i,
    );
    if (catMatch) {
      if (current && current.competitors.length >= 2) categories.push(current);
      const age = catMatch[1].trim();
      const gender = _normalizeGender(catMatch[2]);
      const weight = catMatch[3].trim();
      const section = currentSection || age.toUpperCase();
      current = {
        name: `${age} \u00b7 ${gender} \u00b7 ${weight}`,
        section,
        discipline: currentDiscipline,
        competitors: [],
      };
      continue;
    }

    // Section header: "COMBATE PRE-JUNIOR" / "FORMAS JUNIOR" etc.
    const secMatch = line.match(/^(COMBATE|FORMAS?|POOMSAE|TUL|SPARRING)\s+(.+)/i);
    if (secMatch) {
      currentSection = secMatch[2].trim().toUpperCase();
      const kw = secMatch[1].toUpperCase();
      currentDiscipline =
        kw === "FORMAS" || kw === "FORMA" || kw === "POOMSAE" || kw === "TUL"
          ? "formas"
          : "combate";
      continue;
    }

    // Competitor line: "1. Name" or "1) Name"
    if (current) {
      const compMatch = line.match(/^\d+[.)\-]\s+(.+)/);
      if (compMatch) {
        const name = compMatch[1].trim();
        if (name.length > 1) current.competitors.push(name);
      }
    }
  }

  if (current && current.competitors.length >= 2) categories.push(current);
  return categories;
}

function parseExcelFile(buffer: ArrayBuffer): ParsedCategory[] {
  // Layout (0-indexed columns):
  //   COMBATE block 1 → col 1 (B): cats at cols 1 and 4
  //   COMBATE block 2 → col 7 (H): cats at cols 7 and 10
  // Each category column contains both the meta rows (EDAD, MASC/FEM, PESO)
  // and the competitor names — the row-number col is always catCol-1.
  // Row structure relative to COMBATE row i:
  //   i+1: EDAD <age>
  //   i+2: MASC | FEM
  //   i+3: PESO <weight>
  //   i+4: APELLIDO Y NOMBRE
  //   i+5 … i+29: competitor names (up to 25 slots)

  const wb = XLSX.read(new Uint8Array(buffer));
  const categories: ParsedCategory[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      defval: "",
    }) as unknown[][];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as unknown[];

      // Collect columns where "COMBATE" appears (handles merged cells → value in top-left)
      const combateCols: number[] = [];
      for (let c = 0; c < row.length; c++) {
        if (String(row[c] ?? "").trim().toUpperCase() === "COMBATE") {
          combateCols.push(c);
        }
      }
      if (combateCols.length === 0) continue;

      // Find the row after "APELLIDO Y NOMBRE" to know where names begin
      let nameStartRow = i + 5; // fallback: COMBATE + 4 meta rows + 1
      for (let s = i + 1; s <= i + 8; s++) {
        const sRow = (rows[s] ?? []) as unknown[];
        if (sRow.some((c) => String(c ?? "").toUpperCase().includes("APELLIDO"))) {
          nameStartRow = s + 1;
          break;
        }
      }

      // Each COMBATE block contains 2 categories: at combateCol and combateCol+3
      for (const combateCol of combateCols) {
        for (const offset of [0, 3]) {
          const col = combateCol + offset;

          let age = "";
          let gender = "";
          let weight = "";

          for (let m = i + 1; m < nameStartRow; m++) {
            const cell = String(((rows[m] ?? []) as unknown[])[col] ?? "").trim();
            if (!cell) continue;
            const upper = cell.toUpperCase();
            if (upper.startsWith("EDAD") || /^(INFANTIL|PRE.?JUNIOR|JUNIOR|ADULTO|SENIOR|VETERANO)/i.test(upper)) {
              age = _normalizeAge(cell);
            } else if (/^(MASC|FEM|MASCULINO|FEMENINO)$/i.test(upper)) {
              gender = _normalizeGender(cell);
            } else if (upper.startsWith("PESO") || /\d.*KG/i.test(upper)) {
              weight = _normalizeWeight(cell);
            }
          }

          if (!age && !gender && !weight) continue;

          const competitors = rows
            .slice(nameStartRow, nameStartRow + 25)
            .map((r) => String((r as unknown[])[col] ?? "").trim())
            .filter((n) => n.length > 2 && !/^\d+$/.test(n));

          if (competitors.length >= 2) {
            const catName = [age, gender, weight].filter(Boolean).join(" · ");
            categories.push({ name: catName, section: age.toUpperCase(), discipline: "combate", competitors });
          }
        }
      }
    }
  }
  return categories;
}

type PreviewFight = { id: string; n: number; red: string; blue: string; round: number; group?: string };

// ── Import panel components ──────────────────────────────────────────────────

function _toTitleCase(s: string) {
  return s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function SectionPills({
  categories,
  onSelect,
}: {
  categories: ParsedCategory[];
  onSelect: (cat: ParsedCategory) => void;
}) {
  const sections = [...new Set(categories.map((c) => c.section))];
  const [activeSection, setActiveSection] = useState(sections[0] ?? "");

  if (categories.length === 0) {
    return <p className="text-sm text-muted-foreground py-4 text-center">Sin categorías</p>;
  }

  const sectionCats = categories.filter((c) => c.section === activeSection);

  return (
    <div className="space-y-3">
      {/* Section (age group) tabs */}
      <div className="flex flex-wrap gap-1.5">
        {sections.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setActiveSection(s)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-semibold border transition-colors",
              activeSection === s
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border/60 text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {_toTitleCase(s)}
            <span className="ml-1 opacity-60">({categories.filter((c) => c.section === s).length})</span>
          </button>
        ))}
      </div>
      {/* Category pills */}
      <div className="flex flex-wrap gap-2 min-h-[48px]">
        {sectionCats.map((cat) => {
          const parts = cat.name.split(" \u00b7 ");
          const displayName = parts.length > 1 ? parts.slice(1).join(" \u00b7 ") : cat.name;
          return (
            <button
              key={cat.name}
              type="button"
              onClick={() => onSelect(cat)}
              className="flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/50 hover:bg-primary hover:text-primary-foreground hover:border-primary px-3.5 py-1.5 text-sm font-medium transition-colors"
            >
              {displayName}
              <span className="inline-flex items-center justify-center size-5 rounded-full bg-black/20 text-[11px] font-bold">
                {cat.competitors.length}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ImportPanel({
  categories,
  onSelect,
}: {
  categories: ParsedCategory[];
  onSelect: (cat: ParsedCategory) => void;
}) {
  const combateCats = categories.filter((c) => c.discipline === "combate");
  const formasCats = categories.filter((c) => c.discipline === "formas");
  const defaultTab = combateCats.length > 0 ? "combate" : "formas";

  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList className="mb-3">
        <TabsTrigger value="combate">
          Lucha / Combate
          {combateCats.length > 0 && (
            <Badge variant="secondary" className="ml-1.5 text-[10px]">
              {combateCats.length}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="formas" disabled={formasCats.length === 0}>
          Formas / Tul
          {formasCats.length > 0 && (
            <Badge variant="secondary" className="ml-1.5 text-[10px]">
              {formasCats.length}
            </Badge>
          )}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="combate">
        <SectionPills categories={combateCats} onSelect={onSelect} />
      </TabsContent>
      <TabsContent value="formas">
        <SectionPills categories={formasCats} onSelect={onSelect} />
      </TabsContent>
    </Tabs>
  );
}


function getRoundLabel(remaining: number, r: number): string {
  if (remaining === 0) return "Final";
  if (remaining === 1) return "Semifinal";
  if (remaining === 2) return "Cuartos";
  return `Ronda ${r + 1}`;
}

function buildRoundLabels(fights: PreviewFight[]): Record<number, string> {
  if (fights.length === 0) return {};
  const maxRound = Math.max(...fights.map((f) => f.round));
  const labels: Record<number, string> = {};
  for (let r = 0; r <= maxRound; r++) {
    labels[r] = getRoundLabel(maxRound - r, r);
  }
  return labels;
}

function isPlayablePreviewMatch(match: BracketMatch): boolean {
  // The generator records completed single-sided first-round byes so their
  // athlete advances, but those are not bouts for the table chief to run.
  return match.round > 0 || Boolean(match.red.competitor && match.blue.competitor);
}

function computePreview(
  competitors: CompetitorEntry[],
  mode: string,
  rrOrderMode: RrOrderMode,
): PreviewFight[] {
  if (competitors.length < 2) return [];
  if (mode === "elimination") {
    return generateEliminationBracket(competitors).matches
      .filter(isPlayablePreviewMatch)
      .map((m, i) => ({
        id: m.id,
        n: i + 1,
        red: m.red.competitor?.name ?? "Por definir",
        blue: m.blue.competitor?.name ?? "Por definir",
        round: m.round,
      }));
  }
  if (competitors.length < 3 || competitors.length > 12) return [];
  const { fights } = generateGroupsTournament(competitors, "SERPENTINE", rrOrderMode);
  return fights.map((f, i) => ({
    id: f.id, n: i + 1, red: f.red.name, blue: f.blue.name, round: 0,
    group: f.groupId ?? "G1",
  }));
}

function FightRow({ fight, showNumber }: Readonly<{ fight: PreviewFight; showNumber: boolean }>) {
  return (
    <div data-testid="preview-fight-row"
      className="flex min-h-14 items-center gap-2 rounded-lg border border-border px-3 py-2 text-base sm:text-lg">
      {showNumber && (
        <span className="text-muted-foreground text-sm w-6 text-right shrink-0">{fight.n}.</span>
      )}
      <span className="min-w-0 flex-1 break-words text-right font-semibold leading-snug text-red-400">
        {fight.red}
      </span>
      <span className="shrink-0 text-sm text-muted-foreground">vs</span>
      <span className="min-w-0 flex-1 break-words font-semibold leading-snug text-blue-400">
        {fight.blue}
      </span>
    </div>
  );
}

function FixturePreview({ fights, mode, roundLabels }: Readonly<{
  fights: PreviewFight[];
  mode: string;
  roundLabels: Record<number, string>;
}>) {
  if (fights.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
        <Swords className="size-6 opacity-20" />
        <p className="text-sm">Aparece al agregar competidores</p>
      </div>
    );
  }
  if (mode === "elimination") {
    const rounds = Array.from(new Set(fights.map((f) => f.round)));
    return (
      <div className="space-y-4 max-h-[28rem] overflow-y-auto pr-1">
        {rounds.map((round) => (
          <div key={round}>
            <p className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {roundLabels[round] ?? `Ronda ${round + 1}`}
            </p>
            <div className="space-y-1">
              {fights.filter((f) => f.round === round).map((f) => (
                <FightRow key={f.id} fight={f} showNumber={false} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  // Keep chronological order: interleaved groups cannot be grouped into blocks.
  return (
    <div className="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
      {fights.map((fight) => (
        <div key={fight.id} className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-sm text-muted-foreground">
            Llave {fight.group ?? "G1"}
          </span>
          <div className="min-w-0 flex-1"><FightRow fight={fight} showNumber /></div>
        </div>
      ))}
    </div>
  );
}

const PESO_OPTIONS = ["Liviano A", "Liviano B", "Mediano A", "Mediano B", "Pesado A", "Pesado B", "Pesado C"];
const GENERO_OPTIONS = ["Masculino", "Femenino", "Mixto"];
function withoutNamedWeight(name: string): string {
  let next = name;
  for (const weight of PESO_OPTIONS) {
    next = next.replace(new RegExp(`\\b(?:Peso\\s+)?${weight}\\b`, "gi"), "");
  }
  return next.replace(/\s*·\s*/g, " · ").replace(/^[\s·–—-]+|[\s·–—-]+$/g, "").trim();
}
// Ephemeral browser-session state: AppLayout remounts SetupPage for each category tab.
const sessionWeightStash = new Map<string, string>();
const sessionPreviousWeight = new Map<string, string>();

type CatState = { weight: string; gradeSystem: GradeSystem | ""; beltFrom: string; beltTo: string; gupBand: string; gender: string; ageFrom: string; ageTo: string; ageOpenEnded: boolean; ageMode: "preset" | "custom" };
const EMPTY_CAT: CatState = { weight: "", gradeSystem: "", beltFrom: "", beltTo: "", gupBand: "", gender: "", ageFrom: "", ageTo: "", ageOpenEnded: false, ageMode: "preset" };
type GuidedStep = "age" | "grade" | "grade-range" | "gender" | "discipline" | "weight" | "format";
type GuidedProgress = { active: GuidedStep | null; completed: GuidedStep[] };
const ALL_GUIDED_STEPS: GuidedStep[] = ["age", "grade", "grade-range", "gender", "discipline", "weight", "format"];
const GUIDED_LABELS: Record<GuidedStep, string> = {
  age: "Edad", grade: "Sistema de grado", "grade-range": "Rango de grado",
  gender: "Género", discipline: "Disciplina", weight: "Peso", format: "Formato",
};

function guidedSteps(gradeSystem: CatState["gradeSystem"], matchType: string): GuidedStep[] {
  return ["age", "grade", ...(gradeSystem ? ["grade-range" as const] : []),
    "gender", "discipline", ...(matchType === "tul" ? [] : ["weight" as const]), "format"];
}

function guidedProgressKey(categoryId: string): string {
  return `tkd-category-guided-v1:${categoryId}`;
}

function readGuidedProgress(
  categoryId: string,
  newDraft: boolean,
  gradeSystem: CatState["gradeSystem"],
  matchType: string,
): GuidedProgress {
  try {
    const raw = sessionStorage.getItem(guidedProgressKey(categoryId));
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "completed" in parsed &&
        Array.isArray(parsed.completed) && "active" in parsed &&
        (parsed.active === null || ALL_GUIDED_STEPS.includes(parsed.active as GuidedStep))) {
        const completed = parsed.completed.filter((step: unknown): step is GuidedStep =>
          typeof step === "string" && ALL_GUIDED_STEPS.includes(step as GuidedStep));
        const applicable = guidedSteps(gradeSystem, matchType);
        const savedActive = parsed.active as GuidedStep | null;
        return {
          active: savedActive && !applicable.includes(savedActive)
            ? (applicable.find((step) => !completed.includes(step)) ?? null) : savedActive,
          completed,
        };
      }
    }
  } catch { /* Browser storage can be unavailable; the form remains usable. */ }
  return newDraft
    ? { active: "age", completed: [] }
    : { active: null, completed: [...ALL_GUIDED_STEPS] };
}

function writeGuidedProgress(categoryId: string, progress: GuidedProgress): void {
  try { sessionStorage.setItem(guidedProgressKey(categoryId), JSON.stringify(progress)); }
  catch { /* Browser storage is a convenience, not category data. */ }
}

function validateCustomAge(from: string, to: string): string | null {
  const first = Number(from);
  const last = Number(to);
  if (!/^\d+$/.test(from) || !/^\d+$/.test(to) ||
    !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < 1) {
    return "Ingresá ambas edades como números enteros positivos.";
  }
  return first > last ? "La edad inicial no puede superar la final." : null;
}

function ChipGroup({ label, options, value, onChange }: Readonly<{
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}>) {
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-semibold text-foreground">{label}</legend>
      <div className="flex flex-wrap gap-2 items-center">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            aria-pressed={value === opt}
            className={cn(
              "inline-flex min-h-11 items-center gap-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              value === opt
                ? "border-2 border-primary bg-primary/10 text-foreground font-bold"
                : "border-border bg-background text-foreground hover:border-primary/60 hover:bg-secondary",
            )}
          >
            {value === opt && <Check aria-hidden="true" className="size-4 shrink-0" />}
            {opt === "DAN" ? "DANES" : opt}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function SetupPage() {
  const {
    competitors,
    config,
    fights,
    bracketMatches,
    phase,
    addCompetitor,
    removeCompetitor,
    clearCompetitors,
    updateCompetitor,
    setConfig,
    commitCategoryStart,
    addImportedFights,
    completeFight,
    setupStarted,
    setSetupStarted,
    startNewTournament,
  } = useTournamentStore(
    useShallow((s) => ({
      competitors: s.competitors,
      config: s.config,
      fights: s.fights,
      bracketMatches: s.bracketMatches,
      phase: s.phase,
      addCompetitor: s.addCompetitor,
      removeCompetitor: s.removeCompetitor,
      clearCompetitors: s.clearCompetitors,
      updateCompetitor: s.updateCompetitor,
      setConfig: s.setConfig,
      commitCategoryStart: s.commitCategoryStart,
      addImportedFights: s.addImportedFights,
      completeFight: s.completeFight,
      setupStarted: s.setupStarted,
      setSetupStarted: s.setSetupStarted,
      startNewTournament: s.startNewTournament,
    }))
  );
  const navigate = useNavigate();
  const { socket, connected, stateReady, state: serverState, request } = useSocket();
  const interactionBlocked = useCategoryInteractionBlocked();
  const startPending = useTournamentStore((state) =>
    state.categoryOperationReason === CATEGORY_START_REASON ||
    state.categoryOperationReason === CATEGORY_START_RECOVERY_REASON);
  const snapshot = { phase, config, competitors, fights, bracketMatches, setupStarted,
    groups: useTournamentStore((state) => state.groups),
    currentFightIndex: useTournamentStore((state) => state.currentFightIndex),
    bracketSeeds: useTournamentStore((state) => state.bracketSeeds) };
  const lifecycleContext = { snapshot, connected, stateReady, serverState: serverState ?? {} };
  const primaryAction = useCategoryPrimaryAction(lifecycleContext, request);
  const categoryIsActive = isCategoryInitialized(snapshot);
  const [cat, setCat] = useState<CatState>(EMPTY_CAT);
  const [customAgeDraft, setCustomAgeDraft] = useState({ from: "", to: "" });
  const [danDraft, setDanDraft] = useState({ from: "", to: "" });
  const [danError, setDanError] = useState<string | null>(null);
  useEffect(() => {
    // Hydration is intentionally keyed to category identity, not autosaved field changes.
    const selected = useTournamentStore.getState().config;
    if (selected.id !== config.id) return;
    const age = AGE_DIVISIONS.find((division) => division.id === selected.ageDivision);
    const activeWeight = selected.matchType === "tul" ? "" : (selected.weightLabel ?? "");
    setCat({
      ...EMPTY_CAT,
      weight: activeWeight,
      gradeSystem: selected.gradeSystem ?? "",
      beltFrom: selected.danFrom === undefined ? "" : String(selected.danFrom),
      beltTo: selected.danTo === undefined ? "" : String(selected.danTo),
      gupBand: selected.gupBand ?? "",
      gender: selected.sexDivision ?? "",
      ageFrom: selected.categoryAgeFrom ?? (age ? String(age.from) : ""),
      ageTo: selected.categoryAgeTo ?? (age?.to === undefined ? "" : String(age.to)),
      ageOpenEnded: selected.categoryAgeOpenEnded ?? (!!age && age.to === undefined),
      ageMode: age || (!selected.categoryAgeFrom && !selected.categoryAgeTo)
        ? "preset" : "custom",
    });
    setCustomAgeDraft({
      from: selected.categoryAgeFrom ?? (age ? String(age.from) : ""),
      to: selected.categoryAgeTo ?? (age?.to === undefined ? "" : String(age.to)),
    });
    setDanDraft({
      from: selected.danFrom === undefined ? "" : String(selected.danFrom),
      to: selected.danTo === undefined ? "" : String(selected.danTo),
    });
  }, [config.id]);
  useEffect(() => {
    // Normalize legacy Tul drafts independently; never rehydrate local fields on autosave.
    if (config.matchType !== "tul") return;
    const staleGeneratedWeight = config.nameGenerated === true && PESO_OPTIONS.some((weight) =>
      config.categoryName.toLocaleLowerCase().includes(weight.toLocaleLowerCase()));
    if (!config.weightLabel && !staleGeneratedWeight) return;
    if (config.weightLabel) {
      sessionWeightStash.set(config.id, config.weightLabel);
      sessionPreviousWeight.set(config.id, config.weightLabel);
    }
    const selected = useTournamentStore.getState().config;
    const age = AGE_DIVISIONS.find((division) => division.id === selected.ageDivision);
    setConfig({
      weightLabel: undefined,
      ...((!config.categoryName.trim() || config.nameGenerated === true)
        ? { categoryName: buildCategoryName({
          weight: "",
          gradeSystem: selected.gradeSystem ?? "",
          beltFrom: selected.danFrom === undefined ? "" : String(selected.danFrom),
          beltTo: selected.danTo === undefined ? "" : String(selected.danTo),
          gupBand: selected.gupBand ?? "",
          gender: selected.sexDivision ?? "",
          ageFrom: selected.categoryAgeFrom ?? (age ? String(age.from) : ""),
          ageTo: selected.categoryAgeTo ?? (age?.to === undefined ? "" : String(age.to)),
          ageOpenEnded: selected.categoryAgeOpenEnded ?? (!!age && age.to === undefined),
        }), nameGenerated: true } : {}),
    });
  }, [config.id, config.matchType, config.weightLabel, config.categoryName, config.nameGenerated, setConfig]);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  useEffect(() => {
    if (config.matchType === "tul" && !isCategoryFormatAllowed("tul", config.mode as "round-robin" | "elimination")) {
      setConfig({ mode: defaultCategoryFormat("tul") });
    }
  }, [config.matchType, config.mode, setConfig]);
  const showWelcome = competitors.length === 0 && !setupStarted && !welcomeDismissed && !config.categoryName.trim();


  const [draftTournamentName, setDraftTournamentName] = useState(config.tournamentName ?? "");
  const [draftAlias, setDraftAlias] = useState("");
  const [draftRingName, setDraftRingName] = useState("");

  useEffect(() => {
    fetch("/api/ring/status")
      .then((r) => r.json())
      .then((d: { alias?: string; name?: string }) => {
        if (d.alias) setDraftAlias(d.alias);
        if (d.name) setDraftRingName(d.name);
      })
      .catch(() => {});
  }, []);

  // Cuando Mesa Central reasigna peleas a este tatami, navegar automáticamente a /fight.
  useEffect(() => {
    if (!socket) return;
    async function onFightsImported(payload: { categoryId?: string | null; fights: Array<{ id: string; red: { id: string; name: string }; blue: { id: string; name: string }; completed: boolean; groupId?: string }>; sourceRingLabel?: string | null }) {
      if (payload.categoryId !== config.id) return;
      addImportedFights(
        payload.fights.map((f) => ({
          id: f.id,
          red: { id: f.red.id, name: f.red.name },
          blue: { id: f.blue.id, name: f.blue.name },
          completed: false,
          groupId: f.groupId,
          importedFrom: payload.sourceRingLabel ?? "Mesa Central",
        }))
      );
      toast.warning(
        `📥 ${payload.fights.length} pelea${payload.fights.length !== 1 ? "s" : ""} reasignadas desde ${payload.sourceRingLabel ?? "Mesa Central"}`,
        { description: "Redirigiendo a página de combate...", duration: 5000 }
      );
      try {
        const response = await fetch("/api/ring/status");
        if (!response.ok) throw new Error("No se pudo verificar el tatami.");
        const status = await response.json() as {
          activeMatchLock?: { categoryId: string | null } | null;
        };
        if (status.activeMatchLock && status.activeMatchLock.categoryId !== config.id) {
          navigate(config.mode === "elimination" ? "/bracket" : "/standings");
          return;
        }
        navigate("/fight");
      } catch {
        navigate(config.mode === "elimination" ? "/bracket" : "/standings");
      }
    }
    socket.on("fights:imported", onFightsImported);
    return () => { socket.off("fights:imported", onFightsImported); };
  }, [socket, addImportedFights, navigate, config.id, config.mode]);

  // Cuando el tatami destino termina una pelea reasignada, recibir el resultado.
  useEffect(() => {
    if (!socket) return;
    function onRemoteCompleted(payload: {
      fightId: string;
      categoryId?: string | null;
      winner: string;
      flagsRed: number;
      flagsBlue: number;
      completedIn: string;
    }) {
      if (payload.categoryId && payload.categoryId !== config.id) return;
      const localFight = useTournamentStore.getState().fights.find((fight) => fight.id === payload.fightId);
      if (!localFight || localFight.completed) return;
      completeFight(
        payload.fightId,
        payload.winner as "red" | "blue" | "draw",
        `Jugada en ${payload.completedIn}`,
        { flagsRed: payload.flagsRed, flagsBlue: payload.flagsBlue },
      );
    }
    socket.on("fight:remote-completed", onRemoteCompleted);
    return () => { socket.off("fight:remote-completed", onRemoteCompleted); };
  }, [socket, completeFight, config.id]);

  function updateCat(patch: Partial<CatState>) {
    const next = { ...cat, ...patch };
    if (patch.weight !== undefined && patch.weight !== cat.weight && cat.weight) {
      sessionPreviousWeight.set(config.id, cat.weight);
    }
    setCat(next);
    const dimensions = {
      weightLabel: next.weight || undefined,
      ageDivision: ageDivisionForRange(next.ageFrom, next.ageTo, next.ageOpenEnded),
      categoryAgeFrom: next.ageFrom || undefined,
      categoryAgeTo: next.ageTo || undefined,
      categoryAgeOpenEnded: next.ageOpenEnded,
      sexDivision: GENERO_OPTIONS.includes(next.gender)
        ? next.gender as "Masculino" | "Femenino" | "Mixto" : undefined,
      gradeSystem: next.gradeSystem || undefined,
      gupBand: next.gradeSystem === "GUPS" ? next.gupBand : undefined,
      danFrom: next.gradeSystem === "DAN" && /^\d+$/.test(next.beltFrom)
        ? Number(next.beltFrom) : undefined,
      danTo: next.gradeSystem === "DAN" && /^\d+$/.test(next.beltTo)
        ? Number(next.beltTo) : undefined,
    };
    const profilePatch = config.profileId === "yusan-2026" && config.profileApplied
      ? yusanConfigPatch(config, dimensions, config.mode, BASE) : null;
    const generatedName = !config.categoryName.trim() || config.nameGenerated === true;
    setConfig({
      ...dimensions,
      ...profilePatch,
      ...(generatedName ? { categoryName: buildCategoryName(next), nameGenerated: true } : {}),
    });
  }

  const DEMO_COMPETITORS = [
    { name: "Marcos Pérez", team: "Club Almagro" },
    { name: "Ana García", team: "Club Flores" },
    { name: "Luis Mendoza", team: "Club Almagro" },
    { name: "Carla López", team: "Club Palermo" },
    { name: "Diego Fernández", team: "Club Flores" },
    { name: "María Torres", team: "Club Palermo" },
    { name: "Sebastián Ruiz", team: "Club Almagro" },
    { name: "Valentina Díaz", team: "Club Flores" },
  ];

  function loadDemo() {
    setWelcomeDismissed(true);
    updateCat({ weight: "Mediano A", gradeSystem: "DAN", beltFrom: "1", beltTo: "3", gender: "Masculino" });
    DEMO_COMPETITORS.forEach((c) => { addCompetitor(c); });
  }

  async function handleNewTournament() {
    if (draftAlias.trim()) {
      try {
        await fetch("/api/ring/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alias: draftAlias.trim(), name: draftRingName.trim() || draftAlias.trim() }),
        });
      } catch {
        // non-critical
      }
    }
    startNewTournament(draftTournamentName.trim());
    setSetupStarted(true);
    setWelcomeDismissed(true);
  }

  const [quickName, setQuickName] = useState("");
  const [quickTeam, setQuickTeam] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  // Category card starts expanded when no category is set yet, collapsed otherwise
  const [catExpanded, setCatExpanded] = useState(() =>
    config.categoryName === "" || readGuidedProgress(config.id, false,
      config.gradeSystem ?? "", config.matchType ?? "sparring").active !== null);
  const namedWithoutGeneration = !!config.categoryName.trim() && config.nameGenerated !== true;
  const newGuidedDraft = !categoryIsActive && !namedWithoutGeneration &&
    (useTournamentStore.getState().getCategoryEntries().some((entry) =>
      entry.id === config.id && entry.isDraft) || !config.categoryName.trim());
  const [guided, setGuided] = useState<GuidedProgress>(() => categoryIsActive || namedWithoutGeneration
    ? { active: null, completed: [...ALL_GUIDED_STEPS] }
    : readGuidedProgress(config.id, newGuidedDraft,
      config.gradeSystem ?? "", config.matchType ?? "sparring"));
  const guidedFocusRequested = useRef(false);
  const [customAgeError, setCustomAgeError] = useState<string | null>(null);
  useEffect(() => {
    // Imported/manual names edit directly, even when an import fills the current blank draft.
    const progress = categoryIsActive || namedWithoutGeneration
      ? { active: null, completed: [...ALL_GUIDED_STEPS] } satisfies GuidedProgress
      : readGuidedProgress(config.id, newGuidedDraft,
        config.gradeSystem ?? "", config.matchType ?? "sparring");
    writeGuidedProgress(config.id, progress);
    setGuided(progress);
    setCustomAgeError(null);
    setDanError(null);
  }, [config.id, config.gradeSystem, config.matchType, newGuidedDraft,
    namedWithoutGeneration, categoryIsActive]);
  useEffect(() => {
    if (!guidedFocusRequested.current || !catExpanded) return;
    guidedFocusRequested.current = false;
    const target = document.getElementById(guided.active
      ? `guided-${guided.active}-heading` : "guided-review-heading");
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
  }, [guided.active, catExpanded]);

  function setGuidedProgress(progress: GuidedProgress): void {
    writeGuidedProgress(config.id, progress);
    guidedFocusRequested.current = true;
    setGuided(progress);
  }

  function editGuidedStep(step: GuidedStep): void {
    setCustomAgeError(null);
    setGuidedProgress({ ...guided, active: step });
  }

  function finishGuidedStep(
    step: GuidedStep,
    nextGradeSystem = cat.gradeSystem,
    nextMatchType = config.matchType ?? "sparring",
  ): void {
    const completed = new Set(guided.completed);
    completed.add(step);
    if (step === "grade") completed.delete("grade-range");
    const next = guidedSteps(nextGradeSystem, nextMatchType)
      .find((candidate) => !completed.has(candidate)) ?? null;
    setGuidedProgress({ active: next, completed: [...completed] });
  }

  function skipGuidedStep(step: GuidedStep): void {
    if (step === "age") updateCat({ ageFrom: "", ageTo: "", ageOpenEnded: false, ageMode: "preset" });
    if (step === "grade" || step === "grade-range") {
      updateCat({ gradeSystem: "", gupBand: "", beltFrom: "", beltTo: "" });
    }
    if (step === "gender") updateCat({ gender: "" });
    if (step === "weight") updateCat({ weight: "" });
    finishGuidedStep(step, step === "grade" || step === "grade-range" ? "" : cat.gradeSystem);
  }

  function selectDiscipline(t: "sparring" | "tul"): void {
    if (t === "tul" && cat.weight) {
      sessionWeightStash.set(config.id, cat.weight);
      updateCat({ weight: "" });
    } else if (t === "sparring") {
      const restoredWeight = sessionWeightStash.get(config.id);
      if (restoredWeight) {
        updateCat({ weight: restoredWeight });
        sessionWeightStash.delete(config.id);
        sessionPreviousWeight.delete(config.id);
      }
    }
    const mode = defaultCategoryFormat(t);
    const timing = config.profileId === "yusan-2026" && config.profileApplied
      ? yusanConfigPatch(config, config, mode, BASE) : null;
    setConfig({ ...(timing ?? {}), matchType: t, mode });
    finishGuidedStep("discipline", cat.gradeSystem, t);
  }

  function selectFormat(m: "round-robin" | "elimination"): void {
    if (!isCategoryFormatAllowed(config.matchType ?? "sparring", m)) return;
    if (config.profileId === "yusan-2026" && config.profileApplied) {
      const patch = yusanConfigPatch(config, config, m, BASE);
      setConfig(patch ?? { mode: m });
    } else if (m === "round-robin") {
      const rules = config.ruleSet?.mode === "sparring"
        ? (config.ruleSet as RuleSetSparring) : BASE;
      const judges = config.judgesCount ?? BASE.judgesCount;
      setConfig({
        mode: m,
        ruleSet: {
          ...BASE, ...rules, judgesCount: judges,
          rounds: { ...rules.rounds, count: 1, duration_seconds: 60 },
        },
      });
    } else setConfig({ mode: m });
    finishGuidedStep("format");
  }

  function guidedStepLabel(step: GuidedStep): string {
    if (step === "grade-range") return cat.gradeSystem === "DAN" ? "Grado (Dan)" : "Rango GUP";
    return GUIDED_LABELS[step];
  }

  function guidedStepSummary(step: GuidedStep): string {
    if (step === "age") return formatCategoryAge(cat) || "No especificar";
    if (step === "grade") return cat.gradeSystem === "DAN" ? "DANES" : cat.gradeSystem || "No especificar";
    if (step === "grade-range") return cat.gradeSystem === "DAN"
      ? (cat.beltFrom && cat.beltTo ? `${cat.beltFrom}-${cat.beltTo} Dan` : "No especificar")
      : cat.gupBand || "No especificar";
    if (step === "gender") return cat.gender || "No especificar";
    if (step === "discipline") return config.matchType === "tul" ? "Tul / Formas" : "Sparring";
    if (step === "weight") return cat.weight || "No especificar";
    return config.mode === "round-robin" ? "Round Robin" : "Eliminación";
  }

  // ── Presets ────────────────────────────────────────────────────────────────
  const [serverPresets, setServerPresets] = useState<TimePreset[]>([]);

  useEffect(() => {
    fetchPresets().then(setServerPresets).catch(() => {});
  }, []);

  function applyPreset(p: TimePreset, format = config.mode) {
    const isAgePreset = p.ageFrom !== undefined;
    const presetFormat = format === "round-robin" ? "round-robin" : "elimination";
    const applied = getPresetForCategoryFormat(p, presetFormat);
    const rules = config.ruleSet?.mode === "sparring" ? (config.ruleSet as RuleSetSparring) : BASE;
    const judges = config.judgesCount ?? BASE.judgesCount;
    const updated: RuleSetSparring = {
      ...BASE,
      ...rules,
      judgesCount: judges,
      rounds: {
        ...rules.rounds,
        count: applied.roundCount,
        duration_seconds: applied.durationSeconds,
      },
    };
    const age = ageSelectionFromPreset(p);
    if (age) updateCat({ ...age, ageMode: "preset" });
    const nextConfig: Partial<typeof config> = {
      mode: format,
      ruleSet: updated,
      judgesCount: updated.judgesCount,
      profileApplied: false,
    };
    // Round Robin preset changes only its single round; final and tie settings remain untouched.
    // Saved server presets remain custom, time-only presets and can still be applied as-is.
    if (!isAgePreset || format !== "round-robin") {
      nextConfig.finalRounds = p.finalRounds;
      nextConfig.finalSeconds = p.finalSeconds;
      nextConfig.tiebreakerSeconds = p.tiebreakerSeconds;
      nextConfig.maxTiebreakers = p.maxTiebreakers;
    }
    setConfig(nextConfig);
  }

  function isPresetActive(p: TimePreset): boolean {
    const rules = config.ruleSet?.mode === "sparring" ? (config.ruleSet as RuleSetSparring) : BASE;
    return isTimePresetActive(p, {
      roundCount: rules.rounds.count,
      durationSeconds: rules.rounds.duration_seconds,
      finalRounds: config.finalRounds,
      finalSeconds: config.finalSeconds,
      tiebreakerSeconds: config.tiebreakerSeconds,
      maxTiebreakers: config.maxTiebreakers,
    }, config.categoryName);
  }

  // Resumen de la config actual para mostrar en el chip editor
  const _ar = config.ruleSet?.mode === "sparring" ? (config.ruleSet as RuleSetSparring) : BASE;
  const _rc = _ar.rounds.count;
  const _rd = _ar.rounds.duration_seconds;
  const _rest = _ar.rounds.rest_seconds;
  const _fr = config.finalRounds ?? _rc;
  const _fs = config.finalSeconds ?? _rd;
  const _tb = config.tiebreakerSeconds ?? 30;
  const _gp = _ar.rounds.golden_point ?? true;
  const priorWeight = sessionPreviousWeight.get(config.id);
  const staleNamedWeight = priorWeight && priorWeight !== cat.weight &&
    config.categoryName.toLocaleLowerCase().includes(priorWeight.toLocaleLowerCase());
  const tulNamedWeight = config.matchType === "tul" && PESO_OPTIONS.some((weight) =>
    config.categoryName.toLocaleLowerCase().includes(weight.toLocaleLowerCase()));
  function _fmt(s: number) { return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

  const [dialogOpen, setDialogOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [formError, setFormError] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importPanelOpen, setImportPanelOpen] = useState(false);
  const [importCategories, setImportCategories] = useState<ParsedCategory[]>([]);
  const [importLoading, setImportLoading] = useState(false);

  function handleQuickAdd() {
    const name = quickName.trim();
    if (!name) return;
    const duplicate = competitors.some(
      (c) => c.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      toast.error(`Ya existe un competidor llamado "${name}"`);
      return;
    }
    addCompetitor({ name, team: quickTeam.trim() || undefined });
    setQuickName("");
    setQuickTeam("");
    nameRef.current?.focus();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportLoading(true);
    const isTxt = file.name.toLowerCase().endsWith(".txt");
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        let cats: ParsedCategory[];
        if (isTxt) {
          cats = parseTxtFile(ev.target?.result as string);
        } else {
          cats = parseExcelFile(ev.target?.result as ArrayBuffer);
        }
        if (cats.length === 0) {
          toast.error("No se encontraron categor\u00edas en el archivo.");
        } else {
          setImportCategories(cats);
          setImportPanelOpen(true);
          toast.success(`${cats.length} categor\u00edas importadas`);
        }
      } catch {
        toast.error("No se pudo leer el archivo.");
      } finally {
        setImportLoading(false);
      }
    };
    reader.onerror = () => {
      toast.error("Error al leer el archivo.");
      setImportLoading(false);
    };
    if (isTxt) {
      reader.readAsText(file, "utf-8");
    } else {
      reader.readAsArrayBuffer(file);
    }
    e.target.value = "";
  }

  function handleImportCategory(cat: ParsedCategory) {
    clearCompetitors();
    for (const name of cat.competitors) {
      addCompetitor({ name });
    }
    setConfig({ categoryName: cat.name, nameGenerated: false });
    toast.success(`${cat.competitors.length} competidores cargados \u2014 ${cat.name}`);
  }

  function openEdit(c: CompetitorEntry) {
    setForm({ name: c.name, team: c.team ?? "", weight: c.weight?.toString() ?? "" });
    setEditingId(c.id);
    setFormError("");
    setDialogOpen(true);
  }

  function handleSave() {
    if (!form.name.trim()) {
      setFormError("El nombre es obligatorio.");
      return;
    }
    const weightNum = form.weight ? Number(form.weight) : undefined;
    if (form.weight && (Number.isNaN(weightNum) || (weightNum ?? 0) <= 0)) {
      setFormError("El peso debe ser un numero positivo.");
      return;
    }
    const duplicate = competitors.some(
      (c) => c.id !== editingId && c.name.trim().toLowerCase() === form.name.trim().toLowerCase()
    );
    if (duplicate) {
      setFormError(`Ya existe un competidor llamado "${form.name.trim()}".`);
      return;
    }
    if (editingId) {
      updateCompetitor(editingId, {
        name: form.name.trim(),
        team: form.team.trim() || undefined,
        weight: weightNum,
      });
    }
    setDialogOpen(false);
  }

  async function handleStart(): Promise<void> {
    if (primaryAction.kind !== "start" || primaryAction.disabled || interactionBlocked ||
      useTournamentStore.getState().categoryOperationReason) return;
    const draft = useTournamentStore.getState();
    // The start lock serializes ordinary edits. Keep identity checks as a
    // defense against unexpected state replacement outside store actions.
    const draftIsCurrent = (): boolean => {
      const current = useTournamentStore.getState();
      return current.config === draft.config && current.competitors === draft.competitors &&
        current.fights === draft.fights && current.groups === draft.groups &&
        current.bracketMatches === draft.bracketMatches && current.phase === draft.phase &&
        current.bracketSeeds === draft.bracketSeeds &&
        current.currentFightIndex === draft.currentFightIndex &&
        current.setupStarted === draft.setupStarted;
    };
    const warnChangedDraft = (): void => {
      toast.warning("La categoría cambió mientras se preparaba. Revisá los datos e intentá iniciar otra vez.");
    };
    if (draft.config !== config || draft.competitors !== competitors ||
      draft.fights !== fights || draft.bracketMatches !== bracketMatches || !draftIsCurrent()) {
      warnChangedDraft();
      return;
    }
    useTournamentStore.getState().setCategoryOperationReason(CATEGORY_START_REASON);
    if (useTournamentStore.getState().categoryOperationReason !== CATEGORY_START_REASON) {
      toast.warning("Hay otra operación de categoría en curso. Intentá de nuevo cuando termine.");
      return;
    }
    try {
      let lock: { categoryId: string | null } | null;
      try {
        const response = await fetch("/api/ring/status");
        if (!response.ok) throw new Error("No se pudo verificar el tatami.");
        const status = await response.json() as { activeMatchLock?: { categoryId: string | null } | null };
        lock = status.activeMatchLock ?? null;
      } catch {
        toast.warning("Sin respuesta del servidor. Podés editar esta categoría, pero no iniciarla todavía.");
        return;
      }
      if (!draftIsCurrent()) { warnChangedDraft(); return; }
      if (draft.config.mode === "elimination") {
        const { matches, seeds } = generateEliminationBracket(draft.competitors);
        if (!commitCategoryStart(draft, { mode: "elimination", matches, seeds })) {
          warnChangedDraft();
          return;
        }
      } else {
        const generated = generateGroupsTournament(
          draft.competitors, "SERPENTINE", draft.config.rrOrderMode ?? "group-blocks",
        );
        if (!lock) {
          const response = await fetch("/api/ring/sync-fights", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ competitors: draft.competitors, fights: generated.fights.map((fight) => ({
              id: fight.id, red_id: fight.red.id, blue_id: fight.blue.id, group_id: fight.groupId,
            })), categoryId: draft.config.id, categoryName: draft.config.categoryName,
              tournamentName: draft.config.tournamentName }),
          });
          if (!response.ok) throw new Error("El servidor rechazó la preparación de peleas.");
          if (!draftIsCurrent()) {
            useTournamentStore.getState().setCategoryOperationReason(CATEGORY_START_RECOVERY_REASON);
            toast.error(CATEGORY_START_RECOVERY_REASON);
            return;
          }
        }
        if (!commitCategoryStart(draft, { mode: "round-robin",
          groups: generated.groups, fights: generated.fights })) {
          if (!lock) {
            useTournamentStore.getState().setCategoryOperationReason(CATEGORY_START_RECOVERY_REASON);
            toast.error(CATEGORY_START_RECOVERY_REASON);
          } else warnChangedDraft();
          return;
        }
      }
      navigate(draft.config.mode === "elimination" ? "/bracket" : "/standings");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo sincronizar.");
    } finally {
      if (useTournamentStore.getState().categoryOperationReason === CATEGORY_START_REASON) {
        useTournamentStore.getState().setCategoryOperationReason(null);
      }
    }
  }
  const previewFights: PreviewFight[] = categoryIsActive
    ? config.mode === "elimination"
      ? bracketMatches.filter(isPlayablePreviewMatch).map((match, index) => ({ id: match.id, n: index + 1,
          red: match.red.competitor?.name ?? "Por definir", blue: match.blue.competitor?.name ?? "Por definir", round: match.round }))
      : fights.map((fight, index) => ({ id: fight.id, n: index + 1, red: fight.red.name,
          blue: fight.blue.name, round: 0, group: fight.groupId ?? "G1" }))
    : computePreview(competitors, config.mode, config.rrOrderMode ?? "group-blocks");
  const roundLabels = buildRoundLabels(previewFights);
  const completedPreviewCount = config.mode === "elimination"
    ? bracketMatches.filter((match) => isPlayablePreviewMatch(match) && match.completed).length
    : fights.filter((fight) => fight.completed).length;
  const groupDist = config.mode === "round-robin" ? getGroupDistribution(competitors.length) : undefined;

  if (showWelcome) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="flex flex-col items-center justify-center min-h-full p-4 sm:p-8 gap-6 sm:gap-10 text-center">
        <div className="space-y-3">
          <div className="flex items-center justify-center gap-3 mb-2">
            <Trophy className="size-8 sm:size-10 text-primary" />
            <h1 className="text-3xl sm:text-5xl font-black tracking-tight">TKD Fight</h1>
          </div>
          <p className="text-muted-foreground text-base sm:text-lg max-w-md mx-auto">
            Sistema de scoring para torneos de Taekwondo ITF.<br />
            Gratis, sin registro y funciona sin internet.
          </p>
          <a href="/maintenance" className="inline-block text-sm text-blue-400 underline">
            Respaldo completo
          </a>
        </div>

        <Card className="w-full max-w-2xl text-left">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Configuración del torneo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="wiz-tournament-name">Nombre del evento</Label>
              <Input
                id="wiz-tournament-name"
                placeholder="Torneo Regional ITF 2026"
                value={draftTournamentName}
                onChange={(e) => setDraftTournamentName(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="wiz-ring-alias">Alias del cuadrilátero</Label>
                <Input
                  id="wiz-ring-alias"
                  placeholder="T1"
                  value={draftAlias}
                  onChange={(e) => setDraftAlias(e.target.value.slice(0, 4))}
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-ring-name">Nombre del cuadrilátero</Label>
                <Input
                  id="wiz-ring-name"
                  placeholder="Cuadrilátero 1"
                  value={draftRingName}
                  onChange={(e) => setDraftRingName(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl w-full text-left">
          <div className="rounded-xl border border-border bg-secondary/30 p-5 space-y-2">
            <Wifi className="size-6 text-primary" />
            <p className="font-semibold text-sm">Funciona sin internet</p>
            <p className="text-xs text-muted-foreground">Versión USB portable para gimnasios sin wifi confiable.</p>
          </div>
          <div className="rounded-xl border border-border bg-secondary/30 p-5 space-y-2">
            <Smartphone className="size-6 text-primary" />
            <p className="font-semibold text-sm">Jueces via celular</p>
            <p className="text-xs text-muted-foreground">Jueces conectan escaneando un QR desde su celular, sin apps.</p>
          </div>
          <div className="rounded-xl border border-border bg-secondary/30 p-5 space-y-2">
            <Zap className="size-6 text-primary" />
            <p className="font-semibold text-sm">Bracket automático</p>
            <p className="text-xs text-muted-foreground">Round Robin y Eliminación directa. Desempates incluidos.</p>
          </div>
        </div>

        <div className="flex gap-4 flex-wrap justify-center">
          <Button size="lg" onClick={loadDemo} className="gap-2">
            <Zap className="size-4" />
            Ver demo (8 competidores)
          </Button>
          <Button size="lg" variant="outline" onClick={() => void handleNewTournament()} className="gap-2">
            Nuevo torneo
            <ArrowRight className="size-4" />
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Open source · github.com/tkdbrian/tkdfight
        </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4" inert={startPending} aria-busy={startPending}>
      {/* ── HEADER ─────────────────────────────────────────────── */}
      <div className="space-y-2">
        <a href="/maintenance" className="inline-block text-sm text-blue-400 underline">
          Respaldo completo
        </a>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            {config.tournamentName && (
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50 mb-1">
                {config.tournamentName}
              </p>
            )}
            <h1 className={cn(
              "font-black tracking-tight leading-tight",
              config.categoryName ? "text-2xl text-foreground" : "text-xl text-muted-foreground",
            )}>
              {config.categoryName || "Sin categoría"}
            </h1>
            <div className="mt-2">
              <button
                id="tour-cat-btn"
                type="button"
                aria-expanded={catExpanded}
                aria-controls={catExpanded ? "category-editor" : undefined}
                onClick={() => setCatExpanded((v) => !v)}
                className={cn(
                  "min-h-11 rounded-lg px-4 py-2 text-sm font-semibold border transition-colors flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  catExpanded
                    ? "border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
                    : "border-primary/60 bg-primary/5 text-primary hover:bg-primary/10",
                )}
              >
                <ChevronDown className={cn("size-4 transition-transform", catExpanded && "rotate-180")} />
                {catExpanded ? "Cerrar configuración" : "⚙ Configurar categoría"}
              </button>
              <p className="text-muted-foreground text-xs mt-1">
                {competitors.length === 0
                  ? "Sin competidores"
                  : `${competitors.length} ${competitors.length === 1 ? "competidor" : "competidores"}`}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            {primaryAction.kind !== "start" && (
              <>
                <Button id="tour-start-btn" data-testid="category-primary-action"
                  disabled={primaryAction.disabled || interactionBlocked || startPending} size="xl"
                  onClick={() => {
                    if (primaryAction.route) {
                      if (primaryAction.fightId) {
                        const index = fights.findIndex((fight) => fight.id === primaryAction.fightId);
                        if (index >= 0) useTournamentStore.getState().setCurrentFightIndex(index);
                      }
                      navigate(primaryAction.route, primaryAction.route === "/fight" && primaryAction.fightId
                        ? { state: { kind: "category-continue", categoryId: config.id, fightId: primaryAction.fightId } }
                        : undefined);
                    } else { void handleStart(); }
                  }}>
                  <Swords className="size-5" />{primaryAction.label}
                </Button>
                {primaryAction.reason && <p className="text-xs text-muted-foreground">{primaryAction.reason}</p>}
              </>
            )}
            {categoryIsActive && <Button variant="outline" size="sm" onClick={() => navigate(config.mode === "elimination" ? "/bracket" : "/standings")}>
              {config.mode === "elimination" ? "Ver llave" : "Ver clasificación"}
            </Button>}
            {categoryIsActive && <CategoryRestartButton {...lifecycleContext} />}
            <CategoryDeleteButton {...lifecycleContext} />
          </div>
        </div>

        {/* Las respuestas anteriores se resumen; solo hay una decisión activa. */}
        {catExpanded && (
          <div id="category-editor" className="rounded-xl border border-border bg-secondary/20 p-3 sm:p-4 space-y-4">
            <div className={cn(
              "grid grid-cols-1 items-start gap-4",
              guided.active === null
                ? "lg:grid-cols-2"
                : "lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]",
            )}>
              <fieldset className={cn(
                "min-w-0 space-y-4 rounded-xl border border-border bg-background p-3 sm:p-4",
                guided.active === null && "lg:col-span-2",
              )}>
                <legend className="px-1 text-base font-bold text-foreground">Categoría</legend>
              <p className="text-sm text-muted-foreground">Elegí una opción. Podés volver a cambiar cualquier respuesta.</p>
              <div data-testid="category-answer-grid" className={cn(
                "grid grid-cols-1 gap-2",
                guided.active === null ? "lg:grid-cols-2 2xl:grid-cols-3" : "xl:grid-cols-2",
              )}>
                {guidedSteps(cat.gradeSystem, config.matchType ?? "sparring").filter((step) =>
                  guided.completed.includes(step) && guided.active !== step).map((step) => (
                  <button key={step} type="button"
                    aria-label={`Editar ${guidedStepLabel(step)}: ${guidedStepSummary(step)}`}
                    onClick={() => editGuidedStep(step)}
                    className="flex min-h-16 min-w-0 w-full flex-col gap-1 whitespace-normal rounded-lg border border-border bg-secondary/20 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 hover:border-primary/60">
                    <span className="flex w-full items-start justify-between gap-2 text-sm">
                      <span className="font-semibold">{guidedStepLabel(step)}</span>
                      <span aria-hidden="true" className="shrink-0 text-primary underline underline-offset-2">Editar</span>
                    </span>
                    <span className="min-w-0 break-words text-base font-medium leading-snug text-foreground">
                      {guidedStepSummary(step)}
                    </span>
                  </button>
                ))}
              </div>
              {guided.active && (
                <h3 id={`guided-${guided.active}-heading`} data-testid="guided-active-step" tabIndex={-1}
                  className="text-sm font-bold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Paso {guidedSteps(cat.gradeSystem, config.matchType ?? "sparring").indexOf(guided.active) + 1} de {guidedSteps(cat.gradeSystem, config.matchType ?? "sparring").length}: {guidedStepLabel(guided.active)}
                </h3>
              )}
              {guided.active === null && <h3 id="guided-review-heading" data-testid="guided-review" tabIndex={-1}
                className="text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Configuración lista para revisar</h3>}
              {guided.active === "age" && (
              <fieldset className="min-w-0 space-y-2">
                <legend className="text-sm font-semibold text-foreground">Edad</legend>
                <div className="flex flex-wrap gap-1.5">
                  {AGE_DIVISIONS.map((age) => (
                    <button key={age.id} type="button" aria-pressed={ageDivisionForRange(cat.ageFrom, cat.ageTo, cat.ageOpenEnded) === age.id} className={cn(
                      "inline-flex min-h-11 items-center gap-1 rounded-lg border px-3 py-2 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      ageDivisionForRange(cat.ageFrom, cat.ageTo, cat.ageOpenEnded) === age.id
                        ? "border-2 border-primary bg-primary/10 font-bold" : "border-border bg-background hover:border-primary/60 hover:bg-secondary",
                    )} onClick={() => {
                      updateCat({ ageFrom: String(age.from), ageTo: age.to === undefined ? "" : String(age.to), ageOpenEnded: age.to === undefined, ageMode: "preset" });
                      finishGuidedStep("age");
                    }}>
                      {ageDivisionForRange(cat.ageFrom, cat.ageTo, cat.ageOpenEnded) === age.id && <Check aria-hidden="true" className="size-4 shrink-0" />}
                      {age.label} ({age.from}{age.to === undefined ? "+" : `-${age.to}`})
                    </button>
                  ))}
                </div>
                <button type="button" className="min-h-11 rounded-lg px-3 text-sm font-semibold text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => { setCat((current) => ({ ...current, ageMode: "custom" })); setCustomAgeDraft({ from: cat.ageFrom, to: cat.ageTo }); setCustomAgeError(null); }}>Personalizada</button>
                {cat.ageMode === "custom" && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input type="number" min="1" aria-label="Edad desde" placeholder="Desde" value={customAgeDraft.from}
                        onChange={(e) => { setCustomAgeDraft({ ...customAgeDraft, from: e.target.value }); setCustomAgeError(null); }} className="w-28 h-11 text-sm" />
                      <span className="text-sm text-muted-foreground">a</span>
                      <Input type="number" min="1" aria-label="Edad hasta" placeholder="Hasta" value={customAgeDraft.to}
                        onChange={(e) => { setCustomAgeDraft({ ...customAgeDraft, to: e.target.value }); setCustomAgeError(null); }} className="w-28 h-11 text-sm" />
                    </div>
                    {customAgeError && <p role="alert" className="text-sm text-destructive">{customAgeError}</p>}
                    <Button type="button" variant="outline" className="min-h-11" onClick={() => {
                      const error = validateCustomAge(customAgeDraft.from, customAgeDraft.to);
                      if (error) { setCustomAgeError(error); return; }
                      updateCat({ ageFrom: customAgeDraft.from, ageTo: customAgeDraft.to, ageOpenEnded: false, ageMode: "custom" });
                      finishGuidedStep("age");
                    }}>Aplicar edad</Button>
                  </div>
                )}
                <button type="button" aria-label="No especificar Edad" className="min-h-11 rounded-lg px-3 text-sm text-muted-foreground underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => skipGuidedStep("age")}>No especificar</button>
              </fieldset>
              )}
              {guided.active === "grade" && <div className="space-y-3">
                <ChipGroup
                  label="Sistema de grado"
                  options={["GUPS", "DAN"]}
                  value={cat.gradeSystem}
                  onChange={(value) => {
                    if (value === "DAN" || value === "GUPS") {
                      updateCat({ gradeSystem: value });
                      setDanDraft({ from: cat.beltFrom, to: cat.beltTo });
                      finishGuidedStep("grade", value);
                    }
                  }}
                />
                <button type="button" aria-label="No especificar Sistema de grado" className="min-h-11 rounded-lg px-3 text-sm text-muted-foreground underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => skipGuidedStep("grade")}>No especificar</button>
              </div>}
              {guided.active === "grade-range" && <div className="space-y-3">
                {cat.gradeSystem === "GUPS" && (
                  <ChipGroup
                    label="Rango GUP"
                    options={[...GUP_GRADE_OPTIONS]}
                    value={cat.gupBand}
                    onChange={(value) => { updateCat({ gupBand: value }); finishGuidedStep("grade-range"); }}
                  />
                )}
                {cat.gradeSystem === "DAN" && (
                  <fieldset className="min-w-0 space-y-2">
                    <legend className="text-sm font-semibold text-foreground">Grado (Dan)</legend>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="number"
                        aria-label="Grado Dan desde"
                        min="1"
                        step="1"
                        placeholder="Desde"
                        value={danDraft.from}
                        onChange={(e) => { setDanDraft({ ...danDraft, from: e.target.value }); setDanError(null); }}
                        className="w-28 h-11 text-sm"
                      />
                      <span className="text-sm text-muted-foreground">a</span>
                      <Input
                        type="number"
                        aria-label="Grado Dan hasta"
                        min="1"
                        step="1"
                        placeholder="Hasta"
                        value={danDraft.to}
                        onChange={(e) => { setDanDraft({ ...danDraft, to: e.target.value }); setDanError(null); }}
                        className="w-28 h-11 text-sm"
                      />
                    </div>
                    {danError && <p role="alert" className="text-sm text-destructive">{danError}</p>}
                    <Button type="button" variant="outline" className="min-h-11" onClick={() => {
                      const error = validateDanRange(danDraft.from, danDraft.to);
                      if (error) { setDanError(error); return; }
                      updateCat({ beltFrom: danDraft.from, beltTo: danDraft.to });
                      finishGuidedStep("grade-range");
                    }}>Aplicar rango Dan</Button>
                  </fieldset>
                )}
                <button type="button" aria-label="No especificar Sistema de grado" className="min-h-11 rounded-lg px-3 text-sm text-muted-foreground underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => skipGuidedStep("grade-range")}>Omitir sistema y rango de grado</button>
              </div>}
              {guided.active === "gender" && <div className="space-y-2">
                <ChipGroup label="Género" options={GENERO_OPTIONS} value={cat.gender}
                  onChange={(value) => { updateCat({ gender: value }); finishGuidedStep("gender"); }} />
                <button type="button" aria-label="No especificar Género" className="min-h-11 rounded-lg px-3 text-sm text-muted-foreground underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => skipGuidedStep("gender")}>No especificar</button>
              </div>}
              {guided.active === "discipline" && (
                <fieldset className="min-w-0 space-y-2">
                  <legend className="text-sm font-semibold text-foreground">Disciplina</legend>
                  <div className="flex flex-wrap gap-2">
                    {(["sparring", "tul"] as const).map((type) => (
                      <button key={type} type="button" aria-pressed={(config.matchType ?? "sparring") === type}
                        onClick={() => selectDiscipline(type)}
                        className={cn(
                          "inline-flex min-h-11 items-center gap-1 rounded-lg border px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                          (config.matchType ?? "sparring") === type
                            ? "border-2 border-primary bg-primary/10 font-bold" : "border-border bg-background hover:border-primary/60",
                        )}>
                        {(config.matchType ?? "sparring") === type && <Check aria-hidden="true" className="size-4" />}
                        {type === "sparring" ? "Sparring" : "Tul / Formas"}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              {guided.active === "weight" && (config.matchType ?? "sparring") === "sparring" && <div className="space-y-2">
                <ChipGroup label="Peso" options={PESO_OPTIONS} value={cat.weight}
                  onChange={(value) => { updateCat({ weight: value }); finishGuidedStep("weight"); }} />
                <button type="button" aria-label="No especificar Peso" className="min-h-11 rounded-lg px-3 text-sm text-muted-foreground underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => skipGuidedStep("weight")}>No especificar</button>
              </div>}
              {guided.active === "format" && (
                <fieldset className="min-w-0 space-y-2">
                  <legend className="text-sm font-semibold text-foreground">Formato</legend>
                  <div className="flex flex-wrap gap-2">
                    {availableCategoryFormats(config.matchType ?? "sparring").map((mode) => (
                      <button key={mode} type="button" aria-pressed={config.mode === mode}
                        onClick={() => selectFormat(mode)}
                        className={cn(
                          "inline-flex min-h-11 items-center gap-1 rounded-lg border px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                          config.mode === mode
                            ? "border-2 border-primary bg-primary/10 font-bold" : "border-border bg-background hover:border-primary/60",
                        )}>
                        {config.mode === mode && <Check aria-hidden="true" className="size-4" />}
                        {mode === "round-robin" ? "Round Robin" : "Eliminación"}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              {guided.active === null && !buildCategoryName(cat).trim() && (
                <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
                  <Label htmlFor="category-manual-name" className="text-sm font-semibold">Nombre de la categoría</Label>
                  <p id="category-manual-name-help" className="text-sm text-muted-foreground">
                    {config.categoryName.trim()
                      ? "Podés editar este nombre sin completar las divisiones opcionales."
                      : "Omitiste todas las divisiones. Poné un nombre para poder iniciar la categoría."}
                  </p>
                  <Input id="category-manual-name" aria-describedby="category-manual-name-help"
                    value={config.categoryName}
                    onChange={(event) => setConfig({ categoryName: event.target.value, nameGenerated: false })}
                    className="h-11 w-full text-sm" />
                </div>
              )}
              {guided.active === null && !config.nameGenerated && !!config.categoryName.trim() && (
                <div className="rounded-lg border border-border/60 p-2 space-y-2">
                  <p className="text-sm text-foreground">
                    {staleNamedWeight || tulNamedWeight
                      ? "El nombre original menciona el peso anterior; revisalo antes de continuar."
                      : "El nombre original se conserva aunque edites los datos estructurados."}
                  </p>
                  {!!(buildCategoryName(cat).trim() ||
                    ((staleNamedWeight || tulNamedWeight) && withoutNamedWeight(config.categoryName))) && (
                    <Button type="button" variant="outline" className="min-h-11 h-auto whitespace-normal text-left" onClick={() => setConfig({
                      categoryName: buildCategoryName(cat).trim() || withoutNamedWeight(config.categoryName),
                      nameGenerated: !!buildCategoryName(cat).trim(),
                    })}>Actualizar nombre con los datos seleccionados</Button>
                  )}
                </div>
              )}
              </fieldset>
              <fieldset className="min-w-0 space-y-4 rounded-xl border border-border bg-background p-3 sm:p-4">
                <legend className="px-1 text-base font-bold text-foreground">Combate y tiempos</legend>
              {guided.active === null && config.mode === "round-robin" && (groupDist?.length ?? 0) > 1 && !categoryIsActive && (
                <fieldset className="min-w-0 space-y-2">
                  <legend className="text-sm font-semibold text-foreground">Orden de combates</legend>
                  <div className="flex flex-wrap gap-2">
                    {([
                      ["rest-optimized", "Optimizar descanso (un tatami)"],
                      ["group-blocks", "Por llave (varios tatamis)"],
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        disabled={startPending}
                        aria-pressed={(config.rrOrderMode ?? "group-blocks") === value}
                        onClick={() => setConfig({ rrOrderMode: value })}
                        className={cn(
                          "min-h-11 rounded-lg border px-3 py-2 text-sm font-medium text-foreground",
                          (config.rrOrderMode ?? "group-blocks") === value
                            ? "border-2 border-primary bg-primary/10 font-bold"
                            : "border-border bg-background hover:border-primary/60 hover:bg-secondary",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              <div className="rounded-lg border border-border bg-secondary/20 p-3 space-y-1">
                <p className="text-sm font-semibold text-foreground">Tiempo y perfil activos</p>
                <p className="text-sm text-foreground leading-relaxed">
                  {_rc} round{_rc > 1 ? "s" : ""} × {_fmt(_rd)}
                  {_rest > 0 ? ` · Descanso: ${_fmt(_rest)}` : " · Sin descanso"}
                  {config.mode !== "round-robin" && (_fr !== _rc || _fs !== _rd) ? ` · Final: ${_fr} × ${_fmt(_fs)}` : ""}
                  {` · Desempate: ${_fmt(_tb)}`}
                  {_gp ? " · Golden Point" : ""}
                  {` · Perfil: ${config.profileId === "yusan-2026" ? (config.profileApplied ? "Yusan 2026 activo" : "Yusan 2026 seleccionado") : "Personalizado"}`}
                </p>
              </div>
              {guided.active === null && (
              <details className="rounded-lg border border-border p-3">
                <summary className="min-h-11 cursor-pointer rounded-lg py-2 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Opciones avanzadas: presets y Yusan</summary>
                <div className="space-y-4 pt-3">
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-semibold text-foreground">Preset</legend>
                    <div className="flex flex-wrap gap-2">
                      {serverPresets.map((p) => (
                        <button
                          key={p.id ?? p.name}
                          type="button"
                          aria-pressed={isPresetActive(p)}
                          onClick={() => applyPreset(p)}
                          className={cn(
                            "inline-flex min-h-11 items-center gap-1 rounded-lg border px-3 py-2 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            isPresetActive(p) ? "border-2 border-primary bg-primary/10 font-bold" : "border-border bg-background hover:bg-secondary",
                          )}
                        >
                          {isPresetActive(p) && <Check aria-hidden="true" className="size-4 shrink-0" />}
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  {config.profileId === "yusan-2026" && (
                    <div className="space-y-2">
                      <p className="text-sm font-semibold text-foreground">Perfil Yusan 2026 {config.profileApplied ? "activo" : "seleccionado"}</p>
                      {!config.profileApplied && (
                        <Button type="button" variant="outline" className="min-h-11 h-auto whitespace-normal" onClick={() => {
                          const patch = yusanConfigPatch(config, config, config.mode, BASE);
                          if (!patch) { toast.error("Elegí una edad y un sistema de grado antes de aplicar Yusan 2026."); return; }
                          setConfig(patch);
                        }}>Aplicar Yusan 2026 a esta categoría</Button>
                      )}
                    </div>
                  )}
                  {!config.profileId && (
                    <Button type="button" variant="outline" className="min-h-11 h-auto whitespace-normal" onClick={() => setConfig({
                      eventId: config.eventId ?? crypto.randomUUID(),
                      profileId: "yusan-2026",
                      profileApplied: false,
                    })}>Seleccionar perfil Yusan 2026 para este torneo</Button>
                  )}
                </div>
              </details>
              )}
              </fieldset>
              {guided.active === null && (
              <details className="min-w-0 rounded-xl border border-border bg-background p-3 sm:p-4">
                <summary className="min-h-11 cursor-pointer py-2 text-base font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Mesa (opcional)</summary>
              <fieldset className="min-w-0 space-y-2 rounded-xl border border-border bg-background p-3 sm:p-4">
                <legend className="px-1 text-base font-bold text-foreground">Mesa</legend>
                <label htmlFor="category-table-chief" className="block text-sm font-semibold text-foreground">Jefe de mesa</label>
                <span className="text-sm text-muted-foreground">Opcional</span>
                <Input
                  id="category-table-chief"
                  placeholder="Nombre del jefe de mesa"
                  value={config.tableChief ?? ""}
                  onChange={(e) => setConfig({ tableChief: e.target.value })}
                  className="w-full h-11 text-sm"
                />
              </fieldset>
              </details>
              )}
            </div>
            {guided.active === null && (
            <Button type="button" size="lg" className="min-h-11 w-full sm:w-auto" onClick={() => {
              setCatExpanded(false);
              nameRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
              nameRef.current?.focus();
            }}>
              Continuar con competidores <ArrowRight aria-hidden="true" className="size-4" />
            </Button>
            )}
          </div>
        )}
      </div>

      {/* ── Import panel (aparece después de importar un archivo) ── */}
      {importPanelOpen && importCategories.length > 0 && (
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-sm flex items-center gap-2">
              <FileSpreadsheet className="size-4 text-primary" />
              Planilla importada
              <Badge variant="secondary" className="ml-0.5">{importCategories.length} categorías</Badge>
              <button
                type="button"
                onClick={() => setImportPanelOpen(false)}
                className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              >
                <X className="size-3.5" />
              </button>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <ImportPanel categories={importCategories} onSelect={handleImportCategory} />
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card id="tour-competitor-card">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              Lista
              <Badge variant="secondary">{competitors.length}</Badge>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={importLoading}
                className="ml-auto flex min-h-11 items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
              >
                <FileSpreadsheet className="size-3.5" />
                {importLoading ? "Cargando..." : "Importar Excel"}
              </button>
              {competitors.length > 0 && (
                <button
                  type="button"
                  onClick={() => setClearConfirmOpen(true)}
                  className="flex min-h-11 items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 py-1 text-sm font-medium text-destructive/80 transition-colors hover:bg-destructive/10 hover:text-destructive"
                  title="Vaciar lista de competidores (para cargar otra categoría)"
                >
                  <Trash2 className="size-3.5" />
                  Vaciar lista
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.txt"
                className="hidden"
                onChange={handleFileChange}
              />
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                ref={nameRef}
                placeholder="Nombre del competidor"
                aria-label="Nombre del competidor"
                value={quickName}
                onChange={(e) => setQuickName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleQuickAdd(); }}
                className="h-12 min-w-0 flex-1 text-base md:text-base"
              />
              <Input
                placeholder="Club (opcional)"
                aria-label="Club (opcional)"
                value={quickTeam}
                onChange={(e) => setQuickTeam(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleQuickAdd(); }}
                className="h-12 w-full text-base md:text-base sm:w-40"
              />
              <Button
                size="icon"
                onClick={handleQuickAdd}
                disabled={!quickName.trim()}
                title="Agregar (Enter)"
                aria-label="Agregar competidor"
                className="h-12 w-full shrink-0 sm:w-12"
              >
                <Plus className="size-5" />
              </Button>
            </div>

            {primaryAction.kind === "start" && (
              <div className="flex flex-col items-start gap-1.5">
                <Button
                  id="tour-start-btn"
                  data-testid="category-primary-action"
                  type="button"
                  size="xl"
                  className="w-full sm:w-auto"
                  disabled={primaryAction.disabled || interactionBlocked || startPending}
                  aria-describedby={primaryAction.reason ? "category-start-reason" : undefined}
                  onClick={() => { void handleStart(); }}
                >
                  <Swords className="size-5" />{primaryAction.label}
                </Button>
                {primaryAction.reason && (
                  <p id="category-start-reason" className="text-sm text-muted-foreground" role="status">
                    {primaryAction.reason}
                  </p>
                )}
              </div>
            )}

            {competitors.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
                <AlertCircle className="size-6 opacity-30" />
                <p className="text-sm">Escribe un nombre y presiona Enter</p>
              </div>
            ) : (
              <div data-testid="setup-competitor-list"
                className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
                {competitors.map((c, i) => (
                  <div
                    key={c.id}
                    className="group flex min-h-14 items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-secondary/50"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-bold text-muted-foreground">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="block break-words text-lg font-semibold leading-snug">{c.name}</span>
                      {c.team && <span className="block break-words text-sm text-muted-foreground">{c.team}</span>}
                    </div>
                    <div className="flex shrink-0 gap-0.5">
                      <button
                        type="button"
                        onClick={() => openEdit(c)}
                        aria-label={`Editar a ${c.name}`}
                        className="flex size-11 items-center justify-center rounded text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeCompetitor(c.id)}
                        aria-label={`Eliminar a ${c.name}`}
                        className="flex size-11 items-center justify-center rounded text-destructive hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="setup-fixture-preview">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {categoryIsActive ? (config.mode === "elimination" ? "Llave guardada" : "Fixture guardado") : (config.mode === "elimination" ? "Llave (preview)" : "Fixture (preview)")}
              {previewFights.length > 0 && (
                <Badge variant="secondary" className="text-sm">
                  {previewFights.length} {previewFights.length === 1 ? "combate" : "combates"}
                </Badge>
              )}
              {config.mode === "round-robin" && groupDist && (
                <Badge variant="outline" className="text-xs">
                  {groupDist.length} {groupDist.length === 1 ? "llave" : "llaves"}: {groupDist.join("+")}
                </Badge>
              )}
              {config.mode === "round-robin" && !groupDist && competitors.length > 0 && (
                <Badge variant="outline" className="border-orange-600 text-orange-400 text-xs">
                  {competitors.length < 3 ? "Mín. 3" : "Máx. 12"} competidores
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {categoryIsActive && <p className="mb-3 text-sm text-muted-foreground">
              {completedPreviewCount} de {previewFights.length} combates completados
            </p>}
            <FixturePreview
              fights={previewFights}
              mode={config.mode}
              roundLabels={roundLabels}
            />
          </CardContent>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar competidor</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Nombre *</Label>
              <Input
                id="edit-name"
                value={form.name}
                onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); setFormError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-team">Equipo / Club</Label>
              <Input
                id="edit-team"
                placeholder="Opcional"
                value={form.team}
                onChange={(e) => setForm((f) => ({ ...f, team: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-weight">Peso (kg)</Label>
              <Input
                id="edit-weight"
                type="number"
                placeholder="Opcional"
                value={form.weight}
                onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))}
              />
            </div>
            {formError && (
              <p className="text-destructive text-sm flex items-center gap-1.5">
                <AlertCircle className="size-3.5" /> {formError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={handleSave}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Diálogo de confirmación: vaciar lista de competidores */}
      <Dialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="size-5 text-destructive" />
              Vaciar lista de competidores
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <p className="text-sm">
              Se eliminarán los <strong>{competitors.length}</strong> competidores cargados para que puedas armar una nueva categoría.
            </p>
            <p className="text-xs text-amber-400/80">
              ⚠ Los combates y resultados ya jugados se mantienen en Resultados. Esta acción solo limpia la lista de competidores actual.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setClearConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const n = competitors.length;
                clearCompetitors();
                setClearConfirmOpen(false);
                toast.success(`Lista vaciada — ${n} competidor${n !== 1 ? "es" : ""} eliminados`);
              }}
            >
              <Trash2 className="size-4 mr-1" />
              Vaciar lista
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

