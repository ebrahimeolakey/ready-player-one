import {createContext,useContext,useEffect,useRef,useState} from 'react';
import {DEFAULT_EDITOR_SETTINGS,resolveEditorSettings,validateEditorSettings,type EditorSettingsValue} from '../core/editor-settings.mjs';
import type {Call} from './ui';
import './editor-settings.css';
export const EditorSettingsContext=createContext<Partial<EditorSettingsValue>|undefined>(undefined);
export const useEditorSettings=()=>resolveEditorSettings(useContext(EditorSettingsContext));
export function EditorSettings({settings,call}:{settings?:Partial<EditorSettingsValue>;call:Call}) {
 const [draft,setDraft]=useState(()=>resolveEditorSettings(settings)),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [numbers,setNumbers]=useState(()=>({fontSize:String(draft.fontSize),lineHeight:String(draft.lineHeight),indentWidth:String(draft.indentWidth)}));
 const baseline=useRef(resolveEditorSettings(settings));
 const current=useRef({draft,numbers});current.current={draft,numbers};
 const savedSignature=JSON.stringify(resolveEditorSettings(settings));
 useEffect(()=>{
  const next:EditorSettingsValue=JSON.parse(savedSignature),previous=baseline.current;
  if(JSON.stringify(previous)===savedSignature)return;
  const edited=current.current,merged={...next},nextNumbers={fontSize:String(next.fontSize),lineHeight:String(next.lineHeight),indentWidth:String(next.indentWidth)};
  let preserved=false;
  for(const key of Object.keys(next) as (keyof EditorSettingsValue)[]){
   if(Object.hasOwn(edited.numbers,key)){
    const numericKey=key as keyof typeof nextNumbers;
    // Preserve raw text, including an empty or temporarily invalid numeric input.
    if(edited.numbers[numericKey]!==String(previous[numericKey])){nextNumbers[numericKey]=edited.numbers[numericKey];preserved=true;}
   }else if(edited.draft[key]!==previous[key]){
    Object.assign(merged,{[key]:edited.draft[key]});preserved=true;
   }
  }
  baseline.current=next;setDraft(merged);setNumbers(nextNumbers);
  if(preserved)setMessage('设置已更新，保留未保存修改');
 },[savedSignature]);
 const update=<K extends keyof EditorSettingsValue>(key:K,value:EditorSettingsValue[K])=>{setDraft({...draft,[key]:value});setMessage('');};
 const toggle=(key:keyof EditorSettingsValue,label:string)=><label className="editor-settings-toggle"><span>{label}</span><input type="checkbox" checked={draft[key]===true} onChange={e=>update(key,e.target.checked as never)}/></label>;
 async function save(value?:EditorSettingsValue){setBusy(true);setMessage('');try{if(!value&&Object.values(numbers).some(v=>!v.trim()))throw Error('请填写字号、行高和缩进宽度');value??={...draft,fontSize:Number(numbers.fontSize),lineHeight:Number(numbers.lineHeight),indentWidth:Number(numbers.indentWidth)};const result=await call('settings.editor.save',{settings:validateEditorSettings(value)});if(result){const saved=resolveEditorSettings(result);baseline.current=saved;setDraft(saved);setNumbers({fontSize:String(saved.fontSize),lineHeight:String(saved.lineHeight),indentWidth:String(saved.indentWidth)});setMessage('已保存');}}catch(error){setMessage((error as Error).message);}finally{setBusy(false);}}
 return <section className="editor-settings"><header><button className="button" disabled={busy} onClick={()=>save({...DEFAULT_EDITOR_SETTINGS})}>恢复默认</button></header>
 <form onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={busy}><legend>字体</legend>
 <label><span>字体</span><input list="editor-fonts" value={draft.fontFamily} maxLength={100} onChange={e=>update('fontFamily',e.target.value)}/><datalist id="editor-fonts">{['IBM Plex Mono','Menlo','Monaco','Cascadia Code','JetBrains Mono','monospace'].map(font=><option key={font} value={font}/>)}</datalist></label>
 <p className="editor-settings-note">使用本机字体；未安装时使用等宽后备字体。</p>
 <label><span>字号</span><input type="number" min={8} max={32} step={0.5} value={numbers.fontSize} onChange={e=>{setNumbers({...numbers,fontSize:e.target.value});setMessage('');}}/></label>
 <label><span>行高</span><input type="number" min={1} max={3} step={0.1} value={numbers.lineHeight} onChange={e=>{setNumbers({...numbers,lineHeight:e.target.value});setMessage('');}}/></label>
 {toggle('ligatures','字体连字')}</fieldset>
 <fieldset disabled={busy}><legend>格式</legend>
 <label><span>缩进宽度</span><input type="number" min={1} max={8} step={1} value={numbers.indentWidth} onChange={e=>{setNumbers({...numbers,indentWidth:e.target.value});setMessage('');}}/></label>
 {toggle('insertSpaces','使用空格缩进')}{toggle('formatOnSave','保存时格式化')}{toggle('trimTrailingWhitespace','清理行尾空白')}
 <p className="editor-settings-note">格式化：严格 JSON。行尾空白：JSON、.txt。其他语言保留原文并提示。</p></fieldset>
 <fieldset disabled={busy}><legend>显示</legend><label><span>自动换行</span><select value={draft.wordWrap} onChange={e=>update('wordWrap',e.target.value as 'on'|'off')}><option value="off">关闭</option><option value="on">开启</option></select></label>
 {toggle('renderWhitespace','显示空白')}{toggle('indentGuides','缩进参考线')}{toggle('minimap','代码缩略图')}
 </fieldset><footer><span role="status">{message}</span><button className="button primary" disabled={busy}>保存</button></footer></form></section>;
}
