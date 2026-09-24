export type Entry = { id: string; role: string; text: string; at: string };
export type Lane = {
  id: string;
  ownerId: string;
  owner: string;
  provider: string;
  status: string;
  entries: Entry[];
  files: string[];
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
  plan: { id: string; text: string; owner: string; done: boolean }[];
  comments: {
    id: string;
    text: string;
    owner: string;
    at: string;
    anchor: string;
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
  members: { id: string; name: string; host: boolean }[];
  me?: { id: string; name: string; host: boolean };
  shared?: boolean;
  local: {
    paths: Record<string, string>;
    sessionPaths: Record<string, string>;
    providers: { id: string; available: boolean; version: string }[];
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
  };
};
export type RPO = {
  invoke: <T = any>(
    method: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
  subscribe: (cb: (state: State) => void) => () => void;
};
declare global {
  interface Window {
    rpo: RPO;
  }
}
