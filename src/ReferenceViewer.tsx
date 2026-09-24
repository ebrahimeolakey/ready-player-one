import {useEffect,useState} from 'react';
import type {Call} from './ui';
import {Modal} from './ui';
import './references.css';
export function ReferenceViewer({commentId,context,call,close}:{commentId:string;context:Record<string,unknown>;call:Call;close:()=>void}){
 const [value,setValue]=useState<any>(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;setValue(null);setError('');void call('references.open',{...context,commentId}).then(result=>{if(active)setValue(result);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[commentId,JSON.stringify(context)]);
 useEffect(()=>{document.querySelector('.reference-viewer .reference-selected')?.scrollIntoView({block:'center'});},[value]);
 return <Modal title="评论位置" close={close}>{error&&<p role="alert">{error}</p>}{!value&&!error&&<p>加载中…</p>}{value&&<><p>{value.path} · {value.startLine}–{value.endLine}</p><small>{{current:'当前文件 · 只读',historical:'创建评论时的版本 · 只读',excerpt:'保存的片段 · 最多 8,000 字符',unavailable:'原始版本已不可用'}[value.mode as string]}</small><div className="reference-viewer">{value.content.split('\n').map((line:string,i:number)=>{const n=i+(value.mode==='excerpt'?value.startLine:1);return <div key={i} className={n>=value.startLine&&n<=value.endLine?'reference-selected':''}><small>{n}</small><code>{line||' '}</code></div>;})}</div></>}</Modal>;
}
