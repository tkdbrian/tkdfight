import * as React from "react";
import { cn } from "@/lib/utils";
import type { BracketMatch } from "@/store/tournament";

interface BracketViewProps {
  matches: BracketMatch[];
  competitors: { id: string; name: string }[];
  onSelectMatch?: (matchId: string) => void;
  currentMatchId?: string;
  onSwap?: (aMatchId: string, aSlot: "red" | "blue", bMatchId: string, bSlot: "red" | "blue") => void;
}

const MATCH_W = 160;
const MATCH_H = 60;
const ROUND_GAP = 80;
const MATCH_V_GAP = 20;
const DRAG_THRESHOLD = 5;

function getRoundLabel(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - 1 - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semifinal";
  if (fromEnd === 2) return "Cuartos";
  return `R${round + 1}`;
}

function competitorName(slot: BracketMatch["red"]): string {
  if (slot.competitor) return slot.competitor.name;
  if (slot.fromMatchId) return "Ganador...";
  return "BYE";
}

function slotFill(isWinner: boolean, hasCompetitor: boolean, fromMatchId: string | undefined): string {
  if (isWinner) return "#4ade80";
  if (!hasCompetitor && fromMatchId) return "hsl(var(--muted-foreground))";
  if (!hasCompetitor) return "hsl(var(--muted-foreground)/0.4)";
  return "hsl(var(--foreground))";
}

function getMatchX(round: number): number {
  return ROUND_GAP / 2 + round * (MATCH_W + ROUND_GAP);
}

function getMatchY(round: number, position: number, roundSizes: number[], svgHeight: number): number {
  const count = roundSizes[round] ?? 1;
  const totalH = count * (MATCH_H + MATCH_V_GAP) - MATCH_V_GAP;
  const startY = (svgHeight - totalH) / 2;
  return startY + position * (MATCH_H + MATCH_V_GAP);
}

type DragState = {
  matchId: string;
  slot: "red" | "blue";
  name: string;
  startClientX: number;
  startClientY: number;
  svgX: number;
  svgY: number;
  active: boolean;
  hoverTarget: { matchId: string; slot: "red" | "blue" } | null;
};

export function BracketView({
  matches,
  onSelectMatch,
  currentMatchId,
  onSwap,
}: Readonly<BracketViewProps>) {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [drag, setDrag] = React.useState<DragState | null>(null);

  if (matches.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        No hay bracket generado todavía.
      </div>
    );
  }

  const totalRounds = (matches.at(-1)?.round ?? 0) + 1;
  const roundSizes = Array.from({ length: totalRounds }, (_, r) =>
    matches.filter((m) => m.round === r).length
  );
  const round0Count = roundSizes[0] ?? 1;
  const svgHeight = round0Count * (MATCH_H + MATCH_V_GAP) + MATCH_V_GAP;
  const svgWidth = totalRounds * (MATCH_W + ROUND_GAP) + ROUND_GAP;

  function toSvgCoords(clientX: number, clientY: number) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function getSlotAt(svgX: number, svgY: number): { matchId: string; slot: "red" | "blue" } | null {
    for (const match of matches) {
      if (match.round !== 0 || match.completed) continue;
      const x = getMatchX(match.round);
      const y = getMatchY(match.round, match.position, roundSizes, svgHeight);
      if (svgX >= x && svgX <= x + MATCH_W) {
        if (svgY >= y && svgY <= y + MATCH_H / 2) return { matchId: match.id, slot: "red" };
        if (svgY > y + MATCH_H / 2 && svgY <= y + MATCH_H) return { matchId: match.id, slot: "blue" };
      }
    }
    return null;
  }

  function handleSlotPointerDown(
    e: React.PointerEvent<SVGRectElement>,
    matchId: string,
    slot: "red" | "blue",
    name: string,
  ) {
    if (!onSwap) return;
    e.stopPropagation();
    e.preventDefault();
    const { x, y } = toSvgCoords(e.clientX, e.clientY);
    svgRef.current?.setPointerCapture(e.pointerId);
    setDrag({ matchId, slot, name, startClientX: e.clientX, startClientY: e.clientY, svgX: x, svgY: y, active: false, hoverTarget: null });
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!drag) return;
    const { x, y } = toSvgCoords(e.clientX, e.clientY);
    const dist = Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY);
    const active = drag.active || dist > DRAG_THRESHOLD;
    const hoverTarget = active ? getSlotAt(x, y) : null;
    setDrag((prev) => prev ? { ...prev, svgX: x, svgY: y, active, hoverTarget } : null);
  }

  function handlePointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (!drag) return;
    if (drag.active && onSwap) {
      const { x, y } = toSvgCoords(e.clientX, e.clientY);
      const target = getSlotAt(x, y);
      if (target && (target.matchId !== drag.matchId || target.slot !== drag.slot)) {
        onSwap(drag.matchId, drag.slot, target.matchId, target.slot);
      }
    }
    setDrag(null);
  }

  const lines: React.ReactElement[] = [];
  for (const match of matches) {
    const x = getMatchX(match.round);
    const y = getMatchY(match.round, match.position, roundSizes, svgHeight);
    const midY = y + MATCH_H / 2;
    const rightX = x + MATCH_W;

    const nextMatch = matches.find(
      (m) => m.red.fromMatchId === match.id || m.blue.fromMatchId === match.id
    );
    if (nextMatch) {
      const nx = getMatchX(nextMatch.round);
      const ny = getMatchY(nextMatch.round, nextMatch.position, roundSizes, svgHeight);
      const isRedSlot = nextMatch.red.fromMatchId === match.id;
      const targetY = ny + (isRedSlot ? MATCH_H * 0.25 : MATCH_H * 0.75);
      const midX = rightX + ROUND_GAP / 2;

      lines.push(
        <path
          key={`line-${match.id}`}
          d={`M ${rightX} ${midY} H ${midX} V ${targetY} H ${nx}`}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth={1.5}
        />
      );
    }
  }

  const isDragging = drag?.active ?? false;

  return (
    <div className="overflow-auto w-full">
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: game board SVG — decorative, not semantic content */}
      <svg
        ref={svgRef}
        width={svgWidth}
        height={svgHeight}
        className="block"
        style={{ minWidth: svgWidth, cursor: isDragging ? "grabbing" : "default", touchAction: "none" }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        {Array.from({ length: totalRounds }, (_, round) => (
          <text
            key={`round-label-r${round}`}
            x={getMatchX(round) + MATCH_W / 2}
            y={12}
            textAnchor="middle"
            fontSize={10}
            fill="hsl(var(--muted-foreground))"
          >
            {getRoundLabel(round, totalRounds)}
          </text>
        ))}

        {lines}

        {matches.map((match) => {
          const x = getMatchX(match.round);
          const y = getMatchY(match.round, match.position, roundSizes, svgHeight);
          const isCurrent = match.id === currentMatchId;
          const isCompleted = match.completed;
          const redIsWinner = isCompleted && match.winnerId === match.red.competitor?.id;
          const blueIsWinner = isCompleted && match.winnerId === match.blue.competitor?.id;
          const strokeColor = isCurrent ? "hsl(var(--primary))" : "hsl(var(--border))";
          const canDrag = !isCompleted && match.round === 0 && !!onSwap;

          const redIsDragSource = drag?.matchId === match.id && drag.slot === "red";
          const blueIsDragSource = drag?.matchId === match.id && drag.slot === "blue";
          const redIsHover = isDragging && drag?.hoverTarget?.matchId === match.id && drag.hoverTarget.slot === "red";
          const blueIsHover = isDragging && drag?.hoverTarget?.matchId === match.id && drag.hoverTarget.slot === "blue";

          return (
            <g
              key={match.id}
              onClick={() => !isDragging && onSelectMatch?.(match.id)}
              className={cn(onSelectMatch && !isDragging && "cursor-pointer")}
            >
              <rect
                x={x} y={y}
                width={MATCH_W} height={MATCH_H}
                rx={6}
                fill={isCurrent ? "hsl(var(--accent))" : "hsl(var(--card))"}
                stroke={strokeColor}
                strokeWidth={isCurrent ? 2 : 1}
              />
              {/* Drop-target highlight */}
              {redIsHover && (
                <rect x={x + 1} y={y + 1} width={MATCH_W - 2} height={MATCH_H / 2 - 1} rx={5}
                  fill="hsl(var(--primary)/0.2)" stroke="hsl(var(--primary))" strokeWidth={2} strokeDasharray="4 2" />
              )}
              {blueIsHover && (
                <rect x={x + 1} y={y + MATCH_H / 2} width={MATCH_W - 2} height={MATCH_H / 2 - 1} rx={5}
                  fill="hsl(var(--primary)/0.2)" stroke="hsl(var(--primary))" strokeWidth={2} strokeDasharray="4 2" />
              )}
              <line
                x1={x} y1={y + MATCH_H / 2}
                x2={x + MATCH_W} y2={y + MATCH_H / 2}
                stroke="hsl(var(--border))" strokeWidth={1}
              />
              <text
                x={x + 8} y={y + MATCH_H * 0.32}
                fontSize={11}
                fill={slotFill(redIsWinner, !!match.red.competitor, match.red.fromMatchId)}
                fontWeight={redIsWinner ? "bold" : "normal"}
                opacity={redIsDragSource && isDragging ? 0.25 : 1}
              >
                {competitorName(match.red).substring(0, 18)}
              </text>
              <text
                x={x + 8} y={y + MATCH_H * 0.72}
                fontSize={11}
                fill={slotFill(blueIsWinner, !!match.blue.competitor, match.blue.fromMatchId)}
                fontWeight={blueIsWinner ? "bold" : "normal"}
                opacity={blueIsDragSource && isDragging ? 0.25 : 1}
              >
                {competitorName(match.blue).substring(0, 18)}
              </text>
              {isCurrent && (
                <circle cx={x + MATCH_W - 8} cy={y + 8} r={4} fill="hsl(var(--primary))" />
              )}
              {/* Drag handle hint */}
              {canDrag && (match.red.competitor || match.blue.competitor) && (
                <text x={x + MATCH_W - 8} y={y + MATCH_H / 2} fontSize={10}
                  fill="hsl(var(--muted-foreground)/0.4)" textAnchor="middle"
                  dominantBaseline="middle" pointerEvents="none">⠿</text>
              )}
              {/* Invisible drag areas */}
              {canDrag && (
                <>
                  <rect
                    x={x} y={y} width={MATCH_W} height={MATCH_H / 2}
                    fill="transparent"
                    style={{ cursor: match.red.competitor ? "grab" : "default" }}
                    onPointerDown={match.red.competitor
                      ? (e) => handleSlotPointerDown(e, match.id, "red", match.red.competitor?.name ?? "")
                      : undefined}
                  />
                  <rect
                    x={x} y={y + MATCH_H / 2} width={MATCH_W} height={MATCH_H / 2}
                    fill="transparent"
                    style={{ cursor: match.blue.competitor ? "grab" : "default" }}
                    onPointerDown={match.blue.competitor
                      ? (e) => handleSlotPointerDown(e, match.id, "blue", match.blue.competitor?.name ?? "")
                      : undefined}
                  />
                </>
              )}
            </g>
          );
        })}

        {/* Ghost element while dragging */}
        {drag?.active && (
          <g pointerEvents="none">
            <rect
              x={drag.svgX - MATCH_W / 2} y={drag.svgY - MATCH_H / 4}
              width={MATCH_W} height={MATCH_H / 2}
              rx={5} fill="hsl(var(--primary))" opacity={0.9}
            />
            <text
              x={drag.svgX} y={drag.svgY + 5}
              textAnchor="middle" fontSize={11}
              fill="white" fontWeight="bold"
            >
              {drag.name.substring(0, 18)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}


