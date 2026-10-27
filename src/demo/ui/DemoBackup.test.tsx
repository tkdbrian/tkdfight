import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { emptyDemoDeskState } from "../runtime/reducer";
import { DEMO_BACKUP_FORMAT, DEMO_SCHEMA_VERSION, type DemoImportPreview } from "../storage";
import type { DemoDeskState } from "../runtime/types";
import { DemoBackup } from "./DemoBackup";

it("requires a preview and explicit consent before replacing or erasing local data", async () => {
  const state = emptyDemoDeskState("event-demo");
  const preview: DemoImportPreview<DemoDeskState> = {
    raw: "{}", currentCursor: { generation: 1, revision: 0 },
    backup: { format: DEMO_BACKUP_FORMAT, version: DEMO_SCHEMA_VERSION, exportedAt: "2026-10-27T12:00:00.000Z",
      snapshot: { schemaVersion: DEMO_SCHEMA_VERSION, kind: "active", generation: 1, revision: 2,
        updatedAt: "2026-10-27T12:00:00.000Z", payload: state }, receipts: [] },
  };
  const importBackup = vi.fn(async () => {});
  const reset = vi.fn(async () => {});
  render(<DemoBackup state={state} readOnly={false} exportBackup={async () => "{}"}
    previewImport={async () => preview} importBackup={importBackup} reset={reset} onError={vi.fn()} />);
  const input = screen.getByLabelText("Importar respaldo JSON") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["{}"], "demo.json", { type: "application/json" })] } });
  await screen.findByRole("heading", { name: "Vista previa del respaldo" });
  expect(screen.getByRole("button", { name: "Importar y reemplazar" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Entiendo que se reemplazará/ }));
  fireEvent.click(screen.getByRole("button", { name: "Importar y reemplazar" }));
  await waitFor(() => expect(importBackup).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Borrar mi demo" }));
  expect(screen.getByRole("button", { name: "Borrar definitivamente" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Escribí BORRAR para confirmar" }), { target: { value: "BORRAR" } });
  fireEvent.click(screen.getByRole("button", { name: "Borrar definitivamente" }));
  await waitFor(() => expect(reset).toHaveBeenCalledOnce());
});
