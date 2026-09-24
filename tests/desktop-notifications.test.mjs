import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DesktopNotifications} from '../desktop/services/desktop-notifications.mjs';
const state = () => ({me:{id:'me'},approvals:[],toolApprovals:[],sessions:[],outcomes:[]});
function fixture(options = {}) {
 const shown=[],trays=[],errors=[];let beeps=0,focus=0,quits=0,focused=false,supported=true;
 class Notification extends EventEmitter {
  static isSupported(){return supported;}
  constructor(value){super();this.options=value;this.closed=0;}
  show(){shown.push(this);}
  close(){this.closed++;this.emit('close');}
 }
 class Tray extends EventEmitter {
  constructor(image){super();this.image=image;this.destroyed=0;trays.push(this);}
  setToolTip(value){this.tooltip=value;}
  setContextMenu(menu){this.menu=menu;}
  destroy(){this.destroyed++;}
 }
 const nativeImage={createFromBuffer(bytes,options){assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');return {options,isEmpty:()=>false,setTemplateImage(v){this.template=v;}};}};
 const service=new DesktopNotifications({Notification,Tray,Menu:{buildFromTemplate:value=>value},nativeImage,
  beep:()=>beeps++,showWindow:()=>focus++,quit:()=>quits++,isFocused:()=>focused,onError:e=>errors.push(e.message),...options});
 const connection={state:state()};
 return {service,connection,shown,trays,errors,get beeps(){return beeps;},get focus(){return focus;},get quits(){return quits;},set focused(v){focused=v;},set supported(v){supported=v;},snapshot(value=connection.state,opts={}){connection.state=value;service.observeSnapshot(value,{connection,...opts});}};
}
const pending = id => ({id,status:'pending',sessionId:'s',laneId:'l'});
const handoff = runId => ({id:'s',lanes:[{id:'l',ownerId:'me',status:'needs_handoff',activeRunId:runId,handoffNeeded:{runId}}]});
const unknown = (id,version=0) => ({id,version,status:'unknown',sessionId:'s',laneId:'l'});
const finish = (runId='run',status='done') => ({runId,sessionId:'s',status});

test('initial history only builds a baseline; subsequent real categories aggregate and deduplicate',t=>{
 const f=fixture();t.after(()=>f.service.dispose());
 f.snapshot({...state(),approvals:[pending('old')],sessions:[handoff('old-run')],outcomes:[unknown('old-outcome')]});assert.equal(f.shown.length,0);
 const next={...state(),approvals:[pending('old'),pending('a'),pending('b')],toolApprovals:[pending('t')],sessions:[handoff('new-run')],outcomes:[unknown('new-outcome')]};f.snapshot(next);f.snapshot(next);
 assert.equal(f.shown.length,3);assert.deepEqual(f.shown.map(n=>n.options.body),['有 3 项操作等待审批','有 1 个 Agent 等待接管','有 1 项执行结果待确认']);assert.ok(f.shown.every(n=>n.options.silent));
});
test('master and category settings suppress their events without replay when enabled later',t=>{
 const f=fixture({preferences:{notifyApprovals:false,notifyHandoffs:false,notifyUnknownOutcomes:false}});t.after(()=>f.service.dispose());f.snapshot();
 const next={...state(),approvals:[pending('a')],sessions:[handoff('r')],outcomes:[unknown('o')]};f.snapshot(next);assert.equal(f.shown.length,0);
 f.service.setPreferences({});f.snapshot(next);assert.equal(f.shown.length,0);
 f.snapshot({...next,approvals:[pending('b')]});assert.equal(f.shown.length,1);
 f.service.setPreferences({notificationsEnabled:false});assert.equal(f.shown[0].closed,1);f.snapshot({...next,outcomes:[unknown('o2')]});assert.equal(f.shown.length,1);
});
test('focus suppresses notifications but consumes events; clicking a real notification focuses once',t=>{
 const f=fixture();t.after(()=>f.service.dispose());f.snapshot();f.focused=true;f.snapshot({...state(),approvals:[pending('a')]});f.focused=false;f.snapshot({...state(),approvals:[pending('a')]});assert.equal(f.shown.length,0);
 f.snapshot({...state(),approvals:[pending('b')]});const n=f.shown[0];n.emit('click');n.emit('click');assert.equal(f.focus,1);assert.equal(n.closed,1);assert.equal(n.listenerCount('click'),0);
});
test('completion sound is independently enabled, only trusted terminal success once, without requiring a fast-run snapshot',t=>{
 const f=fixture({preferences:{notificationsEnabled:false,completionSound:true}});t.after(()=>f.service.dispose());f.snapshot();
 assert.equal(f.service.finish(finish(),{connection:f.connection}),true);assert.equal(f.service.finish(finish(),{connection:f.connection}),false);assert.equal(f.beeps,1);assert.equal(f.shown.length,0);
 f.service.finish(finish('error','error'),{connection:f.connection});f.service.finish(finish('stopped','interrupted'),{connection:f.connection});f.service.finish(finish('running','running'),{connection:f.connection});assert.equal(f.beeps,1);assert.equal(f.shown.length,0);
 f.service.setPreferences({completionSound:false});f.service.finish(finish('quiet'),{connection:f.connection});assert.equal(f.beeps,1);assert.equal(f.shown.length,1);
 f.service.finish(finish('generic-error','error'),{connection:f.connection});f.service.finish(finish('generic-stop','interrupted'),{connection:f.connection});assert.equal(f.shown.length,1);
});
test('handoff errors are notified only after authoritative matching Hub state, not generic completion',t=>{
 const f=fixture({preferences:{notifyHandoffs:false,completionSound:true}});t.after(()=>f.service.dispose());f.snapshot();
 f.service.finish({...finish('quota','error'),failure:{kind:'usage_limit'}},{connection:f.connection});assert.equal(f.shown.length,0);assert.equal(f.beeps,0);
 f.snapshot({...state(),sessions:[handoff('quota')]});assert.equal(f.shown.length,0);f.service.setPreferences({});
 const bad=handoff('stale');bad.lanes[0].activeRunId='new';f.snapshot({...state(),sessions:[bad]});assert.equal(f.shown.length,0);
 f.snapshot({...state(),sessions:[handoff('new')]});assert.equal(f.shown.length,1);
});
test('unknown outcomes require actual unknown status and a new record/version',t=>{
 const f=fixture();t.after(()=>f.service.dispose());f.snapshot();f.snapshot({...state(),outcomes:[{...unknown('o'),status:'succeeded'}]});assert.equal(f.shown.length,0);
 f.snapshot({...state(),outcomes:[unknown('o',1)]});assert.equal(f.shown.length,1);f.snapshot({...state(),outcomes:[unknown('o',1)]});assert.equal(f.shown.length,1);f.snapshot({...state(),outcomes:[unknown('o',2)]});assert.equal(f.shown.length,2);
});
test('connection/identity fencing closes old notifications, clears dedupe and prevents old-scope finish',t=>{
 const f=fixture({preferences:{completionSound:true}});t.after(()=>f.service.dispose());f.snapshot();f.snapshot({...state(),approvals:[pending('a')]});const old=f.connection;
 const next={state:state()};f.service.observeSnapshot(next.state,{connection:next});assert.equal(f.shown[0].closed,1);assert.equal(f.service.finish(finish(),{connection:old}),false);
 f.service.finish(finish(),{connection:next});assert.equal(f.beeps,1);
 next.state={...state(),me:{id:'other'},approvals:[pending('history')]};f.service.observeSnapshot(next.state,{connection:next});assert.equal(f.service.finish(finish('old-owner'),{connection:next,identityId:'me'}),false);assert.equal(f.beeps,1);
 f.service.observeSnapshot({...next.state,approvals:[pending('a')]},{connection:next});assert.equal(f.shown.at(-1).options.body,'有 1 项操作等待审批');
});
test('historical terminal runs are silent, and health gating creates no tray/notification/sound backlog',t=>{
 const f=fixture({preferences:{trayIcon:true,completionSound:true},active:false});t.after(()=>f.service.dispose());assert.equal(f.trays.length,0);
 f.snapshot({...state(),sessions:[{id:'s',lanes:[{ownerId:'me',activeRunId:'past',status:'done'}]}]},{active:false});f.service.finish(finish('past'),{connection:f.connection});assert.equal(f.beeps,0);
 f.snapshot({...state(),approvals:[pending('during-check')]},{active:false});f.service.finish(finish('during-check'),{connection:f.connection});assert.equal(f.beeps,0);
 f.service.setActive(true);f.snapshot({...state(),approvals:[pending('during-check'),pending('became-history')]});assert.equal(f.shown.length,0);assert.equal(f.trays.length,1);
 f.service.finish(finish('during-check'),{connection:f.connection});assert.equal(f.beeps,0);
 f.snapshot({...state(),approvals:[pending('new')]});assert.equal(f.shown.length,1);
 f.service.setActive(false);assert.equal(f.trays[0].destroyed,1);assert.equal(f.shown[0].closed,1);
});
test('tray toggles are idempotent; clicks/menu work, then native listeners/resources are destroyed',t=>{
 const f=fixture({preferences:{trayIcon:true},platform:'darwin'});t.after(()=>f.service.dispose());const tray=f.trays[0];assert.equal(tray.image.template,true);assert.equal(tray.image.options.scaleFactor,2);
 f.service.setPreferences({trayIcon:true});assert.equal(f.trays.length,1);tray.emit('click');tray.menu[0].click();tray.menu[2].click();assert.equal(f.focus,2);assert.equal(f.quits,1);
 f.service.setPreferences({trayIcon:false});assert.equal(tray.destroyed,1);assert.equal(tray.listenerCount('click'),0);tray.menu[0].click();tray.menu[2].click();assert.equal(f.focus,2);assert.equal(f.quits,1);f.service.setPreferences({trayIcon:true});assert.equal(f.trays.length,2);
 f.service.dispose();f.service.dispose();assert.equal(f.trays[1].destroyed,1);f.trays[1].menu[0].click();f.trays[1].menu[2].click();assert.equal(f.focus,2);assert.equal(f.quits,1);
});
test('OS denial and unsupported notifications do not throw into persisted settings or run processing',t=>{
 const f=fixture({Tray:class{constructor(){throw Error('tray denied');}}});t.after(()=>f.service.dispose());assert.doesNotThrow(()=>f.service.setPreferences({trayIcon:true}));assert.equal(f.service.getState().trayActive,false);assert.equal(f.service.getState().lastError,'tray denied');assert.deepEqual(f.errors,['tray denied']);
 f.snapshot();f.supported=false;f.snapshot({...state(),approvals:[pending('a')]});assert.equal(f.shown.length,0);f.supported=true;f.snapshot({...state(),approvals:[pending('b')]});f.shown[0].emit('failed',{},'OS denied');assert.equal(f.service.notifications.size,0);assert.equal(f.service.getState().lastError,'OS denied');
});
test('unacknowledged OS notifications are bounded and disposal clears timers and listeners',t=>{
 const f=fixture();t.after(()=>f.service.dispose());f.snapshot();for(let i=0;i<40;i++)f.snapshot({...state(),approvals:[pending(String(i))]});assert.equal(f.service.notifications.size,32);assert.equal(f.shown.filter(n=>n.closed===1).length,8);
 f.service.dispose();assert.equal(f.service.notifications.size,0);assert.ok(f.shown.every(n=>n.closed===1&&n.eventNames().length===0));f.service.finish(finish(),{connection:f.connection});f.service.observeSnapshot(state(),{connection:f.connection});assert.equal(f.shown.length,40);
});
test('native notification show failure is contained and resources are closed',t=>{
 class Notification extends EventEmitter {static isSupported(){return true;}show(){throw Error('cannot show');}close(){this.closed=true;}}
 const f=fixture({Notification});t.after(()=>f.service.dispose());f.snapshot();assert.doesNotThrow(()=>f.snapshot({...state(),approvals:[pending('a')]}));assert.equal(f.service.notifications.size,0);assert.equal(f.service.getState().lastError,'cannot show');
});
