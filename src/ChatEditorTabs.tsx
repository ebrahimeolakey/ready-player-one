import {useLayoutEffect,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {FileCode2,MessageSquare,X} from 'lucide-react';
import type {Lane} from './types';
import './chat-editor-tabs.css';

/** React always owns the same portal target; moving its DOM preserves the view. */
export function ChatViewPortal({target,children}:{target:HTMLElement|null;children:ReactNode}) {
 const [container]=useState(()=>{const node=document.createElement('div');node.className='chat-view-instance';return node;});
 useLayoutEffect(()=>{
  const focused=container.contains(document.activeElement)?document.activeElement as HTMLElement:null;
  if(target){target.appendChild(container);if(focused)focused.focus({preventScroll:true});}else container.remove();
 },[target,container]);
 useLayoutEffect(()=>()=>container.remove(),[container]);
 return createPortal(children,container);
}
export function ChatEditorTabs({lanes,activeId,hidden,onSelect,onClose,onMount}:{lanes:Lane[];activeId:string;hidden:boolean;onSelect:(id:string)=>void;onClose:(id:string)=>void;onMount:(node:HTMLDivElement|null)=>void}) {
 return <section className={'chat-editor-deck'+(activeId?' chat-selected':' file-selected')} hidden={hidden} aria-label="编辑器标签">
  <div className="chat-editor-tabbar" role="tablist" aria-label="文件与聊天">
   <button role="tab" aria-selected={!activeId} onClick={()=>onSelect('')}><FileCode2 size={13}/>文件</button>
   {lanes.map(lane=><div className={'chat-editor-tab'+(activeId===lane.id?' selected':'')} key={lane.id}>
    <button role="tab" data-chat-id={lane.id} aria-selected={activeId===lane.id} title={`${lane.owner} · ${lane.providerLabel||lane.provider} · ${lane.id}`} onClick={()=>onSelect(lane.id)}><MessageSquare size={13}/><span>{lane.owner} · {lane.providerLabel||(lane.provider==='codex'?'Codex':lane.provider==='claude'?'Claude':'Agent')}</span></button>
    <button className="chat-tab-close" aria-label={`关闭 ${lane.owner} 的聊天标签`} title="关闭标签，保留聊天" onClick={()=>onClose(lane.id)}><X size={12}/></button>
   </div>)}
  </div>
  <div className="chat-editor-content" ref={onMount} role="tabpanel" aria-label="当前聊天"/>
 </section>;
}
