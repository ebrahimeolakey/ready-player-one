import { useState } from "react";
import {
  Check,
  Monitor,
  FolderOpen,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import { Modal, type Call } from "./ui";
import { ProviderControls, type ProviderSelection } from "./ProviderControls";
import type { State } from "./types";
import type { Project } from "./project-types";

export function LocalSetup({
  state,
  project,
  call,
  onClose,
  onOpenSession,
  initial,
  onCreated,
  wizard,
}: {
  wizard?:{step:number;onStep:(step:number)=>void};
  initial?: {draftId?:string;name?:string;role?:string;provider?:string};
  onCreated?: (agent: {id:string;sessionId:string;sourceLaneId:string}) => Promise<void>;
  state: State;
  project: Project;
  call: Call;
  onClose: () => void;
  onOpenSession?: (id: string) => void;
}) {
  const [step, setLocalStep] = useState(wizard?.step || 0),
    [provider, setProvider] = useState(initial?.provider || state.local.accounts?.find(a=>a.authenticated && ["codex","claude"].includes(a.id))?.id || "codex"),
    [name, setName] = useState(initial?.name || "项目助手"),
    [selection, setSelection] = useState<ProviderSelection>({
      model: "",
      effort: "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [code, setCode] = useState(""),
    [created, setCreated] = useState(""),
    [registered, setRegistered] = useState<{id:string;sessionId:string;sourceLaneId:string} | null>(null),
    [requestKey, setRequestKey] = useState(() => crypto.randomUUID()),
    [role, setRole] = useState(initial?.role || "执行"),
    [existingSession, setExistingSession] = useState("");
  const setStep=(n:number)=>{setLocalStep(n);wizard?.onStep(n);};
  const templates=state.collaboration?.roleTemplates||[];
  const mapped = !!state.local.projectCheckouts?.[project.id];
  const account = state.local.accounts?.find((a) => a.id === provider),
    job = state.local.authJobs?.find((j) => j.id === provider),
    install = state.local.installations?.find((j) => j.id === provider);
  const ready = !!account?.authenticated;
  const existing = state.sessions.filter(s => s.workspaceId === project.teamId && !s.taskId && s.status === "active" && (!s.projectId || s.projectId === project.id)).flatMap(s => s.lanes.filter(l => l.ownerId === state.me?.id && l.provider === provider && !state.collaboration?.agents.some(a => a.sourceLaneId === l.id)).map(l => ({sessionId:s.id,laneId:l.id,title:s.title})));
  const source = existing.find(l => l.laneId === existingSession);
  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={wizard?`Cindy 带你开始 · 第 ${step+2} / 8 步`:"连接本机 AI"} close={onClose}>
      <div className="local-setup">
        {wizard?<div className="guide-dots" aria-label={`第 ${step+2} 步，共 8 步`}>{Array.from({length:8},(_,i)=><i key={i} className={i<=step+1?"active":""}/>)}</div>:<nav aria-label="设置步骤">
          {["这台电脑", "AI 与模型", "开始协作"].map((label, i) => (
            <button
              key={label}
              disabled={i > step || !!created}
              className={i === step ? "active" : ""}
              onClick={() => setStep(i)}
            >
              <span>{i < step ? <Check size={12} /> : i + 1}</span>
              {label}
            </button>
          ))}
        </nav>}
        {step === 0 && (
          <>
            <Monitor size={30} />
            <h2>让 AI 在这台电脑上工作</h2>
            <p>使用本机账号和项目文件，执行过程分享给团队。</p>
            <div className="setup-check">
              <span>本机执行服务</span>
              <strong>{state.local.online ? "已连接" : "连接中…"}</strong>
            </div>
            <button
              className="button full"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  call("collab.checkout.map", { projectId: project.id }),
                )
              }
            >
              <FolderOpen size={16} />
              {mapped ? "工作文件夹已连接" : "选择项目工作文件夹"}
            </button>
            <small>已内置电脑连接服务，无需另装 Computer CLI。保持应用和电脑在线。</small>
            <details><summary>想用同事的电脑？</summary><p>让同事通过团队邀请加入，在自己的电脑上完成同样的接入。然后在任务的协作成员中邀请他的 Agent。</p></details>
            <button
              className="button primary full"
              disabled={!state.local.online || !mapped || busy}
              onClick={() => setStep(1)}
            >
              下一步：选择 AI <ArrowRight size={15} />
            </button>
          </>
        )}
        {step === 1 && (
          <>
            <h2>使用哪个 AI？</h2>
            <p>沿用你的账号。模型可随时在会话中切换。</p>
            <div className="setup-provider-options">
              {["codex", "claude"].map((id) => (
                <button
                  key={id}
                  aria-pressed={provider === id}
                  onClick={() => {
                    setProvider(id);
                    setSelection({ model: "", effort: "" });
                    setError("");
                  }}
                >
                  {id === "codex" ? "Codex" : "Claude Code"}
                  <small>
                    {state.local.accounts?.find((a) => a.id === id)
                      ?.authenticated
                      ? "已登录"
                      : "连接账号"}
                  </small>
                </button>
              ))}
            </div>
            <div className="setup-check">
              <span>
                {account?.authenticated
                  ? "账号已连接"
                  : account?.available
                    ? "需要登录"
                    : "需要安装"}
              </span>
              <div>
                {!account?.available ? (
                  <button
                    className="button"
                    disabled={busy || install?.status === "running"}
                    onClick={() =>
                      void run(() => call("tools.install", { id: provider }))
                    }
                  >
                    {install?.status === "running" ? "安装中…" : "安装"}
                  </button>
                ) : (
                  !ready && (
                    <button
                      className="button"
                      disabled={busy || job?.status === "running"}
                      onClick={() =>
                        void run(() => call("accounts.login", { id: provider }))
                      }
                    >
                      登录
                    </button>
                  )
                )}
                <button
                  aria-label="重新检测本机账号"
                  className="icon-button"
                  disabled={busy}
                  onClick={() => void run(() => call("accounts.refresh"))}
                >
                  <RefreshCw size={14} />
                </button>
              </div>
            </div>
            {install && <small>{install.message}</small>}
            {job && !ready && (
              <div className="setup-auth">
                <small>
                  {job.status === "running"
                    ? "请在官方页面完成授权"
                    : job.status === "error"
                      ? "登录失败，可重试"
                      : job.status}
                </small>
                <pre>{job.log}</pre>
                {job.url && (
                  <button
                    className="button"
                    onClick={() =>
                      void run(() => call("accounts.open", { id: provider }))
                    }
                  >
                    打开授权页面
                  </button>
                )}
                {provider === "claude" && job.status === "running" && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        await call("accounts.code", { id: provider, code });
                        setCode("");
                      });
                    }}
                  >
                    <input
                      type="password"
                      aria-label="官方授权码"
                      placeholder="仅在官方页面要求时填写授权码"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                    <button disabled={!code.trim() || busy}>提交</button>
                  </form>
                )}
              </div>
            )}
            <label className="setup-model-label">
              模型
              <ProviderControls
                key={provider}
                disabled={!ready}
                value={selection}
                onChange={setSelection}
                models={state.local.modelCatalogs?.[provider]}
                loadModels={() =>
                  call("provider.models", { provider, projectId: project.id })
                }
              />
            </label>
            <small>
              {selection.model
                ? `将使用 ${selection.model}`
                : "默认使用该 Provider 的默认模型，也可以展开选择。"}
            </small>
            <button
              className="button primary full"
              disabled={!ready || busy}
              onClick={() => setStep(2)}
            >
              下一步 <ArrowRight size={15} />
            </button>
          </>
        )}
        {step === 2 &&
          (!created ? (
            <>
              <h2>接入一位 AI 搭档</h2>
              {initial?.name!=="Cindy" && <label>从分工模板开始<select aria-label="角色模板" defaultValue="" disabled={!!registered} onChange={e=>{const t=templates.find(t=>t.id===e.target.value);if(t){setName(t.name);setRole(t.role);}}}><option value="">自己填写</option>{templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><small>模板只是起点，名字和职责都可以修改。</small></label>}
              {!wizard&&<label>会话<select disabled={!!registered || !!initial?.draftId || initial?.name === "Cindy"} className="full" aria-label="接入会话" value={source?.laneId || ""} onChange={e=>setExistingSession(e.target.value)}><option value="">新建独立会话</option>{existing.map(s=><option key={s.laneId} value={s.laneId}>{s.title}</option>)}</select></label>}
              {!wizard&&<small>每个会话是一位独立 Agent。同一个账号可以接入多位。</small>}
              <label>
                名称
                <input
                  className="full"
                  aria-label="AI 名称"
                  value={name}
                  disabled={!!registered || initial?.name === "Cindy"}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>负责什么<textarea rows={2} className="full" aria-label="Agent 分工" disabled={!!registered} value={role} maxLength={3000} placeholder="例如：调研、写方案、开发或复核" onChange={e=>setRole(e.target.value)}/></label>
              <small>{initial?.name==="Cindy"?"新建的 Cindy 引导对话仅你可见。":"团队能看到共享工作；个人账号和未共享文件留在本机。"}</small>
              <small>
                {provider === "codex" ? "Codex" : "Claude Code"} ·{" "}
                {selection.model || "默认模型"} · {project.name}
              </small>
              <button
                className="button primary full"
                disabled={busy || !name.trim() || !ready || !mapped}
                onClick={() =>
                  void run(async () => {
                    const agent = registered || await call(initial?.draftId?"collab.onboarding.draft.commit":"collab.agent.register", {
                      ...(initial?.draftId?{draftId:initial.draftId,model:selection.model,effort:selection.effort}:{}),
                      teamId: project.teamId,
                      projectId: project.id,
                      ...(source ? {sessionId:source.sessionId,laneId:source.laneId} : {provider}),
                      name,
                      role: role.trim() || "执行",
                      requestKey,
                    });
                    setRegistered(agent);
                    await call("lane.options", {
                      sessionId: agent.sessionId,
                      laneId: agent.sourceLaneId,
                      ...selection,
                    });
                    await call("collab.agent.configure", {agentId:agent.id,policy:{trigger:"mentions",projectIds:[project.id],autoTasks:false,maxTurnsPerHour:20}});
                    if (onCreated) await onCreated(agent);
                    setCreated(agent.sessionId);
                  })
                }
              >
                {busy ? "连接中…" : "连接并加入项目"}
              </button>
            </>
          ) : (
            <>
              <Check size={30} />
              <h2>{name} 已准备好</h2>
              <p>已加入 {project.name}。同事加入团队后，也能把自己的 Agent 带进来。</p>
              <button className="button full" onClick={()=>{setCreated("");setRegistered(null);setStep(1);setName("新搭档");setRole("执行");setExistingSession("");setRequestKey(crypto.randomUUID());}}>继续接入一个 Agent</button>
              <button className="button primary full" onClick={onClose}>
                进入项目群
              </button>
              {onOpenSession && (
                <button
                  className="button full"
                  onClick={() => {
                    onClose();
                    onOpenSession(created);
                  }}
                >
                  打开 AI 会话
                </button>
              )}
            </>
          ))}
        {wizard&&<button className="inline-link" disabled={busy} onClick={()=>setStep(step-1)}>上一步</button>}
        {error && (
          <p role="alert" className="room-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
