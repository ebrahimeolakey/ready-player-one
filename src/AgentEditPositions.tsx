import {createContext,useContext,useEffect,useState,useRef} from 'react';
import type {State} from './types';
import {visibleEditPositions,type VisibleEditPosition} from '../core/edit-positions.mjs';
export const AgentEditPositionsContext=createContext<State|undefined>(undefined);
export type AgentDocument={workspaceId:string;path:string;binding?:string;blocked?:boolean};
export function useAgentEditPositions(document:AgentDocument|undefined,content:string,enabled:boolean):VisibleEditPosition[]{
 const bindingRef=useRef<string|undefined>(undefined),fence=useRef(new Map<string,number>());
 const state=useContext(AgentEditPositionsContext),key=JSON.stringify(document),[hashed,setHashed]=useState<{key:string;content:string;hash:string}|null>(null),[now,setNow]=useState(Date.now);
 const binding=document?`${document.workspaceId}:${document.binding||''}`:undefined;
 if(binding!==undefined&&bindingRef.current!==binding){if(bindingRef.current!==undefined){fence.current=new Map((state?.sessions||[]).flatMap(s=>s.lanes.filter(l=>l.editPositions).map(l=>[`${l.id}:${l.editPositions!.runId}`,l.editPositions!.sequence] as [string,number])));}bindingRef.current=binding;}
 useEffect(()=>{
  if(!enabled||!document||content.length>1048576){setHashed(null);return;}
  let active=true;
  void crypto.subtle.digest('SHA-256',new TextEncoder().encode(content)).then(bytes=>{if(active)setHashed({key,content,hash:Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('')});}).catch(()=>{if(active)setHashed(null);});
  return()=>{active=false;};
 },[key,content,enabled]);
 const markers=enabled&&document&&!document.blocked&&hashed?.key===key&&hashed.content===content?visibleEditPositions(state,{...document,hash:hashed.hash},now).filter(p=>p.sequence>(fence.current.get(`${p.laneId}:${p.runId}`)||0)):[];
 const expiry=markers.length?Math.min(...markers.map(p=>p.expires)):0;
 useEffect(()=>{setNow(Date.now());if(!expiry)return;const timer=setTimeout(()=>setNow(Date.now()),Math.max(1,expiry-Date.now()+1));return()=>clearTimeout(timer);},[expiry,state]);
 return markers;
}
