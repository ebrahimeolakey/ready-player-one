export type EditPosition={path:string;hash:string;startLine:number;endLine:number;phase:'pending'|'completed';toolId:string;source:'codex'|'claude'};
export type VisibleEditPosition=EditPosition & {owner:string;ownerId:string;laneId:string;sessionId:string;expires:number;runId:string;sequence:number};
export function validateEditPositions(args:unknown):EditPosition[];
export function visibleEditPositions(state:unknown,document:{workspaceId:string;path:string;hash:string},now?:number):VisibleEditPosition[];
