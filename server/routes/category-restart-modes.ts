import express, { type ErrorRequestHandler, type Express, type Response } from "express";
import type { Server } from "socket.io";
import { categoryDeleteAndRestartRequestSchema } from "../../src/lib/category-restart-modes-contract.js";
import { broadcast } from "../broadcast.js";
import {
  CategoryExecutionError,
  CategoryRestartModeError,
  deleteAndRestartCategoryExecution,
  getCategoryDeleteAndRestart,
  getCategoryTournamentId,
} from "../db/index.js";
import { state } from "../state.js";
import { sendCategoryDeletionError } from "./category-deletion.js";

function sendRestartError(error: unknown, res: Response): void {
  if (error instanceof CategoryRestartModeError) {
    res.status(error.response.error === "replacement_deleted" ? 410 : 409).json(error.response);
  } else if (sendCategoryDeletionError(error, res)) {
    return;
  } else if (error instanceof CategoryExecutionError) {
    res.status(409).json({
      ok: false,
      error: error.code,
      message: error.message,
      ...(error.categoryId ? { categoryId: error.categoryId } : {}),
      ...(error.replacementCategoryId
        ? { replacementCategoryId: error.replacementCategoryId }
        : {}),
    });
  } else {
    res.status(500).json({
      ok: false,
      error: "restart_failed",
      message: "No se confirmó el reinicio. Consultá su recibo antes de reintentar.",
    });
  }
}

/** Installed with the existing restart parser, before the normal 100kb parser. */
export function registerCategoryRestartModesBodyParser(app: Express): void {
  app.post("/api/ring/categories/:categoryId/delete-and-restart", express.json({ limit: "2mb" }));
  const handleJsonError: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (!/^\/api\/ring\/categories\/[^/]+\/delete-and-restart\/?$/.test(req.path))
      return next(error);
    const status =
      error !== null && typeof error === "object" && "status" in error ? error.status : undefined;
    res.status(status === 413 ? 413 : 400).json({
      ok: false,
      error: "invalid_payload",
      message:
        status === 413
          ? "La categoría supera el límite de 2 MiB."
          : "El JSON del reinicio no es válido.",
    });
  };
  app.use(handleJsonError);
}

export function registerCategoryRestartModesRoutes(app: Express, io: Server): void {
  const route = "/api/ring/categories/:categoryId/delete-and-restart";
  app.get(route, (req, res) => {
    try {
      const result = getCategoryDeleteAndRestart(String(req.params.categoryId));
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
      sendRestartError(error, res);
    }
  });
  app.post(route, (req, res) => {
    const parsed = categoryDeleteAndRestartRequestSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.previousSnapshot.config.id !== req.params.categoryId) {
      res.status(400).json({
        ok: false,
        error: "invalid_payload",
        message: "La solicitud de reinicio no es válida.",
      });
      return;
    }
    let result: ReturnType<typeof deleteAndRestartCategoryExecution>;
    try {
      result = deleteAndRestartCategoryExecution(parsed.data, {
        hasUnconfirmedMatch: state.match !== null && !state.resultConfirmed,
      });
    } catch (error) {
      sendRestartError(error, res);
      return;
    }
    // The entire delete/create transaction committed; never clear memory during its savepoint.
    const receipt = result.deletion;
    if (receipt.tournamentId !== null && state.activeTournamentId === receipt.tournamentId) {
      const nextId = getCategoryTournamentId(result.replacementCategoryId);
      if (nextId !== null) state.activeTournamentId = nextId;
    }
    const ownRemnant =
      state.matchCategoryId === receipt.categoryId ||
      (receipt.tournamentId !== null && state.matchTournamentId === receipt.tournamentId);
    if (ownRemnant) {
      if (state.tickInterval) clearInterval(state.tickInterval);
      state.tickInterval = null;
      state.rules = null;
      state.match = null;
      state.matchState = null;
      state.matchCategoryId = null;
      state.matchTournamentId = null;
      state.resultConfirmed = false;
      state.matchPaused = false;
      state.legacyMatchAssociationWarning = null;
      state.roundFlags = [];
      state.judgeVotes.clear();
      state.judges.clear();
      state.nextJudgeNum = 1;
      state.tulPhase = "idle";
    }
    state.fallos = state.fallos.filter((fallo) => fallo.categoryId !== receipt.categoryId);
    res.json(result);
    io.emit("category:deleted", receipt);
    broadcast(io);
  });
}
