import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {FightPage} from '@/pages/FightPage';
import {useTournamentStore} from '@/store/tournament';
import {createMatch} from '@/engine/match-machine';
import type {RuleSetSparring} from '@/engine/types';
import type {ServerState} from '@/lib/socket-types';
import baseline from '@/rules/rules/rules_sparring_itf_baseline.json';
const mocks=vi.hoisted(()=>({useSocket:vi.fn(),request:vi.fn(),emit:vi.fn(),navigate:vi.fn()}));
vi.mock('@/hooks/useSocket',()=>({useSocket:mocks.useSocket}));
vi.mock('react-router-dom',()=>({useNavigate:()=>mocks.navigate}));
const initial=useTournamentStore.getState();
const rules=baseline as RuleSetSparring;
const first={id:'postpone-one',red:{id:'r',name:'Red'},blue:{id:'b',name:'Blue'},groupId:'G1',completed:false};
const second={...first,id:'postpone-two'};
function state():ServerState{return {rules,match:{...first,ringId:'T1',matchMode:'sparring',preFight:{loadId:'load-one',revision:0,started:false,timingKind:'regular'}},categoryId:'postpone-category',matchState:createMatch(rules),matchPaused:false,resultConfirmed:false,judges:[],judgeVotes:{},judgeTotals:{},roundFlags:[],penaltyCounts:{warnings:{red:0,blue:0},fouls:{red:0,blue:0}},fallos:[],serverUrl:''};}
function setup(current=state(),connected=true):void {mocks.useSocket.mockReturnValue({connected,stateReady:true,state:current,emit:mocks.emit,request:mocks.request,socket:{on:vi.fn(),off:vi.fn()}});}
beforeEach(()=>{mocks.request.mockReset().mockResolvedValue({ok:true,result:null});vi.stubGlobal('fetch',vi.fn(async()=>({json:async()=>[]})));Element.prototype.scrollIntoView=vi.fn();act(()=>useTournamentStore.setState({...initial,config:{...initial.config,id:'postpone-category',mode:'round-robin',matchType:'sparring',ruleSet:rules},fights:[first,second],currentFightIndex:0,phase:'fighting'}));setup();});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();act(()=>useTournamentStore.setState(initial));});
describe('safe postpone button',()=>{
 it('does not reorder until ACK and coalesces double click',async()=>{
  let reply:(value:unknown)=>void=()=>{};mocks.request.mockImplementation((event:string)=>event==='match:postpone'?new Promise(resolve=>{reply=resolve;}):Promise.resolve({ok:true,result:null}));render(<FightPage/>);
  const button=screen.getByRole('button',{name:'Postergar'});fireEvent.click(button);fireEvent.click(button);
  expect(mocks.request.mock.calls.filter(call=>call[0]==='match:postpone')).toHaveLength(1);expect(mocks.request).toHaveBeenCalledWith('match:postpone',expect.objectContaining({matchId:first.id,categoryId:'postpone-category',expectedLoadId:'load-one',expectedRevision:0}));
  expect(useTournamentStore.getState().fights[0].id).toBe(first.id);expect(mocks.emit).not.toHaveBeenCalled();
  await act(async()=>reply({ok:true}));await waitFor(()=>expect(useTournamentStore.getState().fights[0].id).toBe(second.id));
 });
 it('retains queue and displays rejection',async()=>{mocks.request.mockResolvedValue({ok:false,error:'No se puede postergar'});render(<FightPage/>);fireEvent.click(screen.getByRole('button',{name:'Postergar'}));await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('No se puede postergar'));expect(useTournamentStore.getState().fights[0].id).toBe(first.id);});
 it('retries lost ACK with identical receipt identity',async()=>{let attempts=0;mocks.request.mockImplementation((event:string)=>event!=='match:postpone'?Promise.resolve({ok:true,result:null}):++attempts===1?Promise.reject(new Error('ACK lost')):Promise.resolve({ok:true,alreadyApplied:true}));render(<FightPage/>);fireEvent.click(screen.getByRole('button',{name:'Postergar'}));await waitFor(()=>expect(useTournamentStore.getState().fights[0].id).toBe(second.id));const calls=mocks.request.mock.calls.filter(call=>call[0]==='match:postpone');expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);});
 it('preserves the queue when connection is lost while awaiting acceptance',async()=>{
  let reject:(reason:Error)=>void=()=>{};let count=0;
  mocks.request.mockImplementation((event:string)=>event!=='match:postpone'?Promise.resolve({ok:true,result:null}):++count===1?new Promise((_resolve,fail)=>{reject=fail;}):Promise.reject(new Error('Disconnected')));
  const view=render(<FightPage/>);fireEvent.click(screen.getByRole('button',{name:'Postergar'}));
  setup(state(),false);view.rerender(<FightPage/>);await act(async()=>reject(new Error('Disconnected')));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Disconnected'));
  expect(useTournamentStore.getState().fights[0].id).toBe(first.id);expect(screen.getByRole('button',{name:'Postergar'})).toBeDisabled();
 });
 it('does not reorder a different selection when a delayed ACK arrives',async()=>{
  let reply:(value:unknown)=>void=()=>{};mocks.request.mockImplementation((event:string)=>event==='match:postpone'?new Promise(resolve=>{reply=resolve;}):Promise.resolve({ok:true,result:null}));
  render(<FightPage/>);fireEvent.click(screen.getByRole('button',{name:'Postergar'}));
  act(()=>useTournamentStore.setState({currentFightIndex:1}));await act(async()=>reply({ok:true}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('selección cambió'));
  expect(useTournamentStore.getState().fights[0].id).toBe(first.id);expect(useTournamentStore.getState().currentFightIndex).toBe(1);
 }); it.each(['disconnected','started','paused','foreign'])('blocks %s without queue mutation',async(kind)=>{const current=state();if(kind==='started'&&current.match?.preFight)current.match.preFight.started=true;if(kind==='paused')current.matchPaused=true;if(kind==='foreign')current.categoryId='foreign';setup(current,kind!=='disconnected');render(<FightPage/>);const button=screen.getByRole('button',{name:'Postergar'});expect(button).toBeDisabled();fireEvent.click(button);expect(mocks.request).not.toHaveBeenCalledWith('match:postpone',expect.anything());expect(useTournamentStore.getState().fights[0].id).toBe(first.id);});
});
