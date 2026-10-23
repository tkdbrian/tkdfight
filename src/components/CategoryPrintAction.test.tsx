import { act,cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { useTournamentStore } from "@/store/tournament";
import { useTournamentPersistenceState } from "@/lib/tournament-persistence";
import { CategoryPrintAction } from "./CategoryPrintAction";
const initial=useTournamentStore.getState();
const red={id:"r",name:"Ana"},blue={id:"b",name:"Bruno"};
beforeEach(()=>{localStorage.clear();useTournamentPersistenceState.setState({blocked:false,message:null,conflict:null});useTournamentStore.setState({...initial,phase:"results",config:{...initial.config,id:"print-cat",categoryName:"Categoría",mode:"round-robin"},competitors:[red,blue],groups:[{id:"G1",size:2,competitors:[red,blue]}],fights:[{id:"f",red,blue,completed:true,winner:"red",groupId:"G1",flagsRed:3,flagsBlue:1,foulsRed:0,foulsBlue:0,warningsRed:0,warningsBlue:0}]});});
afterEach(()=>{cleanup();useTournamentStore.setState(initial,true);localStorage.clear();vi.restoreAllMocks();});
it("requires matching confirmed server results and freezes the preview independently of later edits",async()=>{
 const request=vi.fn().mockResolvedValue({ok:true,result:{fightId:"f",categoryId:"print-cat",status:"confirmed",winner:"red",flagsRed:3,flagsBlue:1,foulsRed:0,foulsBlue:0,warningsRed:0,warningsBlue:0}});
 render(<CategoryPrintAction connected stateReady request={request} tatami="T1"/>);
 await waitFor(()=>expect(screen.getByRole("button",{name:"Imprimir categoría"})).toBeEnabled());
 fireEvent.click(screen.getByRole("button",{name:"Imprimir categoría"}));
 await waitFor(()=>expect(screen.getByRole("button",{name:"Imprimir / Guardar PDF"})).toBeInTheDocument());
 act(()=>useTournamentStore.setState({config:{...useTournamentStore.getState().config,categoryName:"Otro nombre"}}));
 expect(screen.getByRole("heading",{level:1,name:"Categoría"})).toBeInTheDocument();
 expect(request.mock.calls.every(([event])=>event==="match:result:get")).toBe(true);
});
it("refuses pending or inconsistent confirmations without changing local data",async()=>{
 const request=vi.fn().mockResolvedValue({ok:true,result:{fightId:"f",categoryId:"wrong",status:"confirmed",winner:"red"}});
 const snapshot=JSON.stringify(useTournamentStore.getState().fights);
 render(<CategoryPrintAction connected stateReady request={request}/>);
 await waitFor(()=>expect(request).toHaveBeenCalled());
 expect(screen.getByRole("button",{name:"Imprimir categoría"})).toBeDisabled();
 expect(screen.getByText(/confirmados/)).toBeInTheDocument();
 expect(JSON.stringify(useTournamentStore.getState().fights)).toBe(snapshot);
});
it("does not verify or print a category that still has a pending fight",()=>{
 useTournamentStore.setState({fights:useTournamentStore.getState().fights.map(fight=>({...fight,completed:false,winner:undefined}))});
 const request=vi.fn();render(<CategoryPrintAction connected stateReady request={request}/>);
 expect(screen.getByRole("button",{name:"Imprimir categoría"})).toBeDisabled();
 expect(screen.getByRole("status")).toHaveTextContent(/Faltan|pendientes/);
 expect(request).not.toHaveBeenCalled();
});
it("cannot reuse verification after changing the selected category",async()=>{
 const request=vi.fn().mockResolvedValue({ok:true,result:{fightId:"f",categoryId:"print-cat",status:"confirmed",winner:"red",flagsRed:3,flagsBlue:1,foulsRed:0,foulsBlue:0,warningsRed:0,warningsBlue:0}});
 render(<CategoryPrintAction connected stateReady request={request}/>);
 await waitFor(()=>expect(screen.getByRole("button",{name:"Imprimir categoría"})).toBeEnabled());
 act(()=>useTournamentStore.setState({config:{...useTournamentStore.getState().config,id:"different"}}));
 expect(screen.getByRole("button",{name:"Imprimir categoría"})).toBeDisabled();
 await act(async()=>{});
});

it("requires fresh proof after reconnect and rechecks confirmed results on the print click",async()=>{
 const response={ok:true,result:{fightId:"f",categoryId:"print-cat",status:"confirmed",winner:"red",flagsRed:3,flagsBlue:1,foulsRed:0,foulsBlue:0,warningsRed:0,warningsBlue:0}};
 const request=vi.fn().mockResolvedValue(response);
 const view=render(<CategoryPrintAction connected stateReady request={request}/>);
 await waitFor(()=>expect(screen.getByRole("button",{name:"Imprimir categoría"})).toBeEnabled());
 view.rerender(<CategoryPrintAction connected={false} stateReady={false} request={request}/>);
 let reply:((value:unknown)=>void)|undefined;
 request.mockImplementation(()=>new Promise(resolve=>{reply=resolve;}));
 view.rerender(<CategoryPrintAction connected stateReady request={request}/>);
 expect(screen.getByRole("button",{name:"Imprimir categoría"})).toBeDisabled();
 await act(async()=>{reply?.(response);});
 await waitFor(()=>expect(screen.getByRole("button",{name:"Imprimir categoría"})).toBeEnabled());
 request.mockResolvedValue({ok:true,result:{...response.result,status:"pending_confirmation"}});
 fireEvent.click(screen.getByRole("button",{name:"Imprimir categoría"}));
 await waitFor(()=>expect(screen.getByRole("button",{name:"Imprimir categoría"})).toBeDisabled());
 expect(screen.queryByRole("dialog")).toBeNull();
});
