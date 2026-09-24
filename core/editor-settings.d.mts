export type EditorSettingsValue={fontFamily:string;fontSize:number;lineHeight:number;ligatures:boolean;indentWidth:number;insertSpaces:boolean;formatOnSave:boolean;trimTrailingWhitespace:boolean;wordWrap:'off'|'on';renderWhitespace:boolean;indentGuides:boolean;minimap:boolean};
export const DEFAULT_EDITOR_SETTINGS:Readonly<EditorSettingsValue>;
export const EDITOR_FORMAT_LANGUAGES:readonly string[];
export function validateEditorSettings(value:unknown):EditorSettingsValue;
export function resolveEditorSettings(value:unknown):EditorSettingsValue;
export function prepareEditorSave(args:{path:string;content:string;settings?:unknown}):{content:string;notices:string[];formatted:boolean;trimmed:boolean};
