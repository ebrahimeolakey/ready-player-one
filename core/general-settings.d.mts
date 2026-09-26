export type GeneralSettingsValue = {
  autoCheckUpdates: boolean;
  theme: 'dark' | 'light';
  collaboratorColors: boolean;
  layout: 'agent' | 'editor';
  conversationDensity: 'detailed' | 'compact';
  autoHideEmptyEditor: boolean;
  notificationsEnabled: boolean;
  notifyApprovals: boolean;
  notifyHandoffs: boolean;
  notifyUnknownOutcomes: boolean;
  trayIcon: boolean;
  completionSound: boolean;
};
export const DEFAULT_GENERAL_SETTINGS: Readonly<GeneralSettingsValue>;
export function validateGeneralSettings(value: unknown): GeneralSettingsValue;
export function resolveGeneralSettings(value: unknown): GeneralSettingsValue;
