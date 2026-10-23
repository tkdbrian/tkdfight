import { afterEach, describe, expect, it, vi } from "vitest";
import { exportTournamentHTML } from "@/lib/export";
import type { BracketMatch, CompetitorEntry, FightEntry, TournamentGroup } from "@/store/tournament";
import { useTournamentStore } from "@/store/tournament";

const [a, b, c]: CompetitorEntry[] = ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase() }));
const competitors = [a, b, c];
const groups: TournamentGroup[] = [{ id: "G1", competitors, size: 3 }];

function bout(
  id: string,
  red: CompetitorEntry,
  blue: CompetitorEntry,
  winner: FightEntry["winner"],
  flagsRed: number,
  flagsBlue: number,
  foulsRed = 0,
  warningsRed = 0
): FightEntry {
  return {
    id,
    red,
    blue,
    groupId: "G1",
    completed: true,
    winner,
    flagsRed,
    flagsBlue,
    foulsRed,
    foulsBlue: 0,
    warningsRed,
    warningsBlue: 0,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("official HTML export", () => {
  it("never infers an elimination podium from totals without confirmed final dependencies", () => {
    let html = "";
    const NativeBlob = Blob;
    vi.stubGlobal("Blob", class extends NativeBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        html = String(parts[0]);
      }
    });
    Object.defineProperty(URL, "createObjectURL", { configurable: true,
      value: vi.fn(() => "blob:test") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true,
      value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const final: BracketMatch = { id: "bracket-final", round: 0, position: 0,
      red: { competitor: a }, blue: { competitor: b }, completed: true, winnerId: b.id };
    const fight: FightEntry = { id: "durable-final", red: a, blue: b, completed: true,
      winner: "blue", bracketMatchId: final.id, isFinalFight: true };
    const config = { ...useTournamentStore.getState().config, mode: "elimination" as const };
    exportTournamentHTML([fight], [a, b], config, [final]);
    expect(html).not.toContain('class="podium-1"');
    exportTournamentHTML([fight], [a, b], config, [final], [], [fight.id]);
    expect(html).toMatch(/class="podium-1"[^>]*><td>.*?<\/td><td><strong>B<\/strong>/);
  });
  it.each([
    { criterion: "flags", aFlags: 2, bFlags: 3, aFouls: 0, aWarnings: 0 },
    { criterion: "penalty points", aFlags: 3, bFlags: 3, aFouls: 1, aWarnings: 0 },
    { criterion: "warnings", aFlags: 3, bFlags: 3, aFouls: 0, aWarnings: 1 },
  ])("orders RR by $criterion after equal classification points", ({
    aFlags,
    bFlags,
    aFouls,
    aWarnings,
  }) => {
    let html = "";
    const NativeBlob = Blob;
    vi.stubGlobal(
      "Blob",
      class extends NativeBlob {
        constructor(parts: BlobPart[], options?: BlobPropertyBag) {
          super(parts, options);
          html = String(parts[0]);
        }
      }
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const fights = [
      bout("ab", a, b, "draw", 2, 2),
      bout("ac", a, c, "red", aFlags, 0, aFouls, aWarnings),
      bout("bc", b, c, "red", bFlags, 0),
    ];
    const config = { ...useTournamentStore.getState().config, mode: "round-robin" as const };

    exportTournamentHTML(fights, competitors, config, [], groups);

    expect(html).toMatch(/class="podium-1"[^>]*><td>.*?<\/td><td><strong>B<\/strong>/);
    expect(html).toMatch(/<tbody><tr><td>1<\/td><td>B<\/td>/);
    expect(html).toMatch(/<tr><td>2<\/td><td>A<\/td>/);
  });
});
