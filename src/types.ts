export type ProviderFailure = {version:1;source:"codex"|"claude"|"acp"|"openai-compatible";kind:"usage_limit"|"rate_limit"|"authentication"|"billing"|"network"|"server"|"context_limit"|"budget_limit"|"invalid_request"|"tool"|"other";code:string;httpStatus?:number};
export type UsageSnapshot = {
  version:1; source:'codex'|'claude'|'acp'|'openai-compatible';
  context:{usedTokens:number|null;limitTokens:number|null;basis:'provider-context'|'last-request-input'};
  cumulative:null|{scope:'provider-session'|'run'|'turn';includesSubagents:boolean|null;inputTokens:number|null;outputTokens:number|null;totalTokens:number|null;cachedInputTokens:number|null;cacheWriteInputTokens:number|null;reasoningOutputTokens:number|null};
  cost:null|{amount:number;currency:string;scope:'provider-session'|'run'|'turn';kind:'estimate'|'reported'};
};
export type LaneUsage = UsageSnapshot & {runId:string;sequence:number;updatedAt:string};
export type FileScope = { path: string; kind: "file" | "directory" | "unknown" };
export type OverlapEvidence = { type: "path" | "plan-path" | "plan-step" | "task-keywords" | "lock"; current?: FileScope & {source:string;planId?:string}; other?: FileScope & {source:string;planId?:string}; planIds?:string[]; terms?:string[]; text?:string };
export type OverlapDetail = { sessionId:string; sessionTitle:string; laneId:string; ownerId:string; owner:string; files:string[]; kind:"overlapping"|"adjacent"|"lock"; confidence:"high"|"advisory"; currentBranch:string|null; otherBranch:string|null; branchRelation:"same"|"different"|"unknown"; planIds:string[]; evidence:OverlapEvidence[]; algorithm:"deterministic-v1"; advisory:true; reason:string; lockId?:string; expires?:number };
export type Entry = { id: string; role: string; text: string; at: string };
export type ModelConfiguration = { model: string | null; effort: string | null };
export type Lane = {
  id: string;
  ownerId: string;
  owner: string;
  provider: string;
  providerLabel?:string;
  configuration?: ModelConfiguration & { updatedAt: string };
  runConfiguration?: {runId:string;requested:ModelConfiguration;requestedAt:string;reported?:ModelConfiguration & {sequence:number;at:string}};
  status: string;
  entries: Entry[];
  files: string[];
  snapshot?: {ref:string; commit:string; at:string};
  activeRunId?:string;
  providerSessionId?:string;
  usage?:LaneUsage;
  failure?:ProviderFailure;
  handoffNeeded?:{runId:string;reason:ProviderFailure;at:string;lastConfirmedSnapshot:{ref:string;commit:string;at:string}|null};
  activity?:{fileScopes:FileScope[];branch:string|null;planIds:string[];at:string;expires:number};
  changesExpires?:number;
  steering?:{id:string;text:string;status:string;message?:string;runId?:string;restoredAt?:string}[];
  queue?:{id:string;prompt:string;status:string}[];
  diff?: string;
  changedFiles?: { path: string; status: string }[];
};
export type Session = {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  branch: string;
  status: string;
  owner: string;
  at: string;
  lanes: Lane[];
  plan: { id: string; text: string; owner: string; done: boolean; status?:string; assigneeId?:string|null; assignee?:string|null; ownerId?:string; fileScopes?:FileScope[]; history?:{actorId:string;actor:string;action:string;at:string;note?:string;previous?:{assigneeId?:string;status?:string}}[]; transferRequest?:{id:string;fromId:string;toId:string;status:string} }[];
  comments: {
    id: string;
    text: string;
    owner: string;
    at: string;
    anchor: string;
    status?:string; stale?:boolean; taskId?:string; location?:{path:string;startLine:number;endLine:number;commit:string;hash?:string;blob?:string;side?:string;kind?:string;excerpt?:string}; transcript?:{laneId:string;entryId:string;hash:string;at:string};
  }[];
  diff: string;
  files: { path: string; status: string }[];
};
export type Approval = {
  id: string;
  workspaceId: string;
  sessionId: string;
  laneId: string;
  ownerId: string;
  owner: string;
  provider: string;
  providerLabel?:string;
  prompt: string;
  mode: string;
  files: string[];
  overlaps: string[];
  fileScopes?:FileScope[];
  planIds?:string[];
  branch?:string;
  overlapDetails?:OverlapDetail[];
  overlapCheckedAt?:string;
  status: string;
  reviewer?: string;
};
export type Outcome = {
  id:string;runId:string;workspaceId:string;sessionId:string;laneId:string;ownerId:string;owner:string;provider:string;
  prompt:string;dispatchAt:string;at:string;reason:string;lastOutput:string|null;
  dispatches:{approvalId:string;providerRequestId:string;action:string;input:unknown;at:string;reviewer:string|null;reviewedAt:string|null}[];
  observations:{itemId:string;phase:string;text:string;at:string}[];
  status:'unknown'|'succeeded'|'failed';version:number;
  history:{requestId:string;version:number;status:'unknown'|'succeeded'|'failed';evidence:string;ownerId:string;owner:string;at:string}[];
};
export type State = {
  outcomes?: Outcome[];
  workspaces: { id: string; name: string; branch: string; remote: string }[];
  sessions: Session[];
  memories: {
    id: string;
    workspaceId: string;
    title: string;
    text: string;
    owner: string;
    retired: boolean;
  }[];
  approvals: Approval[];
  members: { id: string; name: string; host: boolean; workspaceId?:string; sessionId?:string; role?:string; online?:boolean }[];
  me?: { id: string; name: string; host: boolean; sessionId?:string; role?:string; roles?:Record<string,string> };
  toolApprovals?: {id:string;sessionId:string;laneId:string;owner:string;status:string;action:string;input:any}[];
  locks?: {id:string;workspaceId:string;sessionId:string;laneId:string;owner:string;ownerId:string;path:string;expires:number}[];
  messages?: {id:string;sessionId:string;owner:string;text:string;at:string}[];
  storage?:{encrypted:boolean;retentionDays:number|null;lastCleanupAt?:string};
  identity?:{configured:boolean;issuer?:string|null;audience:string};
  shared?: boolean;
  local: {
    referenceIssues?:{workspaceId:string;sessionId?:string;message:string}[];
    keyboard?:Record<string,string>;
    modelCatalogs?:Record<string,import("./ProviderControls").ProviderModel[]>;
    laneOptions?: Record<string,{model?:string;effort?:string}>;
    update?:import("./UpdatePanel").UpdateState;
    runIssues?:{sessionId:string;runId:string;message:string}[];
    sync?: Record<string, {status:string; message?:string; files?:string[]; commit?:string; at?:string}>;
    syncSessions?: Record<string, boolean>;
    paths: Record<string, string>;
    sessionPaths: Record<string, string>;
    lanePaths?:Record<string,string>;
    providers: { id: string; name?:string; available: boolean; version: string }[];
    online: boolean;
    remote: boolean;
    dataDir: string;
    name: string;
    accounts?: {
      id: string;
      available: boolean;
      authenticated: boolean;
      status: string;
      label: string;
      version: string;
      plan?: string;
    }[];
    authJobs?: { id: string; status: string; log: string; url?: string }[];
    installations?: { id: string; status: string; message: string }[];
    tunnel?: {
      status: string;
      url?: string;
      message: string;
      installed: boolean;
    };
    accountLoading?: boolean;
    appVersion?: string;
    platform?: string;
    os?:string;
  };
};
export type RPO = {
  invoke: <T = any>(
    method: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
  subscribe: (cb: (state: State) => void) => () => void;
  subscribeTerminal: (cb:(event:any)=>void)=>()=>void;
  subscribeDictation: (cb:(event:any)=>void)=>()=>void;
  subscribeBrowser: (cb:(event:any)=>void)=>()=>void;
};
declare global {
  interface Window {
    rpo: RPO;
  }
}
