import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JefeMesaPanel } from "@/pages/FightPage";

afterEach(cleanup);

describe("corrección de banderines en mesa", () => {
  const roundFlags = [{ red: 3, blue: 1, winner: "red" }];

  it("hides round undo after a finished bout has a durable pending result", () => {
    render(<JefeMesaPanel
      judgesCount={4}
      judgeVotes={{}}
      roundFlags={roundFlags}
      phase="finished"
      pendingJuryDecision={false}
      onEmit={vi.fn()}
      mode="porjuez"
    />);
    expect(screen.queryByRole("button", { name: /Deshacer R1/i })).toBeNull();
  });

  it("keeps round undo available between rounds before a result exists", () => {
    render(<JefeMesaPanel
      judgesCount={4}
      judgeVotes={{}}
      roundFlags={roundFlags}
      phase="rest"
      pendingJuryDecision={false}
      onEmit={vi.fn()}
      mode="porjuez"
    />);
    expect(screen.getByRole("button", { name: /Deshacer R1/i })).toBeTruthy();
  });
});
