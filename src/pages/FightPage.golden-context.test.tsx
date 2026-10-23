import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoldenPointMatch } from "@/engine/match-machine";
import type { RuleSetSparring } from "@/engine/types";
import type { ServerState } from "@/lib/socket-types";
import {
  hasConfirmedGoldenOutcomeUpdate,
  JefeMesaPanel,
  withMatchContext,
} from "@/pages/FightPage";
import itfRules from "@/rules/rules/rules_sparring_itf_baseline.json";

afterEach(cleanup);

const baseProps = {
  judgesCount: 4,
  judgeVotes: {},
  roundFlags: [],
  phase: "golden_point",
  pendingJuryDecision: false,
  onEmit: vi.fn(),
  mode: "porjuez" as const,
};

describe("Punto de Oro revisable desde jefe de mesa", () => {
  it("includes category and match identity in vote and outcome commands", () => {
    expect(
      withMatchContext(
        "mesa:goldenVote",
        {
          judgeId: "J1",
          competitor: "red",
          attempt: 2,
        },
        "category-1",
        "match-1"
      )
    ).toEqual({
      judgeId: "J1",
      competitor: "red",
      attempt: 2,
      categoryId: "category-1",
      matchId: "match-1",
    });
    expect(
      withMatchContext(
        "mesa:confirmGoldenOutcome",
        {
          attempt: 2,
        },
        "category-1",
        "match-1"
      )
    ).toEqual({
      attempt: 2,
      categoryId: "category-1",
      matchId: "match-1",
    });
  });

  it("lets the chief replace an erroneous third vote before confirming a winner", () => {
    const onGoldenVote = vi.fn();
    const onConfirmGoldenOutcome = vi.fn();
    const props = { ...baseProps, onGoldenVote, onConfirmGoldenOutcome };
    const { rerender } = render(
      <JefeMesaPanel
        {...props}
        goldenPoint={{ attempt: 1, votes: { J1: "red", J2: "red", J3: "red" } }}
      />
    );

    expect(screen.getByTestId("gp-provisional").textContent).toMatch(/todavía no confirmado/i);
    expect(screen.getByTestId("gp-votes").textContent).toContain("3 — 0");
    expect(screen.getByTestId("gp-confirm-outcome").textContent).toMatch(/Confirmar ganador rojo/);
    expect(onConfirmGoldenOutcome).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("gp-vote-J3-blue"));
    expect(onGoldenVote).toHaveBeenCalledWith("J3", "blue", 1);
    expect(onConfirmGoldenOutcome).not.toHaveBeenCalled();

    rerender(
      <JefeMesaPanel
        {...props}
        goldenPoint={{ attempt: 1, votes: { J1: "red", J2: "red", J3: "blue" } }}
      />
    );
    expect(screen.getByTestId("gp-votes").textContent).toContain("2 — 1");
    expect(screen.getByTestId("gp-confirm-outcome").hasAttribute("disabled")).toBe(true);
  });

  it("requires explicit confirmation for a complete 2–2 before the next attempt", () => {
    const onGoldenVote = vi.fn();
    const onConfirmGoldenOutcome = vi.fn();
    render(
      <JefeMesaPanel
        {...baseProps}
        onGoldenVote={onGoldenVote}
        onConfirmGoldenOutcome={onConfirmGoldenOutcome}
        goldenPoint={{ attempt: 3, votes: { J1: "red", J2: "red", J3: "blue", J4: "blue" } }}
      />
    );

    expect(screen.getByTestId("gp-votes").textContent).toContain("2 — 2");
    expect(screen.getByTestId("gp-confirm-outcome").textContent).toMatch(
      /Confirmar empate y seguir/
    );
    expect(onConfirmGoldenOutcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("gp-confirm-outcome"));
    expect(onConfirmGoldenOutcome).toHaveBeenCalledWith(3);
    expect(onGoldenVote).not.toHaveBeenCalled();
  });

  it("locks voting while waiting for the server acknowledgement", () => {
    render(
      <JefeMesaPanel
        {...baseProps}
        onGoldenVote={vi.fn()}
        onConfirmGoldenOutcome={vi.fn()}
        goldenActionPending
        goldenPoint={{ attempt: 1, votes: { J1: "red", J2: "red", J3: "red" } }}
      />
    );
    expect(screen.getByTestId("gp-vote-J4-blue").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("gp-confirm-outcome").hasAttribute("disabled")).toBe(true);
  });

  it("accepts an idempotent 2–2 retry even if the next attempt already has votes", () => {
    const next: ServerState = {
      rules: null,
      match: {
        id: "match-1",
        ringId: "PREVIEW",
        red: { id: "red-1", name: "Rojo" },
        blue: { id: "blue-1", name: "Azul" },
      },
      categoryId: "category-1",
      matchState: {
        ...createGoldenPointMatch(itfRules as RuleSetSparring),
        goldenPoint: { attempt: 4, votes: { J1: "blue" } },
      },
      matchPaused: false,
      judges: [],
      judgeVotes: {},
      judgeTotals: {},
      penaltyCounts: { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } },
      fallos: [],
      roundFlags: [],
      serverUrl: "",
    };

    expect(hasConfirmedGoldenOutcomeUpdate(next, "category-1", "match-1", 3, null)).toBe(true);
    expect(hasConfirmedGoldenOutcomeUpdate(next, "category-1", "match-1", 4, null)).toBe(false);
    expect(hasConfirmedGoldenOutcomeUpdate(next, "other-category", "match-1", 3, null)).toBe(false);
  });
});
