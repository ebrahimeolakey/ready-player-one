import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_EDITOR_SETTINGS,validateEditorSettings,resolveEditorSettings,prepareEditorSave} from '../core/editor-settings.mjs';
test('editor settings validate limits and reject prototype/CSS injection keys instead of enabling hidden options',()=>{
 assert.equal(DEFAULT_EDITOR_SETTINGS.formatOnSave,false);assert.equal(DEFAULT_EDITOR_SETTINGS.trimTrailingWhitespace,false);
 assert.deepEqual(validateEditorSettings({fontSize:12.5,lineHeight:1.6}),{...DEFAULT_EDITOR_SETTINGS});
 for(const value of [{fontSize:NaN},{fontSize:7},{fontSize:33},{lineHeight:0},{indentWidth:1.5},{indentWidth:9},{minimap:'true'},{wordWrap:'bounded'},{fontFamily:'mono; background:url(https://example.com)'},{fontFamily:'a\nb'},JSON.parse('{"__proto__":{}}'),{constructor:1},{toString:1},[]])assert.throws(()=>validateEditorSettings(value));
 assert.deepEqual(resolveEditorSettings({minimap:'broken'}),{...DEFAULT_EDITOR_SETTINGS});
 assert.equal(validateEditorSettings({fontFamily:'  等宽字体  ',insertSpaces:false}).fontFamily,'等宽字体');
});
test('default save never changes existing text, indentation, line endings or trailing whitespace',()=>{
 for(const [path,content]of[['x.js','const x = `text  \n`;  \r\n'],['x.json',' { "n" :9007199254740993000 }  \r\n'],['x.md','hard break  \nnext\n'],['x.txt',' a \t\r\n']]){
  const result=prepareEditorSave({path,content});assert.equal(result.content,content);assert.deepEqual(result.notices,[]);assert.equal(result.formatted,false);assert.equal(result.trimmed,false);
 }
});
test('strict JSON formatter preserves large numbers, exponent spelling, duplicate keys, escaped strings, BOM and CRLF',()=>{
 const source='\ufeff{"number":90071992547409930001234,"n":-0,"exp":1.20e+9999,"key":1,"key":2,"s":"\\u0041\\n\\\\","empty":[],"nested":[{},true,null]}\r\n';
 const result=prepareEditorSave({path:'data.JSON',content:source,settings:{formatOnSave:true,indentWidth:4}});
 assert.equal(result.formatted,true);assert.equal(result.content[0],'\ufeff');assert.ok(result.content.endsWith('\r\n'));assert.doesNotMatch(result.content,/(^|[^\r])\n/);
 for(const token of ['90071992547409930001234','-0','1.20e+9999','"\\u0041\\n\\\\"'])assert.ok(result.content.includes(token),token);
 assert.equal((result.content.match(/"key"/g)||[]).length,2);assert.ok(result.content.includes('\r\n    "number":'));assert.doesNotThrow(()=>JSON.parse(result.content.slice(1)));
 assert.equal(prepareEditorSave({path:'x.json',content:result.content,settings:{formatOnSave:true,indentWidth:4}}).content,result.content);
 const tabbed=prepareEditorSave({path:'data.json',content:'{"a":[1,2]}',settings:{formatOnSave:true,insertSpaces:false}});assert.ok(tabbed.content.includes('\n\t"a":'));assert.ok(tabbed.content.includes('\n\t\t1,'));
});
test('unsupported languages, malformed JSON and excessive depth preserve text and explicitly report skipped formatting',()=>{
 for(const [path,content]of[['x.ts','const n = 1;  \n'],['x.md','hard break  \n'],['x.jsonc','{/* comment */"a":1}'],['bad.json','{"a": "unfinished  \n'],['deep.json','['.repeat(101)+'0'+']'.repeat(101)]]){
  const result=prepareEditorSave({path,content,settings:{formatOnSave:true,trimTrailingWhitespace:true}});assert.equal(result.content,content);assert.ok(result.notices.some(v=>v.startsWith('未格式化')));assert.equal(result.formatted,false);
 }
});
test('opt-in trailing whitespace cleanup preserves JSON string contents and never changes code/Markdown string semantics',()=>{
 const json=' {"text":"keep spaces  ","escaped":"\\t"} \t\r\n';
 const cleaned=prepareEditorSave({path:'a.json',content:json,settings:{trimTrailingWhitespace:true}});assert.equal(cleaned.content,' {"text":"keep spaces  ","escaped":"\\t"}\r\n');assert.equal(cleaned.trimmed,true);
 assert.equal(prepareEditorSave({path:'a.txt',content:'hello \t\r\nworld  ',settings:{trimTrailingWhitespace:true}}).content,'hello\r\nworld');
 const js='const str = `space  \n`;  \n',result=prepareEditorSave({path:'a.js',content:js,settings:{trimTrailingWhitespace:true}});assert.equal(result.content,js);assert.match(result.notices[0],/未清理行尾空白/);
});
test('real CodeMirror state uses configured indentation/tab facets and wrap/whitespace extensions without a DOM',async t=>{
 const [{build},{mkdtemp,rm},{join},{tmpdir},{pathToFileURL,fileURLToPath},{EditorState},{getIndentUnit},{indentMore},{EditorView}]=await Promise.all([import('esbuild'),import('node:fs/promises'),import('node:path'),import('node:os'),import('node:url'),import('@codemirror/state'),import('@codemirror/language'),import('@codemirror/commands'),import('@codemirror/view')]);
 const dir=await mkdtemp(join(tmpdir(),'rpo-editor-settings-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const output=join(dir,'editor.mjs');
 await build({entryPoints:[fileURLToPath(new URL('../src/CodeEditor.tsx',import.meta.url))],outfile:output,bundle:true,format:'esm',platform:'node',loader:{'.css':'empty'},plugins:[{name:'existing-package-paths',setup(b){b.onResolve({filter:/^[^./]/},args=>({path:fileURLToPath(import.meta.resolve(args.path)),external:true}));}}],logLevel:'silent'});
 const {editorSettingsExtensions}=await import(pathToFileURL(output).href);
 for(const settings of [{indentWidth:4,insertSpaces:true,wordWrap:'on',renderWhitespace:true},{indentWidth:8,insertSpaces:false,wordWrap:'off',renderWhitespace:false}]){
  let state=EditorState.create({doc:'value',extensions:editorSettingsExtensions(validateEditorSettings({...settings,minimap:false,indentGuides:false}))});
  assert.equal(state.tabSize,settings.indentWidth);assert.equal(getIndentUnit(state),settings.indentWidth);
  assert.equal(state.facet(EditorView.contentAttributes).some(value=>typeof value==='object'&&value.class?.includes('cm-lineWrapping')),settings.wordWrap==='on');
  indentMore({state,dispatch:transaction=>{state=transaction.state;}});assert.equal(state.doc.toString(),settings.insertSpaces?'    value':'\tvalue');
 }
});
