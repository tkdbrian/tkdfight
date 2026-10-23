import { expect, it } from "vitest";
import { verifyBuildIdentity } from "./full-backup-build-id";

it("fails closed on a missing release identity or a stale cached index", () => {
  expect(() => verifyBuildIdentity(null, null, true)).toThrow();
  expect(() => verifyBuildIdentity("new", "old", true)).toThrow();
  expect(() => verifyBuildIdentity("new", null, false)).toThrow();
  expect(() => verifyBuildIdentity("same", "same", true)).not.toThrow();
  expect(() => verifyBuildIdentity(null, null, false)).not.toThrow();
});
