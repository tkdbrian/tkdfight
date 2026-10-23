import express, { type ErrorRequestHandler, type Express, type Response } from "express";
import type { Server } from "socket.io";
import {
  categoryDeletionPreviewRequestSchema,
  categoryDeletionRequestSchema,
} from "../../src/lib/category-deletion-contract.js";
import { broadcast } from "../broadcast.js";
import {
  CategoryDeletionError,
  deleteCategoryExecution,
  getCategoryDeletion,
  previewCategoryDeletion,
} from "../db/index.js";
import { state } from "../state.js";

export function sendCategoryDeletionError(error: unknown, res: Response): boolean {
  if (!(error instanceof CategoryDeletionError)) return false;
  const status =
    error.code === "category_deleted" || error.code === "replacement_deleted"
      ? 410
      : error.code === "invalid_payload"
        ? 400
        : error.code === "deletion_not_found"
          ? 404
          : error.code === "deletion_failed"
            ? 500
            : 409;
  res.status(status).json({
    ok: false,
    error: error.code,
    message: error.message,
    ...(error.categoryId ? { categoryId: error.categoryId } : {}),
    ...(error.deletion ? { deletion: error.deletion } : {}),
  });
  return true;
}
export function registerCategoryDeletionBodyParser(app: Express): void {
  app.post(
    [
      "/api/ring/categories/:categoryId/deletion-preview",
      "/api/ring/categories/:categoryId/delete",
    ],
    express.json({ limit: "2mb" })
  );
  const handleJsonError: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (!/^\/api\/ring\/categories\/[^/]+\/(deletion-preview|delete)\/?$/.test(req.path))
      return next(error);
    const status =
      error !== null && typeof error === "object" && "status" in error ? error.status : undefined;
    res.status(status === 413 ? 413 : 400).json({
      ok: false,
      error: "invalid_payload",
      message:
        status === 413
          ? "La categoría supera el límite de 2 MiB."
          : "El JSON de eliminación no es válido.",
    });
  };
  app.use(handleJsonError);
}
export function registerCategoryDeletionRoutes(app: Express, io: Server): void {
  app.get("/api/ring/categories/:categoryId/deletion", (req, res) => {
    const receipt = getCategoryDeletion(String(req.params.categoryId));
    if (!receipt) {
      res.status(404).json({
        ok: false,
        error: "deletion_not_found",
        message: "No hay una eliminación registrada.",
      });
      return;
    }
    res.json(receipt);
  });
  app.post("/api/ring/categories/:categoryId/deletion-preview", (req, res) => {
    const parsed = categoryDeletionPreviewRequestSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.localSnapshot.config.id !== req.params.categoryId) {
      res.status(400).json({
        ok: false,
        error: "invalid_payload",
        message: "La categoría y su snapshot no son válidos.",
      });
      return;
    }
    try {
      res.json(
        previewCategoryDeletion(parsed.data.localSnapshot, {
          hasUnconfirmedMatch: state.match !== null && !state.resultConfirmed,
        })
      );
    } catch (error) {
      if (!sendCategoryDeletionError(error, res)) {
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "category_archived"
        ) {
          res.status(409).json({
            ok: false,
            error: "category_archived",
            message: "Los archivos anteriores no se eliminan con esta acción.",
          });
        } else
          res.status(500).json({
            ok: false,
            error: "deletion_failed",
            message: "No se pudo revisar la eliminación.",
          });
      }
    }
  });
  app.post("/api/ring/categories/:categoryId/delete", (req, res) => {
    const parsed = categoryDeletionRequestSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.localSnapshot.config.id !== req.params.categoryId) {
      res.status(400).json({
        ok: false,
        error: "invalid_payload",
        message: "La solicitud de eliminación no es válida.",
      });
      return;
    }
    let receipt: ReturnType<typeof deleteCategoryExecution>;
    try {
      receipt = deleteCategoryExecution(parsed.data, {
        hasUnconfirmedMatch: state.match !== null && !state.resultConfirmed,
      });
    } catch (error) {
      if (!sendCategoryDeletionError(error, res)) {
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "category_archived"
        ) {
          res.status(409).json({
            ok: false,
            error: "category_archived",
            message: "Los archivos anteriores no se eliminan con esta acción.",
          });
        } else
          res.status(500).json({
            ok: false,
            error: "deletion_failed",
            message: "No se confirmó la eliminación. Consultá su recibo antes de reintentar.",
          });
      }
      return;
    }
    // Database receipt and delete are committed. Only this execution's terminal remnants clear.
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
    res.json(receipt);
    io.emit("category:deleted", receipt);
    broadcast(io);
  });
}
