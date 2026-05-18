import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useRingClient, type RingTarget, type RingLiveState } from "@/hooks/useRingClient";
import { discoverRings } from "@/lib/ring-discovery";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  Wifi,
  WifiOff,
  Search,
  Plus,
  Trash2,
  Swords,
  Clock,
  Users,
  Activity,
  Loader2,
  Monitor,
  AlertTriangle,
  ArrowRightLeft,
  CheckSquare,
  Square,
  X,
  Trophy,
  Download,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  GripVertical,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface ActivityEvent {
  id: number;
  time: string;
  ringAlias: string;
  message: string;
  type: "result" | "round" | "info";
}

interface QueueEntry {
  position: number;
  fight: {
    id: string;
    red: { id: string; name: string };
    blue: { id: string; name: string };
    sourceRing: string | null;
  };
  status: "active" | "next" | "queued";
}

interface CalledEntry {
  competitorId: string;
  name: string;
  ringAlias: string;
  calledAt: string;
  confirmed: boolean;
}

interface MoveSelection {
  /** key = ip:port of source ring */
  sourceKey: string;
  fightIds: Set<string>;
}

interface MoveState {
  /** null = idle, 'selecting' = picking fights, 'picking' = choosing dest */
  stage: "idle" | "selecting" | "picking" | "moving";
  sourceKey: string;
  fightIds: Set<string>;
  error: string | null;
}

// ── Consolidated results types ───────────────────────────────────────────────

interface FalloEntry {
  id: number;
  time: string;
  redName: string;
  blueName: string;
  redScore: number;
  blueScore: number;
  winner: string;
}

interface RingResults {
  alias: string;
  ip: string;
  port: number;
  fallos: FalloEntry[];
}

interface ConsolidatedStanding {
  name: string;
  wins: number;
  losses: number;
  draws: number;
  fought: number;
  points: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function phaseLabel(phase: string): string {
  const map: Record<string, string> = {
    idle: "Esperando",
    round: "Round",
    rest: "Descanso",
    overtime: "Overtime",
    golden_point: "Punto de oro",
    penalties: "Penalidades",
    finished: "Finalizado",
  };
  return map[phase] ?? phase;
}

// ── Persisted targets ────────────────────────────────────────────────────────

const STORAGE_KEY = "tkd-central-targets";

function loadTargets(): RingTarget[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveTargets(targets: RingTarget[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(targets));
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function CentralPage() {
  const [targets, setTargets] = useState<RingTarget[]>(loadTargets);
  const [manualIp, setManualIp] = useState("");
  const [manualPort, setManualPort] = useState("3001");
  const [scanning, setScanning] = useState(false);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [calledMap, setCalledMap] = useState<Map<string, CalledEntry>>(new Map());
  const [queues, setQueues] = useState<Map<string, QueueEntry[]>>(new Map());
  const [moveState, setMoveState] = useState<MoveState>({
    stage: "idle",
    sourceKey: "",
    fightIds: new Set(),
    error: null,
  });
  const [showResults, setShowResults] = useState(false);
  const [ringResults, setRingResults] = useState<RingResults[]>([]);
  const [loadingResults, setLoadingResults] = useState(false);
  const [flashedDestKey, setFlashedDestKey] = useState<string | null>(null);
  const [dragFight, setDragFight] = useState<{ sourceKey: string; fight: QueueEntry["fight"] } | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const activitySeq = useRef(0);
  const prevStatesRef = useRef<Map<string, string>>(new Map());

  const { rings } = useRingClient(targets);

  // Persist targets
  useEffect(() => {
    saveTargets(targets);
  }, [targets]);

  // Poll queue data from each connected tatami every 5s
  useEffect(() => {
    const intervals: ReturnType<typeof setInterval>[] = [];

    async function fetchQueue(ip: string, port: number) {
      try {
        const res = await fetch(`http://${ip}:${port}/api/ring/queue`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return;
        const data = (await res.json()) as QueueEntry[];
        setQueues((prev) => {
          const next = new Map(prev);
          next.set(`${ip}:${port}`, data);
          return next;
        });
      } catch {
        // tatami offline — ignore
      }
    }

    for (const ring of rings) {
      if (!ring.connected) continue;
      const { ip, port } = ring.target;
      fetchQueue(ip, port);
      const id = setInterval(() => fetchQueue(ip, port), 5_000);
      intervals.push(id);
    }

    return () => intervals.forEach(clearInterval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rings.map((r) => `${r.target.ip}:${r.target.port}:${r.connected}`).join(",")]);

  // Track activity from ring state changes
  useEffect(() => {
    for (const ring of rings) {
      const alias = ring.state?.ringAlias ?? ring.target.alias ?? `${ring.target.ip}`;
      const k = `${ring.target.ip}:${ring.target.port}`;
      const match = ring.state?.match;
      const phase = ring.state?.matchState?.phase;

      const prevKey = prevStatesRef.current.get(k);
      const curKey = match
        ? `${match.id}:${phase}:${ring.state?.matchState?.currentRound}`
        : "idle";

      if (prevKey === curKey) continue;
      prevStatesRef.current.set(k, curKey);

      // Don't log on first connection
      if (!prevKey) continue;

      const now = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      if (phase === "finished" && match) {
        const result = ring.state?.matchState?.result;
        const winner = result?.winner === "red" ? match.red.name : result?.winner === "blue" ? match.blue.name : "Empate";
        addActivity({ ringAlias: alias, message: `${match.red.name} vs ${match.blue.name} → ${winner}`, type: "result", time: now });
      } else if (phase === "round" && match) {
        addActivity({
          ringAlias: alias,
          message: `Round ${ring.state?.matchState?.currentRound ?? "?"} — ${match.red.name} vs ${match.blue.name}`,
          type: "round",
          time: now,
        });
      }
    }
  }, [rings]);

  function addActivity(ev: Omit<ActivityEvent, "id">) {
    setActivity((prev) => [{ ...ev, id: ++activitySeq.current }, ...prev].slice(0, 50));
  }

  // ── Add / Remove targets ────────────────────────────────────────────────
  function addManualTarget() {
    const ip = manualIp.trim();
    const port = Number.parseInt(manualPort) || 3001;
    if (!ip) return;
    if (targets.some((t) => t.ip === ip && t.port === port)) return;
    setTargets((prev) => [...prev, { ip, port }]);
    setManualIp("");
  }

  function removeTarget(ip: string, port: number) {
    setTargets((prev) => prev.filter((t) => !(t.ip === ip && t.port === port)));
  }

  // ── Discovery ───────────────────────────────────────────────────────────
  async function runDiscovery() {
    setScanning(true);
    try {
      await discoverRings(undefined, 3001, (found) => {
        setTargets((prev) => {
          if (prev.some((t) => t.ip === found.ip && t.port === found.port)) return prev;
          return [...prev, { ip: found.ip, port: found.port, alias: found.alias }];
        });
      });
    } finally {
      setScanning(false);
    }
  }

  // ── Reassignment logic ───────────────────────────────────────────────────

  function startMove(sourceKey: string) {
    setMoveState({ stage: "selecting", sourceKey, fightIds: new Set(), error: null });
  }

  function toggleFightSelection(fightId: string) {
    setMoveState((prev) => {
      const next = new Set(prev.fightIds);
      if (next.has(fightId)) next.delete(fightId);
      else next.add(fightId);
      return { ...prev, fightIds: next, error: null };
    });
  }

  function cancelMove() {
    setMoveState({ stage: "idle", sourceKey: "", fightIds: new Set(), error: null });
  }

  function handleFightDragStart(sourceKey: string, fight: QueueEntry["fight"]) {
    setDragFight({ sourceKey, fight });
  }

  function handleFightDragEnd() {
    setDragFight(null);
    setDragOverKey(null);
  }

  async function dropFightOnRing(destKey: string) {
    if (!dragFight || destKey === dragFight.sourceKey) {
      setDragFight(null);
      setDragOverKey(null);
      return;
    }
    const { sourceKey, fight } = dragFight;
    setDragFight(null);
    setDragOverKey(null);
    const destRing = rings.find((r) => `${r.target.ip}:${r.target.port}` === destKey);
    const srcAlias = rings.find((r) => `${r.target.ip}:${r.target.port}` === sourceKey)?.state?.ringAlias ?? sourceKey;
    if (!destRing) return;
    try {
      const importRes = await fetch(
        `http://${destRing.target.ip}:${destRing.target.port}/api/ring/import-fights`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fights: [{ id: fight.id, red_id: fight.red.id, blue_id: fight.blue.id }],
            competitors: [fight.red, fight.blue],
            sourceRingLabel: srcAlias,
            sourceRingAddress: sourceKey,
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!importRes.ok) {
        const err = await importRes.json().catch(() => ({}));
        toast.error((err as { message?: string }).message ?? "Error al importar pelea");
        return;
      }
      const [srcIp, srcPortStr] = sourceKey.split(":");
      await fetch(`http://${srcIp}:${srcPortStr}/api/ring/remove-fights`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [fight.id] }),
        signal: AbortSignal.timeout(5000),
      });
      const dstAlias = destRing.state?.ringAlias ?? destKey;
      const now = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
      addActivity({ ringAlias: srcAlias, message: `${fight.red.name} vs ${fight.blue.name} → ${dstAlias}`, type: "info", time: now });
      toast.success(`Pelea movida a ${dstAlias}`, { description: `${srcAlias} → ${dstAlias}` });
      setFlashedDestKey(destKey);
      setTimeout(() => setFlashedDestKey((k) => (k === destKey ? null : k)), 3000);
      setQueues((prev) => {
        const next = new Map(prev);
        next.delete(sourceKey);
        next.delete(destKey);
        return next;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al mover pelea");
    }
  }

  function proceedToPick() {
    if (moveState.fightIds.size === 0) {
      setMoveState((prev) => ({ ...prev, error: "Seleccioná al menos una pelea" }));
      return;
    }
    setMoveState((prev) => ({ ...prev, stage: "picking", error: null }));
  }

  async function executeMove(destKey: string) {
    if (destKey === moveState.sourceKey) {
      setMoveState((prev) => ({ ...prev, error: "El destino debe ser un tatami distinto" }));
      return;
    }

    const sourceQueue = queues.get(moveState.sourceKey) ?? [];
    const selectedEntries = sourceQueue.filter((e) => moveState.fightIds.has(e.fight.id));
    if (selectedEntries.length === 0) {
      cancelMove();
      return;
    }

    setMoveState((prev) => ({ ...prev, stage: "moving", error: null }));

    // Build payload
    const fights = selectedEntries.map((e) => ({
      id: e.fight.id,
      red_id: e.fight.red.id,
      blue_id: e.fight.blue.id,
    }));
    const competitorSet = new Map<string, { id: string; name: string }>();
    for (const e of selectedEntries) {
      competitorSet.set(e.fight.red.id, e.fight.red);
      competitorSet.set(e.fight.blue.id, e.fight.blue);
    }
    const competitors = Array.from(competitorSet.values());

    try {
      // 1. Import into destination
      const destRing = rings.find((r) => `${r.target.ip}:${r.target.port}` === destKey);
      if (!destRing) throw new Error("Tatami destino no encontrado");

      const srcAlias = rings.find((r) => `${r.target.ip}:${r.target.port}` === moveState.sourceKey)?.state?.ringAlias ?? moveState.sourceKey;

      const importRes = await fetch(
        `http://${destRing.target.ip}:${destRing.target.port}/api/ring/import-fights`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fights, competitors, sourceRingLabel: srcAlias, sourceRingAddress: moveState.sourceKey }),
          signal: AbortSignal.timeout(5000),
        },
      );

      if (!importRes.ok) {
        const err = await importRes.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message ?? `Error ${importRes.status}`);
      }

      // 2. Remove from source
      const [srcIp, srcPortStr] = moveState.sourceKey.split(":");
      const removeRes = await fetch(
        `http://${srcIp}:${srcPortStr}/api/ring/remove-fights`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: fights.map((f) => f.id) }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!removeRes.ok) {
        const err = await removeRes.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message ?? `Error ${removeRes.status}`);
      }

      // 3. Refresh queues
      const dstAlias = destRing.state?.ringAlias ?? destKey;
      const now = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
      addActivity({
        ringAlias: srcAlias,
        message: `${fights.length} pelea${fights.length !== 1 ? "s" : ""} movida${fights.length !== 1 ? "s" : ""} a ${dstAlias}`,
        type: "info",
        time: now,
      });
      toast.success(`${fights.length} pelea${fights.length !== 1 ? "s" : ""} movida${fights.length !== 1 ? "s" : ""} a ${dstAlias}`, {
        description: `Desde ${srcAlias} → ${dstAlias}`,
      });
      setFlashedDestKey(destKey);
      setTimeout(() => setFlashedDestKey((k) => (k === destKey ? null : k)), 3000);

      // Invalidate both queues so polling re-fetches
      setQueues((prev) => {
        const next = new Map(prev);
        next.delete(moveState.sourceKey);
        next.delete(destKey);
        return next;
      });

      cancelMove();
    } catch (err: unknown) {
      setMoveState((prev) => ({
        ...prev,
        stage: "selecting",
        error: err instanceof Error ? err.message : "Error desconocido",
      }));
    }
  }

  // ── Consolidated results ────────────────────────────────────────────────
  async function fetchConsolidatedResults() {
    setLoadingResults(true);
    const connected = rings.filter((r) => r.connected);
    const results = await Promise.allSettled(
      connected.map(async (ring) => {
        const res = await fetch(
          `http://${ring.target.ip}:${ring.target.port}/api/ring/results`,
          { signal: AbortSignal.timeout(3000) },
        );
        if (!res.ok) throw new Error(`${ring.target.ip} error ${res.status}`);
        const data = (await res.json()) as { alias: string; fallos: FalloEntry[] };
        return {
          alias: data.alias,
          ip: ring.target.ip,
          port: ring.target.port,
          fallos: data.fallos,
        } satisfies RingResults;
      }),
    );
    const collected = results
      .filter((r): r is PromiseFulfilledResult<RingResults> => r.status === "fulfilled")
      .map((r) => r.value);
    setRingResults(collected);
    setLoadingResults(false);
    setShowResults(true);
  }

  // ── Match Caller ────────────────────────────────────────────────────────
  function callCompetitor(competitorId: string, name: string, ringAlias: string) {
    const now = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
    setCalledMap((prev) => {
      const next = new Map(prev);
      next.set(competitorId, { competitorId, name, ringAlias, calledAt: now, confirmed: false });
      return next;
    });
    addActivity({ ringAlias, message: `📢 ${name} llamado al tatami`, type: "info", time: now });
  }

  function confirmPresent(competitorId: string) {
    setCalledMap((prev) => {
      const next = new Map(prev);
      const entry = next.get(competitorId);
      if (entry) next.set(competitorId, { ...entry, confirmed: true });
      return next;
    });
  }

  function dismissCalled(competitorId: string) {
    setCalledMap((prev) => {
      const next = new Map(prev);
      next.delete(competitorId);
      return next;
    });
  }

  // ── Double Start Check ──────────────────────────────────────────────────
  const duplicates = findDuplicateCompetitors(rings, queues);

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-14 flex items-center gap-3 px-6 border-b border-border shrink-0">
          <Monitor className="size-5 text-primary" />
          <h1 className="font-bold text-sm uppercase tracking-wide">Mesa Central</h1>
          <Badge variant="outline" className="ml-2">
            {rings.filter((r) => r.connected).length}/{targets.length} tatamis
          </Badge>
          {calledMap.size > 0 && (
            <Badge variant="secondary" className="text-[10px] text-yellow-400 border-yellow-500/30">
              📢 {calledMap.size} llamado{calledMap.size !== 1 ? "s" : ""}
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Input
              placeholder="IP del tatami"
              value={manualIp}
              onChange={(e) => setManualIp(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addManualTarget()}
              className="w-36 h-8 text-xs"
            />
            <Input
              placeholder="Puerto"
              value={manualPort}
              onChange={(e) => setManualPort(e.target.value)}
              className="w-16 h-8 text-xs"
            />
            <Button size="sm" variant="secondary" onClick={addManualTarget} aria-label="Agregar tatami">
              <Plus className="size-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={runDiscovery} disabled={scanning}>
              {scanning ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              <span className="ml-1 text-xs">Buscar LAN</span>
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <Button
              size="sm"
              variant="outline"
              onClick={fetchConsolidatedResults}
              disabled={loadingResults || rings.filter((r) => r.connected).length === 0}
            >
              {loadingResults ? <Loader2 className="size-4 animate-spin" /> : <Trophy className="size-4" />}
              <span className="ml-1 text-xs">Resultados</span>
            </Button>
          </div>
        </header>

        {/* Alerts — Double Start Check */}
        {duplicates.length > 0 && (
          <div className="mx-6 mt-3 p-3 rounded-lg bg-destructive/10 border border-destructive/30 flex items-start gap-2">
            <AlertTriangle className="size-5 text-destructive shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-destructive">Conflicto de competidores</p>
              {duplicates.map((d) => (
                <p key={d.name} className="text-muted-foreground">
                  {d.name} está activo en {d.rings.join(" y ")}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Banner — Reassignment in progress */}
        {moveState.stage !== "idle" && (
          <div className={cn(
            "mx-6 mt-3 p-3 rounded-lg border flex items-center gap-3",
            moveState.stage === "picking"
              ? "bg-yellow-500/10 border-yellow-500/30"
              : moveState.stage === "moving"
              ? "bg-secondary/80 border-border"
              : "bg-primary/10 border-primary/30",
          )}>
            {/* Step indicator */}
            <div className="flex items-center gap-1.5 shrink-0">
              {(["selecting", "picking", "moving"] as const).map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    "size-5 rounded-full text-[10px] font-bold flex items-center justify-center",
                    moveState.stage === s
                      ? "bg-primary text-primary-foreground"
                      : (["selecting", "picking", "moving"].indexOf(moveState.stage) > i
                          ? "bg-green-600 text-white"
                          : "bg-secondary text-muted-foreground"),
                  )}
                >
                  {i + 1}
                </span>
              ))}
            </div>
            <div className="flex-1 text-sm">
              {moveState.stage === "selecting" && (
                <span className="text-primary"><strong>Paso 1 de 3</strong> — Seleccioná las peleas y presioná <strong>Elegir destino</strong>.</span>
              )}
              {moveState.stage === "picking" && (
                <span className="text-yellow-400"><strong>Paso 2 de 3</strong> — Hacé clic en el tatami <strong>destino</strong> para mover las {moveState.fightIds.size} pelea(s).</span>
              )}
              {moveState.stage === "moving" && (
                <span className="text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  <strong>Paso 3 de 3</strong> — Aplicando cambios…
                </span>
              )}
              {moveState.error && (
                <p className="text-destructive text-xs mt-0.5">{moveState.error}</p>
              )}
            </div>
            {moveState.stage !== "moving" && (
              <Button size="sm" variant="ghost" className="shrink-0 text-muted-foreground" onClick={cancelMove}>
                <X className="size-4" />
              </Button>
            )}
          </div>
        )}

        {/* Tatami grid */}
        <ScrollArea className="flex-1 p-6">
          {targets.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <Monitor className="size-12 mb-4 opacity-30" />
              <p className="text-sm">No hay tatamis configurados</p>
              <p className="text-xs mt-1">Agregá una IP o usá "Buscar LAN" para detectar automáticamente</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {rings.map((ring) => {
                const qKey = `${ring.target.ip}:${ring.target.port}`;
                const isMoveSrc = moveState.sourceKey === qKey;
                const isMoveDest = moveState.stage === "picking" && moveState.sourceKey !== qKey;
                return (
                <TatamiCard
                    key={qKey}
                    ring={ring}
                    queue={queues.get(qKey) ?? null}
                    calledMap={calledMap}
                    moveStage={moveState.stage}
                    isMoveSrc={isMoveSrc}
                    isMoveDest={isMoveDest}
                    isFlashing={flashedDestKey === qKey}
                    selectedFightIds={isMoveSrc ? moveState.fightIds : new Set()}
                    rings={rings}
                    onRemove={() => removeTarget(ring.target.ip, ring.target.port)}
                    onCall={callCompetitor}
                    onConfirm={confirmPresent}
                    onDismiss={dismissCalled}
                    onStartMove={() => startMove(qKey)}
                    onToggleFight={toggleFightSelection}
                    onConfirmMove={() => proceedToPick()}
                    onCancelMove={cancelMove}
                    onMoveHere={() => executeMove(qKey)}
                    isDragTarget={dragFight !== null && dragFight.sourceKey !== qKey && moveState.stage === "idle"}
                    isDraggedOver={dragOverKey === qKey}
                    onFightDragStart={(fight) => handleFightDragStart(qKey, fight)}
                    onFightDragEnd={handleFightDragEnd}
                    onCardDragOver={() => setDragOverKey(qKey)}
                    onCardDragLeave={() => setDragOverKey((k) => (k === qKey ? null : k))}
                    onDropFight={() => dropFightOnRing(qKey)}
                  />
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Activity sidebar */}
      <aside className="w-72 border-l border-border flex flex-col shrink-0">
        <div className="h-14 flex items-center gap-2 px-4 border-b border-border">
          <Activity className="size-4 text-primary" />
          <span className="text-sm font-semibold">Actividad</span>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-3 space-y-1.5">
            {activity.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">Sin actividad aún</p>
            ) : (
              activity.map((ev) => (
                <div
                  key={ev.id}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-xs",
                    ev.type === "result" && "bg-green-500/10 text-green-400",
                    ev.type === "round" && "bg-blue-500/10 text-blue-400",
                    ev.type === "info" && "bg-secondary text-muted-foreground"
                  )}
                >
                  <span className="font-mono text-[10px] opacity-60 mr-1.5">{ev.time}</span>
                  <Badge variant="outline" className="text-[10px] mr-1.5 px-1 py-0">
                    {ev.ringAlias}
                  </Badge>
                  {ev.message}
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </aside>

      {/* ── Consolidated Results Panel ─────────────────────────────────── */}
      {showResults && (
        <ConsolidatedResultsPanel
          ringResults={ringResults}
          onClose={() => setShowResults(false)}
          onRefresh={fetchConsolidatedResults}
          loading={loadingResults}
        />
      )}
    </div>
  );
}

// ── Tatami Card ──────────────────────────────────────────────────────────────

interface TatamiCardProps {
  ring: RingLiveState;
  queue: QueueEntry[] | null;
  calledMap: Map<string, CalledEntry>;
  moveStage: MoveState["stage"];
  isMoveSrc: boolean;
  isMoveDest: boolean;
  isFlashing: boolean;
  selectedFightIds: Set<string>;
  rings: RingLiveState[];
  onRemove: () => void;
  onCall: (competitorId: string, name: string, ringAlias: string) => void;
  onConfirm: (competitorId: string) => void;
  onDismiss: (competitorId: string) => void;
  onStartMove: () => void;
  onToggleFight: (fightId: string) => void;
  onConfirmMove: () => void;
  onCancelMove: () => void;
  onMoveHere: () => void;
  isDragTarget: boolean;
  isDraggedOver: boolean;
  onFightDragStart: (fight: QueueEntry["fight"]) => void;
  onFightDragEnd: () => void;
  onCardDragOver: () => void;
  onCardDragLeave: () => void;
  onDropFight: () => void;
}

// ── CompletedFightsAccordion ─────────────────────────────────────────────────

function CompletedFightsAccordion({ fallos }: { fallos: FalloEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border/40 bg-muted/30 text-xs">
      <button
        type="button"
        className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-muted/50 transition-colors rounded-md"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-medium text-muted-foreground">
          ✅ {fallos.length} combate{fallos.length !== 1 ? "s" : ""} completado{fallos.length !== 1 ? "s" : ""}
        </span>
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
      </button>
      {open && (
        <div className="px-2.5 pb-2 space-y-1">
          {fallos.map((f) => {
            const winRed = f.winner === "red";
            const winBlue = f.winner === "blue";
            return (
              <div key={f.id} className="flex items-center gap-1.5 py-0.5 border-t border-border/30 first:border-0">
                <span className={cn("font-medium", winRed ? "text-red-500" : "text-muted-foreground")}>
                  {winRed && "🏆 "}{f.redName}
                </span>
                <span className="text-muted-foreground/60">{f.redScore}–{f.blueScore}</span>
                <span className={cn("font-medium", winBlue ? "text-blue-500" : "text-muted-foreground")}>
                  {winBlue && "🏆 "}{f.blueName}
                </span>
                <span className="ml-auto text-muted-foreground/50 tabular-nums">{f.time}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── TatamiCard ────────────────────────────────────────────────────────────────

function TatamiCard({
  ring, queue, calledMap,
  moveStage, isMoveSrc, isMoveDest, isFlashing, selectedFightIds, rings,
  onRemove, onCall, onConfirm, onDismiss,
  onStartMove, onToggleFight, onConfirmMove, onCancelMove, onMoveHere,
  isDragTarget, isDraggedOver,
  onFightDragStart, onFightDragEnd, onCardDragOver, onCardDragLeave, onDropFight,
}: Readonly<TatamiCardProps>) {
  const { connected, state, target } = ring;
  const alias = state?.ringAlias ?? target.alias ?? "T?";
  const ringName = state?.ringName ?? `${target.ip}:${target.port}`;
  const match = state?.match;
  const matchState = state?.matchState;
  const phase = matchState?.phase;
  const hasActiveMatch = match && phase && phase !== "idle" && phase !== "finished";
  const pendingFights = queue?.filter((e) => e.status !== "active") ?? [];
  const pendingCount = pendingFights.length;

  // Helper: given a source_ring ip:port key, return the alias of that ring
  function sourceAlias(key: string | null) {
    if (!key) return null;
    const r = rings.find((r) => `${r.target.ip}:${r.target.port}` === key);
    return r?.state?.ringAlias ?? r?.target.alias ?? key;
  }

  return (
    <Card
      className={cn(
        "transition-all relative",
        !connected && "opacity-60 border-destructive/40",
        isMoveSrc && "ring-2 ring-primary",
        isMoveDest && "ring-2 ring-yellow-500 cursor-pointer hover:bg-yellow-500/5",
        isFlashing && "ring-2 ring-green-500",
        isDragTarget && !isDraggedOver && "ring-2 ring-blue-500/40",
        isDraggedOver && "ring-2 ring-blue-500 bg-blue-500/5",
      )}
      onClick={isMoveDest ? onMoveHere : undefined}
      onDragOver={(e) => {
        if (!isDragTarget) return;
        e.preventDefault();
        onCardDragOver();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) onCardDragLeave();
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (isDragTarget) onDropFight();
      }}
    >
      {/* Flash overlay — shown briefly after a successful move */}
      {isFlashing && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-green-500/8 z-10 pointer-events-none">
          <div className="flex flex-col items-center gap-1">
            <span className="text-2xl">✓</span>
            <span className="text-xs font-semibold text-green-400">Peleas recibidas</span>
          </div>
        </div>
      )}

      {/* Destination overlay */}
      {isMoveDest && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-yellow-500/5 z-10 pointer-events-none">
          <div className="flex flex-col items-center gap-1">
            <ArrowRightLeft className="size-6 text-yellow-400" />
            <span className="text-xs font-medium text-yellow-400">Mover aquí</span>
          </div>
        </div>
      )}

      {/* Drag-over overlay */}
      {isDraggedOver && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-blue-500/10 z-10 pointer-events-none">
          <div className="flex flex-col items-center gap-1">
            <ArrowRightLeft className="size-6 text-blue-400" />
            <span className="text-xs font-medium text-blue-400">Soltar aquí</span>
          </div>
        </div>
      )}

      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          {connected ? (
            <span className="size-2.5 rounded-full bg-green-500 animate-pulse" />
          ) : (
            <span className="size-2.5 rounded-full bg-red-500" />
          )}
          <CardTitle className="text-base font-bold">{alias}</CardTitle>
          <span className="text-xs text-muted-foreground">{ringName}</span>
        </div>
        <div className="flex items-center gap-1">
          {connected ? (
            <Wifi className="size-4 text-green-500" />
          ) : (
            <WifiOff className="size-4 text-destructive" />
          )}
          {/* Move fights button — visible whenever there are pending fights */}
          {connected && moveStage === "idle" && pendingCount > 0 && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground hover:text-primary"
              title={`Reasignar peleas (${pendingCount} pendientes)`}
              onClick={onStartMove}
            >
              <ArrowRightLeft className="size-3.5" />
            </Button>
          )}
          {isMoveSrc && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground hover:text-destructive"
              onClick={onCancelMove}
            >
              <X className="size-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {!connected ? (
          <p className="text-xs text-muted-foreground">Desconectado</p>
        ) : !match ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Clock className="size-4" />
            <span className="text-sm">Sin combate activo</span>
          </div>
        ) : (
          <>
            {/* Current match */}
            <div className="flex items-center gap-2">
              <Swords className="size-4 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                {(match.category || match.matchMode) && (
                  <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                    {match.matchMode && (
                      <span className={cn(
                        "text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0 rounded",
                        match.matchMode === 'sparring'
                          ? "bg-blue-500/15 text-blue-400"
                          : "bg-purple-500/15 text-purple-400"
                      )}>
                        {match.matchMode === 'sparring' ? 'Combate' : 'Formas'}
                      </span>
                    )}
                    {match.category && (
                      <p className="text-[10px] text-muted-foreground truncate">{match.category}</p>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-1 text-sm font-medium">
                  <span className="text-red-400 truncate">{match.red.name}</span>
                  <span className="text-muted-foreground text-xs">vs</span>
                  <span className="text-blue-400 truncate">{match.blue.name}</span>
                </div>
              </div>
            </div>

            {/* Phase + timer */}
            {matchState && (
              <div className="flex items-center gap-3">
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs",
                    phase === "round" && "border-green-500/50 text-green-400",
                    phase === "rest" && "border-yellow-500/50 text-yellow-400",
                    phase === "finished" && "border-blue-500/50 text-blue-400",
                    (phase === "overtime" || phase === "golden_point") && "border-orange-500/50 text-orange-400"
                  )}
                >
                  {phaseLabel(phase ?? "idle")}
                  {matchState.currentRound > 0 && ` ${matchState.currentRound}`}
                </Badge>
                {(phase === "round" || phase === "rest" || phase === "overtime") && (
                  <span className="font-mono text-lg font-bold tabular-nums">
                    {formatTime(matchState.timeLeft)}
                  </span>
                )}
              </div>
            )}

            {/* Judge grid — igual al ring */}
            {matchState && (state?.rules?.judgesCount ?? 0) > 0 || (state?.judgeTotals && Object.keys(state.judgeTotals).length > 0) ? (
              <MiniJudgeGrid
                judgesCount={(state?.rules as { judgesCount?: number })?.judgesCount ?? state?.judges?.length ?? 4}
                judgeTotals={state?.judgeTotals ?? {}}
                judgeVotes={state?.judgeVotes ?? {}}
                connectedJudges={state?.judges ?? []}
              />
            ) : matchState && matchState.rounds.length > 0 ? (
              <div className="flex items-center gap-4 text-sm">
                <span className="text-red-400 font-bold text-xl tabular-nums">
                  {matchState.rounds.reduce((s, r) => s + r.totals.red, 0)}
                </span>
                <span className="text-xs text-muted-foreground">—</span>
                <span className="text-blue-400 font-bold text-xl tabular-nums">
                  {matchState.rounds.reduce((s, r) => s + r.totals.blue, 0)}
                </span>
              </div>
            ) : null}
          </>
        )}

        <Separator />

        {/* Judges + stats */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Users className="size-3.5" />
            <span>
              {state?.judges?.length ?? 0} jueces
            </span>
          </div>
          <span className="text-[11px]">{target.ip}:{target.port}</span>
        </div>

        {/* Completados — acordeón expandible */}
        {(state?.fallos?.length ?? 0) > 0 && (
          <CompletedFightsAccordion fallos={state!.fallos} />
        )}

        {/* Match Caller — próximas peleas / Selección para reasignación */}
        {connected && (
          <>
            <Separator />
            {pendingCount === 0 ? (
              <p className="text-[10px] text-muted-foreground text-center py-1">Sin peleas pendientes</p>
            ) : isMoveSrc ? (
              /* ── Move selection mode ── */
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                    Seleccioná peleas a mover
                  </p>
                  <span className="text-[10px] text-primary">{selectedFightIds.size} sel.</span>
                </div>
                <div className="space-y-1.5">
                  {pendingFights
                    .map((entry) => {
                      const selected = selectedFightIds.has(entry.fight.id);
                      return (
                        <button
                          key={entry.fight.id}
                          type="button"
                          className={cn(
                            "w-full rounded-md border px-2.5 py-2 flex items-center gap-2 text-left transition-colors",
                            selected
                              ? "border-primary/60 bg-primary/10"
                              : "border-border/50 bg-secondary/30 hover:border-border",
                          )}
                          onClick={() => onToggleFight(entry.fight.id)}
                        >
                          {selected ? (
                            <CheckSquare className="size-3.5 text-primary shrink-0" />
                          ) : (
                            <Square className="size-3.5 text-muted-foreground shrink-0" />
                          )}
                          <span className="text-xs flex-1 truncate">
                            <span className="text-red-400">{entry.fight.red.name}</span>
                            <span className="text-muted-foreground mx-1">vs</span>
                            <span className="text-blue-400">{entry.fight.blue.name}</span>
                          </span>
                          {entry.fight.sourceRing && (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1.5 shrink-0 border-yellow-600/50 text-yellow-400"
                            >
                              ↗ {sourceAlias(entry.fight.sourceRing)}
                            </Badge>
                          )}
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] px-1.5 shrink-0",
                              entry.status === "next" && "border-yellow-500/50 text-yellow-400",
                            )}
                          >
                            #{entry.position}
                          </Badge>
                        </button>
                      );
                    })}
                </div>
                <Button
                  size="sm"
                  className="w-full h-7 text-xs"
                  onClick={onConfirmMove}
                  disabled={selectedFightIds.size === 0}
                >
                  <ArrowRightLeft className="size-3.5 mr-1.5" />
                  Elegir destino ({selectedFightIds.size})
                </Button>
              </div>
            ) : (
              /* ── Normal Match Caller mode ── */
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                    Próximas peleas
                  </p>
                  <span className="text-[10px] text-muted-foreground">{pendingCount} pendientes</span>
                </div>
                {pendingFights
                  .slice(0, 5)
                  .map((entry) => {
                    const rowAlias = state?.ringAlias ?? ring.target.alias ?? ring.target.ip;
                    return (
                      <div
                        key={entry.fight.id}
                        className="rounded-md border border-border/50 bg-secondary/30 px-2.5 py-2 space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-muted-foreground font-mono">#{entry.position}</span>
                          <div className="flex items-center gap-1">
                            {entry.fight.sourceRing && (
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1.5 border-yellow-600/50 text-yellow-400"
                              >
                                ↗ de {sourceAlias(entry.fight.sourceRing)}
                              </Badge>
                            )}
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] px-1.5",
                                entry.status === "next" && "border-yellow-500/50 text-yellow-400",
                              )}
                            >
                              {entry.status === "next" ? "Siguiente" : "En cola"}
                            </Badge>
                          </div>
                        </div>
                        <CompetitorCallRow
                          competitor={entry.fight.red}
                          color="red"
                          calledEntry={calledMap.get(entry.fight.red.id)}
                          ringAlias={rowAlias}
                          onCall={onCall}
                          onConfirm={onConfirm}
                          onDismiss={onDismiss}
                        />
                        <CompetitorCallRow
                          competitor={entry.fight.blue}
                          color="blue"
                          calledEntry={calledMap.get(entry.fight.blue.id)}
                          ringAlias={rowAlias}
                          onCall={onCall}
                          onConfirm={onConfirm}
                          onDismiss={onDismiss}
                        />
                      </div>
                    );
                  })}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Competitor Call Row ──────────────────────────────────────────────────────

interface CompetitorCallRowProps {
  competitor: { id: string; name: string };
  color: "red" | "blue";
  calledEntry: CalledEntry | undefined;
  ringAlias: string;
  onCall: (id: string, name: string, alias: string) => void;
  onConfirm: (id: string) => void;
  onDismiss: (id: string) => void;
}

function CompetitorCallRow({ competitor, color, calledEntry, ringAlias, onCall, onConfirm, onDismiss }: CompetitorCallRowProps) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "text-xs font-medium truncate flex-1",
          color === "red" ? "text-red-400" : "text-blue-400",
        )}
      >
        {competitor.name}
      </span>
      {!calledEntry ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground shrink-0"
          onClick={() => onCall(competitor.id, competitor.name, ringAlias)}
        >
          Llamar
        </Button>
      ) : calledEntry.confirmed ? (
        <div className="flex items-center gap-1 shrink-0">
          <Badge variant="secondary" className="text-[10px] px-1.5 text-green-400 border-green-500/30">
            ✓ Presente
          </Badge>
          <Button size="icon" variant="ghost" className="size-5 text-muted-foreground" onClick={() => onDismiss(competitor.id)}>
            <Trash2 className="size-3" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1 shrink-0">
          <Badge variant="outline" className="text-[10px] px-1.5 text-yellow-400 border-yellow-500/30">
            📢 {calledEntry.calledAt}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px] text-green-400 hover:text-green-300"
            onClick={() => onConfirm(competitor.id)}
          >
            ✓
          </Button>
          <Button size="icon" variant="ghost" className="size-5 text-muted-foreground" onClick={() => onDismiss(competitor.id)}>
            <Trash2 className="size-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Double Start Check ───────────────────────────────────────────────────────

function findDuplicateCompetitors(
  rings: RingLiveState[],
  queues: Map<string, QueueEntry[]>,
): Array<{ name: string; rings: string[] }> {
  const competitorRings = new Map<string, { name: string; rings: string[] }>();

  function register(cId: string, name: string, alias: string) {
    const existing = competitorRings.get(cId);
    if (existing) {
      if (!existing.rings.includes(alias)) existing.rings.push(alias);
    } else {
      competitorRings.set(cId, { name, rings: [alias] });
    }
  }

  for (const ring of rings) {
    if (!ring.connected) continue;
    const alias = ring.state?.ringAlias ?? ring.target.alias ?? ring.target.ip;

    // Pelea activa
    if (ring.state?.match) {
      const { red, blue } = ring.state.match;
      register(red.id, red.name, alias);
      register(blue.id, blue.name, alias);
    }

    // Próximas 3 peleas en cola
    const queue = queues.get(`${ring.target.ip}:${ring.target.port}`);
    for (const entry of queue?.slice(0, 3) ?? []) {
      if (entry.status === "active") continue;
      register(entry.fight.red.id, entry.fight.red.name, alias);
      register(entry.fight.blue.id, entry.fight.blue.name, alias);
    }
  }

  return Array.from(competitorRings.values()).filter((c) => c.rings.length > 1);
}

// ── Mini Judge Grid (Mesa Central) ───────────────────────────────────────────

interface MiniJudgeGridProps {
  judgesCount: number;
  connectedJudges: string[];
  judgeTotals: Record<string, { red: number; blue: number }>;
  judgeVotes: Record<string, string>;
}

function MiniJudgeGrid({ judgesCount, connectedJudges, judgeTotals, judgeVotes }: Readonly<MiniJudgeGridProps>) {
  const count = Math.max(judgesCount, Object.keys(judgeTotals).length, Object.keys(judgeVotes).length, 1);
  const ids = Array.from({ length: count }, (_, i) => `J${i + 1}`);

  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(count, 4)}, 1fr)` }}>
      {ids.map((jid) => {
        const totals = judgeTotals?.[jid] ?? { red: 0, blue: 0 };
        const vote = judgeVotes?.[jid];
        const hasPoints = totals.red > 0 || totals.blue > 0;
        const leading = totals.red > totals.blue ? "red" : totals.blue > totals.red ? "blue" : "tied";
        const isConn = connectedJudges.includes(jid);

        const bg =
          hasPoints && leading === "red" ? "bg-red-700/80 border-red-600"
          : hasPoints && leading === "blue" ? "bg-blue-700/80 border-blue-600"
          : vote === "red" ? "bg-red-700/80 border-red-600"
          : vote === "blue" ? "bg-blue-700/80 border-blue-600"
          : "bg-secondary/50 border-border";

        return (
          <div key={jid} className={cn("rounded-lg border px-2 py-2 flex flex-col items-center gap-1 transition-all", bg)}>
            <div className="flex items-center justify-between w-full">
              <span className="text-[10px] font-bold text-white/70">{jid}</span>
              <span className={cn("size-1.5 rounded-full", isConn ? "bg-green-400" : "bg-white/20")} />
            </div>
            {hasPoints ? (
              <div className="flex items-center gap-1 text-xs font-black tabular-nums">
                <span className={cn(leading === "red" ? "text-white" : "text-white/40")}>R{totals.red}</span>
                <span className="text-white/20">·</span>
                <span className={cn(leading === "blue" ? "text-white" : "text-white/40")}>B{totals.blue}</span>
              </div>
            ) : (
              <span className="text-xs font-black text-white/80">
                {vote === "red" ? "🔴" : vote === "blue" ? "🔵" : vote === "draw" ? "🤝" : "—"}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Consolidated Results Panel ───────────────────────────────────────────────

function computeConsolidatedStandings(ringResults: RingResults[]): ConsolidatedStanding[] {
  const map = new Map<string, ConsolidatedStanding>();

  function get(name: string): ConsolidatedStanding {
    if (!map.has(name)) map.set(name, { name, wins: 0, losses: 0, draws: 0, fought: 0, points: 0 });
    return map.get(name)!;
  }

  for (const ring of ringResults) {
    for (const f of ring.fallos) {
      const red = get(f.redName);
      const blue = get(f.blueName);
      red.fought++;
      blue.fought++;
      if (f.winner === f.redName) {
        red.wins++;
        red.points += 3;
        blue.losses++;
      } else if (f.winner === f.blueName) {
        blue.wins++;
        blue.points += 3;
        red.losses++;
      } else {
        red.draws++;
        red.points += 1;
        blue.draws++;
        blue.points += 1;
      }
    }
  }

  return [...map.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || a.losses - b.losses);
}

function exportConsolidatedHTML(ringResults: RingResults[], standings: ConsolidatedStanding[]) {
  const date = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" });
  const totalFights = ringResults.reduce((s, r) => s + r.fallos.length, 0);

  const podiumRows = standings.slice(0, 3).map((s, i) => {
    const medal = ["🥇", "🥈", "🥉"][i];
    return `<tr class="podium-${i + 1}"><td>${medal}</td><td><strong>${s.name}</strong></td><td>${s.wins}G / ${s.losses}P</td></tr>`;
  }).join("\n");

  const standingRows = standings.map((s, i) =>
    `<tr><td>${i + 1}</td><td>${s.name}</td><td>${s.fought}</td><td><strong>${s.points}</strong></td><td>${s.wins}</td><td>${s.losses}</td><td>${s.draws}</td></tr>`
  ).join("\n");

  const tatamisSections = ringResults.map((ring) => {
    if (ring.fallos.length === 0) return "";
    const rows = ring.fallos.map((f, i) =>
      `<tr><td>${i + 1}</td><td>${f.redName}</td><td>${f.blueName}</td><td>${f.winner}</td><td>${f.redScore} — ${f.blueScore}</td></tr>`
    ).join("\n");
    return `<h3>Tatami ${ring.alias} (${ring.ip}:${ring.port})</h3>
<table>
  <thead><tr><th>#</th><th>Rojo</th><th>Azul</th><th>Ganador</th><th>Puntos</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Resultados Consolidados — TKD</title>
<style>
  :root { --gold: #f59e0b; --silver: #94a3b8; --bronze: #b45309; }
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 2rem; background: #0f172a; color: #e2e8f0; }
  h1 { color: #f59e0b; } h2 { border-bottom: 1px solid #334155; padding-bottom: 0.5rem; margin-top: 2.5rem; } h3 { color: #94a3b8; margin-top: 1.5rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; }
  th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #1e293b; font-size: 0.875rem; }
  th { background: #1e293b; color: #94a3b8; font-weight: 600; }
  .podium-1 td { color: var(--gold); font-size: 1rem; } .podium-2 td { color: var(--silver); } .podium-3 td { color: var(--bronze); }
  .subtitle { color: #94a3b8; font-size: 0.875rem; margin-bottom: 2rem; }
  @media print { body { background: white; color: black; } th { background: #f1f5f9; color: #334155; } h3 { color: #475569; } }
</style>
</head>
<body>
<h1>🥋 Resultados Consolidados — Multi-Tatami</h1>
<p class="subtitle">Generado el ${date} · ${totalFights} combates · ${ringResults.length} tatamis</p>

<h2>🏆 Podio</h2>
<table>
  <thead><tr><th>#</th><th>Competidor</th><th>Balance</th></tr></thead>
  <tbody>${podiumRows}</tbody>
</table>

<h2>📊 Clasificación consolidada</h2>
<table>
  <thead><tr><th>Pos</th><th>Nombre</th><th>PJ</th><th style="color:var(--gold)">Pts</th><th>PG</th><th>PP</th><th>PE</th></tr></thead>
  <tbody>${standingRows}</tbody>
</table>

<h2>📋 Combates por tatami</h2>
${tatamisSections}

<p style="margin-top:3rem;color:#475569;font-size:0.75rem;text-align:center">TKD Tournament System — Mesa Central</p>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `resultados_consolidados_${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

interface ConsolidatedResultsPanelProps {
  ringResults: RingResults[];
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

function ConsolidatedResultsPanel({ ringResults, loading, onClose, onRefresh }: Readonly<ConsolidatedResultsPanelProps>) {
  const standings = computeConsolidatedStandings(ringResults);
  const totalFights = ringResults.reduce((s, r) => s + r.fallos.length, 0);

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/50" onClick={onClose} />

      {/* Panel */}
      <div className="w-[520px] max-w-full bg-background border-l border-border flex flex-col shadow-2xl">
        {/* Header */}
        <div className="h-14 flex items-center gap-3 px-4 border-b border-border shrink-0">
          <Trophy className="size-5 text-yellow-400" />
          <span className="font-bold text-sm">Resultados Consolidados</span>
          <Badge variant="outline" className="text-[10px]">{ringResults.length} tatamis · {totalFights} combates</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="icon" variant="ghost" className="size-8" onClick={onRefresh} disabled={loading} title="Actualizar">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => exportConsolidatedHTML(ringResults, standings)}
              disabled={totalFights === 0}
            >
              <Download className="size-3.5 mr-1" />
              Exportar HTML
            </Button>
            <Button size="icon" variant="ghost" className="size-8" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-5">
            {totalFights === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Trophy className="size-10 mx-auto mb-3 opacity-20" />
                <p className="text-sm">Sin combates completados aún</p>
              </div>
            ) : (
              <>
                {/* Podio */}
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium mb-3">Podio</p>
                  <div className="flex gap-3">
                    {standings.slice(0, 3).map((s, i) => {
                      const medals = ["🥇", "🥈", "🥉"];
                      const colors = ["text-yellow-400", "text-gray-300", "text-amber-600"];
                      return (
                        <div key={s.name} className="flex-1 rounded-lg border border-border bg-secondary/30 p-3 text-center">
                          <div className="text-2xl">{medals[i]}</div>
                          <p className={`text-sm font-bold mt-1 ${colors[i]}`}>{s.name}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{s.wins}G / {s.losses}P</p>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Clasificación completa */}
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium mb-2">Clasificación</p>
                  <div className="rounded-lg border border-border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-secondary/50">
                          <th className="px-3 py-2 text-left text-muted-foreground font-medium w-8">#</th>
                          <th className="px-3 py-2 text-left text-muted-foreground font-medium">Competidor</th>
                          <th className="px-3 py-2 text-center text-yellow-400 font-medium">Pts</th>
                          <th className="px-3 py-2 text-center text-green-400 font-medium">G</th>
                          <th className="px-3 py-2 text-center text-red-400 font-medium">P</th>
                          <th className="px-3 py-2 text-center text-muted-foreground font-medium">E</th>
                          <th className="px-3 py-2 text-center text-muted-foreground font-medium">PJ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {standings.map((s, i) => (
                          <tr key={s.name} className="border-t border-border/50 hover:bg-secondary/20">
                            <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                            <td className="px-3 py-2 font-medium">{s.name}</td>
                            <td className="px-3 py-2 text-center font-black text-yellow-400 text-base">{s.points}</td>
                            <td className="px-3 py-2 text-center text-green-400 font-bold">{s.wins}</td>
                            <td className="px-3 py-2 text-center text-red-400">{s.losses}</td>
                            <td className="px-3 py-2 text-center text-muted-foreground">{s.draws}</td>
                            <td className="px-3 py-2 text-center text-muted-foreground">{s.fought}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Combates por tatami */}
                {ringResults.map((ring) => ring.fallos.length > 0 && (
                  <div key={`${ring.ip}:${ring.port}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                        Tatami {ring.alias}
                      </p>
                      <span className="text-[10px] text-muted-foreground">({ring.ip}:{ring.port})</span>
                      <Badge variant="outline" className="text-[10px] px-1.5">{ring.fallos.length} combates</Badge>
                    </div>
                    <div className="rounded-lg border border-border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-secondary/50">
                            <th className="px-3 py-2 text-left text-muted-foreground font-medium">#</th>
                            <th className="px-3 py-2 text-left text-red-400 font-medium">Rojo</th>
                            <th className="px-3 py-2 text-left text-blue-400 font-medium">Azul</th>
                            <th className="px-3 py-2 text-left text-muted-foreground font-medium">Ganador</th>
                            <th className="px-3 py-2 text-center text-muted-foreground font-medium">Pts</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ring.fallos.map((f, i) => (
                            <tr key={f.id} className="border-t border-border/50 hover:bg-secondary/20">
                              <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                              <td className={cn("px-3 py-2", f.winner === f.redName && "text-green-400 font-bold")}>{f.redName}</td>
                              <td className={cn("px-3 py-2", f.winner === f.blueName && "text-green-400 font-bold")}>{f.blueName}</td>
                              <td className="px-3 py-2 font-medium">{f.winner}</td>
                              <td className="px-3 py-2 text-center text-muted-foreground font-mono">{f.redScore}–{f.blueScore}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
