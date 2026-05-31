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

const MATCH_W = 200;
const MATCH_H = 80;
const ROUND_GAP = 90;
const MATCH_V_GAP = 24;
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

// Standard bracket Y: each match in round R is centered between the two
// R-1 matches that feed it. step doubles each round so spacing grows naturally.
const TOP_PADDING = 30;
function getMatchY(round: number, position: number): number {
  const step = (MATCH_H + MATCH_V_GAP) * (2 ** round);
  return TOP_PADDING + position * step + (step - MATCH_H) / 2;
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
  // Prevents the <g> onClick from double-firing after handlePointerUp already selected the match
  const suppressNextClick = React.useRef(false);

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

  // Competitor slot numbers (1..bracketSize) — one per row in every match.
  const bracketSize = Math.max(16, 2 ** totalRounds);
  function getSlotNumber(round: number, position: number, slot: "red" | "blue"): number {
    // Each match occupies 2 consecutive slot numbers
    const slotsPerMatch = 2;
    let cumulative = 0;
    for (let r = 0; r < round; r++) cumulative += (bracketSize / 2 ** r);
    return cumulative + position * slotsPerMatch + (slot === "red" ? 1 : 2);
  }
  const round0Count = roundSizes[0] ?? 1;
  const svgHeight = TOP_PADDING + round0Count * (MATCH_H + MATCH_V_GAP);
  const SLOT_LABEL_W = 22; // extra left margin for slot numbers
  const svgWidth = SLOT_LABEL_W + totalRounds * (MATCH_W + ROUND_GAP) + ROUND_GAP;

  function toSvgCoords(clientX: number, clientY: number) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    // Account for viewBox scaling: map client coords to SVG internal coords
    const scaleX = svgWidth / rect.width;
    const scaleY = svgHeight / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  function getSlotAt(svgX: number, svgY: number): { matchId: string; slot: "red" | "blue" } | null {
    for (const match of matches) {
      if (match.round !== 0 || match.completed) continue;
      const x = getMatchX(match.round);
      const y = getMatchY(match.round, match.position);
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
    // Do NOT call e.preventDefault() here — it would suppress the click event
    // that triggers onSelectMatch on the parent <g> element.
    // setPointerCapture is sufficient to handle drag without default prevention.
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
    } else if (!drag.active) {
      // Tap on a R1 match (no drag happened) — select it.
      // Pointer capture on the SVG can prevent click from bubbling through
      // drag rects, so we handle selection here instead.
      suppressNextClick.current = true;
      onSelectMatch?.(drag.matchId);
    }
    setDrag(null);
  }

  const lines: React.ReactElement[] = [];
  for (const match of matches) {
    const x = getMatchX(match.round);
    const y = getMatchY(match.round, match.position);
    const midY = y + MATCH_H / 2;
    const rightX = x + MATCH_W;

    const nextMatch = matches.find(
      (m) => m.red.fromMatchId === match.id || m.blue.fromMatchId === match.id
    );
    if (nextMatch) {
      const nx = getMatchX(nextMatch.round);
      const ny = getMatchY(nextMatch.round, nextMatch.position);
      const isRedSlot = nextMatch.red.fromMatchId === match.id;
      const targetY = ny + (isRedSlot ? MATCH_H * 0.25 : MATCH_H * 0.75);
      const midX = rightX + ROUND_GAP / 2;

      lines.push(
        <g key={`line-${match.id}`}>
          <path
            d={`M ${rightX} ${midY} H ${midX} V ${targetY} H ${nx}`}
            fill="none"
            stroke="hsl(var(--border))"
            strokeWidth={1.5}
          />
        </g>
      );
    } else {
      lines.push(
        <path
          key={`line-final-${match.id}`}
          d={`M ${rightX} ${midY}`}
          fill="none"
          stroke="none"
        />
      );
    }
  }

  const isDragging = drag?.active ?? false;

  return (
    <div className="overflow-x-auto w-full">
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: game board SVG — decorative, not semantic content */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        width="100%"
        className="block"
        style={{ minWidth: svgWidth, cursor: isDragging ? "grabbing" : "default", touchAction: "none" }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        <g transform={`translate(${SLOT_LABEL_W}, 0)`}>
        {Array.from({ length: totalRounds }, (_, round) => (
          <text
            key={`round-label-r${round}`}
            x={getMatchX(round) + MATCH_W / 2}
            y={16}
            textAnchor="middle"
            fontSize={13}
            fill="hsl(var(--muted-foreground))"
          >
            {getRoundLabel(round, totalRounds)}
          </text>
        ))}

        {lines}

        {matches.map((match) => {
          const x = getMatchX(match.round);
          const y = getMatchY(match.round, match.position);
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
              onClick={() => {
                if (suppressNextClick.current) { suppressNextClick.current = false; return; }
                if (!isDragging) onSelectMatch?.(match.id);
              }}
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
                x={x + 10} y={y + MATCH_H * 0.32}
                fontSize={14}
                fill={slotFill(redIsWinner, !!match.red.competitor, match.red.fromMatchId)}
                fontWeight={redIsWinner ? "bold" : "normal"}
                opacity={redIsDragSource && isDragging ? 0.25 : 1}
              >
                {competitorName(match.red).substring(0, 22)}
              </text>
              {/* Slot number left of red row */}
              <text
                x={x - 5} y={y + MATCH_H * 0.32}
                textAnchor="end"
                fontSize={11}
                fontWeight="600"
                fill="hsl(var(--muted-foreground)/0.6)"
                pointerEvents="none"
              >
                {getSlotNumber(match.round, match.position, "red")}
              </text>
              <text
                x={x + 10} y={y + MATCH_H * 0.72}
                fontSize={14}
                fill={slotFill(blueIsWinner, !!match.blue.competitor, match.blue.fromMatchId)}
                fontWeight={blueIsWinner ? "bold" : "normal"}
                opacity={blueIsDragSource && isDragging ? 0.25 : 1}
              >
                {competitorName(match.blue).substring(0, 22)}
              </text>
              {/* Slot number left of blue row */}
              <text
                x={x - 5} y={y + MATCH_H * 0.72}
                textAnchor="end"
                fontSize={11}
                fontWeight="600"
                fill="hsl(var(--muted-foreground)/0.6)"
                pointerEvents="none"
              >
                {getSlotNumber(match.round, match.position, "blue")}
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
      </g>
      </svg>
    </div>
  );
}


