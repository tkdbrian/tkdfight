import { useState, useEffect } from "react";
import { useTournamentStore } from "@/store/tournament";
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
import { RotateCcw, AlertTriangle, Check } from "lucide-react";
import { cn } from "@/lib/utils";
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
              "px-5 py-3 rounded-lg border text-base font-medium transition-colors",
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
  const { config, setConfig, reset, phase } = useTournamentStore();
  const { state: serverState } = useSocket();
  const [resetOpen, setResetOpen] = useState(false);

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

  const fighting = phase !== "setup";

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Configuración</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Reglas y parámetros de la categoría.
            {fighting && (
              <span className="ml-2 text-yellow-500">
                (Reinicia la categoría para aplicar cambios)
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Nombre del tatami */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nombre del tatami</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
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
              <p className="text-xs text-muted-foreground">Máx. 4 caracteres. Se muestra en el sidebar y en Mesa Central.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ring-name">Nombre completo</Label>
              <Input
                id="ring-name"
                value={tatamiName}
                onChange={(e) => setTatamiName(e.target.value)}
                placeholder="Tatami 1"
              />
              <p className="text-xs text-muted-foreground">Nombre descriptivo para reportes.</p>
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

      {/* Jueces */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Jueces</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleGroup
            label="Número de jueces"
            value={String(judges)}
            onChange={(v) => setJudges(Number(v))}
            options={[
              { label: "1", value: "1" },
              { label: "3", value: "3" },
              { label: "4", value: "4" },
              { label: "5", value: "5" },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            Cada juez se conecta desde su celular en{" "}
            <code className="bg-secondary px-1 rounded">
              http://&lt;IP&gt;:3001/judge?id=N
            </code>
          </p>
        </CardContent>
      </Card>

      {/* Rounds */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rounds</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
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
            label="Duración de cada round"
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
        </CardContent>
      </Card>

      {/* Desempate */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Desempate</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
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
              label="Duración de tiempo extra"
              value={String(rules.rounds.overtime_seconds ?? 60)}
              onChange={(v) => update({ overtime_seconds: Number(v) })}
              options={[
                { label: "30 s", value: "30" },
                { label: "60 s", value: "60" },
                { label: "90 s", value: "90" },
              ]}
            />
          )}
          <p className="text-xs text-muted-foreground">
            Si el combate termina en empate, se disputa un round adicional donde
            el primer punto gana.
          </p>
        </CardContent>
      </Card>

      {/* Resumen de config activa */}
      <Card className="border-border/50 bg-secondary/30">
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">Configuración activa</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs">Jueces</dt>
              <dd className="font-bold">{judges}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Rounds</dt>
              <dd className="font-bold">{roundCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Duración</dt>
              <dd className="font-bold">{Math.floor(roundDuration / 60)}:{String(roundDuration % 60).padStart(2, "0")} min</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Descanso</dt>
              <dd className="font-bold">{restDuration} s</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Golden Point</dt>
              <dd className="font-bold">{goldenPoint ? "Sí" : "No"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Reiniciar torneo */}
      {fighting && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Zona peligrosa</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              Borra todos los combates, resultados y competidores de la categoría actual.
            </p>
            <Button
              variant="destructive"
              onClick={() => setResetOpen(true)}
              className="shrink-0"
            >
              <RotateCcw className="size-4" />
              Reiniciar categoría
            </Button>
          </CardContent>
        </Card>
      )}

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
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                reset();
                setResetOpen(false);
              }}
            >
              Sí, reiniciar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
