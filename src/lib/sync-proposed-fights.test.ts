import { afterEach, describe, expect, it, vi } from "vitest";
import type { FightEntry } from "@/store/tournament";
import { getCanonicalEliminationContinuation, syncProposedFights } from "./sync-proposed-fights";

const config = { id: "category-a", categoryName: "A", tournamentName: "T" };
const fight: FightEntry = {
  id: "fight-a",
  red: { id: "red", name: "Rojo" },
  blue: { id: "blue", name: "Azul" },
  completed: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("sync proposed fights", () => {
  it("reads an existing canonical continuation without writing", async () => {
    const canonicalFight = { id: crypto.randomUUID(), red_id: "red", blue_id: "blue",
      stage: "timed-extra", parentFightId: "parent", parentRevision: 0 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true,
      json: async () => ({ canonicalFight }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getCanonicalEliminationContinuation(config.id, "parent"))
      .toEqual(canonicalFight);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ring/categories/category-a/fights/parent/continuation");
  });

  it("treats only 404 as no canonical continuation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await getCanonicalEliminationContinuation(config.id, "parent")).toBeNull();
  });
  it("sends a parent-scoped elimination continuation and uses the canonical child", async () => {
    const proposal = { ...fight, id: crypto.randomUUID(),
      continuationParentFightId: "parent", continuationStage: "timed-extra" as const,
      isTiebreakExtra: true };
    const canonicalFight = { id: proposal.id, red_id: "red", blue_id: "blue",
      stage: "timed-extra", parentFightId: "parent", parentRevision: 2 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true,
      json: async () => ({ ok: true, synced: 1, tournamentId: 1, canonicalFight }) });
    vi.stubGlobal("fetch", fetchMock);
    const response = await syncProposedFights(config, [proposal], ["parent"], {
      parentFightId: "parent", parentRevision: 2,
      proposedFight: { id: proposal.id, red_id: "red", blue_id: "blue",
        stage: "timed-extra" },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.eliminationContinuation).toMatchObject({ parentFightId: "parent",
      parentRevision: 2 });
    expect(body.fights[0]).toMatchObject({ continuationParentFightId: "parent",
      continuationStage: "timed-extra" });
    expect(response).toEqual(canonicalFight);
  });
  it.each([
    ["false ok", { ok: false, synced: 1, tournamentId: 1 }],
    ["missing sync metadata", {}],
  ])("rejects a canonical child in a %s response", async (_label, metadata) => {
    const childId = crypto.randomUUID();
    const canonicalFight = { id: childId, red_id: "red", blue_id: "blue",
      stage: "timed-extra", parentFightId: "parent", parentRevision: 0 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true,
      json: async () => ({ canonicalFight, ...metadata }) }));
    await expect(syncProposedFights(config, [{ ...fight, id: childId }], [], {
      parentFightId: "parent", parentRevision: 0,
      proposedFight: { id: childId, red_id: "red", blue_id: "blue", stage: "timed-extra" },
    })).rejects.toThrow("El servidor no devolvió la pelea canónica.");
  });

  it("rejects 409 before a caller can add the proposed fight locally", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "active_match", message: "Tatami ocupado" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncProposedFights(config, [fight])).rejects.toThrow("Tatami ocupado");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses non-destructive sync with the original IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await syncProposedFights(config, [fight]);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ring/sync-fights");
    expect(JSON.parse(options.body).fights).toEqual([
      { id: "fight-a", red_id: "red", blue_id: "blue", completed: false },
    ]);
    expect(JSON.parse(options.body).requiredConfirmedFightIds).toBeUndefined();
  });

  it("sends confirmed prerequisite IDs for an official playoff or final", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await syncProposedFights(config, [fight], ["regular-1", "regular-2", "regular-1"]);
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body).requiredConfirmedFightIds).toEqual(["regular-1", "regular-2"]);
  });
});
