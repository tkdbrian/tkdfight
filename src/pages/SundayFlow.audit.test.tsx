import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateDoubleBracket, generateEliminationBracket,
  generateFinalFights, generateGroupsTournament } from "@/lib/bracket";
import { preparePlayoffFights, resolveFirstPlace } from "@/lib/round-robin-resolution";
import { hasCategoryChampion } from "@/lib/category-lifecycle";
import { BracketPage } from "@/pages/BracketPage";
import { ResultsPage } from "@/pages/ResultsPage";
import {
  type BracketMatch,
  type FightEntry,
  type TournamentCategorySnapshot,
  useTournamentStore,
} from "@/store/tournament";

const durable = vi.hoisted(() => ({ status: "confirmed", calls: 0 }));
vi.mock("@/hooks/useSocket", () => ({
  useSocket: () => ({ connected: true, stateReady: true,
    state: { match: null, activeMatchLock: null },
    request: vi.fn(async (_event: string, input: { matchId: string }) => {
      durable.calls += 1;
      const store = useTournamentStore.getState();
      const fight = store.fights.find((entry) => entry.id === input.matchId);
      return { ok: true, result: fight?.completed ? { ...fight, fightId: fight.id,
        categoryId: store.config.id, status: durable.status } : null };
    }) }),
}));

const initial = useTournamentStore.getState();

/** Private in-memory fixture only: no production server, API writes or database. */
function doubleFinal(): TournamentCategorySnapshot {
  const competitors = Array.from({ length: 18 }, (_, index) => ({
    id: `audit-${index}`, name: `Athlete ${index}`,
  }));
  const generated = generateDoubleBracket(competitors);
  let matches: BracketMatch[] = generated.matches;
  for (const original of generated.matches) {
    const current = matches.find((match) => match.id === original.id);
    const winner = current?.red.competitor ?? current?.blue.competitor;
    if (!current || !winner) throw new Error("Invalid isolated bracket fixture");
    matches = matches.map((match) => {
      if (match.id === current.id) return { ...match, completed: true, winnerId: winner.id };
      if (match.red.fromMatchId === current.id)
        return { ...match, red: { ...match.red, competitor: winner } };
      if (match.blue.fromMatchId === current.id)
        return { ...match, blue: { ...match.blue, competitor: winner } };
      return match;
    });
  }
  const winnerA = matches.filter((match) => match.bracketGroup === "A").at(-1)?.winnerId;
  const winnerB = matches.filter((match) => match.bracketGroup === "B").at(-1)?.winnerId;
  const red = competitors.find((competitor) => competitor.id === winnerA);
  const blue = competitors.find((competitor) => competitor.id === winnerB);
  if (!red || !blue) throw new Error("Missing isolated finalists");
  const bracketFights: FightEntry[] = matches.flatMap((match) => {
    if (!match.red.competitor || !match.blue.competitor) return [];
    return [{ id: `audit-bracket-${match.id}`, red: match.red.competitor,
      blue: match.blue.competitor, bracketMatchId: match.id, completed: true,
      winner: match.winnerId === match.red.competitor.id ? "red" as const : "blue" as const,
      flagsRed: 3, flagsBlue: 1 }];
  });
  return { config: { ...initial.config, mode: "elimination", matchType: "sparring" },
    competitors, bracketMatches: matches, bracketSeeds: generated.seeds, groups: [],
    fights: [{ id: "audit-ab", red, blue, groupId: "FINAL_AB", isFinalFight: true,
      completed: true, winner: "draw", flagsRed: 2, flagsBlue: 2 }, ...bracketFights],
    currentFightIndex: 0, phase: "fighting", setupStarted: true };
}

function seed(snapshot: TournamentCategorySnapshot): void {
  act(() => useTournamentStore.setState(snapshot));
}

afterEach(() => {
  cleanup();
  act(() => useTournamentStore.setState(initial, true));
  localStorage.clear();
  durable.status = "confirmed";
  durable.calls = 0;
});

describe("Sunday audit: elimination outcome must reflect the complete final sequence", () => {
  it("does not announce a double-bracket champion after a drawn A+B final", () => {
    const snapshot = doubleFinal();
    expect(hasCategoryChampion(snapshot)).toBe(false);
    seed(snapshot);
    render(<MemoryRouter><BracketPage /></MemoryRouter>);
    expect(screen.queryByText(/Oro.*Campe/)).not.toBeInTheDocument();
  });

  it("uses the confirmed decisive extra for its champion banner", async () => {
    const snapshot = doubleFinal();
    const final = snapshot.fights[0];
    snapshot.fights.push({ ...final, id: "audit-extra", isTiebreakExtra: true,
      bracketMatchId: final.id, continuationParentFightId: final.id,
      continuationStage: "timed-extra",
      tiebreakerSeconds: 60, winner: "red", flagsRed: 3, flagsBlue: 1 });
    expect(hasCategoryChampion(snapshot)).toBe(true);
    seed(snapshot);
    const { container } = render(<MemoryRouter><BracketPage /></MemoryRouter>);
    await waitFor(() => expect(container.querySelector("p.text-yellow-300")?.textContent)
      .toBe(final.red.name));
  });

  it("withholds the bracket champion banner while the decisive result is unconfirmed", async () => {
    const snapshot = doubleFinal();
    snapshot.fights.push({ ...snapshot.fights[0], id: "audit-extra", isTiebreakExtra: true,
      bracketMatchId: snapshot.fights[0].id,
      continuationParentFightId: snapshot.fights[0].id,
      continuationStage: "timed-extra",
      winner: "red", flagsRed: 3, flagsBlue: 1 });
    durable.status = "pending_confirmation";
    seed(snapshot);
    const { container } = render(<MemoryRouter><BracketPage /></MemoryRouter>);
    await waitFor(() => expect(durable.calls).toBeGreaterThanOrEqual(2));
    expect(container.querySelector("p.text-yellow-300")).toBeNull();
  });

  it("does not show a gold podium in Results while the A+B final is still drawn", () => {
    const snapshot = doubleFinal();
    seed(snapshot);
    const { container } = render(<ResultsPage />);
    expect(container.querySelector("p.text-yellow-300")).toBeNull();
  });

  it("places the confirmed decisive A+B extra winner first", async () => {
    const snapshot = doubleFinal();
    const final = snapshot.fights[0];
    snapshot.fights.push({ ...final, id: "audit-extra", isTiebreakExtra: true,
      bracketMatchId: final.id, continuationParentFightId: final.id,
      continuationStage: "timed-extra",
      tiebreakerSeconds: 60, winner: "blue", flagsRed: 1, flagsBlue: 3 });
    seed(snapshot);
    const { container } = render(<ResultsPage />);
    await waitFor(() => expect(container.querySelector("p.text-yellow-300")?.textContent)
      .toBe(final.blue.name));
  });

  it("does not award a locally decisive extra while its durable result is pending", async () => {
    const snapshot = doubleFinal();
    snapshot.fights.push({ ...snapshot.fights[0], id: "audit-extra", isTiebreakExtra: true,
      bracketMatchId: snapshot.fights[0].id,
      continuationParentFightId: snapshot.fights[0].id,
      continuationStage: "timed-extra",
      winner: "blue", flagsRed: 1, flagsBlue: 3 });
    durable.status = "pending_confirmation";
    seed(snapshot);
    const { container } = render(<ResultsPage />);
    await waitFor(() => expect(durable.calls).toBeGreaterThanOrEqual(2));
    expect(container.querySelector("p.text-yellow-300")).toBeNull();
    expect(screen.getByRole("button", { name: /Exportar HTML/ })).toBeDisabled();
  });

  it("does not award an elimination podium after only a semifinal is confirmed", () => {
    const snapshot = doubleFinal();
    snapshot.competitors = snapshot.competitors.slice(0, 4);
    const bracket = generateEliminationBracket(snapshot.competitors);
    snapshot.bracketMatches = bracket.matches;
    snapshot.bracketSeeds = bracket.seeds;
    const semifinal = bracket.matches[0];
    const red = semifinal.red.competitor;
    const blue = semifinal.blue.competitor;
    if (!red || !blue) throw new Error("Missing semifinal fixture");
    const fight: FightEntry = { id: "audit-semi", red, blue, completed: true,
      winner: "red", bracketMatchId: semifinal.id, flagsRed: 3, flagsBlue: 1 };
    snapshot.fights = [fight];
    expect(hasCategoryChampion(snapshot)).toBe(false);
    seed(snapshot);
    const { container } = render(<ResultsPage />);
    expect(container.querySelector("p.text-yellow-300")).toBeNull();
  });

  it("labels ambiguous elimination history as pending review on both pages", () => {
    const snapshot = doubleFinal();
    const final = snapshot.fights[0];
    final.winner = "red";
    snapshot.fights.push({ ...final, id: "orphan-extra", isTiebreakExtra: true,
      bracketMatchId: final.id, continuationParentFightId: final.id,
      continuationStage: "timed-extra" });
    seed(snapshot);
    const bracket = render(<MemoryRouter><BracketPage /></MemoryRouter>);
    expect(bracket.container.textContent).toContain("Pendiente de revisión");
    bracket.unmount();
    const results = render(<ResultsPage />);
    expect(results.container.textContent).toContain("Pendiente de revisión");
    expect(results.container.querySelector("p.text-yellow-300")).toBeNull();
  });
});

describe("Sunday audit control: two RR groups use FINAL, not elimination FINAL_AB", () => {
  it.each(["normal-draw", "extra-pending", "extra-draw", "decisive-extra", "decisive-gp"])(
    "%s keeps podium provisional until a decisive confirmed continuation",
    async (stage) => {
      const snapshot = doubleFinal();
      snapshot.config.mode = "round-robin";
      snapshot.competitors = snapshot.competitors.slice(0, 6);
      const generated = generateGroupsTournament(snapshot.competitors);
      snapshot.groups = generated.groups;
      snapshot.bracketMatches = [];
      snapshot.bracketSeeds = [];
      const winners = generated.groups.map((group) => group.competitors[0]);
      const metrics = { flagsRed: 2, flagsBlue: 2, foulsRed: 0, foulsBlue: 0,
        warningsRed: 0, warningsBlue: 0 };
      snapshot.fights = generated.fights.map((fight) => {
        const leader = winners.find((competitor) =>
          competitor.id === fight.red.id || competitor.id === fight.blue.id);
        return { ...fight, ...metrics, completed: true,
          winner: leader ? fight.red.id === leader.id ? "red" : "blue" : "draw" };
      });
      const [final] = generateFinalFights(winners);
      snapshot.fights.push({ ...final, ...metrics, completed: true, winner: "draw" });
      const rows = winners.map((competitor) => ({ id: competitor.id, points: 1,
        flagsFor: 2, foulsAgainst: 0, warnings: 0 }));
      if (stage !== "normal-draw") {
        const resolution = resolveFirstPlace("FINAL", rows, snapshot.fights,
          winners.map((competitor) => competitor.id));
        const [extra] = preparePlayoffFights(winners, "FINAL", resolution, 60);
        snapshot.fights.push({ ...extra, ...metrics,
          completed: stage !== "extra-pending",
          winner: stage === "extra-pending" ? undefined :
            stage === "decisive-extra" ? "blue" : "draw" });
        if (stage === "decisive-gp") {
          const next = resolveFirstPlace("FINAL", rows, snapshot.fights,
            winners.map((competitor) => competitor.id));
          const [golden] = preparePlayoffFights(winners, "FINAL", next, 60);
          snapshot.fights.push({ ...golden, ...metrics, completed: true, winner: "blue" });
        }
      }
      const decisive = stage.startsWith("decisive");
      expect(hasCategoryChampion(snapshot)).toBe(decisive);
      seed(snapshot);
      const { container } = render(<ResultsPage />);
      if (decisive) {
        await waitFor(() => expect(container.querySelector("p.text-yellow-300")?.textContent)
          .toBe(final.blue.name));
      } else {
        expect(container.querySelector("p.text-yellow-300")).toBeNull();
      }
    }
  );
});
