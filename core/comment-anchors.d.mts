export type DiffRow={index:number;text:string;hunk:number;header:boolean;left:number|null;right:number|null};
export function diffRows(text:string):DiffRow[];
export function diffRange(text:string,args:{hunk:number;side:'left'|'right';startLine?:number;endLine?:number}):{startLine:number;endLine:number;rows:DiffRow[]};
