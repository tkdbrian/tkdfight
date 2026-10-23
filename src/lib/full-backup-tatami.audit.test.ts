import { expect, it } from "vitest";
import { createBackupEnvelope, parseBackupEnvelope } from "./full-backup-contract";

const browser = {
  "tkd-tournament": null,
  "tkd-tournament-categories": null,
  "tkd-category-deletions-v1": null,
  "tkd-retired-category-sources-v1": null,
};
const payload = { sql: { tables: {}, sequences: {} }, browser };

it("records the exact tatami in a backup instead of a generic ring role", async () => {
  const backup = await createBackupEnvelope(
    payload,
    "same-build-on-all-pcs",
    "T1" as never,
    "backup-t1",
    "2026-10-23T00:00:00.000Z"
  );
  expect(backup.role).toBe("T1");
});

it("rejects a T1 backup on T2 even when both installations have the same build", async () => {
  const backup = await createBackupEnvelope(
    payload,
    "same-build-on-all-pcs",
    "T1" as never,
    "backup-t1",
    "2026-10-23T00:00:00.000Z"
  );
  await expect(
    parseBackupEnvelope(JSON.stringify(backup), "same-build-on-all-pcs", "T2" as never)
  ).rejects.toThrow(/role|tatami|mismatch/i);
});
