import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTournamentStore } from "@/store/tournament";
import { useShallow } from "zustand/react/shallow";
import { useSocket } from "@/hooks/useSocket";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { RotateCcw, AlertTriangle, Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isTimePresetActive } from "@/lib/category-age";
import { yusanConfigPatch } from "@/lib/yusan-profile";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import itfRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import type { RuleSetSparring } from "@/engine/types";
import {
  type TimePreset,
  fetchPresets,
  savePreset,
  deleteServerPreset,
} from "@/lib/tournament-presets";

const BASE = itfRules as RuleSetSparring;

// ── Helpers ───────────────────────────────────────────────────────────────────

function ToggleGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: Readonly<{
  label: string;
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}>) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2 flex-wrap">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "px-3 py-2 rounded-lg border text-sm font-medium transition-colors",
              value === o.value
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-transparent text-muted-foreground hover:bg-secondary"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function SettingsPage() {
  const navigate = useNavigate();
  const { config, setConfig, resetAllLocalCategories, createCategory, startNewTournament } = useTournamentStore(
    useShallow((s) => ({
      config: s.config,
      setConfig: s.setConfig,
      resetAllLocalCategories: s.resetAllLocalCategories,
      createCategory: s.createCategory,
      startNewTournament: s.startNewTournament,
    }))
  );
  const { connected, stateReady, state: serverState, socket } = useSocket();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!socket) return;
    function onFullReset() {
      if (!resetAllLocalCategories()) toast.error("El reinicio fue aceptado, pero no se pudo completar el guardado local. Revisá antes de continuar.");
    }
    socket.on("ring:full-reset", onFullReset);
    return () => { socket.off("ring:full-reset", onFullReset); };
  }, [socket, resetAllLocalCategories]);

  // ── Nombre del tatami ────────────────────────────────────────────────────
  const [alias, setAlias] = useState("");
  const [tatamiName, setTatamiName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (serverState.ringAlias) setAlias(serverState.ringAlias);
    if (serverState.ringName) setTatamiName(serverState.ringName);
  }, [serverState.ringAlias, serverState.ringName]);

  async function handleSaveName() {
    if (!alias.trim()) return;
    setSaving(true);
    try {
      await fetch("/api/ring/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: alias.trim(), name: tatamiName.trim() || alias.trim() }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  // Derive current rule values — fallback to ITF baseline
  const rules: RuleSetSparring =
    config.ruleSet?.mode === "sparring"
      ? (config.ruleSet as RuleSetSparring)
      : BASE;
  const judges = config.judgesCount ?? BASE.judgesCount;
  const roundCount = rules.rounds.count;
  const roundDuration = rules.rounds.duration_seconds;
  const restDuration = rules.rounds.rest_seconds;
  const goldenPoint = rules.rounds.golden_point ?? true;

  // ── Presets de configuración rápida ─────────────────────────────────────
  const [serverPresets, setServerPresets] = useState<TimePreset[]>([]);
  const [showPresetInput, setShowPresetInput] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetSaving, setPresetSaving] = useState(false);
  const [presetError, setPresetError] = useState("");

  function isPresetActive(p: TimePreset): boolean {
    return isTimePresetActive(p, {
      roundCount,
      durationSeconds: roundDuration,
      finalRounds: config.finalRounds,
      finalSeconds: config.finalSeconds,
      tiebreakerSeconds: config.tiebreakerSeconds,
      maxTiebreakers: config.maxTiebreakers,
    }, config.categoryName);
  }

  useEffect(() => {
    fetchPresets()
      .then(setServerPresets)
      .catch(() => {/* servidor no disponible */});
  }, []);

  function applyPreset(p: TimePreset) {
    update({ count: p.roundCount, duration_seconds: p.durationSeconds });
    setConfig({
      finalRounds: p.finalRounds,
      finalSeconds: p.finalSeconds,
      tiebreakerSeconds: p.tiebreakerSeconds,
      maxTiebreakers: p.maxTiebreakers,
      profileApplied: false,
    });
  }

  async function handleSavePreset() {
    const name = presetName.trim();
    if (!name) return;
    setPresetSaving(true);
    setPresetError("");
    try {
      const saved = await savePreset({
        name,
        roundCount,
        durationSeconds: roundDuration,
        finalRounds: config.finalRounds,
        finalSeconds: config.finalSeconds,
        tiebreakerSeconds: config.tiebreakerSeconds,
        maxTiebreakers: config.maxTiebreakers,
      });
      setServerPresets((prev) => [...prev, saved]);
      setPresetName("");
      setShowPresetInput(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPresetError(`No se pudo guardar (${msg}). ¿El servidor está corriendo?`);
    } finally {
      setPresetSaving(false);
    }
  }

  async function handleDeletePreset(id: number) {
    try {
      await deleteServerPreset(id);
      setServerPresets((prev) => prev.filter((p) => p.id !== id));
    } catch {
      // silencioso
    }
  }

  function update(patch: Partial<RuleSetSparring["rounds"]>) {
    const updated: RuleSetSparring = {
      ...BASE,
      ...rules,
      judgesCount: judges,
      rounds: { ...rules.rounds, ...patch },
    };
    setConfig({ ruleSet: updated, judgesCount: updated.judgesCount });
  }

  function setJudges(count: number) {
    const updated: RuleSetSparring = {
      ...BASE,
      ...rules,
      judgesCount: count,
    };
    setConfig({ ruleSet: updated, judgesCount: count });
  }


  const formatDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4 max-w-2xl">
      <section className="rounded-xl border border-border bg-muted/30 p-4 space-y-2">
        <h2 className="font-semibold">Respaldo y recuperación</h2>
        <p className="text-sm text-muted-foreground">
          Se abrirá mantenimiento fuera del torneo. Cierre las demás pestañas antes de continuar.
        </p>
        <div className="flex flex-wrap gap-3">
          <a className="rounded bg-primary px-4 py-2 text-primary-foreground" href="/maintenance">
            Guardar respaldo completo
          </a>
          <a className="rounded border border-border px-4 py-2" href="/maintenance">
            Recuperar respaldo
          </a>
        </div>
      </section>
      <div>
        <h1 className="text-2xl font-bold">Configuración</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {judges} jueces · {roundCount} rounds · {formatDur(roundDuration)} min{goldenPoint ? " · Golden Point" : ""}
        </p>
      </div>

      {/* ── Configuración rápida — afecta todos los ajustes ── */}
      <div id="tour-settings-presets" className="rounded-xl border border-border/50 bg-muted/30 px-4 py-3 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">⚡ Configuración rápida</p>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Perfil del torneo</Label>
          <p className="text-xs text-muted-foreground">
            Yusan 2026 se hereda en categorías nuevas. Las existentes conservan sus tiempos hasta aplicarlo expresamente.
          </p>
          {config.profileId === "yusan-2026" && (
            <p className="text-xs text-muted-foreground">
              Este perfil solo ajusta duraciones; no modifica el motor, los desempates ni Punto de Oro.
            </p>
          )}
          {!config.profileId ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setConfig({
              eventId: config.eventId ?? crypto.randomUUID(),
              profileId: "yusan-2026",
              profileApplied: false,
            })}>Seleccionar Yusan 2026</Button>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">Yusan 2026</span>
              {!config.profileApplied && <Button type="button" size="sm" onClick={() => {
                const patch = yusanConfigPatch(config, config, config.mode, BASE);
                if (!patch) { toast.error("Elegí edad y grado en Configurar categoría antes de aplicar el perfil."); return; }
                setConfig(patch);
              }}>Aplicar Yusan 2026 a esta categoría</Button>}
            </div>
          )}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => {
          const categoryId = createCategory();
          if (!categoryId) { toast.error("No se pudo guardar la categoría actual."); return; }
          startNewTournament("");
          navigate("/setup");
        }}>Nuevo torneo (categoría nueva)</Button>

        {serverPresets.length > 0 && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Mis presets</Label>
            <div className="flex gap-2 flex-wrap">
              {serverPresets.map((p) => (
                <div key={p.id} className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => applyPreset(p)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors",
                      isPresetActive(p)
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )}
                  >
                    {p.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeletePreset(p.id!)}
                    className="p-1 rounded text-muted-foreground hover:text-destructive transition-colors"
                    aria-label="Eliminar preset"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {presetError && (
          <p className="text-xs text-destructive">{presetError}</p>
        )}
        {showPresetInput ? (
          <div className="flex gap-2 items-center flex-wrap">
            <Input
              className="h-8 text-sm w-48"
              placeholder="Nombre del preset…"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSavePreset();
                if (e.key === "Escape") setShowPresetInput(false);
              }}
              autoFocus
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleSavePreset()}
              disabled={presetSaving || !presetName.trim()}
            >
              {presetSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Guardar"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setShowPresetInput(false); setPresetName(""); }}
            >
              Cancelar
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowPresetInput(true)}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
          >
            + Guardar configuración actual como preset
          </button>
        )}
      </div>

      <Tabs id="tour-settings-tabs" defaultValue="general" className="space-y-4">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="elimination">Final y desempate</TabsTrigger>
          <TabsTrigger value="ring">Cuadrilátero</TabsTrigger>
        </TabsList>

        {/* ── Tab: General ── */}
        <TabsContent value="general">
          <Card>
            <CardContent className="space-y-5 pt-6">
              <ToggleGroup
                label="Jueces"
                value={String(judges)}
                onChange={(v) => setJudges(Number(v))}
                options={[
                  { label: "1", value: "1" },
                  { label: "3", value: "3" },
                  { label: "4", value: "4" },
                  { label: "5", value: "5" },
                ]}
              />
              <p className="text-xs text-muted-foreground -mt-3">
                Cada juez se conecta desde su celular en{" "}
                <code className="bg-secondary px-1 rounded">http://&lt;IP&gt;:3001/judge?id=N</code>
              </p>

              <div className="border-t border-border" />

              <ToggleGroup
                label="Duración del round"
                value={String(roundDuration)}
                onChange={(v) => update({ duration_seconds: Number(v) })}
                options={[
                  { label: "40 s", value: "40" },
                  { label: "1 min", value: "60" },
                  { label: "1:30", value: "90" },
                  { label: "2 min", value: "120" },
                  { label: "2:30", value: "150" },
                  { label: "3 min", value: "180" },
                ]}
              />

              <ToggleGroup
                label="Cantidad de rounds"
                value={String(roundCount)}
                onChange={(v) => update({ count: Number(v) })}
                options={[
                  { label: "1", value: "1" },
                  { label: "2", value: "2" },
                  { label: "3", value: "3" },
                ]}
              />

              <ToggleGroup
                label="Descanso entre rounds"
                value={String(restDuration)}
                onChange={(v) => update({ rest_seconds: Number(v) })}
                options={[
                  { label: "Sin descanso", value: "0" },
                  { label: "20 s", value: "20" },
                  { label: "30 s", value: "30" },
                  { label: "45 s", value: "45" },
                  { label: "1 min", value: "60" },
                ]}
              />

            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab: Final y desempate ── */}
        <TabsContent value="elimination">
          <Card>
            <CardContent className="space-y-5 pt-6">

              {/* Sección: Combate final */}
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Combate final</p>
                <p className="text-xs text-muted-foreground">En eliminación: la final del bracket. En round robin: el combate entre los dos finalistas empatados en puntos.</p>
              </div>
              <ToggleGroup
                label="Rounds en la final"
                value={String(config.finalRounds ?? roundCount)}
                onChange={(v) => setConfig({ finalRounds: Number(v) })}
                options={[
                  { label: "1 round", value: "1" },
                  { label: "2 rounds", value: "2" },
                  { label: "3 rounds", value: "3" },
                ]}
              />
              <ToggleGroup
                label="Duración del round final"
                value={String(config.finalSeconds ?? rules.rounds.duration_seconds ?? 60)}
                onChange={(v) => setConfig({ finalSeconds: Number(v) })}
                options={[
                  { label: "1 min", value: "60" },
                  { label: "1:30", value: "90" },
                  { label: "2 min", value: "120" },
                  { label: "3 min", value: "180" },
                ]}
              />

              <div className="border-t border-border" />

              {/* Sección: Desempate */}
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Desempate</p>
                <p className="text-xs text-muted-foreground">En eliminación: cuando un combate del bracket termina igualado. En round robin: solo si el combate final termina en empate.</p>
              </div>
              <ToggleGroup
                label="Duración del desempate"
                value={String(config.tiebreakerSeconds ?? rules.rounds.overtime_seconds ?? 30)}
                onChange={(v) => setConfig({ tiebreakerSeconds: Number(v) })}
                options={[
                  { label: "20 s", value: "20" },
                  { label: "30 s", value: "30" },
                  { label: "45 s", value: "45" },
                  { label: "1 min", value: "60" },
                  { label: "1:30", value: "90" },
                ]}
              />
              <ToggleGroup
                label="Desempates antes del Punto de Oro"
                value={String(config.maxTiebreakers ?? 1)}
                onChange={(v) => setConfig({ maxTiebreakers: Number(v) })}
                options={[
                  { label: "1", value: "1" },
                  { label: "2", value: "2" },
                  { label: "3", value: "3" },
                ]}
              />
              <p className="text-xs text-muted-foreground -mt-3">
                Tras este número de desempates el siguiente combate es Punto de Oro — sin tiempo, el primer punto gana.
              </p>

              <ToggleGroup
                label="Punto de oro (Golden Point)"
                value={goldenPoint ? "on" : "off"}
                onChange={(v) => {
                  const on = v === "on";
                  update({ golden_point: on, overtime_seconds: on ? (rules.rounds.overtime_seconds ?? 30) : 0 });
                }}
                options={[
                  { label: "Activado", value: "on" },
                  { label: "Desactivado", value: "off" },
                ]}
              />
              {goldenPoint && (
                <ToggleGroup
                  label="Tiempo extra"
                  value={String(rules.rounds.overtime_seconds ?? 60)}
                  onChange={(v) => update({ overtime_seconds: Number(v) })}
                  options={[
                    { label: "30 s", value: "30" },
                    { label: "60 s", value: "60" },
                    { label: "90 s", value: "90" },
                  ]}
                />
              )}
              {goldenPoint && (
                <p className="text-xs text-muted-foreground -mt-3">
                  Si el combate termina en empate, se disputa un round adicional donde el primer punto gana.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab: Este cuadrilátero ── */}
        <TabsContent value="ring" className="space-y-4">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <p className="text-xs text-muted-foreground">
                Identifica este cuadrilátero en la Mesa Central y en los reportes.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="ring-alias">Alias corto</Label>
                  <Input
                    id="ring-alias"
                    value={alias}
                    onChange={(e) => setAlias(e.target.value.slice(0, 4))}
                    placeholder="T1"
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">Máx. 4 caracteres.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ring-name">Nombre completo</Label>
                  <Input
                    id="ring-name"
                    value={tatamiName}
                    onChange={(e) => setTatamiName(e.target.value)}
                    placeholder="Cuadrilátero 1"
                  />
                </div>
              </div>
              <Button
                onClick={handleSaveName}
                disabled={saving || !alias.trim()}
                variant={saved ? "outline" : "default"}
                className={saved ? "border-green-600 text-green-400" : ""}
              >
                {saved ? <><Check className="size-4" /> Guardado</> : saving ? "Guardando…" : "Guardar nombre"}
              </Button>
            </CardContent>
          </Card>

          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-base text-destructive">Zona peligrosa</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                Borra todas las categorías de este navegador y reinicia las peleas y competidores del torneo activo en este tatami.
              </p>
              <Button
                variant="destructive"
                onClick={() => setResetOpen(true)}
                className="shrink-0"
              >
                <RotateCcw className="size-4" />
                Reiniciar datos locales
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Confirm reset dialog */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-5" />
              ¿Reiniciar datos locales y torneo activo?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Se borrarán <strong className="text-foreground">todas las categorías de este navegador</strong>{" "}
            y las peleas, resultados y competidores del torneo activo en este tatami.
            El historial de otros torneos no se elimina. Esta acción no se puede deshacer.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)} disabled={resetting}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={resetting}
              onClick={async () => {
                if (!connected || !stateReady || serverState.activeMatchLock
                  || (serverState.match && !serverState.resultConfirmed)) {
                  toast.error("No se puede reiniciar el tatami mientras hay un combate activo o sin conexión.");
                  return;
                }
                setResetting(true);
                try {
                  const response = await fetch("/api/ring/full-reset", { method: "POST" });
                  if (!response.ok) throw new Error("El servidor rechazó el reinicio; no se borraron datos locales.");
                  const acknowledgement: unknown = await response.json();
                  if (!acknowledgement || typeof acknowledgement !== "object" ||
                    !("ok" in acknowledgement) || acknowledgement.ok !== true) {
                    throw new Error("El servidor no confirmó el reinicio; no se borraron datos locales.");
                  }
                  if (!resetAllLocalCategories()) {
                    throw new Error("El servidor aceptó el reinicio, pero no se pudo completar el guardado local. Revisá antes de continuar.");
                  }
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "No se pudo reiniciar el tatami.");
                } finally {
                  setResetting(false);
                  setResetOpen(false);
                }
              }}
            >
              {resetting ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
              {resetting ? "Reiniciando…" : "Sí, reiniciar datos"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
