import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
const text = (value, limit) => typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= limit;
const same = (a, b) => ['dev','ino','size','mtimeNs','ctimeNs'].every(key => a[key] === b[key]);
const line = (value, offset) => value.slice(0, offset).split('\n').length;
const span = (value, offset, length) => ({startLine:line(value,offset),endLine:line(value,offset+Math.max(0,length-1))});
const whole = value => value.length ? [{startLine:1,endLine:value.split('\n').length-(value.endsWith('\n')?1:0)}] : [];

function localPath(root, input) {
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\x00-\x1f]/.test(input)) throw Error('invalid_path');
  const path = isAbsolute(input) ? relative(root, input) : input;
  const normalized = path.split(sep).join('/');
  if (normalized.includes('\\') || normalized.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw Error('invalid_path');
  return normalized;
}

async function inspectPath(root, path) {
  const rootInfo = await lstat(root,{bigint:true});
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) throw Error('invalid_root');
  let current = root, info;
  for (const part of path.split('/')) {
    current = join(current,part);
    info = await lstat(current,{bigint:true});
    if (info.isSymbolicLink()) throw Error('symlink');
    if (current !== join(root,path) && !info.isDirectory()) throw Error('invalid_parent');
  }
  const canonical = await realpath(current);
  // Accept a case alias only after the filesystem resolves it inside this root
  // and both spellings provably name the same unchanged ordinary file.
  const canonicalPath = localPath(root,canonical);
  const canonicalInfo = await lstat(canonical,{bigint:true});
  if (canonicalInfo.isSymbolicLink() || !same(info,canonicalInfo)) throw Error('changed_path');
  return {path:canonicalPath,info:canonicalInfo};
}

async function readText(root, input, maxBytes) {
  const requested = localPath(root,input), inspected = await inspectPath(root,requested);
  const {path,info:before} = inspected;
  if (!before.isFile() || before.size > BigInt(maxBytes)) throw Error('unsupported_file');
  const handle = await open(join(root,path),constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    if (!same(before,await handle.stat({bigint:true}))) throw Error('changed_file');
    const bytes = Buffer.alloc(maxBytes+1);
    let size=0;
    while (size < bytes.length) {const next=await handle.read(bytes,size,bytes.length-size,size);if(!next.bytesRead)break;size+=next.bytesRead;}
    const after = await inspectPath(root,requested);
    if (size>maxBytes || after.path!==path || !same(before,await handle.stat({bigint:true})) || !same(before,after.info)) throw Error('changed_file');
    const content = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,size));
    if(content.includes('\0'))throw Error('binary_file');
    return {path,content,hash:sha(bytes.subarray(0,size))};
  } finally {await handle.close();}
}

// Strict unified hunks only. Unknown formats are not interpreted as shell output.
function hunks(diff) {
  const rows=diff.split('\n');if(rows.at(-1)==='')rows.pop();
  const result=[];let current;
  for(const row of rows){
    const match=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(row);
    if(match){current={oldStart:+match[1],oldCount:match[2]===undefined?1:+match[2],newStart:+match[3],newCount:match[4]===undefined?1:+match[4],old:[],new:[],oldChanged:[],newChanged:[]};result.push(current);continue;}
    if(!current){if(/^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode )/.test(row))continue;throw Error('unsupported_diff');}
    if(row==='\\ No newline at end of file')continue;
    if(row.startsWith(' ')){current.old.push(row.slice(1));current.new.push(row.slice(1));}
    else if(row.startsWith('-')){current.oldChanged.push(current.old.length);current.old.push(row.slice(1));}
    else if(row.startsWith('+')){current.newChanged.push(current.new.length);current.new.push(row.slice(1));}
    else throw Error('unsupported_diff');
  }
  if(!result.length || result.length>32)throw Error('unsupported_diff');
  let oldEnd=0,newEnd=0;
  for(const h of result){if(h.old.length!==h.oldCount||h.new.length!==h.newCount||h.oldStart<oldEnd||h.newStart<newEnd||(!h.oldStart&&h.oldCount)||(!h.newStart&&h.newCount)||![h.oldStart,h.newStart,h.oldCount,h.newCount].every(Number.isSafeInteger))throw Error('invalid_hunk');oldEnd=h.oldStart+h.oldCount;newEnd=h.newStart+h.newCount;}
  return result;
}
function hunkPositions(content, changes, side){
  const rows=content.split('\n'), ranges=[];
  for(const h of changes){
    const start=h[side+'Start'], expected=h[side];
    if(expected.some((value,index)=>rows[start-1+index]?.replace(/\r$/,'')!==value.replace(/\r$/,'')))throw Error('hunk_mismatch');
    const changed=h[side+'Changed'];
    for(const offset of changed){const n=start+offset,last=ranges.at(-1);if(n<1||n>rows.length)throw Error('invalid_line');if(last&&last.endLine+1===n)last.endLine=n;else ranges.push({startLine:n,endLine:n});}
  }
  return ranges;
}

function snapshotEvent(event,maxBytes){
  const base={runId:event?.runId,provider:event?.provider,type:event?.type,phase:event?.phase,itemId:event?.itemId,item:null};
  const item=event?.item;
  if(base.provider==='codex'&&item?.type==='fileChange'&&Array.isArray(item.changes)&&item.changes.length<=32){
    let budget=0;
    if(item.changes.every(c=>text(c?.diff,maxBytes)&&((budget+=Buffer.byteLength(c.diff))<=maxBytes)&&typeof c?.path==='string'))base.item={type:item.type,id:item.id,status:item.status,changes:item.changes.map(c=>({path:c.path,diff:c.diff,kind:{type:c.kind?.type,move_path:c.kind?.move_path}}))};
  }else if(base.provider==='claude'&&item?.type==='tool_use'&&['Edit','Write'].includes(item.name)){
    const input=item.input;
    if(input&&typeof input.file_path==='string'&&text(item.name==='Write'?input.content:input.old_string,maxBytes)&& (item.name==='Write'||text(input.new_string,maxBytes)))base.item={type:item.type,id:item.id,name:item.name,input:item.name==='Write'?{file_path:input.file_path,content:input.content}:{file_path:input.file_path,old_string:input.old_string,new_string:input.new_string,replace_all:input.replace_all}};
  }else if(base.provider==='claude'&&item?.type==='tool_result')base.item={type:item.type,tool_use_id:item.tool_use_id,is_error:item.is_error};
  return base;
}

export class AgentEditPositions {
  constructor({onPositions=()=>{},onError=()=>{},maxBytes=1024*1024,maxRuns=64,retentionMs=60_000}={}){
    this.onPositions=onPositions;this.onError=onError;this.maxBytes=Math.min(2*1024*1024,Math.max(1,maxBytes));this.maxRuns=Math.min(128,Math.max(1,maxRuns));this.retentionMs=Math.min(300_000,Math.max(1,retentionMs));this.runs=new Map();this.closed=new Set();this.disposed=false;this.pending=0;
  }
  error(){try{Promise.resolve(this.onError(new Error('无法更新 Agent 文件位置'))).catch(()=>{});}catch{}}
  state(runId,context){
    if(this.disposed||!id(runId)||this.closed.has(runId)||!context||!isAbsolute(context.root||'')||!['workspaceId','sessionId','laneId'].every(k=>id(context[k])))return null;
    const ctx={root:resolve(context.root),workspaceId:context.workspaceId,sessionId:context.sessionId,laneId:context.laneId},key=JSON.stringify(ctx);
    const existing=this.runs.get(runId);if(existing)return existing.key===key?existing:null;
    if(this.runs.size>=this.maxRuns)return null;
    const state={runId,key,context:ctx,sequence:0,tools:new Map(),ended:false,queue:Promise.resolve(),queued:0,last:'[]'};this.runs.set(runId,state);return state;
  }
  enqueue(state,work,force=false){
    if(!state||state.ended||(!force&&this.pending>=64))return Promise.resolve(null);
    state.queued++;this.pending++;
    const result=state.queue.then(async()=>{try{if(this.disposed||this.runs.get(state.runId)!==state)return null;return await work();}catch{this.error();return null;}finally{state.queued--;this.pending--;}});
    state.queue=result.catch(()=>{});return result;
  }
  async publish(state){
    if(this.disposed||this.runs.get(state.runId)!==state)return null;
    const positions=[...state.tools.values()].flatMap(t=>t.positions).slice(-32),serialized=JSON.stringify(positions);
    if(serialized===state.last)return null;state.last=serialized;
    const batch={runId:state.runId,sequence:++state.sequence,positions};
    let timer;
    try{await Promise.race([Promise.resolve().then(()=>{if(!this.disposed)return this.onPositions(structuredClone(batch),{...state.context});}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('notification_timeout')),1000);timer.unref?.();})]);}catch{this.error();}finally{clearTimeout(timer);}
    return batch;
  }
  observe(event,context){
    if(event?.type!=='tool'||!id(event?.itemId)||!['started','completed'].includes(event?.phase))return Promise.resolve(null);
    let snapshot;try{snapshot=snapshotEvent(event,this.maxBytes);}catch{return Promise.resolve(null);}
    const state=this.state(snapshot.runId,context);
    return this.enqueue(state,async()=>{
      const toolId=snapshot.itemId,previous=state.tools.get(toolId);
      if(previous?.done)return null;
      if(state.tools.size>=64&&!previous)return null;
      // Do not retain tool arguments or file contents after this task completes.
      let result={positions:[],done:snapshot.phase==='completed'};
      try{result=await this.positions(snapshot,state.context,previous);}catch{}
      if(this.disposed)return null;
      state.tools.delete(toolId);state.tools.set(toolId,result);
      let remaining=32;
      for(const tool of [...state.tools.values()].reverse()){tool.positions=remaining?tool.positions.slice(-remaining):[];remaining-=tool.positions.length;}
      return this.publish(state);
    });
  }
  async positions(event,context,previous){
    const {item,phase,itemId:toolId,provider:source}=event,done=phase==='completed';
    const make=(file,ranges)=>ranges.slice(0,32).map(range=>({path:file.path,hash:file.hash,...range,phase:done?'completed':'pending',toolId,source}));
    if(source==='codex'&&item?.type==='fileChange'&&item.id===toolId&&item.status===(done?'completed':'inProgress')){
      const positions=[];
      for(const change of item.changes){
        if(!['add','update','delete'].includes(change.kind.type))throw Error('unsupported_change');
        // Deletions have no new lines; new files have no old lines.
        if((done&&change.kind.type==='delete')||(!done&&change.kind.type==='add'))continue;
        const path=done&&change.kind.move_path?change.kind.move_path:change.path;
        localPath(context.root,change.path);if(change.kind.move_path)localPath(context.root,change.kind.move_path);
        const file=await readText(context.root,path,this.maxBytes);
        positions.push(...make(file,hunkPositions(file.content,hunks(change.diff),done?'new':'old')));
      }
      return {positions:positions.slice(0,32),done};
    }
    if(source!=='claude')return {positions:[],done};
    if(done){
      if(item?.type!=='tool_result'||item.tool_use_id!==toolId||(item.is_error!==undefined&&item.is_error!==false)||!previous?.expected)return {positions:[],done};
      const expected=previous.expected,file=await readText(context.root,expected.path,this.maxBytes);
      return {positions:file.hash===expected.hash?make(file,expected.ranges):[],done};
    }
    if(item?.type!=='tool_use'||item.id!==toolId)return {positions:[],done};
    const input=item.input,path=localPath(context.root,input.file_path);
    if(item.name==='Write'){
      // No old_string is provided by Write, so do not claim an old-line location.
      return {positions:[],done,expected:{path,hash:sha(input.content),ranges:whole(input.content)}};
    }
    if(!input.old_string||(input.replace_all!==undefined&&typeof input.replace_all!=='boolean'))return {positions:[],done};
    const file=await readText(context.root,path,this.maxBytes),offsets=[];
    let at=0;
    while((at=file.content.indexOf(input.old_string,at))!==-1){offsets.push(at);at+=input.old_string.length;if(offsets.length>32)throw Error('too_many_ranges');}
    if(!offsets.length||(!input.replace_all&&offsets.length!==1))throw Error('ambiguous_edit');
    const replacement=file.content.split(input.old_string).join(input.new_string);
    if(Buffer.byteLength(replacement)>this.maxBytes)throw Error('too_large');
    const ranges=input.new_string?offsets.map((offset,index)=>span(replacement,offset+index*(input.new_string.length-input.old_string.length),input.new_string.length)):[];
    return {positions:make(file,offsets.map(offset=>span(file.content,offset,input.old_string.length))),done,expected:{path:file.path,hash:sha(replacement),ranges}};
  }
  finish(runId,context){
    const state=this.state(runId,context);
    const result=this.enqueue(state,async()=>{
      for(const [key,tool]of state.tools)state.tools.set(key,{positions:tool.positions.filter(p=>p.phase==='completed'),done:true});
      const batch=await this.publish(state);
      if(this.disposed)return null;
      state.timer=setTimeout(()=>this.runs.delete(runId),this.retentionMs);state.timer.unref?.();return batch;
    },true);
    if(state){state.ended=true;this.closed.add(runId);if(this.closed.size>256)this.closed.delete(this.closed.values().next().value);}
    return result;
  }
  dispose(){this.disposed=true;for(const state of this.runs.values())clearTimeout(state.timer);this.runs.clear();this.closed.clear();}
}
