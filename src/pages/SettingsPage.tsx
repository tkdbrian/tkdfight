import { useState, useEffect } from "react";
import { useTournamentStore } from "@/store/tournament";
import { useShallow } from "zustand/react/shallow";
import { useSocket } from "@/hooks/useSocket";
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
import { RotateCcw, AlertTriangle, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import itfRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import type { RuleSetSparring } from "@/engine/types";

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
  const { config, setConfig, reset } = useTournamentStore(
    useShallow((s) => ({ config: s.config, setConfig: s.setConfig, reset: s.reset }))
  );
  const { state: serverState, socket } = useSocket();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!socket) return;
    function onFullReset() { reset(); }
    socket.on("ring:full-reset", onFullReset);
    return () => { socket.off("ring:full-reset", onFullReset); };
  }, [socket, reset]);

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
      <div>
        <h1 className="text-2xl font-bold">Configuración</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {judges} jueces · {roundCount} rounds · {formatDur(roundDuration)} min{goldenPoint ? " · Golden Point" : ""}
        </p>
      </div>

      <Tabs defaultValue="rules" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="rules">Reglas del combate</TabsTrigger>
          <TabsTrigger value="ring">Este cuadrilátero</TabsTrigger>
        </TabsList>

        {/* ── Tab: Reglas del combate ── */}
        <TabsContent value="rules">
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
                  { label: "1:30 min", value: "90" },
                  { label: "2 min", value: "120" },
                  { label: "2:30 min", value: "150" },
                  { label: "3 min", value: "180" },
                ]}
              />

              <ToggleGroup
                label="Cantidad de rounds"
                value={String(roundCount)}
                onChange={(v) => update({ count: Number(v) })}
                options={[
                  { label: "1 round", value: "1" },
                  { label: "2 rounds", value: "2" },
                  { label: "3 rounds", value: "3" },
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
                  { label: "60 s", value: "60" },
                ]}
              />

              <div className="border-t border-border" />

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
                Borra todos los combates, resultados y competidores. Afecta todas las tabs abiertas de este cuadrilátero.
              </p>
              <Button
                variant="destructive"
                onClick={() => setResetOpen(true)}
                className="shrink-0"
              >
                <RotateCcw className="size-4" />
                Reiniciar todo
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
              ¿Reiniciar categoría?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Se borrarán todos los competidores, combates y resultados. Esta
            acción no se puede deshacer.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)} disabled={resetting}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={resetting}
              onClick={async () => {
                setResetting(true);
                try {
                  await fetch("/api/ring/full-reset", { method: "POST" });
                } catch {
                  // server may be down — reset locally anyway
                  reset();
                } finally {
                  setResetting(false);
                  setResetOpen(false);
                }
              }}
            >
              {resetting ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
              {resetting ? "Reiniciando…" : "Sí, reiniciar todo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
