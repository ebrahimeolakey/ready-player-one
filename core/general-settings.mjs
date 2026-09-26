export const DEFAULT_GENERAL_SETTINGS = Object.freeze({
  autoCheckUpdates: true,
  restoreLastSession: true,
  openChatsAsEditorTabs: true,
  theme: 'dark',
  collaboratorColors: true,
  layout: 'agent',
  reviewControlLocation: 'breadcrumb',
  conversationDensity: 'detailed',
  autoHideEmptyEditor: true,
  notificationsEnabled: true,
  notifyApprovals: true,
  notifyHandoffs: true,
  notifyUnknownOutcomes: true,
  trayIcon: false,
  completionSound: false,
});
const choices = {reviewControlLocation: ['breadcrumb', 'floating'], theme: ['dark', 'light'], layout: ['agent', 'editor'], conversationDensity: ['detailed', 'compact']};
export function validateGeneralSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !Object.hasOwn(DEFAULT_GENERAL_SETTINGS, key))) {
    throw Error('通用设置格式无效');
  }
  const settings = {...DEFAULT_GENERAL_SETTINGS, ...value};
  for (const key of Object.keys(DEFAULT_GENERAL_SETTINGS)) {
    if (Object.hasOwn(choices, key) ? !choices[key].includes(settings[key]) : typeof settings[key] !== 'boolean') {
      throw Error(`通用设置值无效：${key}`);
    }
  }
  return settings;
}
export function resolveGeneralSettings(value) {
  try { return validateGeneralSettings(value || {}); }
  catch { return {...DEFAULT_GENERAL_SETTINGS}; }
}
