import * as React from "react";
import { createPortal } from "react-dom";
import type { CategoryPrintClassicSheet, CategoryPrintReport } from "@/lib/category-print";
import "./CategoryPrintPreview.css";
import { CategoryPrintClassicBracket, fitClassicName } from "./CategoryPrintClassicBracket";

interface ReferenceField {id:string;label:string;value:string;lines:string[];truncated:boolean}
function fitReferenceText(text:string,width:number,marker:string,maxLines:1|2=2):ReturnType<typeof fitClassicName> {
  let remaining=text.replace(/\s+/g," ").trim();
  const lines:string[]=[];
  while(remaining && lines.length<maxLines){
    let line=fitClassicName(remaining,width,marker).lines[0];
    const wordBoundary=line.lastIndexOf(" ");
    if(line.length<remaining.length && remaining[line.length]!==" " && wordBoundary>0)line=line.slice(0,wordBoundary);
    lines.push(line);
    remaining=remaining.slice(line.length).trimStart();
  }
  const truncated=remaining.length>0;
  if(truncated){
    let last=lines[maxLines-1] ?? "";
    const suffix=`… ${marker}`;
    while(last && fitClassicName(last+suffix,width,marker).lines.length>1)last=Array.from(last).slice(0,-1).join("");
    lines[maxLines-1]=last.trimEnd()+suffix;
  }
  return {lines:lines.length ? lines : ["................"],truncated};
}
function referenceField(id:string,label:string,value:string|null|undefined,width:number,maxLines:1|2=2):ReferenceField {
  const text=value?.trim() || "................";
  return {id,label,value:text,...fitReferenceText(text,width,`[${id}]`,maxLines)};
}
function FieldLines({field}:Readonly<{field:Pick<ReferenceField,"lines"|"value">}>):React.JSX.Element {
  const boundarySpace=field.value.replace(/\s+/g," ").trim()[field.lines[0].length]===" ";
  return <>{field.lines.map((line,index)=><span className="category-print-reference-line" key={index}>{line}{index===0 && field.lines.length>1 && boundarySpace ? " " : ""}</span>)}</>;
}

function ReportHeader({report}: {report: CategoryPrintReport}): React.JSX.Element {
  return <header className="category-print-header">
    {report.eventName && <p>{report.eventName}</p>}
    <h1>{report.title}</h1>
    <p>{report.discipline} · {report.format === "elimination" ? "Eliminación directa" : "Round Robin"}
      {report.tatami ? ` · ${report.tatami}` : ""} · {new Date(report.generatedAt).toLocaleString("es-AR")}</p>
  </header>;
}

export function CategoryPrintPreview({report,onBack}: Readonly<{report:CategoryPrintReport;onBack:()=>void}>): React.JSX.Element {
  const [details,setDetails]=React.useState(false);
  const rootRef=React.useRef<HTMLDivElement>(null);
  React.useEffect(()=>{
    const previousFocus=document.activeElement;
    const siblings=Array.from(document.body.children).filter((element):element is HTMLElement=>element instanceof HTMLElement && element!==rootRef.current);
    const original=siblings.map(element=>({element,inert:element.inert}));
    siblings.forEach(element=>{element.inert=true;});
    rootRef.current?.focus();
    return()=>{original.forEach(({element,inert})=>{element.inert=inert;});if(previousFocus instanceof HTMLElement)previousFocus.focus();};
  },[]);
  const landscape=report.format === "elimination";
  const [needsRosters,setNeedsRosters]=React.useState<Record<string,boolean>>({});
  const classicSheets:CategoryPrintClassicSheet[]=report.classicSheets ?? report.panels.map(panel=>({...panel,
    roster:panel.rounds[0]?.matches.flatMap((match,index)=>[match.red,match.blue].map((slot,side)=>({id:slot.competitorId ?? `${match.id}-${side}`,name:slot.name,club:slot.club,entryNumber:slot.entryNumber ?? index*2+side+1}))) ?? []}));
  const appendix=landscape ? report.classicExtras ?? report.appendix : report.appendix;
  const allEntries=Array.from(new Map(classicSheets.flatMap(sheet=>sheet.roster).map(entry=>[entry.id,entry])).values());
  const awardName=(entry:CategoryPrintReport["champion"]):string=>{
    const duplicate=allEntries.filter(candidate=>candidate.name.trim().toLocaleLowerCase("es")===entry.name.trim().toLocaleLowerCase("es")).length>1;
    const reference=allEntries.find(candidate=>candidate.id===entry.id)?.entryNumber;
    return entry.name+(duplicate && reference ? ` [${reference}]`:"");
  };
  const metadata=report.categoryMetadata ?? {discipline:report.discipline==="Sparring" ? "Lucha" : "Formas",grade:null,age:null,sex:null,weight:null};
  const title=referenceField("M1","Categoría",report.title,780,1);
  const event=referenceField("M2","Torneo",report.eventName,780,1);
  const chief=referenceField("M3","Jefe de mesa",report.tableChief,230,1);
  const dimensions=[referenceField("M4","Grado",metadata.grade,180),referenceField("M5","Edad",metadata.age,180,1),referenceField("M6","Sexo",metadata.sex,180,1),
    ...(metadata.weight ? [referenceField("M7","Peso",metadata.weight,180,1)] : [])];
  const awardField=(entry:CategoryPrintReport["champion"],id:string):ReferenceField=>{
    const reference=allEntries.find(candidate=>candidate.id===entry.id)?.entryNumber;
    return {id,label:id==="M8" ? "Primer puesto" : "Segundo puesto",value:entry.name,...fitReferenceText(awardName(entry),230,reference ? `[${reference}]` : `[${id}]`,1)};
  };
  const champion=awardField(report.champion,"M8"),runnerUp=report.runnerUp ? awardField(report.runnerUp,"M9") : null;
  const podiumNeedsRoster=champion.truncated || runnerUp?.truncated;
  const roster=Array.from(new Map(classicSheets.filter(sheet=>needsRosters[sheet.id] || podiumNeedsRoster).flatMap(sheet=>sheet.roster).map(entry=>[entry.id,entry])).values()).sort((a,b)=>a.entryNumber-b.entryNumber);
  const metadataAnnex=[title,...(report.eventName ? [event] : []),chief,...dimensions,
    ...([champion,runnerUp].filter((entry):entry is ReferenceField=>entry!==null).filter(entry=>!allEntries.some(candidate=>candidate.id===(entry.id==="M8" ? report.champion.id : report.runnerUp?.id))))].filter(field=>field.truncated);
  return createPortal(<div ref={rootRef} role="dialog" aria-modal="true" aria-label="Vista previa de impresión" tabIndex={-1}
    onKeyDown={(event)=>{
      if(event.key==="Escape"){event.preventDefault();onBack();}
      if(event.key!=="Tab")return;
      const focusable=Array.from(rootRef.current?.querySelectorAll<HTMLElement>("button,input") ?? []);
      const first=focusable[0],last=focusable.at(-1);
      if(event.shiftKey && (document.activeElement===first || document.activeElement===rootRef.current)){event.preventDefault();last?.focus();}
      if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
    }} data-category-print-root className={`category-print-root ${landscape ? "category-print-landscape" : "category-print-portrait"}`}>
    <style>{`@media print { @page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: ${landscape ? 8 : 12}mm; } }`}</style>
    <nav className="category-print-toolbar" aria-label="Vista previa de impresión">
      <button type="button" onClick={onBack}>Volver</button>
      <label><input type="checkbox" checked={details} onChange={(event)=>setDetails(event.target.checked)}/> Incluir detalle de combates</label>
      <button type="button" onClick={()=>window.print()}>Imprimir / Guardar PDF</button>
      <p>Vista previa fija. Imprimir no modifica el torneo.</p>
    </nav>
    {report.groups.map((group,index)=><section className="category-print-sheet" key={group.id}>
      <ReportHeader report={report}/>
      {index===0 && <p className="category-print-awards"><strong>Campeón: {report.champion.name}</strong>{report.runnerUp && <> · Subcampeón: {report.runnerUp.name}</>}</p>}
      <h2>{group.label}</h2>
      <p>Puntos de clasificación: victoria 3, empate 1, derrota 0. Banderines: votos de jueces.</p>
      <table className="category-print-standings"><colgroup>{[5,26,17,5,5,5,5,6,11,8,7].map((width,index)=><col key={index} style={{width:`${width}%`}}/>)}</colgroup>
        <thead><tr>{["Pos.","Competidor","Club","PJ","PG","PE","PP","Pts.","Banderines","P. contra","Adv."].map(label=><th key={label}>{label}</th>)}</tr></thead>
        <tbody>{group.rows.map(row=><tr key={row.id}><td>{row.position}</td><td className="category-print-name">{row.name}</td><td className="category-print-name">{row.club ?? "—"}</td><td>{row.played}</td><td>{row.wins}</td><td>{row.draws}</td><td>{row.losses}</td><td>{row.points}</td><td>{row.flagsFor}</td><td>{row.foulsAgainst}</td><td>{row.warnings}</td></tr>)}</tbody></table>
      <p className="category-print-legend">PJ: peleas jugadas · PG: ganadas · PE: empatadas · PP: perdidas · Pts.: puntos de clasificación · Banderines: votos de jueces · P. contra: puntos en contra · Adv.: advertencias. La final y los desempates se muestran por separado; no se suman a estas estadísticas del grupo.</p>
    </section>)}
    {classicSheets.map(sheet=><section className="category-print-sheet category-print-classic-sheet" key={sheet.id}>
      <header className="category-print-classic-caption">
        <h1>PLANILLA COMPLETA <span className="category-print-classic-label">{sheet.label}</span></h1>
        {report.eventName && <p><FieldLines field={event}/></p>}
        <h2><FieldLines field={title}/></h2>
        <p>Eliminación directa{report.tatami ? ` · ${report.tatami}` : ""} · {new Date(report.generatedAt).toLocaleString("es-AR")}</p>
      </header>
      <aside className="category-print-reference-metadata" aria-label="Datos de la categoría">
        <h3>{metadata.discipline}</h3>
        <dl>{dimensions.map(field=><div key={field.id}><dt>{field.label}:</dt><dd data-print-field={field.label==="Grado" ? "grade" : field.label==="Edad" ? "age" : field.label==="Sexo" ? "sex" : "weight"}><FieldLines field={field}/></dd></div>)}</dl>
      </aside>
      <CategoryPrintClassicBracket sheet={sheet} sheets={classicSheets} onNeedsRoster={needed=>setNeedsRosters(current=>current[sheet.id]===needed?current:{...current,[sheet.id]:needed})}/>
      <footer className="category-print-reference-podium">
        <p><strong>{classicSheets.length>1 ? "1º de la categoría:" : "1º:"}</strong> <FieldLines field={champion}/></p>
        {runnerUp && <p><strong>{classicSheets.length>1 ? "2º de la categoría:" : "2º:"}</strong> <FieldLines field={runnerUp}/></p>}
        <p><strong>Jefe de mesa:</strong> <FieldLines field={chief}/></p>
        <p className="category-print-reference-signature" data-print-signature>Firma: <span/></p>
      </footer>
      <p className="category-print-classic-note">C: cruce · P: planilla. Pase libre: avance sin combate.
        {(needsRosters[sheet.id] || podiumNeedsRoster || metadataAnnex.length>0) && <> Referencias [n]: nómina completa. Referencias [M]: anexo de datos completos.</>}</p>
    </section>)}
    {landscape && metadataAnnex.length>0 && <section className="category-print-sheet category-print-metadata-annex"><h1>Datos completos de la planilla</h1>
      <p>Las referencias [M] conservan el texto íntegro de los campos extensos de la hoja principal.</p>
      <table><colgroup><col style={{width:"8%"}}/><col style={{width:"20%"}}/><col style={{width:"72%"}}/></colgroup><thead><tr><th>Ref.</th><th>Campo</th><th>Valor completo</th></tr></thead>
        <tbody>{metadataAnnex.map(field=><tr key={field.id}><td>[{field.id}]</td><td>{field.label}</td><td>{field.value}</td></tr>)}</tbody></table>
    </section>}
    {roster.length>0 && <section className="category-print-sheet"><ReportHeader report={report}/><h2>Nómina completa — referencias de la llave</h2>
      <p>Este anexo conserva las identidades completas de las hojas que utilizan referencias [n].</p>
      <table className="category-print-roster"><colgroup><col style={{width:"7%"}}/><col style={{width:"55%"}}/><col style={{width:"38%"}}/></colgroup>
        <thead><tr><th>Ref.</th><th>Nombre completo</th><th>Club</th></tr></thead><tbody>{roster.map(entry=><tr key={entry.id}><td>[{entry.entryNumber}]</td><td>{entry.name}</td><td>{entry.club ?? "—"}</td></tr>)}</tbody></table>
    </section>}
    {appendix.length>0 && <section className="category-print-sheet"><ReportHeader report={report}/><h2>Finales y desempates</h2><FightTable fights={appendix}/></section>}
    {details && report.details.length>0 && <section className="category-print-sheet"><ReportHeader report={report}/><h2>Detalle de combates</h2><FightTable fights={report.details}/></section>}
  </div>,document.body);
}

function FightTable({fights}: {fights:CategoryPrintReport["appendix"]}): React.JSX.Element {
  return <table className="category-print-fights"><thead><tr><th>Combate</th><th>Rojo</th><th>Azul</th><th>Banderines Rojo–Azul</th><th>Ganador / Fallo</th></tr></thead>
    <tbody>{fights.map(fight=><tr key={fight.id}><td>{fight.label}</td><td>{fight.redName}</td><td>{fight.blueName}</td><td>{fight.flagsRed ?? "—"} – {fight.flagsBlue ?? "—"}</td><td>{fight.winnerName}</td></tr>)}</tbody></table>;
}
