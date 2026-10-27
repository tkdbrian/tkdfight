import * as XLSX from "xlsx";

export interface DemoImportedCategory {
  name: string;
  matchType: "sparring" | "tul";
  competitors: string[];
}

function parseText(text: string): DemoImportedCategory[] {
  const found: DemoImportedCategory[] = [];
  let current: DemoImportedCategory | null = null;
  let discipline: DemoImportedCategory["matchType"] = "sparring";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^(COMBATE|FORMAS?|POOMSAE|TUL|SPARRING)\s+(.+)/i);
    if (section) { discipline = /^(FORMAS?|POOMSAE|TUL)$/i.test(section[1]) ? "tul" : "sparring"; continue; }
    const header = line.match(/^EDAD\s+(.+?)\s+-\s+(MASC|FEM|MASCULINO|FEMENINO)\s+-\s+PESO\s+(.+)$/i);
    if (header) {
      if (current && current.competitors.length >= 2) found.push(current);
      current = { name: [header[1].trim(), header[2].trim(), header[3].trim()].join(" · "),
        matchType: discipline, competitors: [] };
      continue;
    }
    const competitor = line.match(/^\d+[.)-]\s+(.+)/);
    if (current && competitor && competitor[1].trim().length > 1) current.competitors.push(competitor[1].trim());
  }
  if (current && current.competitors.length >= 2) found.push(current);
  return found;
}

function parseCategorySheets(workbook: XLSX.WorkBook): DemoImportedCategory[] {
  const found: DemoImportedCategory[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const sectionColumns = row.flatMap((value, index) => /^(COMBATE|FORMAS?|POOMSAE|TUL|SPARRING)$/i.test(String(value).trim()) ? [index] : []);
      if (!sectionColumns.length) continue;
      let nameStart = rowIndex + 5;
      for (let next = rowIndex + 1; next <= Math.min(rowIndex + 8, rows.length - 1); next++) {
        if (rows[next].some((cell) => String(cell).toUpperCase().includes("APELLIDO"))) { nameStart = next + 1; break; }
      }
      for (const sectionColumn of sectionColumns) {
        const matchType = /^(FORMAS?|POOMSAE|TUL)$/i.test(String(row[sectionColumn]).trim()) ? "tul" : "sparring";
        for (const offset of [0, 3]) {
          const column = sectionColumn + offset;
          let age = "", gender = "", weight = "";
          for (let meta = rowIndex + 1; meta < nameStart; meta++) {
            const value = String(rows[meta]?.[column] ?? "").trim();
            if (!value) continue;
            if (/^EDAD\b|^(INFANTIL|PRE.?JUNIOR|JUNIOR|ADULTO|SENIOR|VETERANO)/i.test(value)) age = value.replace(/^EDAD\s+/i, "");
            else if (/^(MASC|FEM|MASCULINO|FEMENINO)$/i.test(value)) gender = value;
            else if (/^PESO\b|\d.*KG/i.test(value)) weight = value.replace(/^PESO\s+/i, "");
          }
          if (!age && !gender && !weight) continue;
          const competitors = rows.slice(nameStart, nameStart + 25)
            .map((entry) => String(entry[column] ?? "").trim())
            .filter((value) => value.length > 2 && !/^\d+$/.test(value));
          if (competitors.length >= 2) found.push({ name: [age, gender, matchType === "tul" ? "" : weight].filter(Boolean).join(" · "),
            matchType, competitors });
        }
      }
    }
  }
  return found;
}

/** Parses the portable category sheet/TXT layout; a plain name/club sheet is a single list. */
export async function parseDemoSpreadsheet(file: File): Promise<{
  categories: DemoImportedCategory[];
  simpleCompetitors: Array<{ name: string; team: string }>;
}> {
  if (file.name.toLocaleLowerCase().endsWith(".txt")) {
    const categories = parseText(await file.text());
    if (!categories.length) throw new Error("No se encontraron categorías en el archivo TXT.");
    return { categories, simpleCompetitors: [] };
  }
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const categories = parseCategorySheets(workbook);
  if (categories.length) return { categories, simpleCompetitors: [] };
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("La planilla no tiene hojas.");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
  const simpleCompetitors = rows.map((row) => ({ name: String(row[0] ?? "").trim(), team: String(row[1] ?? "").trim() }))
    .filter((row) => row.name && !/^(nombre|apellido y nombre|competidor)$/i.test(row.name));
  if (!simpleCompetitors.length) throw new Error("No se encontraron nombres en la primera columna.");
  return { categories: [], simpleCompetitors };
}
