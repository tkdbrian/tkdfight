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
import { Pencil, Trash2, Swords, AlertCircle, Plus, Wifi, Smartphone, Zap, ArrowRight, Trophy } from "lucide-react";
import { generateGroupsTournament, generateEliminationBracket, getGroupDistribution } from "@/lib/bracket";
import { cn } from "@/lib/utils";

type FormData = { name: string; team: string; weight: string };
const EMPTY_FORM: FormData = { name: "", team: "", weight: "" };

type PreviewFight = { id: string; n: number; red: string; blue: string; round: number; group?: string };

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
const GRADO_OPTIONS = ["Blanco-P.Amarilla", "Amarillo-P.Azul", "Azul-P.Negra", "Danes"];
const GENERO_OPTIONS = ["M", "F"];

type CatState = { weight: string; belt: string; gender: string; ageFrom: string; ageTo: string };
const EMPTY_CAT: CatState = { weight: "", belt: "", gender: "", ageFrom: "", ageTo: "" };

function buildCategoryName(c: CatState): string {
  const parts: string[] = [];
  if (c.weight) parts.push(c.weight);
  if (c.belt) parts.push(c.belt);
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
    <div className="space-y-1">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(value === opt ? "" : opt)}
            className={cn(
              "px-4 py-2 rounded-full border text-sm font-medium transition-colors",
              value === opt
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-secondary",
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
    addCompetitor,
    removeCompetitor,
    updateCompetitor,
    setConfig,
    setFights,
    setPhase,
    setBracket,
    addImportedFights,
    completeFight,
    setGroups,
  } = useTournamentStore(
    useShallow((s) => ({
      competitors: s.competitors,
      config: s.config,
      addCompetitor: s.addCompetitor,
      removeCompetitor: s.removeCompetitor,
      updateCompetitor: s.updateCompetitor,
      setConfig: s.setConfig,
      setFights: s.setFights,
      setPhase: s.setPhase,
      setBracket: s.setBracket,
      addImportedFights: s.addImportedFights,
      completeFight: s.completeFight,
      setGroups: s.setGroups,
    }))
  );
  const navigate = useNavigate();
  const { socket } = useSocket();
  const [cat, setCat] = useState<CatState>(EMPTY_CAT);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const showWelcome = competitors.length === 0 && !welcomeDismissed;

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
    updateCat({ weight: "Mediano A", belt: "Danes", gender: "M" });
    DEMO_COMPETITORS.forEach((c) => { addCompetitor(c); });
  }

  const [quickName, setQuickName] = useState("");
  const [quickTeam, setQuickTeam] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [formError, setFormError] = useState("");

  function handleQuickAdd() {
    const name = quickName.trim();
    if (!name) return;
    addCompetitor({ name, team: quickTeam.trim() || undefined });
    setQuickName("");
    setQuickTeam("");
    nameRef.current?.focus();
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
  }

  const previewFights = computePreview(competitors, config.mode);
  const roundLabels = buildRoundLabels(previewFights);
  const groupDist = config.mode === "round-robin" ? getGroupDistribution(competitors.length) : undefined;
  const canStart = config.mode === "elimination"
    ? competitors.length >= 2 && config.categoryName.trim() !== ""
    : competitors.length >= 3 && competitors.length <= 12 && config.categoryName.trim() !== "";

  if (showWelcome) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8 gap-6 sm:gap-10 text-center overflow-auto">
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
          <Button size="lg" variant="outline" onClick={() => setWelcomeDismissed(true)} className="gap-2">
            Nuevo torneo
            <ArrowRight className="size-4" />
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Open source · github.com/tkdbrian/tkdfight
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Competidores</h1>
          <p className="text-muted-foreground text-sm">Completa la lista y lanza la categoría.</p>
          {config.categoryName && (
            <p className="text-sm font-semibold text-primary mt-1">{config.categoryName}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button onClick={() => void handleStart()} disabled={!canStart} size="xl">
            <Swords className="size-5" />
            Iniciar Categoría
          </Button>
          {!canStart && (
            <p className="text-xs text-muted-foreground">
              {!config.categoryName
                ? "Selecciona la categoría"
                : config.mode === "round-robin" && competitors.length < 3
                ? "Mínimo 3 competidores"
                : "Mínimo 2 competidores"}
            </p>
          )}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3 pt-5 px-3 sm:px-5">
          <CardTitle className="text-sm">Definir categoría</CardTitle>
        </CardHeader>
        <CardContent className="px-3 sm:px-5 pb-5 space-y-4">
          <ChipGroup label="Peso" options={PESO_OPTIONS} value={cat.weight} onChange={(v) => updateCat({ weight: v })} />
          <ChipGroup label="Grado" options={GRADO_OPTIONS} value={cat.belt} onChange={(v) => updateCat({ belt: v })} />
          <div className="flex flex-wrap gap-4 items-end">
            <ChipGroup label="Género" options={GENERO_OPTIONS} value={cat.gender} onChange={(v) => updateCat({ gender: v })} />
            <div className="space-y-1">
              <span className="text-sm font-medium text-muted-foreground">Edad</span>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  placeholder="Desde"
                  value={cat.ageFrom}
                  onChange={(e) => updateCat({ ageFrom: e.target.value })}
                  className="w-24 h-9 text-sm"
                />
                <span className="text-xs text-muted-foreground">-</span>
                <Input
                  type="number"
                  placeholder="Hasta"
                  value={cat.ageTo}
                  onChange={(e) => updateCat({ ageTo: e.target.value })}
                  className="w-24 h-9 text-sm"
                />
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-sm font-medium text-muted-foreground">Disciplina</span>
              <div className="flex gap-2">
                {(["sparring", "tul"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setConfig({ matchType: t })}
                    className={cn(
                      "px-4 py-2 rounded-full border text-sm font-medium transition-colors",
                      (config.matchType ?? "sparring") === t
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:bg-secondary",
                    )}
                  >
                    {t === "sparring" ? "Sparring" : "Tul / Formas"}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-sm font-medium text-muted-foreground">Modo</span>
              <div className="flex gap-2">
                {(["round-robin", "elimination"] as TournamentMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setConfig({ mode: m })}
                    className={cn(
                      "px-4 py-2 rounded-full border text-sm font-medium transition-colors",
                      config.mode === m
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:bg-secondary",
                    )}
                  >
                    {m === "round-robin" ? "Round Robin" : "Eliminación"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Jefe de mesa</span>
            <Input
              placeholder="Nombre del jefe de mesa"
              value={config.tableChief}
              onChange={(e) => setConfig({ tableChief: e.target.value })}
              className="max-w-xs h-9 text-sm"
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm flex items-center gap-2">
              Lista
              <Badge variant="secondary">{competitors.length}</Badge>
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
                    className="flex items-center gap-2 rounded-lg px-2 py-2.5 hover:bg-secondary/50 group"
                  >
                    <span className="text-xs text-muted-foreground w-5 text-right shrink-0">{i + 1}</span>
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
    </div>
  );
}