import {useEffect,useState,useRef} from 'react';
import {MessageSquare} from 'lucide-react';
import {diffRows} from '../core/comment-anchors.mjs';
import type {Call} from './ui';
import './references.css';
type Pick={hunk:number;side:'left'|'right';startLine?:number;endLine?:number};
export function DiffReview({text,preview,context,path,staged,call,canComment}:{text:string;preview:{diffHash:string;canonicalRoot:string}|null;context:Record<string,unknown>;path:string;staged:boolean;call:Call;canComment:boolean}){
 const [pick,setPick]=useState<Pick|null>(null),[comment,setComment]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const contextKey=JSON.stringify([context,path,staged,preview]);
 useEffect(()=>{setPick(null);setComment('');setError('');},[contextKey]);
 const active=useRef(contextKey);active.current=contextKey;
 const rows=diffRows(text),enabled=canComment&&!!preview&&!busy;
 async function submit(){if(!pick||!preview||!comment.trim())return;setBusy(true);setError('');try{const location=await call('references.diff',{...context,path,staged,...pick,expectedDiffHash:preview.diffHash,expectedRoot:preview.canonicalRoot});if(!location||active.current!==contextKey)return;await call('comment.add',{...context,text:comment,location});setPick(null);setComment('');}catch(e){setError(e instanceof Error?e.message:'评论失败');}finally{setBusy(false);}}
 return <><div className="diff-review">{rows.map(row=><div key={row.index} className={'diff-row '+(row.header?'diff-header':row.text.startsWith('+')&&row.right!==null?'diff-added':row.text.startsWith('-')&&row.left!==null?'diff-removed':'')}>{row.header?<><code>{row.text}</code>{enabled&&(['left','right'] as const).map(side=>rows.some(r=>r.hunk===row.hunk&&r[side]!==null)&&<button key={side} title={'评论'+(side==='left'?'修改前':'修改后')+'片段'} onClick={()=>setPick({hunk:row.hunk,side})}><MessageSquare size={12}/>{side==='left'?'前':'后'}</button>)}</>:<>{(['left','right'] as const).map(side=><button key={side} className="diff-line-number" disabled={!enabled||row[side]===null} title={row[side]===null?'':`评论${side==='left'?'修改前':'修改后'}第 ${row[side]} 行`} onClick={()=>setPick({hunk:row.hunk,side,startLine:row[side]!,endLine:row[side]!})}>{row[side]??''}</button>)}<code>{row.text||' '}</code></>}</div>)}</div>{pick&&<form className="diff-comment" onSubmit={e=>{e.preventDefault();void submit();}}><small>评论{pick.side==='left'?'修改前':'修改后'}{pick.startLine?`第 ${pick.startLine} 行`:'片段'}</small><textarea autoFocus aria-label="差异评论" value={comment} maxLength={5000} onChange={e=>setComment(e.target.value)} required/><div><button className="button" type="button" disabled={busy} onClick={()=>setPick(null)}>取消</button><button className="button primary" disabled={busy||!comment.trim()}>发送</button></div></form>}{error&&<p role="alert">{error}</p>}</>;
}
