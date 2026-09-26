import {createContext, useContext, useEffect, useState} from 'react';
import {DEFAULT_GENERAL_SETTINGS, resolveGeneralSettings, validateGeneralSettings, type GeneralSettingsValue} from '../core/general-settings.mjs';
import type {Call} from './ui';
import './general-settings.css';

export const GeneralSettingsContext = createContext<Partial<GeneralSettingsValue> | undefined>(undefined);
export const useGeneralSettings = () => resolveGeneralSettings(useContext(GeneralSettingsContext));

export function GeneralSettings({settings, call, error}: {settings?: Partial<GeneralSettingsValue>; call: Call; error?: string|null}) {
  const [draft, setDraft] = useState(() => resolveGeneralSettings(settings));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const signature = JSON.stringify(resolveGeneralSettings(settings));
  useEffect(() => { setDraft(JSON.parse(signature)); }, [signature]);
  const update = <K extends keyof GeneralSettingsValue>(key: K, value: GeneralSettingsValue[K]) => {
    setDraft(current => ({...current, [key]: value})); setMessage('');
  };
  const toggle = (key: keyof GeneralSettingsValue, label: string, disabled = false) => (
    <label><span>{label}</span><input type="checkbox" checked={draft[key] === true} disabled={disabled}
      onChange={event => update(key, event.target.checked as never)}/></label>
  );
  async function save(value = draft) {
    setBusy(true); setMessage('');
    try {
      const result = await call('settings.general.save', {settings: validateGeneralSettings(value)});
      if (result) { setDraft(resolveGeneralSettings(result)); setMessage('已保存'); }
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="general-settings">
    {error && <p role="alert" className="general-settings-error">系统通知 / 托盘不可用：{error}</p>}
    <form onSubmit={event => {event.preventDefault(); void save();}}>
      <fieldset disabled={busy}><legend>界面</legend>
        <label><span>主题</span><select value={draft.theme} onChange={event => update('theme', event.target.value as GeneralSettingsValue['theme'])}>
          <option value="dark">深色</option><option value="light">浅色</option>
        </select></label>
        {toggle('collaboratorColors', '协作者颜色')}
        <label><span>会话布局</span><select value={draft.layout} onChange={event => update('layout', event.target.value as GeneralSettingsValue['layout'])}>
          <option value="agent">对话优先</option><option value="editor">编辑器优先</option>
        </select></label>
        <label><span>对话密度</span><select value={draft.conversationDensity} onChange={event => update('conversationDensity', event.target.value as GeneralSettingsValue['conversationDensity'])}>
          <option value="detailed">详细</option><option value="compact">紧凑</option>
        </select></label>
        <label><span>Git 审阅按钮</span><select value={draft.reviewControlLocation} onChange={event => update('reviewControlLocation', event.target.value as GeneralSettingsValue['reviewControlLocation'])}>
          <option value="breadcrumb">路径栏</option><option value="floating">浮动条</option>
        </select></label>
        {toggle('openChatsAsEditorTabs', '聊天作为编辑器标签')}
        {toggle('autoHideEmptyEditor', '隐藏空编辑器')}
        {toggle('restoreLastSession', '启动时打开上次会话')}
      </fieldset>
      <fieldset disabled={busy}><legend>通知</legend>
        {toggle('notificationsEnabled', '系统通知')}
        {toggle('notifyApprovals', '等待审批', !draft.notificationsEnabled)}
        {toggle('notifyHandoffs', '任务接管', !draft.notificationsEnabled)}
        {toggle('notifyUnknownOutcomes', '结果待确认', !draft.notificationsEnabled)}
        {toggle('completionSound', '完成提示音')}
        {toggle('trayIcon', '菜单栏 / 托盘图标')}
      </fieldset>
      <fieldset disabled={busy}><legend>更新</legend>
        {toggle('autoCheckUpdates', '启动时检查更新')}
      </fieldset>
      <footer><span role="status">{message}</span><div>
        <button className="button" type="button" disabled={busy} onClick={() => void save({...DEFAULT_GENERAL_SETTINGS})}>恢复默认</button>
        <button className="button primary" disabled={busy}>保存</button>
      </div></footer>
    </form>
  </section>;
}
