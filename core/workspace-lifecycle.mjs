import { createHash, randomUUID } from "node:crypto";
const tables = ["sessions", "members", "sessionMembers", "memories", "memoryHistory", "approvals", "outcomes", "toolApprovals", "handoffs", "subtasks", "locks", "messages", "groupMessages", "groupTasks", "invites"];
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const optionalTables = new Set(["groupMessages", "groupTasks"]);
function rows(db, key) {
  // Optional feature tables may not exist in the released Hub. Do not install
  // that feature's schema as a side effect of deleting an unrelated workspace.
  if (db[key] === undefined && optionalTables.has(key)) return [];
  if (!Array.isArray(db[key])) throw Error(`工作区记录表无效：${key}`);
  return db[key];
}
const related = (db, workspaceId) => Object.fromEntries(tables.map(key => [key, rows(db,key).filter(v => v.workspaceId === workspaceId)]));
export function recoverWorkspaceDeletions(hub) {
  for (const deletion of hub.db.workspaceDeletions || []) {
    for (const name of deletion.transcripts) hub.store.removeFile(name);
    for (const name of deletion.artifacts || []) hub.store.removeFile(name);
    for (const key of hub.rawEntries.keys()) if (deletion.laneIds.some(id => key.startsWith(`${id}:`))) hub.rawEntries.delete(key);
  }
  if (hub.db.workspaceDeletions?.length) { hub.db.workspaceDeletions = []; hub.save(); }
}
export function workspaceLifecycle(hub, peer, method, a) {
  if (method === "workspace.delete.status") {
    const receipt = (hub.db.workspaceDeletionReceipts || []).find(r => r.previewId === a.previewId && r.ownerId === peer.id && r.workspaceId === a.workspaceId);
    return receipt ? {deleted:true,workspaceId:receipt.workspaceId,previewId:receipt.previewId} : {deleted:false};
  }
  const workspace = hub.workspace(peer, a.workspaceId);
  hub.deletionPreviews ??= new Map();
  const records = related(hub.db, workspace.id);
  const collaboration = hub.db.collaboration && Object.fromEntries(Object.entries(hub.db.collaboration).map(([key, rows]) => [key, rows.filter(v => v.teamId === workspace.id)]));
  const lanes = records.sessions.flatMap(s => s.lanes);
  const blockers = lanes.filter(l => ["running", "awaiting"].includes(l.status) || records.approvals.some(ap => ap.laneId === l.id && ap.status === "claimed"));
  const fingerprint = digest({ workspace, records, ...(collaboration ? { collaboration } : {}) });
  const counts = Object.fromEntries(tables.map(key => [key, records[key].length]));
  if (collaboration) for (const [key, rows] of Object.entries(collaboration)) counts[key] = rows.length;
  const transcripts = lanes.map(l => hub.logName(l));
  const inventory = { workspaceId:workspace.id, name:workspace.name, counts, sessions:records.sessions.map(s => ({id:s.id,title:s.title})), transcripts, blocked:blockers.map(l => ({laneId:l.id,owner:l.owner,status:l.status})), preservesLocalProject:true, retained:["本机项目与 Git 工作树", "Provider 自身历史与外部导出", "其他成员本机副本", "缺少身份范围索引的输入与文件草稿"] };
  if (method === "workspace.delete.preview") {
    for (const [id,p] of hub.deletionPreviews) if (p.expires <= Date.now()) hub.deletionPreviews.delete(id);
    if (hub.deletionPreviews.size >= 100) throw Error("删除预览过多，请稍后重试");
    const previewId = randomUUID(), expires = Date.now()+5*60000;
    hub.deletionPreviews.set(previewId,{ownerId:peer.id,workspaceId:workspace.id,fingerprint,expires});
    return {...inventory, previewId, expires};
  }
  const preview = hub.deletionPreviews.get(a.previewId);
  if (!preview || preview.ownerId !== peer.id || preview.workspaceId !== workspace.id || preview.expires <= Date.now()) throw Error("删除预览已失效，请重新预览");
  if (a.confirmation !== workspace.name) throw Error("请输入完整工作区名称确认删除");
  if (preview.fingerprint !== fingerprint) throw Error("工作区内容已变化，请重新预览删除范围");
  if (blockers.length) throw Error("仍有执行或审批等待结束确认，请停止并确认结束后重新预览");
  const previous = hub.db;
  const remaining = Object.fromEntries(tables.filter(key => hub.db[key] !== undefined).map(key => [key, rows(hub.db,key).filter(v => v.workspaceId !== workspace.id)]));
  const affectedIds = new Set([...records.members,...records.sessionMembers].filter(m => !m.host).map(m => m.id));
  const retainedIds = new Set([...remaining.members,...remaining.sessionMembers].map(m => m.id));
  const orphanIds = new Set([...affectedIds].filter(id => !retainedIds.has(id)));
  const journal = { id:randomUUID(),workspaceId:workspace.id,laneIds:lanes.map(l => l.id),transcripts,
    artifacts: (collaboration?.artifactVersions || []).filter(v => v.contentRef).map(v => `artifacts/${v.id}.json`) };
  const remainingCollaboration = collaboration ? { collaboration: Object.fromEntries(Object.entries(hub.db.collaboration).map(([key, rows]) => [key, rows.filter(v => v.teamId !== workspace.id)])) } : {};
  hub.db = {...hub.db,...remaining,...remainingCollaboration,workspaces:hub.db.workspaces.filter(w => w.id !== workspace.id),identities:hub.db.identities.filter(v => !orphanIds.has(v.peerId)),workspaceDeletions:[...(hub.db.workspaceDeletions || []),journal],workspaceDeletionReceipts:[...(hub.db.workspaceDeletionReceipts || []).slice(-499),{workspaceId:workspace.id,previewId:a.previewId,ownerId:peer.id,at:Date.now()}]};
  try { hub.save(); } catch (error) { hub.db=previous; throw error; }
  // Commit metadata removal before deleting files. A restart completes this exact
  // logical-name journal and cannot recreate deleted transcripts from cached lanes.
  hub.deletionPreviews.delete(a.previewId);
  for (const [nonce, challenge] of hub.identity.challenges) if (challenge.workspaceId === workspace.id) hub.identity.challenges.delete(nonce);
  for (const [ws,p] of hub.peers) if (!p.host && p.workspaceId === workspace.id) queueMicrotask(() => ws.close(1008,"工作区已删除"));
  recoverWorkspaceDeletions(hub);
  return {...inventory,deleted:true};
}
