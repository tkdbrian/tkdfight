import * as React from "react";
import { z } from "zod";
import { useShallow } from "zustand/react/shallow";
import { useTournamentStore, type TournamentCategorySnapshot } from "@/store/tournament";
import { useCategoryInteractionBlocked } from "@/hooks/useCategoryInteractionBlocked";
import { categoryRestartInteractionBlocked } from "@/store/category-restart-state";
import { createCategoryPrintReport, getCategoryPrintEligibility, type CategoryPrintReport } from "@/lib/category-print";
import { Button } from "@/components/ui/button";
import { CategoryPrintPreview } from "./CategoryPrintPreview";

type ReadOnlyRequest = <T>(event:string,data:unknown,timeoutMs?:number)=>Promise<T|null>;
interface CategoryPrintActionProps { connected:boolean; stateReady:boolean; request:ReadOnlyRequest; tatami?:string }
const confirmedResult = z.object({ok:z.literal(true),result:z.object({
  fightId:z.string(),categoryId:z.string(),status:z.literal("confirmed"),winner:z.enum(["red","blue","draw"]),
  flagsRed:z.number().int().optional(),flagsBlue:z.number().int().optional(),
  foulsRed:z.number().int().optional(),foulsBlue:z.number().int().optional(),
  warningsRed:z.number().int().optional(),warningsBlue:z.number().int().optional(),
})});
function snapshotOf(state:ReturnType<typeof useTournamentStore.getState>):TournamentCategorySnapshot {
  return {phase:state.phase,config:state.config,competitors:state.competitors,fights:state.fights,
    groups:state.groups,bracketMatches:state.bracketMatches,bracketSeeds:state.bracketSeeds,
    currentFightIndex:state.currentFightIndex,setupStarted:state.setupStarted};
}
async function verifyResults(snapshot:TournamentCategorySnapshot,ids:string[],request:ReadOnlyRequest):Promise<boolean> {
  const fights=snapshot.fights.filter(fight=>ids.includes(fight.id));
  const checks=await Promise.all(fights.map(async fight=>{
    const raw=await request<unknown>("match:result:get",{categoryId:snapshot.config.id,matchId:fight.id});
    const parsed=confirmedResult.safeParse(raw);
    if(!parsed.success)return false;
    const result=parsed.data.result;
    const fields=["flagsRed","flagsBlue","foulsRed","foulsBlue","warningsRed","warningsBlue"] as const;
    return result.categoryId===snapshot.config.id && result.fightId===fight.id && result.winner===fight.winner && fight.completed &&
      fields.every(field=> snapshot.config.mode==="elimination" ? fight[field]===undefined || fight[field]===result[field]
        : Number.isInteger(fight[field]) && Number.isInteger(result[field]) && fight[field]===result[field]);
  }));
  return checks.length===ids.length && checks.length>0 && checks.every(Boolean);
}

export function CategoryPrintAction({connected,stateReady,request,tatami}:Readonly<CategoryPrintActionProps>):React.JSX.Element {
  const snapshot=useTournamentStore(useShallow(snapshotOf));
  const blocked=useCategoryInteractionBlocked();
  const key=JSON.stringify(snapshot);
  const candidate=getCategoryPrintEligibility(snapshot,{categoryId:snapshot.config.id,verified:true,
    confirmedResultIds:snapshot.fights.filter(fight=>fight.completed).map(fight=>fight.id)});
  const requestRef=React.useRef(request);requestRef.current=request;
  const connection=React.useRef({connected,stateReady,epoch:0});
  if(connection.current.connected!==connected || connection.current.stateReady!==stateReady)
    connection.current={connected,stateReady,epoch:connection.current.epoch+1};
  const epoch=connection.current.epoch;
  const [verified,setVerified]=React.useState<{key:string;ids:string[];epoch:number}|null>(null);
  const [report,setReport]=React.useState<CategoryPrintReport|null>(null);
  const [opening,setOpening]=React.useState(false);
  const openingRef=React.useRef(false);
  React.useEffect(()=>{
    if(!candidate.eligible || !connected || !stateReady || blocked || report)return;
    let cancelled=false;
    const ids=candidate.requiredResultIds;
    void verifyResults(snapshot,ids,requestRef.current).then(valid=>{if(!cancelled)setVerified(valid?{key,ids,epoch}:null);})
      .catch(()=>{if(!cancelled)setVerified(null);});
    return()=>{cancelled=true;};
    // The serialized snapshot tracks the exact immutable report inputs and confirmation dependencies.
  },[key,candidate.eligible,connected,stateReady,blocked,report,epoch]);
  const ready=candidate.eligible && connected && stateReady && !blocked && verified?.key===key && verified.epoch===epoch;
  const reason=!candidate.eligible ? candidate.reason : !connected || !stateReady ? "Conectá con el servidor para verificar los resultados."
    : blocked ? "Resolvé la operación o el guardado pendiente antes de imprimir." : !ready ? "Se requieren resultados confirmados y coincidentes con el servidor." : null;
  async function openPreview():Promise<void> {
    if(!ready || !verified || openingRef.current)return;
    const latest=structuredClone(snapshotOf(useTournamentStore.getState()));
    if(JSON.stringify(latest)!==verified.key)return;
    openingRef.current=true;setOpening(true);
    try {
      const valid=await verifyResults(latest,verified.ids,requestRef.current);
      if(!valid){setVerified(null);return;}
      if(connection.current.epoch!==epoch || !connection.current.connected || !connection.current.stateReady ||
        categoryRestartInteractionBlocked() || JSON.stringify(snapshotOf(useTournamentStore.getState()))!==verified.key)return;
      const frozen=createCategoryPrintReport(latest,{categoryId:latest.config.id,verified:true,confirmedResultIds:verified.ids,tatami});
      if(frozen)setReport(frozen);
    } catch {setVerified(null);}
    finally{openingRef.current=false;setOpening(false);}
  }
  return <div className="flex flex-col items-start gap-1">
    <Button type="button" variant="outline" size="sm" disabled={!ready || opening} title={reason ?? undefined} onClick={()=>{void openPreview();}}>Imprimir categoría</Button>
    {opening && <p className="text-xs text-muted-foreground" role="status">Verificando resultados para la vista previa…</p>}
    {reason && <p className="max-w-xs text-xs text-muted-foreground" role="status">{reason}</p>}
    {report && <CategoryPrintPreview report={report} onBack={()=>{setVerified(null);setReport(null);}}/>}
  </div>;
}
