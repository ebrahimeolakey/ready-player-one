import { resolveGeneralSettings } from '../../core/general-settings.mjs';

// Original 18-point monochrome window mark at 2x. No external file/network load.
const TRAY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAVUlEQVR4nO3VwREAMAQFUUXov9WkBQfBlz3s/c0wmLvbpNoBgABVgU5R+qBXowH0Hyh7ifeBxo0MkCQodPoBqYGin30nKDNAgNpAr9MFtdUOAAQouwtvYDHc7+F/KwAAAABJRU5ErkJggg==';
const categorySetting = { approval:'notifyApprovals', handoff:'notifyHandoffs', unknown:'notifyUnknownOutcomes' };
const terminal = new Set(['done','error','interrupted','needs_handoff']);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 500;
const key = (...parts) => JSON.stringify(parts);

/** Electron capabilities are injected. Construct/apply tray settings after app.ready. */
export class DesktopNotifications {
  constructor({ Notification, Tray, Menu, nativeImage, beep = () => {},
    showWindow = () => {}, quit = () => {}, isFocused = () => false,
    preferences, active = true, platform = process.platform, onError = () => {},
    notificationLifetimeMs = 120000 } = {}) {
    Object.assign(this, { Notification, Tray, Menu, nativeImage, beep, showWindow, quit, isFocused, platform, onError });
    this.preferences = resolveGeneralSettings(preferences);
    this.active = Boolean(active);
    this.disposed = false;
    this.lastError = null;
    this.notifications = new Set();
    this.notificationLifetimeMs = Math.min(300000, Math.max(100, Number(notificationLifetimeMs) || 120000));
    this.resetConnection();
    this.updateTray();
  }
  report(error) {
    // Platform denial must not interrupt execution, sync, or the shutdown path.
    const failure = error instanceof Error ? error : Error('桌面通知不可用');
    this.lastError = failure.message;
    try { this.onError(failure); } catch {}
  }
  run(callback) {
    try { const value = callback(); if (value?.catch) value.catch(error => this.report(error)); }
    catch (error) { this.report(error); }
  }
  getState() { return {active:this.active && !this.disposed,trayActive:Boolean(this.tray),lastError:this.lastError}; }
  setPreferences(value) {
    if (this.disposed) return;
    this.lastError = null;
    this.preferences = resolveGeneralSettings(value);
    for (const record of [...this.notifications]) if (!this.allowed(record.category)) this.closeNotification(record);
    this.updateTray();
  }
  setActive(value) {
    if (this.disposed || this.active === Boolean(value)) return;
    this.active = Boolean(value);
    // Suppressed events are history, never a backlog to emit after verification.
    this.baselineNext = true;
    if (!this.active) this.closeNotifications();
    this.updateTray();
  }
  resetConnection() {
    this.closeNotifications();
    this.connection = null;
    this.identityId = null;
    this.baselineNext = true;
    this.seen = new Set();
    this.finished = new Set();
  }
  allowed(category) {
    return !this.disposed && this.active && this.preferences.notificationsEnabled &&
      (!categorySetting[category] || this.preferences[categorySetting[category]]);
  }
  observeSnapshot(snapshot, { connection, active = this.active } = {}) {
    if (this.disposed) return;
    this.setActive(active);
    if (!connection || !id(snapshot?.me?.id)) return;
    if (connection !== this.connection || snapshot.me.id !== this.identityId) {
      this.resetConnection();
      this.connection = connection;
      this.identityId = snapshot.me.id;
    }
    const fresh = { approval:[], handoff:[], unknown:[] };
    const observe = (category, eventId, target) => {
      if (this.seen.has(eventId)) return;
      this.seen.add(eventId);
      if (!this.baselineNext && this.active) fresh[category].push(target);
    };
    for (const [kind, approvals] of [['run',snapshot.approvals],['tool',snapshot.toolApprovals]]) {
      for (const approval of approvals || []) {
        if (approval.status === 'pending' && id(approval.id)) {
          observe('approval',key('approval',kind,approval.id),{sessionId:approval.sessionId,laneId:approval.laneId});
        }
      }
    }
    for (const session of snapshot.sessions || []) {
      for (const lane of session.lanes || []) {
        const runId = lane.handoffNeeded?.runId;
        if (lane.status === 'needs_handoff' && id(runId) && runId === lane.activeRunId) {
          observe('handoff',key('handoff',session.id,lane.id,runId),{sessionId:session.id,laneId:lane.id});
        }
        // Historical terminal runs must not replay completion sound after restart.
        if (this.baselineNext && lane.ownerId === this.identityId && terminal.has(lane.status) && id(lane.activeRunId)) {
          this.finished.add(key(session.id,lane.activeRunId));
        }
      }
    }
    for (const outcome of snapshot.outcomes || []) {
      if (outcome.status === 'unknown' && id(outcome.id)) {
        // An explicit later resolution back to unknown is a new actionable version.
        const version = Number.isSafeInteger(outcome.version) && outcome.version >= 0 ? outcome.version : 0;
        observe('unknown',key('unknown',outcome.id,version),{sessionId:outcome.sessionId,laneId:outcome.laneId});
      }
    }
    this.baselineNext = false;
    for (const [category, events] of Object.entries(fresh)) {
      if (!events.length) continue;
      const count = events.length;
      const body = category === 'approval' ? `有 ${count} 项操作等待审批` :
        category === 'handoff' ? `有 ${count} 个 Agent 等待接管` : `有 ${count} 项执行结果待确认`;
      this.notify(category,body);
    }
  }
  /** Trusted local RunCoordinator.onFinish callback, never inferred from snapshots. */
  finish(result, { connection, identityId = connection?.state?.me?.id, active = this.active } = {}) {
    if (this.disposed) return false;
    this.setActive(active);
    if (!this.connection || connection !== this.connection || identityId !== this.identityId ||
        !id(result?.runId) || !id(result.sessionId) || !['done','error','interrupted'].includes(result.status)) return false;
    const eventId = key(result.sessionId,result.runId);
    if (this.finished.has(eventId)) return false;
    this.finished.add(eventId);
    if (!this.active) return false;
    if (result.status === 'done' && this.preferences.completionSound) this.run(() => this.beep());
    // Failures/interruption are classified by authoritative Hub handoff/outcome
    // records; a generic error notice would bypass those category preferences.
    if (result.status === 'done') this.notify('completion','Agent 已完成任务');
    return true;
  }
  notify(category, body) {
    if (!this.allowed(category)) return;
    try {
      if (this.isFocused() || !this.Notification?.isSupported()) return;
      const notification = new this.Notification({title:'头号玩家',body,silent:true});
      const record = { notification, category, closed:false, timer:null };
      record.onClick = () => { if (!record.closed && !this.disposed && this.active) this.run(() => this.showWindow()); this.closeNotification(record); };
      record.onClose = () => this.closeNotification(record,false);
      record.onFailed = (_event, error) => { this.report(Error(typeof error === 'string' ? error : '系统拒绝显示通知')); this.closeNotification(record); };
      notification.on('click',record.onClick);
      notification.on('close',record.onClose);
      notification.on('failed',record.onFailed);
      this.notifications.add(record);
      record.timer = setTimeout(() => this.closeNotification(record),this.notificationLifetimeMs);
      record.timer.unref?.();
      // Bound native resources even if the OS never emits dismissal callbacks.
      while (this.notifications.size > 32) this.closeNotification(this.notifications.values().next().value);
      try { notification.show(); } catch (error) { this.closeNotification(record); throw error; }
    } catch (error) { this.report(error); }
  }
  closeNotification(record, close = true) {
    if (!record || record.closed) return;
    record.closed = true;
    clearTimeout(record.timer);
    this.notifications.delete(record);
    record.notification.removeListener('click',record.onClick);
    record.notification.removeListener('close',record.onClose);
    record.notification.removeListener('failed',record.onFailed);
    if (close) this.run(() => record.notification.close());
  }
  closeNotifications() { for (const record of [...(this.notifications || [])]) this.closeNotification(record); }
  updateTray() {
    if (this.disposed || !this.active || !this.preferences.trayIcon) { this.destroyTray(); return; }
    if (this.tray) return;
    try {
      const image = this.nativeImage.createFromBuffer(Buffer.from(TRAY_PNG,'base64'),{scaleFactor:2});
      if (image.isEmpty()) throw Error('菜单栏图标无法加载');
      if (this.platform === 'darwin') image.setTemplateImage(true);
      this.tray = new this.Tray(image);
      const tray = this.tray;
      this.trayClick = () => { if (this.tray === tray && !this.disposed && this.active) this.run(() => this.showWindow()); };
      this.tray.on('click',this.trayClick);
      this.tray.setToolTip('头号玩家');
      this.tray.setContextMenu(this.Menu.buildFromTemplate([
        {label:'显示窗口',click:this.trayClick},
        {type:'separator'},
        {label:'退出头号玩家',click:() => { if (this.tray === tray && !this.disposed && this.active) this.run(() => this.quit()); }},
      ]));
    } catch (error) { this.destroyTray(); this.report(error); }
  }
  destroyTray() {
    const tray = this.tray;
    this.tray = null;
    if (!tray) return;
    tray.removeListener('click',this.trayClick);
    this.trayClick = null;
    this.run(() => tray.destroy());
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.closeNotifications();
    this.destroyTray();
    this.connection = null;
    this.identityId = null;
    this.seen.clear();
    this.finished.clear();
  }
}
