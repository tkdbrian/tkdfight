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
import itfRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import type { RuleSetSparring } from "@/engine/types";
import { COPA_DANES_26, fetchPresets, type TimePreset } from "@/lib/tournament-presets";

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
            categories.push({ name: catName, competitors });
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

const PESO_OPTIONS = ["Liviano A", "Liviano B", "Mediano A", "Mediano B", "Pesado A", "Pesado B"];
const GENERO_OPTIONS = ["M", "F"];

type CatState = { weight: string; beltFrom: string; beltTo: string; gender: string; ageFrom: string; ageTo: string };
const EMPTY_CAT: CatState = { weight: "", beltFrom: "", beltTo: "", gender: "", ageFrom: "", ageTo: "" };

function buildCategoryName(c: CatState): string {
  const parts: string[] = [];
  if (c.weight) parts.push(c.weight);
  if (c.beltFrom || c.beltTo) parts.push(`${c.beltFrom || "?"}-${c.beltTo || "?"} Dan`);
  if (c.gender) parts.push(c.gender);
  if (c.ageFrom || c.ageTo) parts.push(`${c.ageFrom || "?"}-${c.ageTo || "?"} a\u00f1os`);
  return parts.join(" \u00b7 ");
}

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
            className={cn(
              "rounded-full border font-medium transition-all duration-150",
              value === opt
                ? "px-5 py-2 text-sm font-bold border-2 border-primary bg-primary/10 text-primary ring-2 ring-primary/20 shadow-sm"
                : "px-3 py-1.5 text-xs border border-border/50 text-muted-foreground/60 hover:border-border hover:text-muted-foreground hover:bg-secondary",
            )}
          >
            {opt}
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
  } = useTournamentStore(
    useShallow((s) => ({
      competitors: s.competitors,
      config: s.config,
      fights: s.fights,
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
    }))
  );
  const navigate = useNavigate();
  const { socket } = useSocket();
  const [cat, setCat] = useState<CatState>(EMPTY_CAT);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const showWelcome = competitors.length === 0 && !setupStarted && !welcomeDismissed;

  // Confirmación de 2 pasos para no borrar categoría activa por accidente
  // 0 = normal, 1 = primer aviso, 2 = segundo aviso (último paso antes de ejecutar)
  const [confirmStart, setConfirmStart] = useState(0);
  const categoryIsActive = phase === "fighting" && fights.length > 0;

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
    function onFightsImported(payload: { fights: Array<{ id: string; red: { id: string; name: string }; blue: { id: string; name: string }; completed: boolean; groupId?: string }>; sourceRingLabel?: string | null }) {
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
      navigate("/fight");
    }
    socket.on("fights:imported", onFightsImported);
    return () => { socket.off("fights:imported", onFightsImported); };
  }, [socket, addImportedFights, navigate]);

  // Cuando el tatami destino termina una pelea reasignada, recibir el resultado.
  useEffect(() => {
    if (!socket) return;
    function onRemoteCompleted(payload: {
      fightId: string;
      winner: string;
      flagsRed: number;
      flagsBlue: number;
      completedIn: string;
    }) {
      completeFight(
        payload.fightId,
        payload.winner as "red" | "blue" | "draw",
        `Jugada en ${payload.completedIn}`,
        payload.flagsRed,
        payload.flagsBlue,
      );
    }
    socket.on("fight:remote-completed", onRemoteCompleted);
    return () => { socket.off("fight:remote-completed", onRemoteCompleted); };
  }, [socket, completeFight]);

  function updateCat(patch: Partial<CatState>) {
    const next = { ...cat, ...patch };
    setCat(next);
    setConfig({ categoryName: buildCategoryName(next) });
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
    updateCat({ weight: "Mediano A", beltFrom: "1", beltTo: "3", gender: "M" });
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
    if (draftTournamentName.trim()) {
      setConfig({ tournamentName: draftTournamentName.trim() });
    }
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

  function applyPreset(p: TimePreset) {
    const rules = config.ruleSet?.mode === "sparring" ? (config.ruleSet as RuleSetSparring) : BASE;
    const judges = config.judgesCount ?? BASE.judgesCount;
    const updated: RuleSetSparring = {
      ...BASE,
      ...rules,
      judgesCount: judges,
      rounds: { ...rules.rounds, count: p.roundCount, duration_seconds: p.durationSeconds },
    };
    setConfig({
      ruleSet: updated,
      judgesCount: updated.judgesCount,
      finalRounds: p.finalRounds,
      finalSeconds: p.finalSeconds,
      tiebreakerSeconds: p.tiebreakerSeconds,
      maxTiebreakers: p.maxTiebreakers,
    });
  }

  function isPresetActive(p: TimePreset): boolean {
    const rules = config.ruleSet?.mode === "sparring" ? (config.ruleSet as RuleSetSparring) : BASE;
    return (
      rules.rounds.count === p.roundCount &&
      rules.rounds.duration_seconds === p.durationSeconds &&
      config.finalRounds === p.finalRounds &&
      config.finalSeconds === p.finalSeconds &&
      config.tiebreakerSeconds === p.tiebreakerSeconds &&
      config.maxTiebreakers === p.maxTiebreakers
    );
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
    setConfig({ categoryName: cat.name });
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

  async function handleStart() {
    if (config.mode === "elimination") {
      const { matches, seeds } = generateEliminationBracket(competitors);
      setBracket(matches, seeds);
      setFights([]);
      setGroups([]);
    } else {
      const { groups, fights } = generateGroupsTournament(competitors);
      setGroups(groups);
      setFights(fights);
      // Populate server queue so Mesa Central can see and reassign fights
      try {
        await fetch("/api/ring/import-fights", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            competitors: competitors.map((c) => ({
              id: c.id,
              name: c.name,
              team: c.team,
              weight: c.weight,
            })),
            fights: fights.map((f) => ({
              id: f.id,
              red_id: f.red.id,
              blue_id: f.blue.id,
              group_id: f.groupId,
            })),
            categoryName: config.categoryName,
            newCategory: true,
          }),
        });
      } catch {
        // Non-critical — Mesa Central queue won't show but fighting still works
      }
    }
    setPhase("fighting");
    navigate(config.mode === "elimination" ? "/bracket" : "/fight");
  }

  const previewFights = computePreview(competitors, config.mode);
  const roundLabels = buildRoundLabels(previewFights);
  const groupDist = config.mode === "round-robin" ? getGroupDistribution(competitors.length) : undefined;
  const canStart = config.mode === "elimination"
    ? competitors.length >= 2 && config.categoryName.trim() !== ""
    : competitors.length >= 3 && competitors.length <= 12 && config.categoryName.trim() !== "";

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

  let canStartHint = "Seleccioná la categoría primero";
  if (config.categoryName) {
    canStartHint = config.mode === "round-robin" && competitors.length < 3
      ? "Mínimo 3 competidores"
      : "Mínimo 2 competidores";
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {/* ── HEADER ─────────────────────────────────────────────── */}
      <div className="space-y-2">
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
            {/* Paso 0: botón normal */}
            {confirmStart === 0 && (
              <Button
                id="tour-start-btn"
                onClick={() => {
                  if (categoryIsActive) {
                    setConfirmStart(1);
                  } else {
                    void handleStart();
                  }
                }}
                disabled={!canStart}
                size="xl"
                className={cn(
                  "transition-all",
                  canStart
                    ? "bg-green-600 hover:bg-green-500 text-white border-green-600 shadow-lg shadow-green-900/40 ring-2 ring-green-600/25"
                    : "",
                )}
              >
                <Swords className="size-5" />
                Iniciar Categoría
              </Button>
            )}

            {/* Paso 1: primer aviso */}
            {confirmStart === 1 && (
              <div className="rounded-xl border border-amber-600/60 bg-amber-950/40 px-4 py-3 space-y-3 max-w-xs text-right">
                <div className="flex items-start gap-2 text-left">
                  <span className="text-amber-400 text-xl leading-none mt-0.5">⚠</span>
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-amber-300">Hay una categoría activa</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Se borrarán todas las peleas y resultados de <span className="font-semibold text-foreground">{config.categoryName || "la categoría actual"}</span>. Esta acción no se puede deshacer.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="outline" onClick={() => setConfirmStart(0)}>
                    Cancelar
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setConfirmStart(2)}>
                    Continuar igual
                  </Button>
                </div>
              </div>
            )}

            {/* Paso 2: confirmación final */}
            {confirmStart === 2 && (
              <div className="rounded-xl border border-destructive/70 bg-destructive/15 px-4 py-3 space-y-3 max-w-xs text-right">
                <div className="flex items-start gap-2 text-left">
                  <span className="text-destructive text-xl leading-none mt-0.5">🗑</span>
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-destructive">¿Confirmar borrado?</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Última oportunidad. Los <span className="font-semibold text-foreground">{fights.filter(f => f.completed).length} resultado{fights.filter(f => f.completed).length !== 1 ? "s" : ""}</span> cargados se perderán para siempre.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="outline" onClick={() => setConfirmStart(0)}>
                    Cancelar
                  </Button>
                  <Button size="sm" variant="destructive" className="font-bold" onClick={() => { setConfirmStart(0); void handleStart(); }}>
                    Sí, borrar y empezar
                  </Button>
                </div>
              </div>
            )}

            {canStart && confirmStart === 0 ? null : (!canStart && confirmStart === 0 ? <p className="text-xs text-muted-foreground/60">{canStartHint}</p> : null)}
          </div>
        </div>

        {/* Inline chip editor — abre al hacer click en el nombre de categoría */}
        {catExpanded && (
          <div className="rounded-xl border border-border/40 bg-secondary/20 px-4 py-4 space-y-4">

            {/* Presets rápidos */}
            <div className="space-y-2">
              <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">⚡ Preset</span>
              <div className="flex gap-2 flex-wrap">
                {[...COPA_DANES_26, ...serverPresets].map((p) => (
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

            {/* Resumen de la config activa */}
            <p className="text-xs text-muted-foreground/70 leading-relaxed">
              {_rc} round{_rc > 1 ? "s" : ""} × {_fmt(_rd)}
              {_rest > 0 ? ` · Descanso: ${_fmt(_rest)}` : " · Sin descanso"}
              {config.mode !== "round-robin" && (_fr !== _rc || _fs !== _rd) ? ` · Final: ${_fr} × ${_fmt(_fs)}` : ""}
              {` · Desempate: ${_fmt(_tb)}`}
              {_gp ? " · Golden Point" : ""}
            </p>

            <ChipGroup label="Peso" options={PESO_OPTIONS} value={cat.weight} onChange={(v) => updateCat({ weight: v })} />
            <div className="flex flex-wrap gap-4 items-end">
              <div className="space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">Grado (Dan)</span>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    placeholder="Desde"
                    value={cat.beltFrom}
                    onChange={(e) => updateCat({ beltFrom: e.target.value })}
                    className="w-24 h-9 text-sm"
                  />
                  <span className="text-xs text-muted-foreground/50">—</span>
                  <Input
                    type="number"
                    placeholder="Hasta"
                    value={cat.beltTo}
                    onChange={(e) => updateCat({ beltTo: e.target.value })}
                    className="w-24 h-9 text-sm"
                  />
                </div>
              </div>
              <ChipGroup label="Género" options={GENERO_OPTIONS} value={cat.gender} onChange={(v) => updateCat({ gender: v })} />
              <div className="space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">Edad</span>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    placeholder="Desde"
                    value={cat.ageFrom}
                    onChange={(e) => updateCat({ ageFrom: e.target.value })}
                    className="w-24 h-9 text-sm"
                  />
                  <span className="text-xs text-muted-foreground/50">—</span>
                  <Input
                    type="number"
                    placeholder="Hasta"
                    value={cat.ageTo}
                    onChange={(e) => updateCat({ ageTo: e.target.value })}
                    className="w-24 h-9 text-sm"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">Disciplina</span>
                <div className="flex gap-2">
                  {(["sparring", "tul"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        const updates: Partial<typeof config> = { matchType: t };
                        // Defaults por disciplina: tul → eliminación; sparring → round-robin
                        updates.mode = t === "tul" ? "elimination" : "round-robin";
                        setConfig(updates);
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
                  {(["round-robin", "elimination"] as TournamentMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setConfig({ mode: m })}
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
              {config.mode === "elimination" ? "Llave (preview)" : "Fixture (preview)"}
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