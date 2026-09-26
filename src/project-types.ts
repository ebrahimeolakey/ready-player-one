export type Project = {
  id: string;
  teamId: string;
  name: string;
  parentProjectId: string | null;
  repository: string | null;
  subPath: string;
  branch: string;
  driUserId: string;
};
export type ProjectMessage = {
  id: string;
  channelId: string;
  seq: number;
  author: { type: string; id?: string; name: string };
  text: string;
  at: string;
  taskId?: string;
  versionId?: string;
  anchor?: string;
};
export type ProjectTask = {
  id: string;
  teamId: string;
  projectId: string;
  channelId: string;
  goal: string;
  acceptance: string;
  artifactPath: string;
  driUserId: string;
  status: string;
  revision: number;
  generation: number;
  workerId?: string;
  workerOnline?: boolean;
  execution?: string;
  agentId?: string;
  sessionId?: string;
  laneId?: string;
  runId?: string;
  previewVersionId?: string;
  acceptedVersionId?: string;
  kind?: string;
  proposalError?: string;
  controllers: { userId: string; revokedAt?: string }[];
};
export type ArtifactVersion = {
  id: string;
  teamId: string;
  taskId: string;
  number: number;
  runId: string;
  generation: number;
  hash: string;
  kind: "html" | "markdown";
  previewStatus: string;
  content?: string;
};
export type CollaborationState = {
  projects: Project[];
  channels: {
    id: string;
    teamId: string;
    projectId: string;
    name: string;
    seq: number;
  }[];
  channelMessages: ProjectMessage[];
  agents: {
    id: string;
    teamId: string;
    name: string;
    role: string;
    provider: string;
    workerId: string;
  }[];
  tasks: ProjectTask[];
  artifactVersions: ArtifactVersion[];
  artifactComments: {
    id: string;
    taskId: string;
    versionId: string;
    anchor: string;
    text: string;
    createdBy: string;
  }[];
};
