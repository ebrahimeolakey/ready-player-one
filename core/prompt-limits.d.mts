export const PROMPT_LIMITS: Readonly<{codePoints:number;utf8Bytes:number}>;
export const DRAFT_LIMITS: Readonly<{codePoints:number;utf8Bytes:number}>;
export const SUMMARY_LIMIT:number;
export const CONTEXT_LIMIT:number;
export function promptStats(value:string):{codePoints:number;utf8Bytes:number};
export function promptProblem(value:unknown,options?:{allowEmpty?:boolean;limits?:{codePoints:number;utf8Bytes:number}}):string;
export function validatePrompt(value:string,options?:{allowEmpty?:boolean;limits?:{codePoints:number;utf8Bytes:number}}):string;
export function summarizePrompt(value:string,limit?:number):{kind:string;codePoints:number;utf8Bytes:number;limit:number;truncated:boolean;text:string;display:string};
export function providerPrompt(session:any,memories:any[],original:string):string;
