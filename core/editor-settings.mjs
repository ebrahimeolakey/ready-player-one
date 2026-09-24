export const DEFAULT_EDITOR_SETTINGS=Object.freeze({fontFamily:'IBM Plex Mono',fontSize:12.5,lineHeight:1.6,ligatures:true,indentWidth:2,insertSpaces:true,formatOnSave:false,trimTrailingWhitespace:false,wordWrap:'off',renderWhitespace:false,indentGuides:true,minimap:true});
const booleanKeys=['ligatures','insertSpaces','formatOnSave','trimTrailingWhitespace','renderWhitespace','indentGuides','minimap'];
const bounds={fontSize:[8,32],lineHeight:[1,3],indentWidth:[1,8]};
export function validateEditorSettings(value) {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_EDITOR_SETTINGS,key)))throw Error('编辑器设置格式无效');
 const settings={...DEFAULT_EDITOR_SETTINGS,...value};
 if(typeof settings.fontFamily!=='string'||!settings.fontFamily.trim()||settings.fontFamily.length>100||!/^[-\p{L}\p{N} _]+$/u.test(settings.fontFamily))throw Error('字体名称无效');
 settings.fontFamily=settings.fontFamily.trim();
 for(const key of booleanKeys)if(typeof settings[key]!=='boolean')throw Error(`编辑器开关无效：${key}`);
 for(const [key,[min,max]]of Object.entries(bounds))if(typeof settings[key]!=='number'||!Number.isFinite(settings[key])||settings[key]<min||settings[key]>max||(key==='indentWidth'&&!Number.isInteger(settings[key])))throw Error(`编辑器数值超出范围：${key}`);
 if(!['off','on'].includes(settings.wordWrap))throw Error('自动换行设置无效');
 return settings;
}
export function resolveEditorSettings(value) {try{return validateEditorSettings(value||{});}catch{return {...DEFAULT_EDITOR_SETTINGS};}}
export const EDITOR_FORMAT_LANGUAGES=Object.freeze(['json']);
function prettyJSON(source,unit,eol) {
 // Validation only: never serialize parsed values. Raw tokens preserve large
 // integers, exponents, duplicate keys and escaped strings byte-for-byte.
 JSON.parse(source);
 const tokens=source.match(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g)||[];
 let depth=0;const output=[];
 const newline=()=>output.push(eol,unit.repeat(depth));
 for(let i=0;i<tokens.length;i++){
  const token=tokens[i];
  if(token==='{'||token==='['){output.push(token);if(tokens[i+1]===(token==='{'?'}':']'))output.push(tokens[++i]);else{if(++depth>100)throw Error('JSON 嵌套超过格式化上限');newline();}}
  else if(token==='}'||token===']'){depth--;newline();output.push(token);}
  else if(token===','){output.push(token);newline();}
  else if(token===':')output.push(': ');
  else output.push(token);
 }
 return output.join('')+(source.endsWith('\n')?eol:'');
}
export function prepareEditorSave({path,content,settings}) {
 if(typeof content!=='string'||typeof path!=='string')throw Error('待保存文件无效');
 const options=resolveEditorSettings(settings),notices=[];let result=content,formatted=false,trimmed=false;
 const json=/\.json$/i.test(path),plain=/\.txt$/i.test(path),bom=content.startsWith('\ufeff')?'\ufeff':'',body=content.slice(bom.length);
 const bounded=content.length<=2*1024*1024;
 let validJSON=false;if(json&&bounded){try{JSON.parse(body);validJSON=true;}catch{}}
 if(options.formatOnSave){
  if(!json)notices.push('未格式化：目前仅支持严格 JSON');
  else if(!bounded)notices.push('未格式化：JSON 超过格式化长度上限');
  else if(!validJSON)notices.push('未格式化：JSON 语法无效，原文已保留');
  else{try{const eol=body.includes('\r\n')&&!/(^|[^\r])\n/.test(body)?'\r\n':'\n';result=bom+prettyJSON(body,options.insertSpaces?' '.repeat(options.indentWidth):'\t',eol);formatted=result!==content;}catch{notices.push('未格式化：JSON 超出安全格式化范围，原文已保留');}}
 }
 if(options.trimTrailingWhitespace){
  if(plain||validJSON){const next=result.replace(/[\t ]+(?=\r?$)/gm,'');trimmed=next!==result;result=next;}
  else notices.push('未清理行尾空白：仅支持严格 JSON 和 .txt，其他语言原文保留');
 }
 return {content:result,notices,formatted,trimmed};
}
