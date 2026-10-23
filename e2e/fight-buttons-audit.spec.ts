import { expect, type Page, type TestInfo } from '@playwright/test';
import { io } from 'socket.io-client';
import { writeFile } from 'node:fs/promises';
import { test } from './isolated-test';
import { SetupPage } from './setup-page';
import { FightPage } from './fight-page';
import { RoundRobinPage, readFightResult } from './round-robin-page';
import type { ServerState } from '../src/lib/socket-types';

async function server(): Promise<ServerState> {
  return new Promise((resolve,reject)=>{const socket=io('http://127.0.0.1:3397',{transports:['websocket'],reconnection:false});const timeout=setTimeout(()=>{socket.disconnect();reject(new Error('observer timeout'));},5000);socket.once('state:update',(state:ServerState)=>{clearTimeout(timeout);socket.disconnect();resolve(state);});socket.once('connect_error',error=>{clearTimeout(timeout);socket.disconnect();reject(error);});});
}

class ButtonAuditPage {
 readonly fight: FightPage;
 readonly rr: RoundRobinPage;
 readonly passed: string[]=[];
 capture=false;
 readonly commands:string[]=[];
 constructor(readonly page:Page){this.fight=new FightPage(page);this.rr=new RoundRobinPage(page);page.on('websocket',socket=>socket.on('framesent',frame=>{const payload=String(frame.payload);if(this.capture && /"(?:match:(?:load|start|reset|pause|resume|finishRound|event|saveFallo)|mesa:)/.test(payload))this.commands.push(payload);}));}
 async action(name:string,run:()=>Promise<void>):Promise<void>{await test.step(name,async()=>{await run();this.passed.push(name);});}
 async evidence(info:TestInfo):Promise<void>{const file=info.outputPath('button-actions.json');await writeFile(file,JSON.stringify({passed:this.passed,commands:this.commands,server:await server(),progress:await this.rr.progress()},null,2));await info.attach('button-action-matrix',{contentType:'application/json',path:file});}
 async setup(mode:'Round Robin'|'Eliminación',count:number):Promise<void>{
  const setup=new SetupPage(this.page);await setup.goto();
  await this.page.getByRole('button',{name:'Seleccionar perfil Yusan 2026 para este torneo'}).click();
  for(const label of ['ADULTOS (18-35)','GUPS','Amarillos a Puntas Azules','Liviano A','Masculino',mode])await setup.selectCategoryOption(label);
  const reopen=this.page.getByRole('button',{name:/Configurar categoría/});if(await reopen.isVisible())await reopen.click();
  await this.page.getByRole('button',{name:'Aplicar Yusan 2026 a esta categoría'}).click();
  await setup.addCompetitors(Array.from({length:count},(_,i)=>`Audit ${i+1}`));await setup.startCategory();
  if(mode==='Eliminación')await this.page.getByRole('button',{name:'Iniciar ronda actual',exact:true}).click();
  else await this.page.getByRole('button',{name:'Ir a Combate',exact:true}).click();
 }
 settings(){return this.page.locator('fieldset').filter({has:this.page.getByText('Ajustes de este combate',{exact:true})}).filter({visible:true});}
 async save():Promise<void>{await this.settings().getByRole('button',{name:'Guardar ajustes',exact:true}).click();await expect(this.settings().getByRole('button',{name:'Guardar ajustes',exact:true})).toBeDisabled();}
 async review():Promise<void>{const overlay=this.page.getByRole('dialog',{name:'Resultado del combate',exact:true});await expect(overlay).toBeVisible();await overlay.getByRole('button',{name:'Confirmar resultado →',exact:true}).click();await expect(this.page.getByRole('dialog',{name:'Registrar resultado del combate',exact:true})).toBeVisible();}
 async confirm():Promise<void>{await this.page.getByRole('dialog',{name:'Registrar resultado del combate',exact:true}).getByRole('button',{name:'Confirmar y continuar',exact:true}).click();}
}

test('buttons: final timings save restore clock pause resume restart and sticky guard',async({page},info)=>{
 const a=new ButtonAuditPage(page);try{
  await a.setup('Eliminación',2);
  await a.action('Cargar final explicitly loads matching identity',async()=>{await a.fight.loadFight();expect((await server()).match?.id).toBe((await a.rr.currentFight()).id);});
  for(const [seconds,label] of [[40,'40 s'],[60,'1 min'],[90,'1:30'],[120,'2 min']] as const){await a.action(`Final duration ${seconds}s button + save`,async()=>{await a.settings().getByRole('button',{name:label,exact:true}).click();await a.save();await expect.poll(async()=>(await server()).rules?.rounds.duration_seconds).toBe(seconds);});}
  for(const [count,label] of [[2,'2 rounds'],[1,'1 round']] as const){await a.action(`Final ${count} round button + save`,async()=>{await a.settings().getByRole('button',{name:label,exact:true}).click();await a.save();await expect.poll(async()=>(await server()).rules?.rounds.count).toBe(count);});}
  await a.action('Restore category timing and save',async()=>{await a.settings().getByRole('button',{name:'40 s',exact:true}).click();await a.save();await a.settings().getByRole('button',{name:'Restablecer valores de la categoría',exact:true}).click();await a.save();await expect.poll(async()=>(await server()).rules?.rounds.duration_seconds).toBe(120);});
  await a.action('Unsaved timing blocks Start; save unblocks',async()=>{await a.settings().getByRole('button',{name:'1 min',exact:true}).click();await expect(a.fight.startFightButton).toBeDisabled();await a.save();await expect(a.fight.startFightButton).toBeEnabled();});
  await a.action('Start activates round',async()=>{await a.fight.startFight();await expect.poll(async()=>(await server()).matchState?.phase).toBe('round');});
  await a.action('Pause freezes clock and Resume restarts',async()=>{await page.getByRole('button',{name:'Pausar',exact:true}).click();await expect.poll(async()=>(await server()).matchPaused).toBe(true);const stopped=(await server()).matchState?.timeLeft;await page.waitForTimeout(1100);expect((await server()).matchState?.timeLeft).toBe(stopped);await page.getByRole('button',{name:'Reanudar',exact:true}).click();await expect.poll(async()=>(await server()).matchPaused).toBe(false);});
  await a.action('Clock Restart resets idle but never unlocks timing',async()=>{await page.getByRole('button',{name:'Reiniciar',exact:true}).click();await expect.poll(async()=>(await server()).matchState?.phase).toBe('idle');await expect(a.fight.startFightButton).toBeVisible();await expect(a.settings()).toHaveCount(0);expect((await server()).match?.preFight?.started).toBe(true);});
 }finally{await a.evidence(info);}
});

test('buttons: RR sanctions incomplete flags correction confirmation and completed review',async({page},info)=>{
 const a=new ButtonAuditPage(page);try{
  await a.setup('Round Robin',3);await a.fight.loadFight();const initial=await a.rr.currentFight();
  await a.fight.startFight();
  await a.action('Postpone disabled during running fight',async()=>{await expect(page.getByRole('button',{name:'Postergar',exact:true})).toBeDisabled();});
  await a.fight.endRound();
  await a.action('After clock warning add/undo and direct penalty add/undo',async()=>{for(const kind of ['warning','minus_point'] as const){await a.rr.adjustSanction('red',kind,'add');await expect.poll(async()=>kind==='warning'?(await server()).penaltyCounts?.warnings.red:(await server()).penaltyCounts?.fouls.red).toBe(1);await a.rr.adjustSanction('red',kind,'remove');await expect.poll(async()=>kind==='warning'?(await server()).penaltyCounts?.warnings.red:(await server()).penaltyCounts?.fouls.red).toBe(0);}});
  await a.action('Incomplete individual flags cannot confirm',async()=>{await a.fight.voteJudge(1,'red');await expect(page.getByRole('button',{name:'🔴 Confirmar — Rojo gana el round',exact:true})).toBeDisabled();expect(await readFightResult((await a.rr.progress()).config.id,initial.id)).toBeNull();});
  await a.action('Complete flags produce provisional winner',async()=>{for(const j of [2,3,4])await a.fight.voteJudge(j,'red');await page.getByRole('button',{name:'🔴 Confirmar — Rojo gana el round',exact:true}).click();await expect(page.getByRole('dialog',{name:'Resultado del combate',exact:true})).toBeVisible();});
  await a.action('Correct flags before final confirmation changes winner',async()=>{await page.getByRole('dialog',{name:'Resultado del combate',exact:true}).getByRole('button',{name:'↩ Corregir banderines',exact:true}).click();await expect.poll(async()=>(await server()).matchState?.phase).toBe('rest');for(const j of [1,2,3,4])await a.fight.voteJudge(j,'blue');await page.getByRole('button',{name:'🔵 Confirmar — Azul gana el round',exact:true}).click();await a.review();});
  await a.action('Result-dialog sanctions edit/undo preserves winner',async()=>{await a.rr.adjustSanction('blue','warning','add',true);await expect.poll(async()=>(await server()).penaltyCounts?.warnings.blue).toBe(1);await a.rr.adjustSanction('blue','warning','remove',true);await expect.poll(async()=>(await server()).penaltyCounts?.warnings.blue).toBe(0);expect((await server()).matchState?.result?.winner).toBe('blue');});
  await a.action('Confirm and continue saves corrected result once',async()=>{await a.confirm();await expect.poll(async()=>(await a.rr.progress()).fights.find(f=>f.id===initial.id)?.completed).toBe(true);expect(await readFightResult((await a.rr.progress()).config.id,initial.id)).toMatchObject({status:'confirmed',winner:'blue',flagsBlue:4,flagsRed:0});});
  await a.action('Explicit load next fight; review completed is read-only; return active',async()=>{await a.fight.loadFight();await a.fight.startFight();const active=(await server()).match?.id;a.capture=true;await page.getByRole('button',{name:'1',exact:true}).click();await expect(page.getByTestId('fight-review-notice')).toBeVisible();await expect(page.getByRole('button',{name:/Rehacer combate/}).filter({visible:true})).toBeDisabled();expect((await server()).match?.id).toBe(active);await page.getByTestId('fight-review-notice').getByRole('button').click();await expect(page.getByRole('button',{name:'Pausar',exact:true})).toBeVisible();expect((await server()).match?.id).toBe(active);a.capture=false;expect(a.commands).toEqual([]);});
 }finally{await a.evidence(info);}
});

test('buttons: postpone loaded idle fight allows next pending fight',async({page},info)=>{
 const a=new ButtonAuditPage(page);try{
  await a.setup('Round Robin',3);await a.fight.loadFight();const old=await a.rr.currentFight();const before=await a.rr.progress();
  await a.action('Postpone idle changes queue and selects next pending',async()=>{const button=page.getByRole('button',{name:'Postergar',exact:true});await expect(button).toBeEnabled();await button.click();await expect.poll(async()=>(await a.rr.currentFight()).id).toBe(before.fights[1].id);expect((await a.rr.progress()).fights.find(f=>f.id===old.id)?.completed).toBe(false);});
  await a.action('Postponed handoff permits loading selected next fight',async()=>{await expect(a.fight.loadFightButton).toBeEnabled();await a.fight.loadFight();expect((await server()).match?.id).toBe((await a.rr.currentFight()).id);});
 }finally{await a.evidence(info);}
});

test('buttons: paused clock adjustment and DQ cancel/confirm safety',async({page},info)=>{
 const a=new ButtonAuditPage(page);try{
  await a.setup('Round Robin',3);await a.fight.loadFight();await a.fight.startFight();await page.getByRole('button',{name:'Pausar',exact:true}).click();await expect.poll(async()=>(await server()).matchPaused).toBe(true);
  for(const delta of [-15,-5,-1,1,5,15])await a.action(`Paused clock ${delta>0?'+':''}${delta}s button`,async()=>{const before=(await server()).matchState?.timeLeft;if(before===undefined)throw new Error('clock missing');await page.getByRole('button',{name:`${delta>0?'+':''}${delta}s`,exact:true}).click();await expect.poll(async()=>(await server()).matchState?.timeLeft).toBe(before+delta);});
  await a.action('DQ dialog Cancel preserves active bout',async()=>{await page.getByRole('button',{name:'Descalif. Rojo',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Confirmar descalificación',exact:true});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();expect((await server()).matchState?.result).toBeNull();expect((await server()).matchState?.phase).toBe('round');});
  await a.action('DQ Confirm awards opposite side without altering prior fights',async()=>{await page.getByRole('button',{name:'Descalif. Azul',exact:true}).click();await page.getByRole('dialog',{name:'Confirmar descalificación',exact:true}).getByRole('button',{name:'Descalificar',exact:true}).click();await expect.poll(async()=>(await server()).matchState?.result).toMatchObject({winner:'red',reason:'dq'});await a.review();await a.confirm();await expect.poll(async()=>(await a.rr.progress()).fights.filter(f=>f.completed).length).toBe(1);});
 }finally{await a.evidence(info);}
});
