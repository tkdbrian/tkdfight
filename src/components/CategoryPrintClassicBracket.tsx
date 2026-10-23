import * as React from "react";
import type {CategoryPrintClassicSheet} from "@/lib/category-print";

interface FittedName {lines:string[];truncated:boolean}
type MeasureText=(text:string)=>number;
const estimatedWidth:MeasureText=text=>Array.from(text).reduce((width,char)=>width+(/[MW]/.test(char)?16:/[ilI .,:]/.test(char)?4.5:char.codePointAt(0)!>0x2ff?16.5:9),0);

/** Bound labels to two readable lines; the complete identity is retained in the roster. */
export function fitClassicName(text:string,width:number,marker:string,measure:MeasureText=estimatedWidth):FittedName {
  const source=Array.from(text.replace(/\s+/g," ").trim());
  const lines:string[]=[];
  while(source.length && lines.length<2){
    let line="";
    while(source.length && measure(line+source[0])<=width)line+=source.shift();
    if(!line && source.length)line=source.shift() ?? "";
    lines.push(line.trim());
  }
  const truncated=source.length>0;
  if(truncated){
    let last=lines[1] ?? "";
    const suffix=`… ${marker}`;
    while(last && measure(last+suffix)>width)last=last.slice(0,-1);
    lines[1]=last+suffix;
  }
  return {lines:lines.length?lines:["—"],truncated};
}

interface Label {key:string;x:number;y:number;name:string;width:number;marker:string;structural?:boolean}
interface Stroke {key:string;x1:number;y1:number;x2:number;y2:number}
export function CategoryPrintClassicBracket({sheet,sheets,onNeedsRoster}:Readonly<{
  sheet:CategoryPrintClassicSheet;sheets:readonly CategoryPrintClassicSheet[];onNeedsRoster:(needed:boolean)=>void;
}>):React.JSX.Element {
  const [measure,setMeasure]=React.useState<MeasureText>(()=>(text:string)=>estimatedWidth(text)*18/16.5);
  React.useLayoutEffect(()=>{
    if(typeof CanvasRenderingContext2D==="undefined")return;
    const context=document.createElement("canvas").getContext("2d");
    if(!context)return;
    context.font="18px Arial";
    setMeasure(()=>((text:string)=>context.measureText(text).width));
  },[]);
  const columns=sheet.rounds.length+1,width=1140/Math.max(columns,2),start=35;
  const spacing=680/(Math.max(sheet.inputSlots,2)+1);
  const labels:Label[]=[],strokes:Stroke[]=[],centres=new Map<string,number>();
  const references=new Map(sheets.flatMap((panel,index)=>panel.rounds.flatMap(round=>round.matches.map(match=>[match.id,`P${index+1}/${match.label.replace("Cruce ","C")}`] as const))));
  const markerFor=(name:string,id?:string):string=>{
    const entry=sheet.roster.find(competitor=>id ? competitor.id===id : competitor.name===name);
    return entry?`[${entry.entryNumber}]`:"[ver nómina]";
  };
  const keyForName=(name:string):string=>name.replace(/\s+/g," ").trim().toLocaleLowerCase("es");
  const counts=new Map<string,number>();
  sheet.roster.forEach(entry=>counts.set(keyForName(entry.name),(counts.get(keyForName(entry.name)) ?? 0)+1));
  const duplicateNames=new Set([...counts].filter(([,count])=>count>1).map(([name])=>name));
  const identityName=(name:string,id?:string):string=>name+(duplicateNames.has(keyForName(name))?` ${markerFor(name,id)}`:"");
  const line=(key:string,x1:number,y1:number,x2:number,y2:number):void=>{strokes.push({key,x1,y1,x2,y2});};
  for(const [column,round] of sheet.rounds.entries())for(const [index,match] of round.matches.entries()){
    const x=start+width*(column+1);
    let redY:number,blueY:number;
    if(column===0){
      redY=(index*2+1)*spacing;blueY=(index*2+2)*spacing;
      for(const [slot,y,side] of [[match.red,redY,0],[match.blue,blueY,1]] as const){
        const prefix=slot.sourceMatchId ? `(${references.get(slot.sourceMatchId) ?? "Referencia anterior"}) ` : "";
        labels.push({key:`${match.id}-${side}`,x:start+5,y:y-5,name:prefix+identityName(slot.name,slot.competitorId),width:width-18,marker:markerFor(slot.name,slot.competitorId)});
        labels.push({key:`${match.id}-${side}-position`,x:4,y:y-4,name:String(slot.inputPosition ?? index*2+side+1),width:26,marker:"",structural:true});
        line(`${match.id}-${side}-input`,start,y,x,y);
      }
    }else{
      redY=centres.get(match.red.sourceMatchId ?? "") ?? (index*2+.5)*680/round.matches.length/2;
      blueY=centres.get(match.blue.sourceMatchId ?? "") ?? (index*2+1.5)*680/round.matches.length/2;
    }
    const middle=(redY+blueY)/2;
    centres.set(match.id,middle);
    line(`${match.id}-cross`,x,redY,x,blueY);
    line(`${match.id}-winner`,x,middle,x+width,middle);
    labels.push({key:`${match.id}-name`,x:x+6,y:middle-5,name:identityName(match.winnerName,match.winnerId),width:width-18,marker:markerFor(match.winnerName,match.winnerId)});
    const next=match.nextPanelId ? ` → ${references.get(match.nextMatchId ?? "") ?? "Hoja siguiente"}` : "";
    labels.push({key:`${match.id}-ref`,x:x+5,y:middle+17,name:match.label.replace("Cruce ","C")+(match.isBye?" · Pase libre":"")+next,width:width-15,marker:"",structural:true});
  }
  const fitted=labels.map(label=>({...label,fit:label.structural?{lines:[label.name],truncated:false}:fitClassicName(label.name,label.width,label.marker,measure)}));
  const needsRoster=duplicateNames.size>0 || fitted.some(label=>label.fit.truncated);
  const callback=React.useRef(onNeedsRoster);callback.current=onNeedsRoster;
  React.useEffect(()=>{callback.current(needsRoster);},[needsRoster]);
  return <svg className="category-print-classic-bracket" viewBox="0 0 1200 680" preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Llave completa: ${sheet.label}`}>
    <title>{sheet.label}</title>
    <g fill="none" stroke="#000" strokeWidth="1.2">{strokes.map(stroke=><line key={stroke.key} x1={stroke.x1} y1={stroke.y1} x2={stroke.x2} y2={stroke.y2}/>)}</g>
    <g fill="#000" fontFamily="Arial" fontSize="18">{fitted.map(label=><text key={label.key} x={label.x} y={label.y} fontSize={label.structural ? 14.5 : label.fit.lines.length===2 ? 16:18}>
      {label.fit.lines.map((text,index)=><tspan key={index} x={label.x} dy={index===0 ? (label.fit.lines.length===2?-16:0) : 17}>{text}</tspan>)}
    </text>)}</g>
  </svg>;
}
