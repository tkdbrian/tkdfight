import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, Request } from "express";
import express from "express";
import type { Server } from "socket.io";
import { z } from "zod";
import type { BackupPayload, BackupRole } from "../../src/lib/full-backup-contract.js";
import {
  BACKUP_BROWSER_KEYS,
  canonicalJson,
  createBackupEnvelope,
  parseBackupEnvelope,
  sha256Hex,
  validateBrowserPayload,
} from "../../src/lib/full-backup-contract.js";
import type { SqlBackup } from "../db/full-backup.js";
import {
  bootSqlAuthority,
  captureSqlBackup,
  completeSqlRestore,
  getRestoreReceipt,
  isSqlIdle,
  restoreSqlBackup,
} from "../db/full-backup.js";
import type { CoherentSql } from "../db/full-backup-coherence.js";
import { assertBrowserSqlCoherent } from "../db/full-backup-coherence.js";
import {
  getActiveMatchLock,
  getRetiredIdleTournamentId,
  getStartupTournamentId,
} from "../db/index.js";
import { state } from "../state.js";
import { readBackupRole } from "./full-backup-identity.js";
import { BackupLease, isBackupPeerAllowed } from "./full-backup-security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browserSchema = z.strictObject(
  Object.fromEntries(BACKUP_BROWSER_KEYS.map((key) => [key, z.string().nullable()])) as Record<
    (typeof BACKUP_BROWSER_KEYS)[number],
    z.ZodNullable<z.ZodString>
  >
);
const exportSchema = z.strictObject({ token: z.string(), browser: browserSchema });
const restoreSchema = z.strictObject({ token: z.string(), backup: z.string() });
const completeSchema = z.strictObject({
  token: z.string(),
  backupId: z.string().optional(),
  payloadHash: z.string().optional(),
  browserHash: z.string().optional(),
  abort: z.boolean().optional(),
});

function buildId(filePath?: string): string | null {
  try {
    const packageRoot =
      path.basename(__dirname) === "routes"
        ? path.join(__dirname, "..", "..")
        : path.join(__dirname, "..");
    const raw: unknown = JSON.parse(
      readFileSync(filePath ?? path.join(packageRoot, "build-id.json"), "utf8")
    );
    const checked = z
      .strictObject({ buildId: z.string().min(1), backupSchemaVersion: z.literal(1) })
      .safeParse(raw);
    return checked.success ? checked.data.buildId : null;
  } catch {
    return null;
  }
}

function isLoopbackStatusRequest(req: Request, port: number): boolean {
  const host = req.get("host");
  return isBackupPeerAllowed(
    req.socket.remoteAddress,
    host,
    req.get("origin") ?? (host ? `http://${host}` : undefined),
    port
  );
}

function isIdle(io: Server): boolean {
  return (
    io.sockets.sockets.size === 0 && state.match === null && !getActiveMatchLock() && isSqlIdle()
  );
}

export function registerFullBackupRoutes(
  app: Express,
  io: Server,
  port: number,
  buildIdPath?: string
): () => boolean {
  const currentBuildId = () => buildId(buildIdPath);
  const packageRoot =
    path.basename(__dirname) === "routes"
      ? path.join(__dirname, "..", "..")
      : path.join(__dirname, "..");
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(packageRoot, "data");
  const configuredLaunchRole = process.env.TKD_ROLE;
  const currentRole = (): BackupRole | null => readBackupRole(configuredLaunchRole, dataDir);
  const lease = new BackupLease();
  app.use((req, res, next) => {
    if (
      (lease.active || getRestoreReceipt()?.status === "pending") &&
      req.method !== "GET" &&
      !req.path.startsWith("/api/backup/")
    ) {
      res.status(423).json({ error: "Backup maintenance active" });
      return;
    }
    next();
  });
  io.use((_socket, next) => {
    if (lease.active || getRestoreReceipt()?.status === "pending")
      next(new Error("Backup maintenance active"));
    else next();
  });

  app.get("/boot-status", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      maintenanceRequired: lease.active || getRestoreReceipt()?.status === "pending",
      buildId: currentBuildId(),
      role: currentRole(),
      backupSchemaVersion: 1,
      ...bootSqlAuthority(),
    });
  });

  app.get("/api/build-id", (req, res) => {
    if (!isLoopbackStatusRequest(req, port)) {
      res.sendStatus(403);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ buildId: currentBuildId(), role: currentRole(), backupSchemaVersion: 1 });
  });
  app.get("/api/backup/status", (req, res) => {
    if (!isLoopbackStatusRequest(req, port)) {
      res.sendStatus(403);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      buildId: currentBuildId(),
      role: currentRole(),
      leaseActive: lease.active,
      receipt: getRestoreReceipt(),
      idle: isIdle(io),
    });
  });
  app.use("/api/backup", (req, res, next) => {
    if (!isBackupPeerAllowed(req.socket.remoteAddress, req.get("host"), req.get("origin"), port)) {
      res.sendStatus(403);
      return;
    }
    next();
  });
  // Reject non-loopback peers before parsing a potentially 2x-escaped 32 MiB file.
  app.use("/api/backup", express.json({ limit: "70mb" }));
  app.post("/api/backup/begin", (req, res) => {
    if (!currentBuildId()) {
      res.status(503).json({ error: "Missing package build ID" });
      return;
    }
    if (!currentRole()) {
      res.status(503).json({ error: "Missing or mismatched launcher tatami identity" });
      return;
    }
    const receipt = getRestoreReceipt();
    const recoveryBackupId = z
      .strictObject({ recoveryBackupId: z.string().optional() })
      .safeParse(req.body);
    if (
      !recoveryBackupId.success ||
      (receipt?.status === "pending" &&
        recoveryBackupId.data.recoveryBackupId !== receipt.backup_id) ||
      (receipt?.status !== "pending" && recoveryBackupId.data.recoveryBackupId)
    ) {
      res.status(409).json({ error: "Pending restore requires matching recovery ID" });
      return;
    }
    if (!isIdle(io)) {
      res.status(409).json({ error: "Tournament or sockets are busy" });
      return;
    }
    try {
      res.json({ token: lease.begin(), receipt });
    } catch {
      res.status(423).json({ error: "Maintenance already active" });
    }
  });
  app.post("/api/backup/export", async (req, res) => {
    const role = currentRole();
    if (!role) {
      res.status(503).json({ error: "Tatami identity unavailable" });
      return;
    }
    const parsed = exportSchema.safeParse(req.body);
    if (!parsed.success || !lease.matches(parsed.data.token)) {
      res.sendStatus(403);
      return;
    }
    if (!isIdle(io) || getRestoreReceipt()?.status === "pending") {
      res.status(409).json({ error: "Tournament is not idle" });
      return;
    }
    try {
      validateBrowserPayload(parsed.data.browser);
      const payload: BackupPayload = { sql: captureSqlBackup(), browser: parsed.data.browser };
      assertBrowserSqlCoherent(
        payload.sql as unknown as CoherentSql,
        payload.browser["tkd-tournament-categories"]
      );
      const envelope = await createBackupEnvelope(
        payload,
        currentBuildId() ?? "",
        role,
        randomUUID(),
        new Date().toISOString()
      );
      res.setHeader("Cache-Control", "no-store");
      res.json(envelope);
    } catch (error) {
      res.status(422).json({ error: String(error) });
    }
  });
  app.post("/api/backup/restore", async (req, res) => {
    const role = currentRole();
    if (!role) {
      res.status(503).json({ error: "Tatami identity unavailable" });
      return;
    }
    const parsed = restoreSchema.safeParse(req.body);
    if (!parsed.success || !lease.matches(parsed.data.token)) {
      res.sendStatus(403);
      return;
    }
    try {
      const build = currentBuildId();
      if (!build) throw new Error("Missing package build ID");
      const backup = await parseBackupEnvelope(parsed.data.backup, build, role);
      assertBrowserSqlCoherent(
        backup.payload.sql as unknown as CoherentSql,
        backup.payload.browser["tkd-tournament-categories"]
      );
      const browserHash = await sha256Hex(canonicalJson(backup.payload.browser));
      const receipt = getRestoreReceipt();
      if (receipt) {
        if (
          receipt.backup_id !== backup.backupId ||
          receipt.payload_hash !== backup.payloadHash ||
          receipt.browser_hash !== browserHash
        )
          throw new Error("Conflicting restore receipt");
      } else {
        if (!isIdle(io)) throw new Error("Tournament is not idle");
        restoreSqlBackup(
          backup.payload.sql as SqlBackup,
          backup.backupId,
          backup.payloadHash,
          browserHash
        );
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ receipt: getRestoreReceipt() });
    } catch (error) {
      res.status(409).json({ error: String(error), receipt: getRestoreReceipt() });
    }
  });
  app.post("/api/backup/complete", (req, res) => {
    if (!currentRole()) {
      res.status(503).json({ error: "Tatami identity unavailable" });
      return;
    }
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success || !lease.matches(parsed.data.token)) {
      res.sendStatus(403);
      return;
    }
    const receipt = getRestoreReceipt();
    if (parsed.data.abort) {
      if (receipt?.status === "pending") {
        res.status(409).json({ error: "SQL restore committed; cannot abort" });
        return;
      }
      lease.end(parsed.data.token);
      res.json({ ok: true });
      return;
    }
    if (!receipt || !parsed.data.backupId || !parsed.data.payloadHash || !parsed.data.browserHash) {
      res.status(400).json({ error: "Missing restore receipt fields" });
      return;
    }
    try {
      completeSqlRestore(parsed.data.backupId, parsed.data.payloadHash, parsed.data.browserHash);
      state.activeTournamentId =
        getStartupTournamentId() ?? getRetiredIdleTournamentId() ?? state.activeTournamentId;
      lease.end(parsed.data.token);
      res.json({ receipt: getRestoreReceipt() });
    } catch (error) {
      res.status(409).json({ error: String(error) });
    }
  });
  return () => lease.active || getRestoreReceipt()?.status === "pending";
}
