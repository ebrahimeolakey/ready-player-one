export type ActivityKind='file'|'directory'|'unknown';
export type ActivityScope={path:string;kind:ActivityKind};
export type ActivitySource={source:'declared'|'open'|'changed';kind:ActivityKind;sessionId:string;sessionTitle:string;laneId:string;ownerId:string;owner:string;approvalId?:string;legacy?:boolean;expiresAt?:number};
export type ActivityEntry={key:string;path:string;workspaceId:string;workspace:string;kind:ActivityKind;sources:ActivitySource[]};
export type ActivityResult={entries:ActivityEntry[];counts:{files:number;directories:number;unknown:number};nextExpiry:number|null};
export type ActivitySnapshot={
 workspaces?:{id:string;name:string}[];
 me?:{sessionId?:string};
 sessions?:{id:string;workspaceId:string;title:string;status:string;lanes:{id:string;ownerId:string;owner:string;status:string;activeRunId?:string;files?:string[];fileScopes?:ActivityScope[];activity?:{fileScopes:ActivityScope[];expires:number};changedFiles?:{path:string}[];changesExpires?:number}[]}[];
 approvals?:{id:string;workspaceId:string;sessionId:string;laneId:string;ownerId:string;status:string;fileScopes?:ActivityScope[];files?:string[]}[];
};
export function activityView(snapshot:ActivitySnapshot,options?:{sessionIds?:string[];now?:number}):ActivityResult;
export function scheduleActivityExpiry(expiresAt:number|null,onExpire:()=>void,clock?:{now?:()=>number;setTimer?:(callback:()=>void,delay:number)=>unknown;clearTimer?:(id:any)=>void}):()=>void;
