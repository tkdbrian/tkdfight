import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoldenPointMatch } from "@/engine/match-machine";
import type { RuleSetSparring } from "@/engine/types";
import type { PenaltyCounts, ServerState } from "@/lib/socket-types";
import {
  canReviewPostClockSanctions,
  dispatchScoreSanctionAction,
  hasSanctionCountUpdate,
  PostClockSanctionReview,
  ScoreSanctionControls,
  withMatchContext,
} from "@/pages/FightPage";
import itfRules from "@/rules/rules/rules_sparring_itf_baseline.json";

afterEach(cleanup);

const counts: PenaltyCounts = {
  warnings: { red: 2, blue: 0 },
  fouls: { red: 1, blue: 0 },
};

describe("revisión de sanciones después del reloj", () => {
  it("keeps original score buttons compact and routes a post-clock click to review", () => {
    const emitLive = vi.fn();
    const editPostClock = vi.fn();
    render(
      <ScoreSanctionControls
        side="red"
        fighterName="Ana"
        layout="desktop"
        counts={counts}
        enabled
        busy={false}
        onAdjust={(side, kind, delta) =>
          dispatchScoreSanctionAction(side, kind, delta, false, true, emitLive, editPostClock)
        }
      />
    );

    expect(screen.getByTestId("score-sanctions-red-desktop")).toBeTruthy();
    expect(screen.queryByTestId("sanction-review-pending")).toBeNull();
    expect(
      screen.getByTestId("score-sanction-red-warning-add-desktop").getAttribute("aria-label")
    ).toBe("Ana (rojo): agregar advertencia");
    fireEvent.click(screen.getByTestId("score-sanction-red-warning-add-desktop"));
    fireEvent.click(screen.getByTestId("score-sanction-red-minus_point-remove-desktop"));
    expect(editPostClock).toHaveBeenNthCalledWith(1, "red", "warning", 1);
    expect(editPostClock).toHaveBeenNthCalledWith(2, "red", "minus_point", -1);
    expect(emitLive).not.toHaveBeenCalled();
  });

  it("preserves live arbiter events and disables score buttons when review is unavailable", () => {
    const emitLive = vi.fn();
    const editPostClock = vi.fn();
    const onAdjust = (side: "red" | "blue", kind: "warning" | "minus_point", delta: -1 | 1) =>
      dispatchScoreSanctionAction(side, kind, delta, true, false, emitLive, editPostClock);
    const { rerender } = render(
      <ScoreSanctionControls
        side="blue"
        fighterName="Berta"
        layout="mobile"
        counts={counts}
        enabled
        busy={false}
        onAdjust={onAdjust}
      />
    );
    fireEvent.click(screen.getByTestId("score-sanction-blue-warning-add-mobile"));
    expect(screen.getByTestId("score-sanction-blue-warning-add-mobile").className).toContain(
      "min-h-11"
    );
    expect(
      screen.getByTestId("score-sanction-blue-minus_point-add-mobile").getAttribute("aria-label")
    ).toBe("Berta (azul): agregar punto en contra directo");
    fireEvent.click(screen.getByTestId("score-sanction-blue-minus_point-add-mobile"));
    expect(emitLive).toHaveBeenNthCalledWith(1, "blue", "warning_minor");
    expect(emitLive).toHaveBeenNthCalledWith(2, "blue", "minus_point");
    expect(editPostClock).not.toHaveBeenCalled();

    rerender(
      <ScoreSanctionControls
        side="blue"
        fighterName="Berta"
        layout="mobile"
        counts={counts}
        enabled={false}
        busy={false}
        onAdjust={onAdjust}
      />
    );
    expect(
      screen.getByTestId("score-sanction-blue-warning-add-mobile").hasAttribute("disabled")
    ).toBe(true);
    fireEvent.click(screen.getByTestId("score-sanction-blue-warning-add-mobile"));
    expect(emitLive).toHaveBeenCalledTimes(2);
  });

  it("locks score-side edits during a pending ACK and at the server count bounds", () => {
    const onAdjust = vi.fn();
    const maxCounts: PenaltyCounts = {
      warnings: { red: 99, blue: 0 },
      fouls: { red: 0, blue: 99 },
    };
    const { rerender } = render(
      <ScoreSanctionControls
        side="red"
        fighterName="Ana"
        layout="desktop"
        counts={maxCounts}
        enabled
        busy={false}
        onAdjust={onAdjust}
      />
    );
    expect(
      screen.getByTestId("score-sanction-red-warning-add-desktop").hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByTestId("score-sanction-red-minus_point-remove-desktop").hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByTestId("score-sanction-red-warning-remove-desktop").hasAttribute("disabled")
    ).toBe(false);

    rerender(
      <ScoreSanctionControls
        side="red"
        fighterName="Ana"
        layout="desktop"
        counts={maxCounts}
        enabled
        busy
        onAdjust={onAdjust}
      />
    );
    expect(
      screen.getByTestId("score-sanction-red-warning-remove-desktop").hasAttribute("disabled")
    ).toBe(true);
    fireEvent.click(screen.getByTestId("score-sanction-red-warning-remove-desktop"));
    expect(onAdjust).not.toHaveBeenCalled();
  });

  it("does not offer corrections for a DQ or Golden Point result", () => {
    expect(canReviewPostClockSanctions("rest")).toBe(true);
    expect(canReviewPostClockSanctions("penalties")).toBe(true);
    expect(canReviewPostClockSanctions("finished", "points")).toBe(true);
    expect(canReviewPostClockSanctions("finished", "dq")).toBe(false);
    expect(canReviewPostClockSanctions("finished", "golden_point")).toBe(false);
    expect(canReviewPostClockSanctions("finished", null)).toBe(false);
  });

  it("shows both durable counts and add/remove controls before official confirmation", () => {
    const onAdjust = vi.fn();
    render(
      <PostClockSanctionReview
        redName="Ana"
        blueName="Berta"
        counts={counts}
        busy={false}
        editable
        stage="result"
        onAdjust={onAdjust}
      />
    );

    expect(screen.getByTestId("sanction-review-pending").textContent).toMatch(/sin confirmar/i);
    expect(screen.getByTestId("sanction-red-warning-count").textContent).toBe("2");
    expect(screen.getByTestId("sanction-red-minus_point-count").textContent).toBe("1");
    expect(screen.getByTestId("sanction-blue-warning-count").textContent).toBe("0");
    expect(screen.getByTestId("sanction-blue-minus_point-count").textContent).toBe("0");

    fireEvent.click(screen.getByTestId("sanction-red-warning-remove"));
    fireEvent.click(screen.getByTestId("sanction-blue-minus_point-add"));
    expect(onAdjust).toHaveBeenNthCalledWith(1, "red", "warning", -1);
    expect(onAdjust).toHaveBeenNthCalledWith(2, "blue", "minus_point", 1);
    expect(screen.getByTestId("sanction-blue-warning-remove").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("sanction-blue-minus_point-remove").hasAttribute("disabled")).toBe(
      true
    );
  });

  it("locks editing during persistence or after confirmation/disconnection", () => {
    const onAdjust = vi.fn();
    const props = {
      redName: "Ana",
      blueName: "Berta",
      counts,
      stage: "voting" as const,
      onAdjust,
    };
    const { rerender } = render(<PostClockSanctionReview {...props} editable busy={false} />);
    expect(screen.getByTestId("sanction-red-warning-add").hasAttribute("disabled")).toBe(false);

    rerender(<PostClockSanctionReview {...props} editable busy />);
    expect(screen.getByTestId("sanction-red-warning-add").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("sanction-red-warning-remove").hasAttribute("disabled")).toBe(true);

    rerender(<PostClockSanctionReview {...props} editable={false} busy={false} />);
    expect(screen.getByTestId("sanction-red-warning-add").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("sanction-red-warning-add"));
    expect(onAdjust).not.toHaveBeenCalled();
  });

  it("stops adding sanctions at the server's maximum count of 99", () => {
    render(
      <PostClockSanctionReview
        redName="Ana"
        blueName="Berta"
        counts={{ warnings: { red: 99, blue: 0 }, fouls: { red: 0, blue: 99 } }}
        busy={false}
        editable
        stage="result"
        onAdjust={vi.fn()}
      />
    );
    expect(screen.getByTestId("sanction-red-warning-add").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("sanction-blue-minus_point-add").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("sanction-red-warning-remove").hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("sanction-blue-minus_point-remove").hasAttribute("disabled")).toBe(
      false
    );
  });

  it("requires same fight/category and expected server count before reporting synchronization", () => {
    const state: ServerState = {
      rules: null,
      match: {
        id: "match-1",
        ringId: "PREVIEW",
        red: { id: "r", name: "Ana" },
        blue: { id: "b", name: "Berta" },
      },
      categoryId: "category-1",
      matchState: createGoldenPointMatch(itfRules as RuleSetSparring),
      matchPaused: false,
      judges: [],
      judgeVotes: {},
      judgeTotals: {},
      penaltyCounts: counts,
      fallos: [],
      roundFlags: [],
      serverUrl: "",
    };

    expect(hasSanctionCountUpdate(state, "category-1", "match-1", "red", "warning", 2)).toBe(true);
    expect(hasSanctionCountUpdate(state, "category-1", "match-1", "red", "warning", 3)).toBe(false);
    expect(hasSanctionCountUpdate(state, "category-2", "match-1", "red", "warning", 2)).toBe(false);
    expect(hasSanctionCountUpdate(state, "category-1", "match-2", "red", "warning", 2)).toBe(false);
    expect(
      withMatchContext(
        "mesa:setSanctionCount",
        { competitor: "red", kind: "warning", expectedCount: 2, count: 3 },
        "category-1",
        "match-1"
      )
    ).toEqual({
      categoryId: "category-1",
      matchId: "match-1",
      competitor: "red",
      kind: "warning",
      expectedCount: 2,
      count: 3,
    });
  });
});
