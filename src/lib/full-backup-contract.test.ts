import { describe, expect, it } from "vitest";
import {
  createBackupEnvelope,
  parseBackupEnvelope,
  sha256Hex,
  validateBrowserPayload,
} from "./full-backup-contract";

const payload = {
  sql: {
    tables: { tournaments: [{ id: 7, name: "Evento", category: "", created_at: "2026-10-23" }] },
    sequences: { tournaments: 7 },
  },
  browser: {
    "tkd-tournament": JSON.stringify({ state: { phase: "setup" }, version: 1 }),
    "tkd-tournament-categories": JSON.stringify({
      categories: {},
      version: 2,
      visibleCategoryIds: [],
      selectedCategoryId: null,
      draftCategoryId: null,
      draftReturnCategoryId: null,
    }),
    "tkd-category-deletions-v1": "[]",
    "tkd-retired-category-sources-v1": "[]",
  },
};

describe("full backup envelope", () => {
  it("accepts a current generated draft and a migratable legacy empty main state", () => {
    const snapshot = {
      phase: "setup",
      config: { id: "draft", tournamentName: "Torneo", categoryName: "" },
      competitors: [],
      fights: [],
      groups: [],
      currentFightIndex: 0,
      bracketMatches: [],
      bracketSeeds: [],
      setupStarted: false,
    };
    expect(() =>
      validateBrowserPayload({
        "tkd-tournament": JSON.stringify({
          version: 1,
          state: { ...snapshot, categoryRevision: 0, eventProfiles: {} },
        }),
        "tkd-tournament-categories": JSON.stringify({
          version: 2,
          categories: { draft: snapshot },
          visibleCategoryIds: ["draft"],
          selectedCategoryId: "draft",
          draftCategoryId: null,
          draftReturnCategoryId: null,
        }),
        "tkd-category-deletions-v1": "[]",
        "tkd-retired-category-sources-v1": "[]",
      })
    ).not.toThrow();
    expect(() =>
      validateBrowserPayload({
        ...payload.browser,
        "tkd-tournament": JSON.stringify({ version: 1, state: {} }),
      })
    ).not.toThrow();
  });
  it("round trips an explicitly versioned, canonical payload", async () => {
    const backup = await createBackupEnvelope(
      payload,
      "build-one",
      "T1",
      "id-one",
      "2026-10-23T00:00:00.000Z"
    );
    expect(backup.format).toBe("tkd-backup");
    expect(backup.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await parseBackupEnvelope(JSON.stringify(backup), "build-one", "T1")).toEqual(backup);
  });

  it("rejects tamper, foreign build, and unexpected keys", async () => {
    const backup = await createBackupEnvelope(
      payload,
      "build-one",
      "T1",
      "id-one",
      "2026-10-23T00:00:00.000Z"
    );
    await expect(
      parseBackupEnvelope(
        JSON.stringify({
          ...backup,
          payload: { ...backup.payload, sql: { tables: {}, sequences: {} } },
        }),
        "build-one",
        "T1"
      )
    ).rejects.toThrow();
    await expect(parseBackupEnvelope(JSON.stringify(backup), "build-two", "T1")).rejects.toThrow();
    await expect(
      parseBackupEnvelope(JSON.stringify({ ...backup, secret: "no" }), "build-one", "T1")
    ).rejects.toThrow();
    await expect(
      parseBackupEnvelope(
        JSON.stringify({ ...backup, createdAt: "2026-10-23T01:00:00.000+01:00" }),
        "build-one",
        "T1"
      )
    ).rejects.toThrow();
  });

  it("rejects oversized input before parsing", async () => {
    await expect(
      parseBackupEnvelope("x".repeat(32 * 1024 * 1024 + 1), "build-one", "T1")
    ).rejects.toThrow();
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
