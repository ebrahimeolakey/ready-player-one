import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_GENERAL_SETTINGS, resolveGeneralSettings, validateGeneralSettings} from '../core/general-settings.mjs';

test('general settings keep explicit opt-ins off and reject malformed or prototype keys', () => {
  assert.equal(DEFAULT_GENERAL_SETTINGS.completionSound, false);
  assert.equal(DEFAULT_GENERAL_SETTINGS.trayIcon, false);
  assert.deepEqual(validateGeneralSettings({}), {...DEFAULT_GENERAL_SETTINGS});
  for (const value of [null, [], false, {layout:'vscode'}, {conversationDensity:'hidden'}, {notificationsEnabled:'false'},
    {autoCheckUpdates:0}, {completionSound:null}, {constructor:true}, {toString:true}, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => validateGeneralSettings(value));
  }
  const saved = validateGeneralSettings({notificationsEnabled:false, notifyApprovals:true, layout:'editor', conversationDensity:'compact'});
  assert.equal(saved.notifyApprovals, true, 'master switch must not erase category preferences');
  assert.deepEqual(resolveGeneralSettings(JSON.parse(JSON.stringify(saved))), saved);
  const defaults = resolveGeneralSettings({notificationsEnabled:'bad'});
  defaults.trayIcon = true;
  assert.equal(resolveGeneralSettings(undefined).trayIcon, false, 'callers must receive independent defaults');
});
