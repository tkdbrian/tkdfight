import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CategoryPrintReport } from "@/lib/category-print";
import { CategoryPrintPreview } from "./CategoryPrintPreview";
import {readFileSync} from "node:fs";
afterEach(cleanup);
it("insets printed right box borders from browser fractional page clipping without shrinking the bracket",()=>{
 const styles=readFileSync("src/components/CategoryPrintPreview.css","utf8");
 const printRules=styles.slice(styles.indexOf("@media print"));
 expect(printRules).toMatch(/\.category-print-reference-metadata,\.category-print-reference-podium\s*\{\s*right:\s*\.3mm/);
 expect(printRules).not.toMatch(/\.category-print-classic-bracket\s*\{[^}]*width:/);
});
const report: CategoryPrintReport = {
 categoryId:"cat",title:"Infantiles <script>alert(1)</script>",eventName:"Torneo",tatami:"T1",discipline:"Sparring",generatedAt:"2026-10-23T12:00:00.000Z",format:"round-robin",
 details:[],champion:{id:"a",name:"Ana"},runnerUp:{id:"b",name:"Bruno"},panels:[],groups:[{id:"G1",label:"Llave G1",rows:[{position:1,id:"a",name:"Ana",played:2,wins:2,draws:0,losses:0,points:6,flagsFor:8,foulsAgainst:0,warnings:1}]}],appendix:[{id:"final",label:"Final",redName:"Ana",blueName:"Bruno",winnerName:"Ana",flagsRed:3,flagsBlue:1}]
};
it("renders printable safe text and separates standings from the decisive bouts", () => {
 render(<CategoryPrintPreview report={report} onBack={vi.fn()}/>);
 expect(screen.getAllByText(report.title).length).toBeGreaterThan(0);
 expect(document.querySelector("script")).toBeNull();
 expect(screen.getByRole("columnheader",{name:"Pts."})).toBeInTheDocument();
 expect(screen.getByText(/PJ: peleas jugadas/)).toHaveTextContent("P. contra: puntos en contra");
 expect(screen.getByText("Final")).toBeInTheDocument();
 expect(screen.getByRole("checkbox")).not.toBeChecked();
 expect(screen.queryByText(/Detalle de combates/)).toBeNull();
});
it("prints only on explicit action and exits without touching the tournament", () => {
 const print=vi.spyOn(window,"print").mockImplementation(()=>{}),onBack=vi.fn();
 render(<CategoryPrintPreview report={report} onBack={onBack}/>);
 expect(print).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Imprimir / Guardar PDF"}));
 expect(print).toHaveBeenCalledOnce();
 fireEvent.click(screen.getByRole("button",{name:"Volver"}));expect(onBack).toHaveBeenCalledOnce();
 print.mockRestore();
});
it("renders real bracket connections with human cross-references, not technical identities",()=>{
 const elimination:CategoryPrintReport={...report,format:"elimination",groups:[],appendix:[],panels:[{id:"technical-panel",label:"Llave A · Panel 1",group:"A",inputSlots:4,rounds:[
  {round:0,label:"Semifinal",matches:[{id:"uuid-first",label:"Combate 1",red:{name:"Ana"},blue:{name:"Bruno"},winnerName:"Ana",isBye:false,nextMatchId:"uuid-final"}]},
  {round:1,label:"Final",matches:[{id:"uuid-final",label:"Combate 3",red:{name:"Ana",sourceMatchId:"uuid-first"},blue:{name:"Carla"},winnerName:"Ana",isBye:false}]}
 ]}]};
 render(<CategoryPrintPreview report={elimination} onBack={vi.fn()}/>);
 expect(document.querySelectorAll(".category-print-classic-bracket line").length).toBeGreaterThan(0);
 expect(screen.getByText("Combate 3")).toBeInTheDocument();
 expect(screen.getByText("Combate 1")).toBeInTheDocument();
 expect(document.body.textContent).not.toContain("uuid-");
 expect(document.querySelector("style")?.textContent).toContain("A4 landscape");
});
it("keeps optional details off until selected and allows keyboard return",()=>{
 const back=vi.fn();render(<CategoryPrintPreview report={{...report,details:[{...report.appendix[0],id:"detail",label:"Combate regular"}]}} onBack={back}/>);
 expect(screen.queryByRole("heading",{name:"Detalle de combates"})).toBeNull();
 fireEvent.click(screen.getByRole("checkbox"));
 expect(screen.getByRole("heading",{name:"Detalle de combates"})).toBeInTheDocument();
 fireEvent.keyDown(screen.getByRole("dialog"),{key:"Escape"});expect(back).toHaveBeenCalledOnce();
});
it("removes its page orientation and restores underlying focusability after closing",()=>{
 const background=document.createElement("div");document.body.appendChild(background);
 const view=render(<CategoryPrintPreview report={report} onBack={vi.fn()}/>);
 expect(background.inert).toBe(true);
 expect(document.querySelector("style")?.textContent).toContain("A4 portrait");
 view.unmount();
 expect(background.inert).toBeFalsy();
 expect(document.querySelector("[data-category-print-root]")).toBeNull();
 expect(document.querySelector("style")).toBeNull();
 background.remove();
});
it("prints a complete classic sheet with podium and chief, without duplicating its ordinary final",()=>{
 const classic:CategoryPrintReport={...report,format:"elimination",groups:[],panels:[],tableChief:"Brian",classicExtras:[],classicSheets:[{id:"whole",label:"Llave completa",group:null,inputSlots:2,roster:[{id:"a",name:"Ana",entryNumber:1},{id:"b",name:"Bruno",entryNumber:2}],rounds:[{round:0,label:"Final",matches:[{id:"final",label:"Cruce 1",red:{name:"Ana"},blue:{name:"Bruno"},winnerName:"Ana",isBye:false}]}]}]};
 render(<CategoryPrintPreview report={classic} onBack={vi.fn()}/>);
 expect(screen.getByRole("heading",{name:/^PLANILLA COMPLETA/})).toBeInTheDocument();
 expect(screen.getByText("Jefe de mesa:").closest("p")).toHaveTextContent("Jefe de mesa: Brian");
 expect(screen.getByText("1º:").closest("p")).toHaveTextContent("Ana");
 expect(document.querySelectorAll(".category-print-sheet")).toHaveLength(1);
 expect(document.querySelector(".category-print-match")).toBeNull();
 expect(screen.queryByRole("heading",{name:"Finales y desempates"})).toBeNull();
});
it("labels the global podium as category results on separate A/B sheets",()=>{
 const sheet={id:"a",label:"Llave A",group:"A" as const,inputSlots:2,roster:[{id:"a",name:"Ana",entryNumber:1},{id:"b",name:"Bruno",entryNumber:2}],rounds:[{round:0,label:"Final de llave",matches:[{id:"match-a",label:"Cruce 1",red:{name:"Ana"},blue:{name:"Bruno"},winnerName:"Ana",isBye:false}]}]};
 const multi:CategoryPrintReport={...report,format:"elimination",groups:[],panels:[],classicExtras:[],champion:{id:"c",name:"Carla"},classicSheets:[sheet,{...sheet,id:"b",label:"Llave B",group:"B"}]};
 render(<CategoryPrintPreview report={multi} onBack={vi.fn()}/>);
 const labels=screen.getAllByText("1º de la categoría:");expect(labels).toHaveLength(2);
 labels.forEach(label=>expect(label.closest("p")).toHaveTextContent("Carla"));
 expect(screen.queryByText("1º:")).toBeNull();
});

function referenceReport():CategoryPrintReport {
 return {...report,format:"elimination",groups:[],panels:[],classicExtras:[],tableChief:"Brian Lipnjak",categoryMetadata:{discipline:"Lucha",grade:"GUPS · Amarillos a Puntas Azules",age:"8-9 años",sex:"Femenino",weight:"Liviano A"},classicSheets:[{id:"whole",label:"Llave completa",group:null,inputSlots:2,roster:[{id:"a",name:"Ana",entryNumber:1},{id:"b",name:"Bruno",entryNumber:2}],rounds:[{round:0,label:"Final",matches:[{id:"final",label:"Cruce 1",red:{name:"Ana",competitorId:"a"},blue:{name:"Bruno",competitorId:"b"},winnerName:"Ana",winnerId:"a",isBye:false}]}]}]};
}
it("places the real selected dimensions in the reference metadata block and boxes podium and chief",()=>{
 render(<CategoryPrintPreview report={referenceReport()} onBack={vi.fn()}/>);
 const metadata=document.querySelector(".category-print-reference-metadata");
 expect(metadata).toHaveTextContent("Lucha");
 expect(metadata?.querySelector('[data-print-field="grade"]')).toHaveTextContent("GUPS · Amarillos a Puntas Azules");
 expect(Array.from(metadata?.querySelectorAll('[data-print-field="grade"] .category-print-reference-line') ?? []).map(line=>line.textContent?.trim())).toEqual(["GUPS · Amarillos a","Puntas Azules"]);
 expect(metadata?.querySelector('[data-print-field="age"]')).toHaveTextContent("8-9 años");
 expect(metadata?.querySelector('[data-print-field="sex"]')).toHaveTextContent("Femenino");
 expect(metadata?.querySelector('[data-print-field="weight"]')).toHaveTextContent("Liviano A");
 const podium=document.querySelector(".category-print-reference-podium");
 expect(podium).toHaveTextContent("1º: Ana");expect(podium).toHaveTextContent("2º: Bruno");
 expect(podium).toHaveTextContent("Jefe de mesa: Brian Lipnjak");
 expect(podium?.querySelector('[data-print-signature]')).toHaveTextContent("Firma:");
 expect(document.querySelectorAll(".category-print-sheet")).toHaveLength(1);
});
it("prints Formas DAN metadata without an invented band or weight and keeps missing legacy dimensions blank",()=>{
 const formas={...referenceReport(),discipline:"Tul / Formas" as const,categoryMetadata:{discipline:"Formas" as const,grade:"1-3 Dan",age:"46+ años",sex:"Mixto" as const,weight:null}};
 const view=render(<CategoryPrintPreview report={formas} onBack={vi.fn()}/>);
 const metadata=document.querySelector(".category-print-reference-metadata");
 expect(metadata).toHaveTextContent("Formas");expect(metadata).toHaveTextContent("1-3 Dan");expect(metadata).toHaveTextContent("46+ años");
 expect(metadata).not.toHaveTextContent("GUPS");expect(metadata?.querySelector('[data-print-field="weight"]')).toBeNull();
 view.unmount();
 render(<CategoryPrintPreview report={{...referenceReport(),title:"1-3 Dan · Masculino · 18-35 años",categoryMetadata:undefined}} onBack={vi.fn()}/>);
 expect(document.querySelector('[data-print-field="grade"]')).toHaveTextContent("................");
 expect(document.querySelector('[data-print-field="sex"]')).not.toHaveTextContent("Masculino");
});
it("retains lengthy header and chief values in a referenced annex without shrinking the bracket",()=>{
 const title="Categoría " + "Extensa".repeat(100),chief="Master " + "Apellido".repeat(60);
 render(<CategoryPrintPreview report={{...referenceReport(),title,tableChief:chief}} onBack={vi.fn()}/>);
 expect(screen.getByRole("heading",{name:"Datos completos de la planilla"})).toBeInTheDocument();
 const appendix=document.querySelector(".category-print-metadata-annex");
 expect(appendix).toHaveTextContent(title);expect(appendix).toHaveTextContent(chief);
 expect(document.querySelector(".category-print-reference-podium")).toHaveTextContent("[M3]");
 expect(document.querySelector(".category-print-classic-bracket")).toHaveAttribute("viewBox","0 0 1200 680");
});
it("uses narrower margins only for elimination and preserves full long compact fields via references",()=>{
 const view=render(<CategoryPrintPreview report={{...referenceReport(),tableChief:"Master "+"Apellido".repeat(20),champion:{id:"a",name:"Nombre".repeat(30)}}} onBack={vi.fn()}/>);
 expect(document.querySelector("style")?.textContent).toContain("margin: 8mm");
 const podium=document.querySelector(".category-print-reference-podium");
 expect(podium?.querySelectorAll("p:nth-child(1) .category-print-reference-line")).toHaveLength(1);
 expect(podium?.querySelectorAll("p:nth-child(3) .category-print-reference-line")).toHaveLength(1);
 expect(document.querySelector(".category-print-metadata-annex")).toHaveTextContent("Master "+"Apellido".repeat(20));
 view.unmount();
 render(<CategoryPrintPreview report={report} onBack={vi.fn()}/>);
 expect(document.querySelector("style")?.textContent).toContain("margin: 12mm");
});
it("does not add classic metadata references or annexes to Round Robin reports",()=>{
 render(<CategoryPrintPreview report={{...report,tableChief:"Apellido".repeat(100),categoryMetadata:{discipline:"Lucha",grade:"GUPS "+"Amarillo".repeat(50),age:"8-9 años",sex:"Femenino",weight:"Peso".repeat(100)}}} onBack={vi.fn()}/>);
 expect(screen.queryByRole("heading",{name:"Datos completos de la planilla"})).toBeNull();
 expect(document.querySelector(".category-print-reference-metadata")).toBeNull();
 expect(document.querySelector(".category-print-reference-podium")).toBeNull();
 expect(document.querySelectorAll(".category-print-sheet")).toHaveLength(2);
});
