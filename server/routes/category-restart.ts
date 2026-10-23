import express, { type ErrorRequestHandler, type Express, type Response } from "express";
import type { Server } from "socket.io";
import { restartCategoryRequestSchema } from "../../src/lib/category-restart-contract.js";
import { broadcast } from "../broadcast.js";
import {
  CategoryExecutionError,
  clearConfirmedMatchSnapshot,
  getCategoryReplacement,
  restartCategoryExecution,
} from "../db/index.js";
import { state } from "../state.js";
import { sendCategoryDeletionError } from "./category-deletion.js";
import { registerCategoryRestartModesBodyParser } from "./category-restart-modes.js";

export function sendCategoryExecutionError(error: unknown, res: Response): boolean {
  if (sendCategoryDeletionError(error, res)) return true;
  if (!(error instanceof CategoryExecutionError)) return false;
  res.status(error.code === "replacement_not_found" ? 404 : 409).json({
    ok: false,
    error: error.code,
    message: error.message,
    ...(error.categoryId ? { categoryId: error.categoryId } : {}),
    ...(error.replacementCategoryId ? { replacementCategoryId: error.replacementCategoryId } : {}),
  });
  return true;
}

/** Must precede the normal 100kb parser; no other endpoint gets this limit. */
export function registerCategoryRestartBodyParser(app: Express): void {
  registerCategoryRestartModesBodyParser(app);
  app.post("/api/ring/restart-category", express.json({ limit: "2mb" }));
  const handleRestartJsonError: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (req.path !== "/api/ring/restart-category") return next(error);
    const status =
      error !== null && typeof error === "object" && "status" in error ? error.status : undefined;
    res.status(status === 413 ? 413 : 400).json({
      ok: false,
      error: "invalid_payload",
      message:
        status === 413
          ? "El archivo de categoría supera el límite de 2 MiB."
          : "El JSON de la categoría no es válido.",
    });
  };
  app.use(handleRestartJsonError);
}

export function registerCategoryRestartRoutes(app: Express, io: Server): void {
  app.get("/api/ring/categories/:categoryId/replacement", (req, res, next) => {
    try {
    const result = getCategoryReplacement(String(req.params.categoryId));
    if (!result) {
      res.status(404).json({
        ok: false,
        error: "replacement_not_found",
        message: "No se encontró una ejecución de reemplazo.",
      });
      return;
    }
    res.json(result);
    } catch (error) {
      if (!sendCategoryExecutionError(error, res)) next(error);
    }
  });
  app.post("/api/ring/restart-category", (req, res) => {
    const parsed = restartCategoryRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "invalid_payload",
        message: "Los datos de reinicio de categoría no son válidos.",
      });
      return;
    }
    try {
      const result = restartCategoryExecution(parsed.data, {
        hasUnconfirmedMatch: state.match !== null && !state.resultConfirmed,
        selectedTournamentId: state.activeTournamentId,
      });
      // Nothing operational changes until the archive transaction has committed.
      clearConfirmedMatchSnapshot();
      if (state.activeTournamentId === result.archive.sourceTournamentId) {
        state.activeTournamentId = result.archive.replacementTournamentId;
      }
      if (state.match && state.resultConfirmed) {
        if (state.tickInterval) clearInterval(state.tickInterval);
        state.tickInterval = null;
        state.rules = null;
        state.match = null;
        state.matchState = null;
        state.matchPaused = false;
        state.matchCategoryId = null;
        state.matchTournamentId = null;
        state.resultConfirmed = false;
        state.legacyMatchAssociationWarning = null;
        state.roundFlags = [];
        state.judgeVotes.clear();
        state.judges.clear();
        state.nextJudgeNum = 1;
        state.tulPhase = "idle";
      }
      res.json(result);
      broadcast(io);
    } catch (error) {
      if (sendCategoryExecutionError(error, res)) return;
      res.status(500).json({
        ok: false,
        error: "restart_failed",
        message: "No se pudo archivar la categoría; no se modificó su ejecución.",
      });
    }
  });
}
