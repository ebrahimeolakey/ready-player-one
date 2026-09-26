import ts from 'typescript';
import {createHash,randomUUID} from 'node:crypto';
import {validateEditorSettings} from '../../core/editor-settings.mjs';
import {KEYBOARD_ACTIONS,validateBindings} from '../../core/keybindings.mjs';
import {redactText} from '../../core/secure-store.mjs';

export const IMPORT_LIMITS=Object.freeze({bytes:256*1024,depth:32,nodes:12000,plans:8});
const forbidden=new Set(['__proto__','prototype','constructor']);
const commandMap=Object.freeze({
 'workbench.action.quickOpen':'searchFiles',
 'workbench.action.files.save':'saveFile',
 'workbench.action.terminal.toggleTerminal':'toggleTerminal',
});
const editorMap=Object.freeze({
 'editor.fontFamily':'fontFamily','editor.fontSize':'fontSize','editor.lineHeight':'lineHeight',
 'editor.fontLigatures':'ligatures','editor.tabSize':'indentWidth','editor.insertSpaces':'insertSpaces',
 'editor.formatOnSave':'formatOnSave','files.trimTrailingWhitespace':'trimTrailingWhitespace',
 'editor.wordWrap':'wordWrap','editor.renderWhitespace':'renderWhitespace',
 'editor.guides.indentation':'indentGuides','editor.minimap.enabled':'minimap',
});
const labels={unsupported:'未支持的设置（键名和值未保留）',language:'语言专属覆盖未导入；不会改变全局设置',
 invalid:'值超出本编辑器支持范围',command:'命令没有等价操作（命令和值未保留）',
 conditional:'带 when 条件的快捷键未导入',arguments:'带参数或额外语义的快捷键未导入',
 removal:'移除默认快捷键规则未导入',binding:'组合键格式或系统保留键不受支持',
 chord:'多段快捷键不受支持',platform:'此平台不支持该修饰键',extensions:'不兼容 VS Code 扩展；不会安装扩展'};
function fail(code,message){const error=Error(message);error.code=code;throw error;}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy=value=>JSON.parse(JSON.stringify(value));

/** JSONC data only. TypeScript is already a production dependency. Its AST is
 * checked explicitly: never evaluate code or use its object-building converter. */
export function parseImportJSONC(text){
 if(typeof text!=='string')fail('IMPORT_INVALID_JSONC','请选择 JSONC 文本');
 if(Buffer.byteLength(text,'utf8')>IMPORT_LIMITS.bytes)fail('IMPORT_TOO_LARGE','配置文件超过 256 KiB 上限');
 const source=text.replace(/^\ufeff/,'');let depth=0,tokens=0;
 const scanner=ts.createScanner(ts.ScriptTarget.Latest,true,ts.LanguageVariant.Standard,source,()=>fail('IMPORT_INVALID_JSONC','JSONC 语法无效'));
 while(true){const token=scanner.scan();if(token===ts.SyntaxKind.EndOfFileToken)break;
  if(++tokens>IMPORT_LIMITS.nodes)fail('IMPORT_COMPLEXITY','配置节点数量超过上限');
  if(token===ts.SyntaxKind.OpenBraceToken||token===ts.SyntaxKind.OpenBracketToken){if(++depth>IMPORT_LIMITS.depth)fail('IMPORT_COMPLEXITY','配置嵌套超过上限');}
  else if(token===ts.SyntaxKind.CloseBraceToken||token===ts.SyntaxKind.CloseBracketToken)depth--;
 }
 const tree=ts.parseJsonText('selected.json',source);
 if(tree.parseDiagnostics.length||tree.statements.length!==1)fail('IMPORT_INVALID_JSONC','JSONC 语法无效');
 let nodes=0;
 function convert(node,level=0){
  if(!node||++nodes>IMPORT_LIMITS.nodes||level>IMPORT_LIMITS.depth)fail('IMPORT_COMPLEXITY','配置结构超过上限');
  if(ts.isObjectLiteralExpression(node)){
   const result=Object.create(null);
   for(const property of node.properties){
    if(!ts.isPropertyAssignment(property)||!ts.isStringLiteral(property.name))fail('IMPORT_INVALID_JSONC','配置只能包含 JSON 属性');
    const name=convert(property.name,level+1);
    if(forbidden.has(name)||Object.hasOwn(result,name))fail('IMPORT_INVALID_JSONC','配置包含重复或不安全的属性名');
    result[name]=convert(property.initializer,level+1);
   }return result;
  }
  if(ts.isArrayLiteralExpression(node))return node.elements.map(value=>convert(value,level+1));
  if(ts.isStringLiteral(node)){
   const raw=node.getText(tree);if(!raw.startsWith('"'))fail('IMPORT_INVALID_JSONC','JSON 字符串必须使用双引号');
   try{return JSON.parse(raw);}catch{fail('IMPORT_INVALID_JSONC','JSON 字符串无效');}
  }
  if(ts.isNumericLiteral(node)||(ts.isPrefixUnaryExpression(node)&&node.operator===ts.SyntaxKind.MinusToken&&ts.isNumericLiteral(node.operand))){
   const raw=node.getText(tree);if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw))fail('IMPORT_INVALID_JSONC','JSON 数值无效');
   const value=Number(raw);if(!Number.isFinite(value))fail('IMPORT_INVALID_JSONC','JSON 数值超出范围');return value;
  }
  if(node.kind===ts.SyntaxKind.TrueKeyword)return true;if(node.kind===ts.SyntaxKind.FalseKeyword)return false;if(node.kind===ts.SyntaxKind.NullKeyword)return null;
  fail('IMPORT_INVALID_JSONC','配置只能包含 JSON 数据');
 }
 return convert(tree.statements[0].expression);
}
function baseline(current,platform){
 try{return {editorSettings:validateEditorSettings(current?.editorSettings||{}),keyboard:validateBindings(current?.keyboard||{},platform)};}
 catch{fail('IMPORT_CURRENT_INVALID','当前设置无效，请先修复后重新预览');}
}
function scopeKey(scope){if(typeof scope!=='string'||!scope||scope.length>1024)fail('IMPORT_SCOPE_INVALID','缺少本机设置作用域');return digest(scope);}
function combination(raw,platform){
 if(typeof raw!=='string'||!raw||raw.length>100)throw Error('binding');
 if(/\s/.test(raw.trim()))throw Error('chord');
 const pieces=raw.trim().toLowerCase().split('+'),last=pieces.pop(),mods=[];
 for(const part of pieces){
  const modifier={cmd:'Meta',ctrl:'Control',alt:'Alt',shift:'Shift',win:'Meta'}[part];
  if(!modifier||mods.includes(modifier))throw Error('binding');
  if((part==='cmd'&&platform!=='darwin')||(part==='win'&&platform==='darwin'))throw Error('platform');
  mods.push(modifier);
 }
 let code;
 if(/^[a-z]$/.test(last))code='Key'+last.toUpperCase();
 else if(/^\d$/.test(last))code='Digit'+last;
 else if(/^f(?:[1-9]|1[0-2])$/.test(last))code=last.toUpperCase();
 else if(/^\[(key[a-z]|digit[0-9])\]$/.test(last)){const plain=last.slice(1,-1);code=plain.startsWith('key')?'Key'+plain.slice(3).toUpperCase():'Digit'+plain.slice(5);}
 else code={enter:'Enter',escape:'Escape',esc:'Escape',space:'Space',up:'ArrowUp',down:'ArrowDown',left:'ArrowLeft',right:'ArrowRight'}[last];
 if(!code)throw Error('binding');
 return ['Meta','Control','Alt','Shift'].filter(m=>mods.includes(m)).concat(code).join('+');
}
function supportedEditor(source,value,base,bySource){
 const target=editorMap[source],notes=[],requires=[];
 if(source==='editor.fontFamily'){
  if(typeof value!=='string'||redactText(value)!==value)throw Error('invalid');
  const parts=value.split(',');value=parts[0].trim();
  if((value.startsWith("'")&&value.endsWith("'"))||(value.startsWith('"')&&value.endsWith('"')))value=value.slice(1,-1);
  if(parts.length>1)notes.push('仅保留首个字体；本程序不支持备用字体列表');
 }else if(source==='editor.lineHeight'){
  if(typeof value!=='number'||value<=0)throw Error('invalid');
  if(value>=8){
   const font=bySource.get('editor.fontSize');value=value/(font?.value??base.fontSize);
   if(font)requires.push(font.id);notes.push('已将像素行高按预览字号换算为倍数');
  }
 }else if(source==='editor.renderWhitespace'){
  if(!['none','all'].includes(value))throw Error('invalid');value=value==='all';
 }
 if(source==='editor.formatOnSave')notes.push('本程序保存时格式化目前仅支持严格 JSON');
 if(source==='files.trimTrailingWhitespace')notes.push('本程序目前仅对严格 JSON 和 .txt 清理行尾空白');
 try{value=validateEditorSettings({...base,[target]:value})[target];}catch{throw Error('invalid');}
 return {target,value,notes,requires};
}

/** No filesystem access or persistence. Main owns file selection and atomic save. */
export class VSCodeImportService{
 #plans=new Map();
 constructor({platform=process.platform,now=Date.now,ttlMs=300000}={}){
  if(!['darwin','win32','linux'].includes(platform))fail('IMPORT_PLATFORM','不支持的平台');
  if(!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>600000)fail('IMPORT_TTL','预览有效期无效');
  Object.assign(this,{platform,now,ttlMs});
 }
 preview({settingsText,keybindingsText,current,scope}={}){
  const base=baseline(current,this.platform),scopeHash=scopeKey(scope),changes=[],unsupported=[],bySource=new Map();
  if(settingsText===undefined&&keybindingsText===undefined)fail('IMPORT_EMPTY','请选择配置文件');
  const skip=(source,index,code)=>unsupported.push({source,index,code,label:labels[code]||labels.unsupported});
  if(settingsText!==undefined){
   const settings=parseImportJSONC(settingsText);if(!settings||Array.isArray(settings)||typeof settings!=='object')fail('IMPORT_SETTINGS_SHAPE','settings.json 必须是对象');
   // Font size first, so pixel line-height conversion has an explicit dependency.
   const entries=Object.entries(settings).map(([name,value],index)=>({name,value,index})).sort((a,b)=>(a.name==='editor.fontSize'?-1:0)-(b.name==='editor.fontSize'?-1:0));
   for(const {name,value,index} of entries){
    if(!Object.hasOwn(editorMap,name)){skip('settings',index,/^\[.*\]$/.test(name)?'language':/^extensions(?:\.|$)/.test(name)?'extensions':'unsupported');continue;}
    try{
     const data=supportedEditor(name,value,base.editorSettings,bySource);
     const change={id:randomUUID(),kind:'editor',source:name,...data};changes.push(change);bySource.set(name,change);
    }catch{skip('settings',index,'invalid');}
   }
  }
  if(keybindingsText!==undefined){
   const bindings=parseImportJSONC(keybindingsText);if(!Array.isArray(bindings))fail('IMPORT_BINDINGS_SHAPE','keybindings.json 必须是数组');
   for(const [index,binding]of bindings.entries()){
    if(!binding||Array.isArray(binding)||typeof binding!=='object'){skip('keybindings',index,'binding');continue;}
    if(typeof binding.command==='string'&&binding.command.startsWith('-')){skip('keybindings',index,'removal');continue;}
    if(Object.hasOwn(binding,'when')){skip('keybindings',index,'conditional');continue;}
    if(Object.keys(binding).some(k=>!['key','command'].includes(k))){skip('keybindings',index,'arguments');continue;}
    if(typeof binding.command!=='string'||!Object.hasOwn(commandMap,binding.command)){skip('keybindings',index,'command');continue;}
    const target=commandMap[binding.command];
    try{
     const value=combination(binding.key,this.platform),empty=Object.fromEntries(KEYBOARD_ACTIONS.map(a=>[a.id,'']));
     const validated=validateBindings({...empty,[target]:value},this.platform)[target];
     changes.push({id:randomUUID(),kind:'keyboard',source:binding.command,target,value:validated,notes:['使用本程序操作范围；字符键按物理键编码，非美式布局请核对'],requires:[]});
    }catch(error){skip('keybindings',index,['chord','platform'].includes(error.message)?error.message:'binding');}
   }
  }
  for(const change of changes){
   change.conflicts=[];
   if(change.kind!=='keyboard')continue;
   for(const [action,value]of Object.entries(base.keyboard))if(action!==change.target&&value===change.value)change.conflicts.push({target:action,reason:'existing-binding'});
   for(const other of changes)if(other!==change&&other.kind==='keyboard'&&(other.target===change.target||other.value===change.value))change.conflicts.push({target:other.target,changeId:other.id,reason:other.target===change.target?'multiple-bindings':'selected-binding'});
  }
  this.cleanup();while(this.#plans.size>=IMPORT_LIMITS.plans)this.#plans.delete(this.#plans.keys().next().value);
  const planId=randomUUID(),expiresAt=this.now()+this.ttlMs;
  this.#plans.set(planId,{expiresAt,scopeHash,baseline:digest(base),changes:copy(changes)});
  return {planId,expiresAt,changes,unsupported,availableTargets:KEYBOARD_ACTIONS.map(({id,label})=>({id,label})),warnings:[
   '只导入本程序支持的全局设置；不导入账号、终端命令、插件或 VS Code 扩展。',
   '快捷键只映射打开文件、保存文件、展开终端；其余操作没有已确认等价关系，保持原值。',
  ]};
 }
 apply({planId,selectedIds,current,scope}={}){
  this.cleanup();const plan=this.#plans.get(planId);
  if(!plan)fail('IMPORT_PLAN_EXPIRED','预览已过期、已使用或不存在，请重新选择文件预览');
  if(scopeKey(scope)!==plan.scopeHash){this.#plans.delete(planId);fail('IMPORT_SCOPE_CHANGED','设置作用域已改变，请重新预览');}
  const base=baseline(current,this.platform);
  if(digest(base)!==plan.baseline){this.#plans.delete(planId);fail('IMPORT_PLAN_STALE','设置已被修改，请重新预览');}
  if(!Array.isArray(selectedIds)||selectedIds.length>plan.changes.length||new Set(selectedIds).size!==selectedIds.length||selectedIds.some(id=>!plan.changes.some(c=>c.id===id)))fail('IMPORT_SELECTION','导入选择无效');
  const selected=new Set(selectedIds),editorPatch={},keyboardPatch={};
  for(const change of plan.changes){if(!selected.has(change.id))continue;
   if(change.requires.some(id=>!selected.has(id)))fail('IMPORT_SELECTION','像素行高需要同时选择其预览字号');
   const patch=change.kind==='editor'?editorPatch:keyboardPatch;
   if(Object.hasOwn(patch,change.target))fail('IMPORT_CONFLICT','同一操作只能选择一个快捷键');
   patch[change.target]=change.value;
  }
  try{validateEditorSettings({...base.editorSettings,...editorPatch});validateBindings({...base.keyboard,...keyboardPatch},this.platform);}
  catch{fail('IMPORT_CONFLICT','选中的设置或快捷键冲突，请调整选择后重试');}
  this.#plans.delete(planId);return {editorPatch,keyboardPatch};
 }
 cleanup(){const now=this.now();for(const [id,plan]of this.#plans)if(plan.expiresAt<=now)this.#plans.delete(id);}
 discard(planId){this.#plans.delete(planId);}
 dispose(){this.#plans.clear();}
}
