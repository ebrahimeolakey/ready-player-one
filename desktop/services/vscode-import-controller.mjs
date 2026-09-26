import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {VSCodeImportService,IMPORT_LIMITS} from './vscode-import.mjs';
import {validateEditorSettings} from '../../core/editor-settings.mjs';
import {validateBindings} from '../../core/keybindings.mjs';
const fail=(code,message)=>{const e=Error(message);e.code=code;throw e;};
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
function args(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('IMPORT_ARGUMENTS','导入请求参数无效');}

/** Called only with a path returned by the trusted native file dialog, never IPC. */
export async function readSelectedImportFile(selectedPath){
 if(typeof selectedPath!=='string'||!isAbsolute(selectedPath)||selectedPath.includes('\0'))fail('IMPORT_FILE_SELECTION','所选文件无效');
 let handle;
 try{
  const before=await lstat(selectedPath,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink())fail('IMPORT_FILE_TYPE','请选择普通 JSON/JSONC 文件');
  if(before.size>BigInt(IMPORT_LIMITS.bytes))fail('IMPORT_TOO_LARGE','配置文件超过 256 KiB 上限');
  const canonical=await realpath(selectedPath);
  handle=await open(canonical,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
  if(!same(before,await handle.stat({bigint:true})))fail('IMPORT_FILE_CHANGED','所选文件已改变，请重新选择');
  const bytes=Buffer.alloc(IMPORT_LIMITS.bytes+1);let count=0;
  while(count<bytes.length){const result=await handle.read(bytes,count,bytes.length-count,count);if(!result.bytesRead)break;count+=result.bytesRead;}
  if(count>IMPORT_LIMITS.bytes)fail('IMPORT_TOO_LARGE','配置文件超过 256 KiB 上限');
  if(!same(before,await handle.stat({bigint:true}))||!same(before,await lstat(selectedPath,{bigint:true}))||await realpath(selectedPath)!==canonical)fail('IMPORT_FILE_CHANGED','读取期间配置文件改变，请重新选择');
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count));}catch{fail('IMPORT_FILE_ENCODING','配置必须是 UTF-8 文本');}
 }catch(error){if(error.code?.startsWith('IMPORT_'))throw error;fail('IMPORT_FILE_READ','无法读取所选配置文件');}
 finally{await handle?.close();}
}

/** Main-owned adapter: native selection, bounded reading, then one synchronous
 * encrypted commit. All input/current values/scope come from trusted callbacks. */
export class VSCodeImportController{
 constructor({selectFile,getConfig,getScope,persist,platform=process.platform,importer=new VSCodeImportService({platform})}){
  Object.assign(this,{selectFile,getConfig,getScope,persist,platform,importer});this.disposed=false;this.selecting=false;
 }
 ready(){if(this.disposed)fail('IMPORT_CLOSED','导入服务已关闭');}
 async preview(request){
  this.ready();args(request,['kind']);const {kind}=request;
  if(!['settings','keybindings'].includes(kind))fail('IMPORT_KIND','请选择设置或快捷键文件');
  if(this.selecting)fail('IMPORT_BUSY','文件选择正在进行');
  this.selecting=true;
  try{
   const scope=this.getScope(),choice=await this.selectFile(kind);this.ready();
   if(choice?.canceled)return null;
   if(!Array.isArray(choice?.filePaths)||choice.filePaths.length!==1)fail('IMPORT_FILE_SELECTION','请选择一个配置文件');
   const text=await readSelectedImportFile(choice.filePaths[0]);this.ready();
   if(this.getScope()!==scope)fail('IMPORT_SCOPE_CHANGED','设置作用域已改变，请重新选择文件');
   const config=this.getConfig(),current={editorSettings:config.editorSettings||{},keyboard:config.keyboard||{}};
   return {...this.importer.preview({[kind==='settings'?'settingsText':'keybindingsText']:text,current,scope}),kind};
  }finally{this.selecting=false;}
 }
 apply(request){
  this.ready();args(request,['planId','selectedIds']);
  const config=this.getConfig(),current={editorSettings:config.editorSettings||{},keyboard:config.keyboard||{}};
  const {editorPatch,keyboardPatch}=this.importer.apply({...request,current,scope:this.getScope()});
  const updates={};
  if(Object.keys(editorPatch).length)updates.editorSettings=validateEditorSettings({...current.editorSettings,...editorPatch});
  if(Object.keys(keyboardPatch).length)updates.keyboard=validateBindings({...current.keyboard,...keyboardPatch},this.platform);
  const previous=new Map(Object.keys(updates).map(key=>[key,{present:Object.hasOwn(config,key),value:config[key]}]));
  if(!previous.size)return {imported:0};
  try{
   Object.assign(config,updates);
   // No await between baseline validation, in-memory replacement and commit.
   this.persist();
  }catch(error){
   for(const [key,old]of previous)if(old.present)config[key]=old.value;else delete config[key];
   fail('IMPORT_SAVE_FAILED','导入保存失败，原设置已保留；请重新预览');
  }
  return {imported:request.selectedIds.length};
 }
 discard(request){this.ready();args(request,['planId']);if(typeof request.planId!=='string')fail('IMPORT_ARGUMENTS','预览标识无效');this.importer.discard(request.planId);return true;}
 dispose(){this.disposed=true;this.importer.dispose();}
}
