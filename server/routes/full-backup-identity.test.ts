// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBackupRole } from "./full-backup-identity.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

it("requires launch role and matching ring.json alias without writing defaults", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tkd-backup-role-"));
  dirs.push(dir);
  expect(readBackupRole(undefined, dir)).toBeNull();
  expect(readBackupRole("cuadrilatero1", dir)).toBeNull();
  writeFileSync(path.join(dir, "ring.json"), JSON.stringify({ alias: "T1", name: "Tatami 1" }));
  expect(readBackupRole("cuadrilatero1", dir)).toBe("T1");
  expect(readBackupRole("cuadrilatero2", dir)).toBeNull();
  expect(readBackupRole("unknown", dir)).toBeNull();
});

it("distinguishes all official launcher roles, including central table", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tkd-backup-role-"));
  dirs.push(dir);
  for (const [launch, alias] of [
    ["cuadrilatero2", "T2"],
    ["cuadrilatero3", "T3"],
    ["mesacentral", "MC"],
  ]) {
    writeFileSync(path.join(dir, "ring.json"), JSON.stringify({ alias, name: alias }));
    expect(readBackupRole(launch, dir)).toBe(alias);
  }
});
