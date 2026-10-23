import { expect, it } from "vitest";
import { decideBackupBoot } from "./full-backup-boot";

it("never imports the writable app with a pending marker or server receipt", () => {
  expect(decideBackupBoot("/", true, false)).toBe("maintenance");
  expect(decideBackupBoot("/", false, true)).toBe("maintenance");
  expect(decideBackupBoot("/maintenance", false, false)).toBe("maintenance");
  expect(decideBackupBoot("/", false, false)).toBe("normal");
});
