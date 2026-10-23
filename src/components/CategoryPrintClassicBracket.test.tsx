import {cleanup,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import type {CategoryPrintClassicSheet} from "@/lib/category-print";
import {CategoryPrintClassicBracket,fitClassicName} from "./CategoryPrintClassicBracket";
afterEach(cleanup);
const sheet:CategoryPrintClassicSheet={id:"p1",label:"Llave completa",group:null,inputSlots:4,roster:[{id:"a",name:"Ana",entryNumber:1},{id:"b",name:"Bruno",entryNumber:2},{id:"c",name:"Carla",entryNumber:3},{id:"d",name:"Diego",entryNumber:4}],rounds:[
 {round:0,label:"Semifinal",matches:[{id:"m1",label:"Cruce 1",red:{name:"Ana",competitorId:"a",inputPosition:1},blue:{name:"Bruno",competitorId:"b",inputPosition:2},winnerName:"Ana",isBye:false,nextMatchId:"m3"},{id:"m2",label:"Cruce 2",red:{name:"Carla",inputPosition:3},blue:{name:"Diego",inputPosition:4},winnerName:"Carla",isBye:false,nextMatchId:"m3"}]},
 {round:1,label:"Final",matches:[{id:"m3",label:"Cruce 3",red:{name:"Ana",sourceMatchId:"m1"},blue:{name:"Carla",sourceMatchId:"m2"},winnerName:"Ana",isBye:false}]}
]};
it("draws familiar lines and crosses without colored fight cards or repeated side labels",()=>{
 render(<CategoryPrintClassicBracket sheet={sheet} sheets={[sheet]} onNeedsRoster={vi.fn()}/>);
 expect(screen.getByText("Bruno")).toBeInTheDocument();
 expect(document.querySelectorAll("svg line").length).toBeGreaterThanOrEqual(10);
 expect(screen.queryByText(/Rojo:|Azul:|Ganador:/)).toBeNull();
 expect(document.querySelector(".category-print-match")).toBeNull();
});
it("keeps long identities in an explicit roster instead of clipping or reducing font size",()=>{
 const full="María".repeat(50),onNeedsRoster=vi.fn();
 const fit=fitClassicName(full,150,"[1]",text=>text.length*10);
 expect(fit.lines).toHaveLength(2);expect(fit.truncated).toBe(true);expect(fit.lines[1]).toContain("[1]");
 render(<CategoryPrintClassicBracket sheet={{...sheet,rounds:sheet.rounds.map(round=>({...round,matches:round.matches.map(match=>({...match,red:{...match.red,name:full,entryNumber:1}}))}))}} sheets={[sheet]} onNeedsRoster={onNeedsRoster}/>);
 expect(onNeedsRoster).toHaveBeenCalledWith(true);
});
it("disambiguates identical short names with their real roster entry numbers",()=>{
 const duplicate:CategoryPrintClassicSheet={...sheet,roster:[{id:"a",name:"Juan",club:"Norte",entryNumber:1},{id:"b",name:"Juan",club:"Sur",entryNumber:2}],rounds:[{round:0,label:"Final",matches:[{id:"same",label:"Cruce 1",red:{name:"Juan",competitorId:"a"},blue:{name:"Juan",competitorId:"b"},winnerName:"Juan",winnerId:"b",isBye:false}]}],inputSlots:2};
 const onNeedsRoster=vi.fn();render(<CategoryPrintClassicBracket sheet={duplicate} sheets={[duplicate]} onNeedsRoster={onNeedsRoster}/>);
 expect(screen.getAllByText("Juan [1]")).toHaveLength(1);
 expect(screen.getAllByText("Juan [2]")).toHaveLength(2);
 expect(onNeedsRoster).toHaveBeenCalledWith(true);
});
it("uses a proportionate taller drawing with larger names, wider row spacing and compact unique references",()=>{
 const sixteen={...sheet,inputSlots:16};
 render(<CategoryPrintClassicBracket sheet={sixteen} sheets={[sixteen]} onNeedsRoster={vi.fn()}/>);
 const svg=document.querySelector("svg");
 expect(svg).toHaveAttribute("viewBox","0 0 1200 680");
 expect(svg).toHaveAttribute("preserveAspectRatio","xMidYMid meet");
 expect(screen.getAllByText("Ana")[0].closest("text")).toHaveAttribute("font-size","18");
 expect(screen.getByText("C1")).toBeInTheDocument();expect(screen.queryByText("Cruce 1")).toBeNull();
 const inputs=Array.from(document.querySelectorAll('svg line')).filter(line=>line.getAttribute("x1")==="35");
 expect(Number(inputs[1]?.getAttribute("y1"))-Number(inputs[0]?.getAttribute("y1"))).toBe(40);
});
