import * as XLSX from "xlsx";
import { expect, it } from "vitest";
import { parseDemoSpreadsheet } from "./DemoSpreadsheet";

it("reads the portable category-column layout without importing other categories automatically", async () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["", "COMBATE", "", "", "", "", "", "FORMAS"],
    ["", "EDAD JUNIOR", "", "", "", "", "", "EDAD JUNIOR"],
    ["", "MASC", "", "", "", "", "", "FEM"],
    ["", "PESO LIVIANO A", "", "", "", "", "", ""],
    ["", "APELLIDO Y NOMBRE", "", "", "", "", "", "APELLIDO Y NOMBRE"],
    ["", "Juan Pérez", "", "", "", "", "", "Ana García"],
    ["", "Pedro Ruiz", "", "", "", "", "", "María Solís"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Torneo");
  const content = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const file = { name: "torneo.xlsx", arrayBuffer: async () => content } as File;
  const parsed = await parseDemoSpreadsheet(file);
  expect(parsed.simpleCompetitors).toEqual([]);
  expect(parsed.categories).toHaveLength(2);
  expect(parsed.categories[0]).toMatchObject({ name: "JUNIOR · MASC · LIVIANO A", matchType: "sparring",
    competitors: ["Juan Pérez", "Pedro Ruiz"] });
  expect(parsed.categories[1]).toMatchObject({ name: "JUNIOR · FEM", matchType: "tul",
    competitors: ["Ana García", "María Solís"] });
});

it("accepts a simple name/club workbook as a roster preview", async () => {
  const sheet = XLSX.utils.aoa_to_sheet([["Nombre", "Club"], ["Ana", "Club A"], ["Beto", "Club B"]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Lista");
  const content = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const parsed = await parseDemoSpreadsheet({ name: "lista.xlsx", arrayBuffer: async () => content } as File);
  expect(parsed.categories).toEqual([]);
  expect(parsed.simpleCompetitors).toEqual([{ name: "Ana", team: "Club A" }, { name: "Beto", team: "Club B" }]);
});
