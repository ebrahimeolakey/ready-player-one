import { AgentSettings } from "./AgentSettings";
import { Bot, MessageSquare, ArrowRight } from "lucide-react";
import type { State } from "./types";
import { Modal, type Call } from "./ui";


const labels: Record<string, string> = {
  proposed: "待接入", ready: "待开始", running: "执行中",
  review: "待验收", accepted: "已完成", failed: "失败",
  interrupted: "已中断", declined: "暂不参与",
};

// A member is an identity. Its source session and task sessions are destinations,
// not the member's default navigation target.
export function AgentMember({ call, state, agentId, projectId, close, onDiscussion, onOpenTask, onOpenSession }: {
  call?:Call;
  state: State;
  agentId: string;
  projectId?: string;
  close: () => void;
  onDiscussion: () => void;
  onOpenTask: (id: string) => void;
  onOpenSession?: (id: string) => void;
}) {

  const data = state.collaboration;
  const agent = data?.agents.find(a => a.id === agentId);
  if (!agent) return null;
  const identities = new Set([agent.id, ...data!.agents.filter(a => a.parentAgentId === agent.id).map(a => a.id)]);
  const tasks = data!.tasks.filter(t => t.teamId === agent.teamId &&
    (identities.has(t.agentId || "") || t.requestedAgentId === agent.id));
  const source = state.sessions.find(s => s.workspaceId === agent.teamId &&
    (s.id === agent.sessionId || s.lanes.some(l => l.id === agent.sourceLaneId)));
  const project = data!.projects.find(p => p.id === projectId);
  const owner = agent.workerId === state.me?.id ? "我" :
    state.members.find(m => m.id === agent.workerId && m.workspaceId === agent.teamId)?.name || "团队成员";
  const messages = data!.channelMessages.filter(m => m.author.type === "agent" &&
    identities.has(m.author.id || "") && data!.channels.some(c => c.id === m.channelId && c.projectId === projectId)).slice(-3);
  return <Modal title="AI 成员" close={close} drawer>
    <div className="agent-member" data-agent-id={agent.id}>
      <header className="agent-member-identity">
        <Bot size={28}/><div><h2>{agent.name}</h2><p>{owner}的 Agent · {agent.provider === "claude" ? "Claude Code" : "Codex"}</p></div>
      </header>
      <p className="agent-member-role">{agent.role || "执行任务"} · {agent.online ? "持有人在线" : "持有人离线"}</p>
      {call&&<AgentSettings key={agent.id} state={state} agentId={agent.id} call={call} onOpenSession={id=>{close();onOpenSession?.(id);}}/>}
      <section aria-label="群聊中的 Agent">
        <h3>项目群</h3>
        <button className="agent-member-link" onClick={onDiscussion}>
          <MessageSquare size={17}/><span>{project?.name || "当前项目"}<small>回到群聊</small></span><ArrowRight size={16}/>
        </button>
        {messages.map(m => <blockquote key={m.id}>{m.text}</blockquote>)}
        {!messages.length && <p className="agent-member-empty">还没有在这个群里发言</p>}
      </section>
      <section aria-label="Agent 共享会话">
        <h3>共享会话 <small>{tasks.length}</small></h3>
        {tasks.map(t => <button className="agent-member-link" key={t.id} onClick={() => { close(); onOpenTask(t.id); }}>
          <MessageSquare size={17}/><span>{t.goal}<small>{data!.projects.find(p => p.id === t.projectId)?.name} · {labels[t.status] || t.status}</small></span><ArrowRight size={16}/>
        </button>)}
        {!tasks.length && <p className="agent-member-empty">还没有参与任务。在任务里添加这位 Agent，即可一起工作。</p>}
      </section>
      <section aria-label="Agent 原始会话">
        <h3>原始会话</h3>
        {source && onOpenSession ? <button className="agent-member-link" onClick={() => { close(); onOpenSession(source.id); }}>
          <MessageSquare size={17}/><span>打开 Agent 会话<small>{source.title}</small></span><ArrowRight size={16}/>
        </button> : <p className="agent-member-empty">原始会话暂不可访问，共享任务仍可单独查看。</p>}
      </section>
    </div>
  </Modal>;
}
