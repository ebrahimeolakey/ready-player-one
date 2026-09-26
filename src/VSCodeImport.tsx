import {useEffect, useRef, useState} from 'react';
import {formatBinding, KEYBOARD_ACTIONS} from '../core/keybindings.mjs';
import type {Call} from './ui';
import './vscode-import.css';

type Change = {
  id: string; kind: 'editor'|'keyboard'; target: string; value: string|number|boolean;
  notes: string[]; requires: string[];
  conflicts: {target: string; changeId?: string; reason: string}[];
};
type Preview = {
  planId: string; changes: Change[]; expiresAt: number;
  unsupported: {source: string; index: number; label: string}[];
};
const labels: Record<string, string> = {
  fontFamily:'字体', fontSize:'字号', lineHeight:'行高', ligatures:'字体连字',
  indentWidth:'缩进宽度', insertSpaces:'使用空格缩进', wordWrap:'自动换行',
  renderWhitespace:'显示空白', indentGuides:'缩进参考线', minimap:'代码缩略图',
  formatOnSave:'保存时格式化', trimTrailingWhitespace:'清理行尾空白',
  ...Object.fromEntries(KEYBOARD_ACTIONS.map(action => [action.id, action.label])),
};
const errorMessage = (cause:unknown) => (cause instanceof Error ? cause.message : String(cause))
  .replace(/^Error invoking remote method 'rpo:invoke': Error: /, '');

export function VSCodeImport({kind, call, os='darwin'}: {kind:'settings'|'keybindings'; call:Call; os?:string}) {
  const [preview, setPreview] = useState<Preview|null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const current = useRef<Preview|null>(null), mounted = useRef(false), invoke = useRef(call);
  invoke.current = call;
  const discard = (id: string) => { void invoke.current('settings.vscode.discard', {planId:id}).catch(() => {}); };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (current.current) discard(current.current.planId); current.current = null; };
  }, []);
  async function choose() {
    setBusy(true); setMessage(''); setError('');
    try {
      const next: Preview|null = await call('settings.vscode.preview', {kind});
      if (!mounted.current) { if (next) discard(next.planId); return; }
      if (next) {
        if (current.current) discard(current.current.planId);
        current.current = next; setPreview(next); setSelected([]);
      }
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }
  function cancel() {
    if (current.current) discard(current.current.planId);
    current.current = null; setPreview(null); setSelected([]); setError('');
  }
  async function apply() {
    if (!preview || !selected.length) return;
    setBusy(true); setMessage(''); setError('');
    try {
      const result = await call('settings.vscode.apply', {planId:preview.planId, selectedIds:selected});
      if (!mounted.current) return;
      current.current = null; setPreview(null); setSelected([]); setMessage(`已导入 ${result.imported} 项`);
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }
  const valueLabel = (change:Change) => change.kind === 'keyboard' ? formatBinding(String(change.value), os)
    : typeof change.value === 'boolean' ? change.value ? '开启' : '关闭'
    : change.target === 'wordWrap' ? change.value === 'on' ? '开启' : '关闭' : String(change.value);
  return <section className="vscode-import" aria-label="导入 VS Code 配置">
    <header><button className="button" disabled={busy} onClick={() => void choose()}>{busy ? '处理中…' : preview ? '重新选择文件' : '从 VS Code 导入'}</button>
      <span className="muted">{kind === 'settings' ? 'settings.json' : 'keybindings.json'}</span></header>
    {preview && <div className="vscode-import-preview">
      <p>选择要导入的项目</p>
      <fieldset disabled={busy}>
        {preview.changes.map(change => <div className="vscode-import-item" key={change.id}>
          <label><input type="checkbox" checked={selected.includes(change.id)} onChange={event => {
            setSelected(ids => event.target.checked ? [...ids, change.id] : ids.filter(id => id !== change.id)); setError('');
          }}/><span>{labels[change.target] || change.target}</span><strong>{valueLabel(change)}</strong></label>
          {!!change.requires.length && <small>需同时选择：{change.requires.map(id => labels[preview.changes.find(item => item.id === id)?.target || ''] || '关联设置').join('、')}</small>}
          {!!change.conflicts.length && <small>键位冲突：{[...new Set(change.conflicts.map(conflict => labels[conflict.target] || conflict.target))].join('、')}</small>}
          {!!change.notes.length && <details><summary>说明</summary>{change.notes.map(note => <small key={note}>{note}</small>)}</details>}
        </div>)}
        {!preview.changes.length && <p>没有可导入的项目</p>}
      </fieldset>
      {!!preview.unsupported.length && <details className="vscode-import-skipped"><summary>已跳过 {preview.unsupported.length} 项</summary>
        <ul>{preview.unsupported.map((item,index) => <li key={index}>第 {item.index + 1} 项：{item.label}</li>)}</ul>
      </details>}
      <small className="muted">仅导入兼容设置，不导入账号或扩展。预览 5 分钟有效。</small>
      <footer><button className="button" disabled={busy} onClick={cancel}>取消</button><button className="button primary" disabled={busy || !selected.length} onClick={() => void apply()}>导入 {selected.length} 项</button></footer>
    </div>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
