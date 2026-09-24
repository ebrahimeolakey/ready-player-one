export type Entry = { id: string; role: string; text: string; at: string };
export type Lane = {
  id: string;
  ownerId: string;
  owner: string;
  provider: string;
  providerLabel?:string;
  status: string;
  entries: Entry[];
  files: string[];
  snapshot?: {ref:string; commit:string; at:string};
  activeRunId?:string;
  providerSessionId?:string;
  steering?:{id:string;text:string;status:string;message?:string}[];
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
  plan: { id: string; text: string; owner: string; done: boolean; status?:string; assigneeId?:string|null; assignee?:string|null; ownerId?:string; transferRequest?:{id:string;fromId:string;toId:string;status:string} }[];
  comments: {
    id: string;
    text: string;
    owner: string;
    at: string;
    anchor: string;
    status?:string; stale?:boolean; taskId?:string; location?:{path:string;startLine:number;endLine:number;commit:string};
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
  status: string;
  reviewer?: string;
};
export type State = {
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
  members: { id: string; name: string; host: boolean; workspaceId?:string; role?:string; online?:boolean }[];
  me?: { id: string; name: string; host: boolean; role?:string; roles?:Record<string,string> };
  toolApprovals?: {id:string;sessionId:string;laneId:string;owner:string;status:string;action:string;input:any}[];
  locks?: {id:string;workspaceId:string;sessionId:string;laneId:string;owner:string;ownerId:string;path:string;expires:number}[];
  messages?: {id:string;sessionId:string;owner:string;text:string;at:string}[];
  storage?:{encrypted:boolean;retentionDays:number|null;lastCleanupAt?:string};
  identity?:{configured:boolean;issuer?:string|null;audience:string};
  shared?: boolean;
  local: {
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
