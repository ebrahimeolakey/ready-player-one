import {createContext, useContext, useLayoutEffect, type ReactNode} from 'react';
import './theme.css';

export type AppearanceValue = {theme:'dark'|'light';collaboratorColors:boolean};
export const DEFAULT_APPEARANCE:AppearanceValue = {theme:'dark',collaboratorColors:true};
export const AppearanceContext = createContext<Partial<AppearanceValue> | undefined>(undefined);
export function useAppearance():AppearanceValue {
 const value=useContext(AppearanceContext);
 return {theme:value?.theme==='light'?'light':'dark',collaboratorColors:value?.collaboratorColors!==false};
}
/** Mount once around the application, including its modal/portal hosts. */
export function AppearanceProvider({value,children}:{value?:Partial<AppearanceValue>;children:ReactNode}) {
 const theme=value?.theme==='light'?'light':'dark';
 useLayoutEffect(()=>{
  const html=document.documentElement,previous=html.getAttribute('data-theme');
  html.setAttribute('data-theme',theme);
  return()=>{if(html.getAttribute('data-theme')===theme){if(previous===null)html.removeAttribute('data-theme');else html.setAttribute('data-theme',previous);}};
 },[theme]);
 return <AppearanceContext.Provider value={{theme,collaboratorColors:value?.collaboratorColors!==false}}>{children}</AppearanceContext.Provider>;
}

const avatarPalettes={
 dark:[['#325e51','#dcf5e9'],['#344f77','#dfebff'],['#604477','#f3e3ff'],['#704937','#ffecdf'],['#5b5832','#f8f0c6'],['#6c4057','#ffe2f0']],
 light:[['#dcefe5','#24533e'],['#dfebfb','#284f80'],['#efe3f7','#623879'],['#f9e6da','#7a4425'],['#efeccf','#59551c'],['#f6e0eb','#78384f']],
};
export function avatarColors(name:string,appearance:AppearanceValue) {
 if(!appearance.collaboratorColors)return appearance.theme==='light'?{background:'#e2e5e9',color:'#414852'}:{background:'#3b4047',color:'#e3e7ed'};
 let hash=0;for(const char of name.normalize('NFC'))hash=(Math.imul(hash,31)+(char.codePointAt(0)||0))>>>0;
 const [background,color]=avatarPalettes[appearance.theme][hash%avatarPalettes.dark.length];
 return {background,color};
}

export function terminalColors(theme:AppearanceValue['theme']) {
 return theme==='light'?{
  background:'#fafbfc',foreground:'#26323b',cursor:'#256b50',cursorAccent:'#ffffff',selectionBackground:'#cadff080',selectionInactiveBackground:'#e0e5eb80',
  black:'#303740',red:'#a62b2b',green:'#267046',yellow:'#80600b',blue:'#285eae',magenta:'#8040a1',cyan:'#14727e',white:'#c5cbd2',
  brightBlack:'#646e79',brightRed:'#bd3434',brightGreen:'#287d49',brightYellow:'#8a6900',brightBlue:'#246ac0',brightMagenta:'#9345b5',brightCyan:'#0b7e8b',brightWhite:'#eef1f5',
 }:{
  background:'#111111',foreground:'#d4d4d4',cursor:'#98d8c0',cursorAccent:'#111111',selectionBackground:'#46675980',selectionInactiveBackground:'#444a5080',
  black:'#25282d',red:'#dd7272',green:'#7fc395',yellow:'#d3ba77',blue:'#81abdf',magenta:'#c093d5',cyan:'#79c8d1',white:'#d4d4d4',
  brightBlack:'#8a929d',brightRed:'#f08b8b',brightGreen:'#9adbaa',brightYellow:'#ecd08b',brightBlue:'#9bc3f2',brightMagenta:'#d9a9ea',brightCyan:'#98e0e6',brightWhite:'#ffffff',
 };
}
