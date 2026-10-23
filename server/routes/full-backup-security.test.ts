import { expect, it } from "vitest";
import { BackupLease, isBackupPeerAllowed } from "./full-backup-security.js";

it("accepts only exact same-origin loopback requests", () => {
  expect(isBackupPeerAllowed("::1", "localhost:3001", "http://localhost:3001", 3001)).toBe(true);
  expect(
    isBackupPeerAllowed("::ffff:127.0.0.1", "127.0.0.1:3001", "http://127.0.0.1:3001", 3001)
  ).toBe(true);
  expect(isBackupPeerAllowed("192.168.1.8", "localhost:3001", "http://localhost:3001", 3001)).toBe(
    false
  );
  expect(isBackupPeerAllowed("::1", "localhost:3001", "http://evil.test", 3001)).toBe(false);
  expect(isBackupPeerAllowed("::1", "localhost:3001", undefined, 3001)).toBe(false);
});

it("uses one opaque token and blocks concurrent lease acquisition", () => {
  const lease = new BackupLease();
  const token = lease.begin();
  expect(token).toMatch(/^[a-f0-9-]{36}$/);
  expect(() => lease.begin()).toThrow();
  expect(lease.matches("wrong")).toBe(false);
  expect(lease.matches(token)).toBe(true);
  lease.end(token);
  expect(lease.active).toBe(false);
});

it("expires an abandoned lease so a crashed maintenance tab cannot wedge a healthy server", () => {
  let now = 100;
  const lease = new BackupLease(() => now, 1000);
  const token = lease.begin();
  now = 1101;
  expect(lease.active).toBe(false);
  expect(lease.matches(token)).toBe(false);
  expect(lease.begin()).not.toBe(token);
});
