import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultBindings, validateBindings, matchesBinding, formatBinding, bindingFromEvent} from '../core/keybindings.mjs';
const event=(code,extras={})=>({code,metaKey:false,ctrlKey:false,altKey:false,shiftKey:false,...extras});
test('platform defaults match only exact modifiers and respect consumed, repeated and composing input',()=>{
 const mac=defaultBindings('darwin'),win=defaultBindings('win32');
 assert(matchesBinding(event('KeyK',{metaKey:true}),'searchSessions',mac,'darwin'));
 assert(!matchesBinding(event('KeyK',{ctrlKey:true}),'searchSessions',mac,'darwin'));
 assert(matchesBinding(event('KeyK',{ctrlKey:true}),'searchSessions',win,'win32'));
 for(const extras of [{altKey:true},{shiftKey:true},{repeat:true},{defaultPrevented:true},{isComposing:true},{keyCode:229},{nativeEvent:{isComposing:true}}])assert(!matchesBinding(event('KeyK',{metaKey:true,...extras}),'searchSessions',mac,'darwin'));
});
test('custom shortcuts replace defaults, can be disabled, and reset without leaving old bindings active',()=>{
 const custom=validateBindings({searchSessions:'Shift+Meta+KeyF'},'darwin');
 assert.equal(custom.searchSessions,'Meta+Shift+KeyF');
 assert(matchesBinding(event('KeyF',{metaKey:true,shiftKey:true}),'searchSessions',custom,'darwin'));
 assert(!matchesBinding(event('KeyK',{metaKey:true}),'searchSessions',custom,'darwin'));
 const disabled=validateBindings({...custom,searchSessions:''},'darwin');
 assert(!matchesBinding(event('KeyK',{metaKey:true}),'searchSessions',disabled,'darwin'));
 assert(matchesBinding(event('KeyK',{metaKey:true}),'searchSessions',validateBindings({},'darwin'),'darwin'));
});
test('conflicts, plain typing, native edit/menu commands, unknown actions and malformed settings are rejected',()=>{
 for(const input of [{sendPrompt:'Meta+KeyK'},{sendPrompt:'KeyB'},{sendPrompt:'Enter'},{sendPrompt:'Meta+KeyC'},{sendPrompt:'Meta+KeyR'},{sendPrompt:'Escape'},{typo:'Meta+KeyL'},{sendPrompt:'Meta+Meta+KeyL'},{sendPrompt:'Meta+Delete'},null,[]])assert.throws(()=>validateBindings(input,'darwin'));
 assert.throws(()=>validateBindings({sendPrompt:'Meta+Enter'},'win32'));
 assert.throws(()=>validateBindings({sendPrompt:'Control+Alt+F4'},'win32'));
 assert.equal(validateBindings({stopRun:''},'linux').stopRun,'');
});
test('capture uses physical key codes rather than shifted letters and ignores modifier-only or IME presses',()=>{
 assert.equal(bindingFromEvent(event('KeyL',{key:'L',metaKey:true,shiftKey:true})),'Meta+Shift+KeyL');
 assert.equal(bindingFromEvent(event('MetaLeft',{metaKey:true})),null);
 assert.equal(bindingFromEvent(event('KeyK',{isComposing:true,metaKey:true})),null);
 assert.equal(formatBinding('Meta+Shift+KeyL','darwin'),'⌘⇧L');
 assert.equal(formatBinding('Control+Shift+KeyL','win32'),'Ctrl+Shift+L');
 assert.equal(formatBinding('','darwin'),'未设置');
});
