import { TeamConfiguration } from "./TeamConfiguration";
import type { State } from "./types";
import type { Project } from "./project-types";
import type { Call } from "./ui";
import { Bot, Check, UserPlus, Monitor, ArrowRight } from "lucide-react";
import { useState } from "react";
export const teamRoleNames: Record<string, string> = {
  owner: "管理员",
  editor: "协作者",
  commenter: "评论者",
  viewer: "查看者",
};
export function AccessSummary({ scope = "workspace" }: { scope?: string }) {
  return (
    <div className="access-summary">
      <strong>
        {scope === "workspace"
          ? "可见范围：整个团队"
          : "可见范围：仅此共享会话"}
      </strong>
      <p>
        {scope === "workspace"
          ? "团队成员可查看这个团队的项目讨论、任务、Agent 共享会话和已发布产物。"
          : "受邀者可查看此会话的执行记录及已共享内容，不能查看项目群和其他会话。"}
      </p>
      <small>
        账号凭据、未共享的本机文件不会交给同事。远程执行需由 Agent
        持有人接入；控制权单独授权。
      </small>
    </div>
  );
}
export function TeamSpace({
  state,
  project,
  call,
  onInvite,
  onAdd,
  onOpenTask,
  onOpenAgent,
  onStart,
}: {
  state: State;
  project: Project;
  call: Call;
  onInvite?: () => void;
  onAdd: () => void;
  onOpenTask?: (id: string) => void;
  onOpenAgent: (id: string) => void;
  onStart: () => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const me = state.me!,
    members = state.members.filter(
      (m) => m.workspaceId === project.teamId && !m.sessionId,
    ),
    agents = (state.collaboration?.agents || []).filter(
      (a) =>
        a.teamId === project.teamId &&
        !a.taskId &&
        (!a.projectId || a.projectId === project.id),
    );
  const mine = agents.filter((a) => a.workerId === me.id),
    others = members.filter((m) => m.id !== me.id),
    mapped = state.local.projectCheckouts?.[project.id];
  const owner = me.host || me.roles?.[project.teamId] === "owner",
    editor = owner || me.roles?.[project.teamId] === "editor";
  const pending = (state.collaboration?.tasks || []).filter(
    (t) =>
      t.projectId === project.id &&
      t.status === "proposed" &&
      t.requestedAgentId &&
      mine.some((a) => a.id === t.requestedAgentId),
  );
  async function change(memberId: string, role: string) {
    setBusy(true);
    setError("");
    try {
      await call("member.role", {
        workspaceId: project.teamId,
        memberId,
        role,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="team-space" aria-label="成员与 Agent">
      <header>
        <div>
          <h2>把你的团队和 AI 带进来</h2>
          <p>每个人连接自己的电脑与账号，在同一个项目协作。</p>
        </div>
        {onInvite && (
          <button onClick={onInvite}>
            <UserPlus size={15} />
            邀请同事
          </button>
        )}
      </header>
      <div className="team-onboarding" aria-label="团队上手清单">
        <button disabled={!onInvite} onClick={onInvite}>
          <span>{others.length ? <Check size={16} /> : 1}</span>
          <strong>邀请同事</strong>
          <small>
            {others.length
              ? `${others.length} 位已加入`
              : onInvite
                ? "发送团队邀请，对方从「加入」进入"
                : "请管理员发送团队邀请"}
          </small>
        </button>
        <button disabled={!editor} onClick={onAdd}>
          <span>{mapped ? <Check size={16} /> : 2}</span>
          <strong>连接我的电脑</strong>
          <small>
            {mapped ? "工作文件夹已连接" : "各自选择本机的项目目录"}
          </small>
        </button>
        <button disabled={!editor} onClick={onAdd}>
          <span>{mine.length ? <Check size={16} /> : 3}</span>
          <strong>接入我的 Agent</strong>
          <small>
            {mine.length
              ? `已接入 ${mine.length} 位 · 可继续添加`
              : "Codex / Claude · 每个会话一位 Agent"}
          </small>
        </button>
        <button onClick={onStart}>
          <span>4</span>
          <strong>一起完成任务</strong>
          <small>打开任务板，邀请同事的 Agent 参与分工</small>
        </button>
      </div>
      {pending.length > 0 && (
        <div className="team-pending">
          <strong>等待你接入 · {pending.length}</strong>
          {pending.map((t) => (
            <button key={t.id} onClick={() => onOpenTask?.(t.id)}>
              {agents.find((a) => a.id === t.requestedAgentId)?.name}：{t.goal}
              <ArrowRight size={14} />
            </button>
          ))}
        </div>
      )}
      <TeamConfiguration state={state} teamId={project.teamId} call={call}/>
      <AccessSummary />
      {error && <p role="alert">{error}</p>}
      <div className="team-member-grid">
        {members.map((m) => {
          const list = agents.filter((a) => a.workerId === m.id);
          return (
            <article className="team-member" key={m.id}>
              <header>
                <div>
                  <strong>
                    {m.name}
                    {m.id === me.id ? "（我）" : ""}
                  </strong>
                  <small>
                    {m.online ? "在线" : "离线"} ·{" "}
                    {teamRoleNames[m.role || "viewer"]}
                  </small>
                </div>
                {owner && !m.host && m.id !== me.id && (
                  <select
                    aria-label={`${m.name}的团队权限`}
                    disabled={busy}
                    value={m.role}
                    onChange={(e) => void change(m.id, e.target.value)}
                  >
                    {Object.entries(teamRoleNames).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
              </header>
              {list.map((a) => (
                <button
                  className="team-agent"
                  key={a.id}
                  onClick={() => onOpenAgent(a.id)}
                >
                  <Bot size={20} />
                  <span>
                    <strong>{a.name}</strong>
                    <small>
                      {a.role} ·{" "}
                      {a.provider === "codex" ? "Codex" : "Claude Code"}
                    </small>
                    <small>
                      <Monitor size={11} />{" "}
                      {m.id === me.id ? "我的电脑" : `${m.name}的电脑`} ·{" "}
                      {a.online ? "已连接" : "持有人离线"}
                    </small>
                  </span>
                  <ArrowRight size={14} />
                </button>
              ))}
              {!list.length && (
                <p>
                  {m.id === me.id
                    ? "接入你的第一位 Agent"
                    : "等待同事连接电脑并接入 Agent"}
                </p>
              )}
              {m.id === me.id && editor && (
                <button onClick={onAdd}>＋ 接入一个 Agent</button>
              )}
            </article>
          );
        })}
      </div>
      <details className="team-permissions">
        <summary>谁能看、谁能操作</summary>
        <table>
          <thead>
            <tr>
              <th>权限</th>
              <th>查看共享内容</th>
              <th>讨论与评论</th>
              <th>接入 Agent / 分工</th>
              <th>管理成员</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["查看者", "✓", "—", "—", "—"],
              ["评论者", "✓", "✓", "—", "—"],
              ["协作者", "✓", "✓", "✓", "—"],
              ["管理员", "✓", "✓", "✓", "✓"],
            ].map((row) => (
              <tr key={row[0]}>
                {row.map((v, i) => (
                  <td key={i}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          当前按团队隔离项目。此团队内的项目对全体团队成员可见；需要不同可见范围时请创建另一个团队。仅受邀会话的成员不会获得项目访问权。
        </p>
      </details>
    </section>
  );
}
