import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { BackupRole } from "../../src/lib/full-backup-contract.js";

const launcherRoles: Record<string, BackupRole> = {
  cuadrilatero1: "T1",
  cuadrilatero2: "T2",
  cuadrilatero3: "T3",
  mesacentral: "MC",
};
const ringConfigSchema = z.object({ alias: z.enum(["T1", "T2", "T3", "MC"]) });

export function readBackupRole(launchRole: string | undefined, dataDir: string): BackupRole | null {
  if (!launchRole || !Object.hasOwn(launcherRoles, launchRole)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path.join(dataDir, "ring.json"), "utf8"));
    const config = ringConfigSchema.safeParse(raw);
    const role = launcherRoles[launchRole];
    return config.success && config.data.alias === role ? role : null;
  } catch {
    return null;
  }
}
