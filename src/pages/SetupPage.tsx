import { useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useSocket } from "@/hooks/useSocket";
import { useTournamentStore, type CompetitorEntry, type TournamentMode } from "@/store/tournament";
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
import { Pencil, Trash2, Swords, AlertCircle, Plus, Wifi, Smartphone, Zap, ArrowRight, Trophy, FileSpreadsheet, X, ChevronDown } from "lucide-react";
import { generateGroupsTournament, generateEliminationBracket, getGroupDistribution } from "@/lib/bracket";
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

function computePreview(
  competitors: CompetitorEntry[],
  mode: string,
): PreviewFight[] {
  if (competitors.length < 2) return [];
  if (mode === "elimination") {
    return generateEliminationBracket(competitors).matches
      .filter((m) => m.red.competitor && m.blue.competitor)
      .map((m, i) => ({
        id: m.id,
        n: i + 1,
        // biome-ignore lint/style/noNonNullAssertion: filter above guarantees competitor is not null
        red: m.red.competitor!.name,
        // biome-ignore lint/style/noNonNullAssertion: filter above guarantees competitor is not null
        blue: m.blue.competitor!.name,
        round: m.round,
      }));
  }
  if (competitors.length < 3 || competitors.length > 12) return [];
  const { fights } = generateGroupsTournament(competitors);
  return fights.map((f, i) => ({
    id: f.id, n: i + 1, red: f.red.name, blue: f.blue.name, round: 0,
    group: f.groupId ?? "G1",
  }));
}

function FightRow({ fight, showNumber }: Readonly<{ fight: PreviewFight; showNumber: boolean }>) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm">
      {showNumber && (
        <span className="text-muted-foreground text-xs w-5 text-right shrink-0">{fight.n}.</span>
      )}
      <span className="font-medium text-red-400 flex-1 truncate text-right">{fight.red}</span>
      <span className="text-muted-foreground text-xs shrink-0">vs</span>
      <span className="font-medium text-blue-400 flex-1 truncate">{fight.blue}</span>
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
        <p className="text-xs">Aparece al agregar competidores</p>
      </div>
    );
  }
  if (mode === "elimination") {
    const rounds = Array.from(new Set(fights.map((f) => f.round)));
    return (
      <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
        {rounds.map((round) => (
          <div key={round}>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
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
  // Round-robin: group by llave
  const groups = Array.from(new Set(fights.map((f) => f.group ?? "G1")));
  return (
    <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
      {groups.map((gid) => {
        const gFights = fights.filter((f) => (f.group ?? "G1") === gid);
        return (
          <div key={gid}>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
              Llave {gid}
            </p>
            <div className="space-y-1">
              {gFights.map((f) => <FightRow key={f.id} fight={f} showNumber />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const PESO_OPTIONS = ["Liviano A", "Liviano B", "Mediano A", "Mediano B", "Pesado A", "Pesado B", "Pesado C"];
const GENERO_OPTIONS = ["Masculino", "Femenino", "Mixto"];

type CatState = { weight: string; gradeSystem: GradeSystem | ""; beltFrom: string; beltTo: string; gupBand: string; gender: string; ageFrom: string; ageTo: string; ageOpenEnded: boolean; ageMode: "preset" | "custom" };
const EMPTY_CAT: CatState = { weight: "", gradeSystem: "", beltFrom: "", beltTo: "", gupBand: "", gender: "", ageFrom: "", ageTo: "", ageOpenEnded: false, ageMode: "custom" };
function ChipGroup({ label, options, value, onChange }: Readonly<{
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}>) {
  return (
    <div className="space-y-2">
      <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">{label}</span>
      <div className="flex flex-wrap gap-2 items-center">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(value === opt ? "" : opt)}
            aria-pressed={value === opt}
            className={cn(
              "rounded-full border font-medium transition-all duration-150",
              value === opt
                ? "px-5 py-2 text-sm font-bold border-2 border-primary bg-primary/10 text-primary ring-2 ring-primary/20 shadow-sm"
                : "px-3 py-1.5 text-xs border border-border/50 text-muted-foreground/60 hover:border-border hover:text-muted-foreground hover:bg-secondary",
            )}
          >
            {opt === "DAN" ? "DANES" : opt}
          </button>
        ))}
      </div>
    </div>
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
    setFights,
    setPhase,
    setBracket,
    addImportedFights,
    completeFight,
    setGroups,
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
      setFights: s.setFights,
      setPhase: s.setPhase,
      setBracket: s.setBracket,
      addImportedFights: s.addImportedFights,
      completeFight: s.completeFight,
      setGroups: s.setGroups,
      setupStarted: s.setupStarted,
      setSetupStarted: s.setSetupStarted,
      startNewTournament: s.startNewTournament,
    }))
  );
  const navigate = useNavigate();
  const { socket, connected, stateReady, state: serverState, request } = useSocket();
  const interactionBlocked = useCategoryInteractionBlocked();
  const snapshot = { phase, config, competitors, fights, bracketMatches, setupStarted,
    groups: useTournamentStore((state) => state.groups),
    currentFightIndex: useTournamentStore((state) => state.currentFightIndex),
    bracketSeeds: useTournamentStore((state) => state.bracketSeeds) };
  const lifecycleContext = { snapshot, connected, stateReady, serverState: serverState ?? {} };
  const primaryAction = useCategoryPrimaryAction(lifecycleContext, request);
  const categoryIsActive = isCategoryInitialized(snapshot);
  const [cat, setCat] = useState<CatState>(EMPTY_CAT);
  useEffect(() => {
    const age = AGE_DIVISIONS.find((division) => division.id === config.ageDivision);
    setCat({
      ...EMPTY_CAT,
      weight: config.weightLabel ?? "",
      gradeSystem: config.gradeSystem ?? "",
      beltFrom: config.danFrom === undefined ? "" : String(config.danFrom),
      beltTo: config.danTo === undefined ? "" : String(config.danTo),
      gupBand: config.gupBand ?? "",
      gender: config.sexDivision ?? "",
      ageFrom: config.categoryAgeFrom ?? (age ? String(age.from) : ""),
      ageTo: config.categoryAgeTo ?? (age?.to === undefined ? "" : String(age.to)),
      ageOpenEnded: config.categoryAgeOpenEnded ?? (!!age && age.to === undefined),
      ageMode: age ? "preset" : "custom",
    });
  }, [config.id]);
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
  }, [socket, addImportedFights, navigate, config.id]);

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
  const [catExpanded, setCatExpanded] = useState(config.categoryName === "");

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
    if (primaryAction.kind !== "start" || primaryAction.disabled || interactionBlocked) return;
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
    const preparingOtherCategory = Boolean(lock);
    if (config.mode === "elimination") {
      const { matches, seeds } = generateEliminationBracket(competitors);
      setBracket(matches, seeds); setFights([]); setGroups([]);
    } else {
      const generated = generateGroupsTournament(competitors);
      if (!preparingOtherCategory) {
        try {
          const response = await fetch("/api/ring/sync-fights", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ competitors, fights: generated.fights.map((fight) => ({
              id: fight.id, red_id: fight.red.id, blue_id: fight.blue.id, group_id: fight.groupId,
            })), categoryId: config.id, categoryName: config.categoryName, tournamentName: config.tournamentName }),
          });
          if (!response.ok) throw new Error("El servidor rechazó la preparación de peleas.");
        } catch (error) { toast.error(error instanceof Error ? error.message : "No se pudo sincronizar."); return; }
      }
      setGroups(generated.groups); setFights(generated.fights);
    }
    setPhase("fighting");
    navigate(config.mode === "elimination" ? "/bracket" : "/standings");
  }
  const previewFights: PreviewFight[] = categoryIsActive
    ? config.mode === "elimination"
      ? bracketMatches.map((match, index) => ({ id: match.id, n: index + 1,
          red: match.red.competitor?.name ?? "Por definir", blue: match.blue.competitor?.name ?? "Por definir", round: match.round }))
      : fights.map((fight, index) => ({ id: fight.id, n: index + 1, red: fight.red.name,
          blue: fight.blue.name, round: 0, group: fight.groupId ?? "G1" }))
    : computePreview(competitors, config.mode);
  const roundLabels = buildRoundLabels(previewFights);
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
    <div className="flex-1 overflow-auto p-4 space-y-4">
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
                onClick={() => setCatExpanded((v) => !v)}
                className={cn(
                  "rounded-lg px-4 py-2 text-sm font-semibold border transition-colors flex items-center gap-2",
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
            <Button id="tour-start-btn" data-testid="category-primary-action"
              disabled={primaryAction.disabled || interactionBlocked} size="xl"
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
            {categoryIsActive && <Button variant="outline" size="sm" onClick={() => navigate(config.mode === "elimination" ? "/bracket" : "/standings")}>
              {config.mode === "elimination" ? "Ver llave" : "Ver clasificación"}
            </Button>}
            {categoryIsActive && <CategoryRestartButton {...lifecycleContext} />}
            <CategoryDeleteButton {...lifecycleContext} />
          </div>
        </div>

        {/* Inline chip editor — abre al hacer click en el nombre de categoría */}
        {catExpanded && (
          <div className="rounded-xl border border-border/40 bg-secondary/20 px-4 py-4 space-y-4">

            {/* Presets rápidos */}
            <div className="space-y-2">
              <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">⚡ Preset</span>
              <div className="flex gap-2 flex-wrap">
                {serverPresets.map((p) => (
                  <button
                    key={p.id ?? p.name}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors",
                      isPresetActive(p)
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/50 bg-background/50 text-muted-foreground hover:bg-secondary hover:text-foreground"
                    )}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
            {config.profileId === "yusan-2026" && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                <p className="text-sm font-semibold">Perfil Yusan 2026 {config.profileApplied ? "activo" : "seleccionado"}</p>
                {!config.profileApplied && (
                  <Button type="button" size="sm" variant="outline" onClick={() => {
                    const patch = yusanConfigPatch(config, config, config.mode, BASE);
                    if (!patch) { toast.error("Elegí una edad y un sistema de grado antes de aplicar Yusan 2026."); return; }
                    setConfig(patch);
                  }}>Aplicar Yusan 2026 a esta categoría</Button>
                )}
              </div>
            )}
            {!config.profileId && (
              <Button type="button" size="sm" variant="outline" onClick={() => setConfig({
                eventId: config.eventId ?? crypto.randomUUID(),
                profileId: "yusan-2026",
                profileApplied: false,
              })}>Seleccionar perfil Yusan 2026 para este torneo</Button>
            )}

            {/* Resumen de la config activa */}
            <p className="text-xs text-muted-foreground/70 leading-relaxed">
              {_rc} round{_rc > 1 ? "s" : ""} × {_fmt(_rd)}
              {_rest > 0 ? ` · Descanso: ${_fmt(_rest)}` : " · Sin descanso"}
              {config.mode !== "round-robin" && (_fr !== _rc || _fs !== _rd) ? ` · Final: ${_fr} × ${_fmt(_fs)}` : ""}
              {` · Desempate: ${_fmt(_tb)}`}
              {_gp ? " · Golden Point" : ""}
            </p>

            <div className="space-y-5">
              <div className="space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">Edad</span>
                <div className="flex flex-wrap gap-1.5">
                  {AGE_DIVISIONS.map((age) => (
                    <button key={age.id} type="button" aria-pressed={ageDivisionForRange(cat.ageFrom, cat.ageTo, cat.ageOpenEnded) === age.id} className={cn(
                      "rounded-full border px-2.5 py-1 text-xs",
                      ageDivisionForRange(cat.ageFrom, cat.ageTo, cat.ageOpenEnded) === age.id
                        ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground",
                    )} onClick={() => updateCat({ ageFrom: String(age.from), ageTo: age.to === undefined ? "" : String(age.to), ageOpenEnded: age.to === undefined, ageMode: "preset" })}>
                      {age.label} ({age.from}{age.to === undefined ? "+" : `-${age.to}`})
                    </button>
                  ))}
                </div>
                {cat.ageMode === "preset" ? (
                  <div className="flex h-9 items-center gap-2">
                    <span className="text-sm font-medium">{formatCategoryAge(cat)}</span>
                    <button type="button" className="text-xs text-primary underline-offset-4 hover:underline" onClick={() => updateCat({ ageMode: "custom" })}>Personalizada</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <Input type="number" aria-label="Edad desde" placeholder="Desde" value={cat.ageFrom} onChange={(e) => updateCat({ ageFrom: e.target.value, ageOpenEnded: false })} className="w-24 h-9 text-sm" />
                    <span className="text-xs text-muted-foreground/50">?</span>
                    <Input type="number" aria-label="Edad hasta" placeholder="Hasta" value={cat.ageTo} onChange={(e) => updateCat({ ageTo: e.target.value, ageOpenEnded: false })} className="w-24 h-9 text-sm" />
                  </div>
                )}
              </div>
              <div className="space-y-3">
                <ChipGroup
                  label="Sistema de grado"
                  options={["GUPS", "DAN"]}
                  value={cat.gradeSystem}
                  onChange={(value) => {
                    if (value === "DAN" || value === "GUPS") updateCat({ gradeSystem: value });
                  }}
                />
                {cat.gradeSystem === "GUPS" && (
                  <ChipGroup
                    label="Rango GUP"
                    options={[...GUP_GRADE_OPTIONS]}
                    value={cat.gupBand}
                    onChange={(value) => updateCat({ gupBand: value })}
                  />
                )}
                {cat.gradeSystem === "DAN" && (
                  <div className="space-y-2">
                    <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">Grado (Dan)</span>
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        aria-label="Grado Dan desde"
                        min="1"
                        step="1"
                        placeholder="Desde"
                        value={cat.beltFrom}
                        onChange={(e) => updateCat({ beltFrom: e.target.value })}
                        className="w-24 h-9 text-sm"
                      />
                      <span className="text-xs text-muted-foreground/50">—</span>
                      <Input
                        type="number"
                        aria-label="Grado Dan hasta"
                        min="1"
                        step="1"
                        placeholder="Hasta"
                        value={cat.beltTo}
                        onChange={(e) => updateCat({ beltTo: e.target.value })}
                        className="w-24 h-9 text-sm"
                      />
                    </div>
                    {cat.beltFrom || cat.beltTo ? (
                      <p className="text-xs text-destructive">{validateDanRange(cat.beltFrom, cat.beltTo)}</p>
                    ) : null}
                  </div>
                )}
              </div>
              <ChipGroup label="Género" options={GENERO_OPTIONS} value={cat.gender} onChange={(v) => updateCat({ gender: v })} />
              <ChipGroup label="Peso" options={PESO_OPTIONS} value={cat.weight} onChange={(v) => updateCat({ weight: v })} />
              {!config.nameGenerated && !!config.categoryName.trim() && (
                <div className="rounded-lg border border-border/60 p-2 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    El nombre original se conserva aunque edites los datos estructurados.
                  </p>
                  <Button type="button" size="sm" variant="outline" onClick={() => setConfig({
                    categoryName: buildCategoryName(cat),
                    nameGenerated: true,
                  })}>Reemplazar nombre con los datos seleccionados</Button>
                </div>
              )}
              <div className="space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">Disciplina</span>
                <div className="flex gap-2">
                  {(["sparring", "tul"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={(config.matchType ?? "sparring") === t}
                      onClick={() => {
                        // Defaults por disciplina: tul → eliminación; sparring → round-robin
                        const mode = defaultCategoryFormat(t);
                        const timing = config.profileId === "yusan-2026" && config.profileApplied
                          ? yusanConfigPatch(config, config, mode, BASE) : null;
                        setConfig({ ...(timing ?? {}), matchType: t, mode });
                      }}
                      className={cn(
                        "rounded-full border font-medium transition-all duration-150",
                        (config.matchType ?? "sparring") === t
                          ? "px-5 py-2 text-sm font-bold border-2 border-primary bg-primary/10 text-primary ring-2 ring-primary/20 shadow-sm"
                          : "px-3 py-1.5 text-xs border border-border/50 text-muted-foreground/60 hover:border-border hover:text-muted-foreground hover:bg-secondary",
                      )}
                    >
                      {t === "sparring" ? "Sparring" : "Tul / Formas"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">Formato</span>
                <div className="flex gap-2">
                  {availableCategoryFormats(config.matchType ?? "sparring").map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={config.mode === m}
                      onClick={() => {
                        if (!isCategoryFormatAllowed(config.matchType ?? "sparring", m)) return;
                        if (config.profileId === "yusan-2026" && config.profileApplied) {
                          const patch = yusanConfigPatch(config, config, m, BASE);
                          setConfig(patch ?? { mode: m });
                          return;
                        }
                        if (m === "round-robin") {
                          const rules = config.ruleSet?.mode === "sparring"
                            ? (config.ruleSet as RuleSetSparring)
                            : BASE;
                          const judges = config.judgesCount ?? BASE.judgesCount;
                          setConfig({
                            mode: m,
                            ruleSet: {
                              ...BASE,
                              ...rules,
                              judgesCount: judges,
                              rounds: {
                                ...rules.rounds,
                                count: 1,
                                duration_seconds: 60,
                              },
                            },
                          });
                          return;
                        }
                        setConfig({ mode: m });
                      }}
                      className={cn(
                        "rounded-full border font-medium transition-all duration-150",
                        config.mode === m
                          ? "px-5 py-2 text-sm font-bold border-2 border-primary bg-primary/10 text-primary ring-2 ring-primary/20 shadow-sm"
                          : "px-3 py-1.5 text-xs border border-border/50 text-muted-foreground/60 hover:border-border hover:text-muted-foreground hover:bg-secondary",
                      )}
                    >
                      {m === "round-robin" ? "Round Robin" : "Eliminación"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 items-end">
              <div className="space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">Jefe de mesa</span>
                <Input
                  placeholder="Nombre del jefe de mesa"
                  value={config.tableChief ?? ""}
                  onChange={(e) => setConfig({ tableChief: e.target.value })}
                  className="w-52 h-9 text-sm"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => setCatExpanded(false)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
            >
              Listo
            </button>
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card id="tour-competitor-card">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm flex items-center gap-2">
              Lista
              <Badge variant="secondary">{competitors.length}</Badge>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={importLoading}
                className="ml-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border border-border/60 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-50"
              >
                <FileSpreadsheet className="size-3.5" />
                {importLoading ? "Cargando..." : "Importar Excel"}
              </button>
              {competitors.length > 0 && (
                <button
                  type="button"
                  onClick={() => setClearConfirmOpen(true)}
                  className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border border-destructive/40 text-destructive/80 hover:bg-destructive/10 hover:text-destructive transition-colors"
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
            <div className="flex gap-2">
              <Input
                ref={nameRef}
                placeholder="Nombre del competidor"
                value={quickName}
                onChange={(e) => setQuickName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleQuickAdd(); }}
                className="flex-1"
                autoFocus
              />
              <Input
                placeholder="Club (opcional)"
                value={quickTeam}
                onChange={(e) => setQuickTeam(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleQuickAdd(); }}
                className="w-36"
              />
              <Button
                size="icon"
                onClick={handleQuickAdd}
                disabled={!quickName.trim()}
                title="Agregar (Enter)"
              >
                <Plus className="size-4" />
              </Button>
            </div>

            {competitors.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
                <AlertCircle className="size-6 opacity-30" />
                <p className="text-xs">Escribe un nombre y presiona Enter</p>
              </div>
            ) : (
              <div className="space-y-0.5 max-h-80 overflow-y-auto pr-1">
                {competitors.map((c, i) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-2.5 hover:bg-secondary/50 group"
                  >
                    <span className="size-6 shrink-0 rounded-full bg-secondary text-[11px] font-bold text-muted-foreground flex items-center justify-center">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-sm truncate block">{c.name}</span>
                      {c.team && <span className="text-xs text-muted-foreground truncate block">{c.team}</span>}
                    </div>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => openEdit(c)}
                        className="p-1 rounded hover:bg-secondary text-muted-foreground"
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeCompetitor(c.id)}
                        className="p-1 rounded hover:bg-secondary text-destructive"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm flex items-center gap-2">
              {categoryIsActive ? (config.mode === "elimination" ? "Llave guardada" : "Fixture guardado") : (config.mode === "elimination" ? "Llave (preview)" : "Fixture (preview)")}
              {previewFights.length > 0 && (
                <Badge variant="secondary">{previewFights.length} combates</Badge>
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
            {categoryIsActive && <p className="text-xs text-muted-foreground">{fights.filter((fight) => fight.completed).length} de {fights.length} combates completados</p>}
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

