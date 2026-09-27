import { validateFile, storedBytes } from "./artifact-files.mjs";
import { randomUUID } from "node:crypto";
export function projectOutputs(
  hub,
  peer,
  method,
  a,
  { target, projectPath, post },
) {
  const db = hub.db.collaboration;
  if (method === "collab.output.track") {
    const { s, l } = hub.lane(peer, a);
    const project = target(hub, peer, "projects", s.projectId, true);
    if (project.teamId !== s.workspaceId) throw Error("项目不属于此会话");
    const path = projectPath(a.path);
    if (!path) throw Error("请选择产物文件");
    const existing = db.outputs.find(
      (o) => o.sessionId === s.id && o.laneId === l.id && o.path === path,
    );
    if (existing) return existing;
    const output = {
      id: randomUUID(),
      teamId: s.workspaceId,
      projectId: project.id,
      sessionId: s.id,
      laneId: l.id,
      workerId: peer.id,
      path,
      name: path.split("/").at(-1),
      at: new Date().toISOString(),
    };
    db.outputs.push(output);
    return output;
  }
  if (method === "collab.output.read") {
    const version = target(hub, peer, "artifactVersions", a.versionId);
    if (!version.outputId) throw Error("产物类型不匹配");
    const stored = hub.store.readJSON(`artifacts/${version.id}.json`);
    storedBytes(stored, version);
    return { ...version, ...stored };
  }
  if (method === "collab.output.approve") {
    const output = target(hub, peer, "outputs", a.outputId, true);
    const project = target(hub, peer, "projects", output.projectId, true);
    if (project.driUserId !== peer.id) throw Error("只有项目 DRI 可以审批产物");
    const version = target(hub, peer, "artifactVersions", a.versionId);
    if (version.outputId !== output.id || version.id !== output.previewVersionId || version.previewStatus !== "ready" || db.artifactVersions.filter(v=>v.outputId===output.id).at(-1)?.id !== version.id) throw Error("文件已更新，请先查看最新版本");
    if (version.approval?.by !== peer.id || version.approval?.hash !== version.hash) version.approval = {by:peer.id,at:new Date().toISOString(),hash:version.hash};
    output.acceptedVersionId = version.id;
    return version;
  }
  const output = target(
    hub,
    peer,
    "outputs",
    a.outputId,
    method !== "collab.output.read",
  );
  if (method === "collab.output.publish") {
    if (output.workerId !== peer.id) throw Error("只能发布本机产物");
    const { s, l } = hub.lane(peer, {
      sessionId: output.sessionId,
      laneId: output.laneId,
    });
    if (s.projectId !== output.projectId || s.status !== "active")
      throw Error("产物会话已改变");
    if (
      a.runId &&
      (a.runId !== l.activeRunId ||
        l.fencedRunId === a.runId ||
        l.stopRequested)
    )
      throw Error("产物执行已失效");
    const file = validateFile(a, output.path);
    const versions = db.artifactVersions.filter(
        (v) => v.outputId === output.id,
      ),
      contentHash = file.hash,
      latest = versions.at(-1);
    if (latest?.hash === contentHash) return latest;
    if (versions.length >= 2000) throw Error("产物版本已达上限");
    const version = {
      id: randomUUID(),
      teamId: output.teamId,
      projectId: output.projectId,
      sessionId: output.sessionId,
      laneId: output.laneId,
      outputId: output.id,
      artifactId: output.id,
      number: versions.length + 1,
      hash: contentHash,
      kind: file.kind, mime: file.mime, size: file.size, encoding: file.encoding,
      previewStatus: ["html","markdown"].includes(file.kind) ? "pending" : "ready",
      at: new Date().toISOString(),
      runId: a.runId || null,
    };
    version.contentRef = `artifacts/${version.id}.json`;
    hub.store.writeJSON(version.contentRef, { content: file.content, ...(file.encoding ? {encoding:file.encoding} : {}) });
    db.artifactVersions.push(version);
    if (version.previewStatus === "ready") output.previewVersionId = version.id;
    return version;
  }
  if (method === "collab.output.check") {
    const version = target(hub, peer, "artifactVersions", a.versionId);
    if (version.outputId !== output.id || version.hash !== a.hash)
      throw Error("产物版本不匹配");
    if (version.previewStatus !== "pending") return version;
    version.previewStatus = a.loaded === true ? "ready" : "failed";
    if (a.loaded === true) {
      const prior = db.artifactVersions.find(
        (v) => v.id === output.previewVersionId,
      );
      if (!prior || version.number > prior.number)
        output.previewVersionId = version.id;
      if (!prior) {
        const channel = db.channels.find(
          (c) => c.projectId === output.projectId,
        );
        if (channel)
          post(
            hub,
            channel,
            { type: "system", name: "产物" },
            `已共享产物：${output.name}`,
            { outputId: output.id, versionId: version.id },
          );
      }
    }
    return version;
  }
  throw Error("未知产物操作");
}
