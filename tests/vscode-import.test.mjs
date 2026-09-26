import test from 'node:test';
import assert from 'node:assert/strict';
import {VSCodeImportService,parseImportJSONC,IMPORT_LIMITS} from '../desktop/services/vscode-import.mjs';
import {validateEditorSettings} from '../core/editor-settings.mjs';
import {validateBindings} from '../core/keybindings.mjs';
const context={scope:'synthetic-local-settings',current:{editorSettings:{},keyboard:{}}};
function fixture(t,options={}){const service=new VSCodeImportService({platform:'darwin',...options});t.after(()=>service.dispose());return service;}
const all=p=>p.changes.map(c=>c.id);
const rule=(command,key,rest={})=>({command,key,...rest});
const quick='workbench.action.quickOpen',save='workbench.action.files.save',terminal='workbench.action.terminal.toggleTerminal';

test('JSONC comments/BOM/trailing commas import supported global settings with validated partial patch',t=>{
 const service=fixture(t);const p=service.preview({...context,settingsText:'\ufeff{/* note */"editor.fontFamily":"\'Fira Code\', monospace","editor.fontSize":14,"editor.tabSize":4,"editor.insertSpaces":false,"editor.wordWrap":"on","editor.minimap.enabled":false,"editor.renderWhitespace":"all",// final\n}'});
 assert.equal(p.unsupported.length,0);assert.ok(p.changes.find(c=>c.target==='fontFamily').notes.length);const patch=service.apply({...context,planId:p.planId,selectedIds:all(p)});
 assert.deepEqual(patch,{editorPatch:{fontSize:14,fontFamily:'Fira Code',indentWidth:4,insertSpaces:false,wordWrap:'on',minimap:false,renderWhitespace:true},keyboardPatch:{}});assert.equal(validateEditorSettings(patch.editorPatch).fontFamily,'Fira Code');
});
test('language scopes, extension configuration and unknown key/value contents never escape preview',t=>{
 const service=fixture(t),secret='ghp_synthetic_credential_DO_NOT_RETURN';
 const p=service.preview({...context,settingsText:JSON.stringify({'editor.fontSize':15,'editor.fontFamily':secret,'[typescript]':{'editor.fontSize':29},['secret-key-'+secret]:secret,'extensions.configuration':{apiKey:secret}})});
 assert.equal(p.changes.length,1);assert.deepEqual(p.unsupported.map(i=>i.code),['invalid','language','unsupported','extensions']);assert.ok(!JSON.stringify(p).includes(secret));assert.ok(!JSON.stringify(p).includes('typescript'));
 assert.deepEqual(service.apply({...context,planId:p.planId,selectedIds:all(p)}).editorPatch,{fontSize:15});
});
test('prototype keys, duplicate properties, executable syntax and non-JSON constructs are rejected without echoes',()=>{
 for(const text of ['{"__proto__":{"polluted":true}}','{"x":{"constructor":{}}}','{"prototype":1}','{"editor.fontSize":12,"editor.fontSize":20}','{editor:1}',"{'x':1}",'{"x":undefined}','{"x":(()=>42)()}','{"x":NaN}','{"x":0x10}','{"x":1_000}','{"x":1e999}','[1,,2]','{"x":"secret_DO_NOT_ECHO", bad:true}']){
  assert.throws(()=>parseImportJSONC(text),error=>error.code==='IMPORT_INVALID_JSONC'&&!error.message.includes('secret_DO_NOT_ECHO'));
 }assert.equal(Object.prototype.polluted,undefined);
});
test('strings containing comment markers and escaped quotes remain literal data',()=>{
 const value=parseImportJSONC('{"string":"https://example.test/a//b/*c*/\\\""}');assert.equal(value.string,'https://example.test/a//b/*c*/"');assert.equal(Object.getPrototypeOf(value),null);
});
test('parse limits bound UTF8 bytes, depth and tokens before constructing an AST',()=>{
 assert.throws(()=>parseImportJSONC('"'+'中'.repeat(IMPORT_LIMITS.bytes/2)+'"'),{code:'IMPORT_TOO_LARGE'});
 assert.throws(()=>parseImportJSONC('['.repeat(40)+'0'+']'.repeat(40)),{code:'IMPORT_COMPLEXITY'});
 assert.throws(()=>parseImportJSONC('['+Array(7000).fill('0').join(',')+']'),{code:'IMPORT_COMPLEXITY'});
});
test('unsupported editor semantics are skipped instead of silently approximated',t=>{
 const service=fixture(t);const p=service.preview({...context,settingsText:JSON.stringify({'editor.lineHeight':0,'editor.fontLigatures':'"ss01"','editor.wordWrap':'bounded','editor.renderWhitespace':'boundary','editor.fontSize':50,'editor.tabSize':3.5,'editor.formatOnSave':true,'files.trimTrailingWhitespace':true,'editor.guides.indentation':false})});
 assert.equal(p.unsupported.length,6);assert.equal(p.changes.length,3);assert.ok(p.changes.find(c=>c.target==='formatOnSave').notes[0].includes('JSON'));assert.ok(p.changes.find(c=>c.target==='trimTrailingWhitespace').notes[0].includes('.txt'));
});
test('pixel line height depends on explicitly selected font size; ratio values are not divided again',t=>{
 const service=fixture(t);let p=service.preview({...context,settingsText:'{"editor.lineHeight":24,"editor.fontSize":16}'});const height=p.changes.find(c=>c.target==='lineHeight');assert.equal(height.value,1.5);
 assert.throws(()=>service.apply({...context,planId:p.planId,selectedIds:[height.id]}),{code:'IMPORT_SELECTION'});assert.deepEqual(service.apply({...context,planId:p.planId,selectedIds:all(p)}).editorPatch,{fontSize:16,lineHeight:1.5});
 p=service.preview({...context,settingsText:'{"editor.lineHeight":1.8}'});assert.equal(p.changes[0].value,1.8);assert.deepEqual(p.changes[0].requires,[]);
});
test('imports only verified equivalent commands; seven app targets do not imply seven VS Code equivalents',t=>{
 const service=fixture(t);const p=service.preview({...context,keybindingsText:JSON.stringify([rule(quick,'cmd+shift+p'),rule(save,'cmd+shift+s'),rule(terminal,'cmd+shift+j'),rule('workbench.action.chat.newChat','cmd+n'),rule('workbench.action.chat.submit','cmd+enter'),rule('workbench.action.chat.cancel','escape'),rule('workbench.action.chat.history','cmd+k')])});
 assert.equal(p.availableTargets.length,7);assert.equal(p.changes.length,3);assert.equal(p.unsupported.length,4);assert.ok(p.unsupported.every(i=>i.code==='command'));
 assert.deepEqual(service.apply({...context,planId:p.planId,selectedIds:all(p)}).keyboardPatch,{searchFiles:'Meta+Shift+KeyP',saveFile:'Meta+Shift+KeyS',toggleTerminal:'Meta+Shift+KeyJ'});
});
test('when, args, chord and removal rules are never flattened into global bindings',t=>{
 const service=fixture(t);const p=service.preview({...context,keybindingsText:JSON.stringify([rule(save,'cmd+s',{when:'editorTextFocus && secretValue'}),rule(save,'cmd+s',{args:{secret:'do not echo'}}),rule(save,'cmd+k cmd+s'),rule('-'+save,'cmd+s'),rule('unknown-secret-command','cmd+l'),rule({weird:'value'},'cmd+k')])});
 assert.deepEqual(p.unsupported.map(i=>i.code),['conditional','arguments','chord','removal','command','command']);assert.equal(p.changes.length,0);assert.ok(!JSON.stringify(p).includes('secretValue'));assert.ok(!JSON.stringify(p).includes('do not echo'));assert.ok(!JSON.stringify(p).includes('unknown-secret-command'));
});
test('modifiers use target platform rules with no silent Ctrl/Command translation',t=>{
 const mac=fixture(t),win=fixture(t,{platform:'win32'});const a=mac.preview({...context,keybindingsText:JSON.stringify([rule(save,'ctrl+shift+s'),rule(quick,'cmd+[KeyP]')])});assert.equal(a.changes[0].value,'Control+Shift+KeyS');assert.equal(a.changes[1].value,'Meta+KeyP');
 const b=win.preview({...context,keybindingsText:JSON.stringify([rule(save,'cmd+s'),rule(quick,'ctrl+shift+p'),rule(terminal,'alt+f4')])});assert.equal(b.changes.length,1);assert.equal(b.changes[0].value,'Control+Shift+KeyP');assert.equal(b.unsupported[0].code,'platform');assert.equal(b.unsupported[1].code,'binding');
 assert.doesNotThrow(()=>validateBindings(win.apply({...context,planId:b.planId,selectedIds:all(b)}).keyboardPatch,'win32'));
});
test('conflicts are previewed; selected final state supports swaps and refuses collisions atomically',t=>{
 const service=fixture(t);const p=service.preview({...context,keybindingsText:JSON.stringify([rule(quick,'cmd+s'),rule(save,'cmd+p')])});assert.ok(p.changes.every(c=>c.conflicts.some(x=>x.reason==='existing-binding')));
 assert.throws(()=>service.apply({...context,planId:p.planId,selectedIds:[p.changes[0].id]}),{code:'IMPORT_CONFLICT'});
 const patch=service.apply({...context,planId:p.planId,selectedIds:all(p)});assert.deepEqual(patch.keyboardPatch,{searchFiles:'Meta+KeyS',saveFile:'Meta+KeyP'});
 const duplicate=service.preview({...context,keybindingsText:JSON.stringify([rule(save,'cmd+shift+s'),rule(save,'cmd+alt+s')])});assert.throws(()=>service.apply({...context,planId:duplicate.planId,selectedIds:all(duplicate)}),{code:'IMPORT_CONFLICT'});assert.equal(service.apply({...context,planId:duplicate.planId,selectedIds:[duplicate.changes[1].id]}).keyboardPatch.saveFile,'Meta+Alt+KeyS');
});
test('preview values cannot be tampered through returned objects; patches are single-use',t=>{
 const service=fixture(t);const p=service.preview({...context,settingsText:'{"editor.fontSize":16}'});p.changes[0].value=30;p.changes[0].target='formatOnSave';assert.deepEqual(service.apply({...context,planId:p.planId,selectedIds:all(p)}),{editorPatch:{fontSize:16},keyboardPatch:{}});assert.throws(()=>service.apply({...context,planId:p.planId,selectedIds:all(p)}),{code:'IMPORT_PLAN_EXPIRED'});
});
test('changed baseline, scope, expiry and evicted plans cannot be applied',t=>{
 let now=10;const service=fixture(t,{now:()=>now,ttlMs:1000});const preview=()=>service.preview({...context,settingsText:'{"editor.fontSize":16}'});
 let p=preview();assert.throws(()=>service.apply({...context,current:{editorSettings:{fontSize:17},keyboard:{}},planId:p.planId,selectedIds:all(p)}),{code:'IMPORT_PLAN_STALE'});
 p=preview();assert.throws(()=>service.apply({...context,scope:'other-data-dir',planId:p.planId,selectedIds:all(p)}),{code:'IMPORT_SCOPE_CHANGED'});
 p=preview();now+=1001;assert.throws(()=>service.apply({...context,planId:p.planId,selectedIds:all(p)}),{code:'IMPORT_PLAN_EXPIRED'});
 p=preview();for(let i=0;i<IMPORT_LIMITS.plans;i++)preview();assert.throws(()=>service.apply({...context,planId:p.planId,selectedIds:all(p)}),{code:'IMPORT_PLAN_EXPIRED'});
 p=preview();service.discard(p.planId);assert.throws(()=>service.apply({...context,planId:p.planId,selectedIds:all(p)}),{code:'IMPORT_PLAN_EXPIRED'});
});
test('selection ids, root types and current settings are validated, and no unselected setting is overwritten',t=>{
 const service=fixture(t);assert.throws(()=>service.preview({...context,settingsText:'[]'}),{code:'IMPORT_SETTINGS_SHAPE'});assert.throws(()=>service.preview({...context,keybindingsText:'{}'}),{code:'IMPORT_BINDINGS_SHAPE'});
 assert.throws(()=>service.preview({...context,current:{editorSettings:{fontSize:99}},settingsText:'{}'}),{code:'IMPORT_CURRENT_INVALID'});
 const p=service.preview({...context,settingsText:'{"editor.fontSize":16,"editor.minimap.enabled":false}'});assert.throws(()=>service.apply({...context,planId:p.planId,selectedIds:['invented']}),{code:'IMPORT_SELECTION'});assert.throws(()=>service.apply({...context,planId:p.planId,selectedIds:[p.changes[0].id,p.changes[0].id]}),{code:'IMPORT_SELECTION'});
 assert.deepEqual(service.apply({...context,planId:p.planId,selectedIds:[p.changes[1].id]}),{editorPatch:{minimap:false},keyboardPatch:{}});
});
