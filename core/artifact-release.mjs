import { storedBytes } from "./artifact-files.mjs";
export function artifactRelease(hub, peer, a, { target }) {
  const version = target(hub, peer, "artifactVersions", a.versionId);
  const item = version.taskId
    ? target(hub, peer, "tasks", version.taskId, true)
    : target(hub, peer, "outputs", version.outputId, true);
  const project = target(hub, peer, "projects", item.projectId, true);
  const dri = version.taskId ? item.driUserId : project.driUserId;
  if (peer.id !== dri) throw Error("只有 DRI 可以发布已审批产物");
  if (
    item.acceptedVersionId !== version.id ||
    (version.taskId && item.status !== "accepted") ||
    version.approval?.by !== dri ||
    version.approval.hash !== version.hash
  )
    throw Error("该版本尚未由当前 DRI 审批");
  const stored = hub.store.readJSON(`artifacts/${version.id}.json`);
  storedBytes(stored, version);
  return {
    version: { ...version, ...stored },
    project,
    path: item.artifactPath || item.path,
  };
}
