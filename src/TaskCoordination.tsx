import { useState } from "react";
import { GitBranch, ArrowRightLeft, Plus, Check, Play } from "lucide-react";
import type { State, Session } from "./types";
import type { Call } from "./ui";
import { Modal } from "./ui";

type Handoff = { id:string;sessionId:string;laneId:string;targetLaneId:string;fromId:string;from:string;toId:string;to:string;status:string;reason:string;checkpoint?:{snapshot:{commit:string};summary:string;offline:boolean} };
type ChildTask = { id:string;sessionId:string;parentLaneId:string;laneId?:string;ownerId:string;owner:string;title:string;status:string;baseCommit:string;candidate?:{commit:string;diff:string};requiredCheckIds:string[];integrationCommit?:string };
type ExtendedState = State & { handoffs?:Handoff[];subtasks?:ChildTask[] };
type CheckResult = { id:string;passed:boolean;exitCode:number;output:string;commit:string };
type Review = { id:string;candidateCommit?:string;diff?:string;status?:string;checks?:CheckResult[];integrationChecks?:CheckResult[];integrationCommit?:string;message?:string;details?:string;files?:string[] };
const labels:Record<string,string> = {requested:"待接收",running:"执行中",review:"待审阅",candidate:"待检查",checked:"检查通过",failed:"检查失败",integrated:"已集成",cancelled:"已取消",ready:"可接管",accepted:"已接管",rejected:"已拒绝",conflict:"有冲突",stale:"版本已更新"};
export function TaskCoordination({state,session,call}:{state:State;session:Session;call:Call}) {
  const shared = state as ExtendedState, me = state.me?.id;
  const role = state.me?.roles?.[session.workspaceId] || (state.me?.host ? "owner" : "viewer");
  const canEdit = ["owner","editor"].includes(role);
  const own = session.lanes.filter(l => l.ownerId === me);
  const others = session.lanes.filter(l => l.ownerId !== me);
  const handoffs = (shared.handoffs || []).filter(h => h.sessionId === session.id && ["requested","ready"].includes(h.status));
  const tasks = (shared.subtasks || []).filter(t => t.sessionId === session.id);
  const [showSpawn,setShowSpawn] = useState(false), [showHandoff,setShowHandoff] = useState(false);
  const [parent,setParent] = useState(""), [source,setSource] = useState(""), [target,setTarget] = useState("");
  const [title,setTitle] = useState(""), [prompt,setPrompt] = useState(""), [checks,setChecks] = useState("");
  const [busy,setBusy] = useState(""), [message,setMessage] = useState(""), [review,setReview] = useState<Review|null>(null);
  const [offlineConsent,setOfflineConsent] = useState<Record<string,boolean>>({});
  const params = {sessionId:session.id,workspaceId:session.workspaceId};
  async function run(key:string,method:string,args:Record<string,unknown>) {
    setBusy(key); setMessage("");
    try { return await call(method,{...params,...args}); }
    catch(error) { setMessage(error instanceof Error ? error.message : String(error)); return null; }
    finally { setBusy(""); }
  }
  async function receive(h:Handoff) {
    const result = await run(h.id,"handoff.receive",{id:h.id,acknowledgeUnconfirmedWork:offlineConsent[h.id] === true});
    if (result) setMessage(result.status === "accepted" ? "已创建接力任务，等待执行审批。" : result.message || labels[result.status] || "请检查同步结果");
  }
  return <>
    <details className="rail-section" open={handoffs.length > 0 || undefined}>
      <summary><ArrowRightLeft size={12}/> 接力与子任务 <span>{tasks.filter(t=>!["integrated","cancelled"].includes(t.status)).length || ""}</span></summary>
      {canEdit && <div className="comment-actions">
        <button disabled={!own.length || !!busy} onClick={()=>{setParent(own[0]?.id || "");setShowSpawn(true);}}><Plus size={12}/> 拆分子任务</button>
        <button disabled={!own.some(l=>!["running","awaiting"].includes(l.status)) || !others.length || !!busy} onClick={()=>{setSource(others[0]?.id || "");setTarget(own.find(l=>!["running","awaiting"].includes(l.status))?.id || "");setShowHandoff(true);}}>请求接力</button>
      </div>}
      {handoffs.map(h => {
        const from = session.lanes.find(l=>l.id===h.laneId) as (Session["lanes"][number] & {offlineSince?:string}) | undefined;
        const online = state.members.some(m=>m.id===h.fromId && m.online!==false && (!m.workspaceId || m.workspaceId===session.workspaceId));
        return <article className="approval-card" key={h.id}>
          <strong>{h.from} → {h.to}</strong><small>{labels[h.status]} · {h.reason}</small>
          {h.checkpoint && <small>快照 {h.checkpoint.snapshot.commit.slice(0,8)}</small>}
          {canEdit && h.fromId===me && h.status==="requested" && <div className="comment-actions">
            <button disabled={!!busy} onClick={()=>run(h.id,"handoff.prepare",{id:h.id})}>停止并交接</button>
            <button disabled={!!busy} onClick={()=>run(h.id,"handoff.reject",{id:h.id})}>拒绝</button>
          </div>}
          {canEdit && h.toId===me && <>
            {h.status==="requested" && !online && from?.offlineSince && <label className="small-note"><input type="checkbox" checked={!!offlineConsent[h.id]} onChange={e=>setOfflineConsent({...offlineConsent,[h.id]:e.target.checked})}/> 从最近快照继续；离线未同步工作可能不包含在内。</label>}
            <div className="comment-actions">
              <button disabled={!!busy || (h.status!=="ready" && !offlineConsent[h.id])} onClick={()=>receive(h)}>同步并接管</button>
              <button disabled={!!busy} onClick={()=>run(h.id,"handoff.cancel",{id:h.id})}>取消</button>
            </div>
          </>}
        </article>;
      })}
      {tasks.map(task => {
        const parentLane = session.lanes.find(l=>l.id===task.parentLaneId), child = session.lanes.find(l=>l.id===task.laneId);
        const done = child && !["running","awaiting"].includes(child.status);
        return <article className="approval-card" key={task.id}>
          <strong><GitBranch size={12}/> {task.title}</strong><small>{task.owner} · {labels[task.status] || task.status}</small>
          {task.integrationCommit && <small>{task.integrationCommit.slice(0,8)}</small>}
          {canEdit && <div className="comment-actions">
            {task.ownerId===me && done && task.status!=="cancelled" && <button disabled={!!busy} onClick={async()=>{const result=await run(task.id,"tasks.review",{id:task.id});if(result)setReview({...result,id:task.id});}}>审阅成果</button>}
            {(task.ownerId===me || parentLane?.ownerId===me) && !["integrated","cancelled"].includes(task.status) && <button disabled={!!busy} onClick={()=>run(task.id,"subtask.cancel",{id:task.id})}>取消</button>}
          </div>}
        </article>;
      })}
      {busy && <small role="status">正在处理…</small>}
      {message && <p role="status" className="small-note">{message}</p>}
    </details>
    {showSpawn && <Modal title="拆分子任务" close={()=>!busy&&setShowSpawn(false)}>
      {message && <p role="alert" className="small-note">{message}</p>}
      <form onSubmit={async e=>{e.preventDefault();const result=await run("spawn","tasks.spawn",{parentLaneId:parent,title,prompt,checkCommands:checks.split("\n").map(v=>v.trim()).filter(Boolean)});if(result){setShowSpawn(false);setTitle("");setPrompt("");setChecks("");setMessage("子任务已创建，等待执行审批。");}}}>
        <label>父通道<select aria-label="父通道" value={parent} onChange={e=>setParent(e.target.value)}>{own.map(l=><option key={l.id} value={l.id}>{l.owner} · {l.provider}</option>)}</select></label>
        <label>标题<input required maxLength={200} aria-label="子任务标题" value={title} onChange={e=>setTitle(e.target.value)} placeholder="例如：补充登录测试"/></label>
        <label>任务<textarea required rows={4} aria-label="子任务要求" value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="交给这个 Agent 完成什么？"/></label>
        <label>必需检查<textarea required rows={3} aria-label="必需检查命令" value={checks} onChange={e=>setChecks(e.target.value)} placeholder="每行一条，例如 npm test"/></label>
        <p className="small-note">检查命令由你指定，在独立工作树中执行。父 Agent 可并行工作，暂停后再集成已检查成果。</p>
        <button className="button primary" disabled={!!busy || !parent || !checks.trim()}><GitBranch size={14}/> 创建子任务</button>
      </form>
    </Modal>}
    {showHandoff && <Modal title="请求接力" close={()=>!busy&&setShowHandoff(false)}>
      {message && <p role="alert" className="small-note">{message}</p>}
      <form onSubmit={async e=>{e.preventDefault();if(await run("handoff","handoff.request",{laneId:source,targetLaneId:target})){setShowHandoff(false);setMessage("已请求接力，等待原执行者安全停止。");}}}>
        <label>接手通道<select aria-label="接手通道" value={source} onChange={e=>setSource(e.target.value)}>{others.map(l=><option key={l.id} value={l.id}>{l.owner} · {l.provider}</option>)}</select></label>
        <label>我的通道<select aria-label="我的接收通道" value={target} onChange={e=>setTarget(e.target.value)}>{own.filter(l=>!["running","awaiting"].includes(l.status)).map(l=><option key={l.id} value={l.id}>{l.provider}</option>)}</select></label>
        <p className="small-note">同步确认快照后，用你的账号和新会话继续。</p>
        <button className="button primary" disabled={!!busy || !source || !target}><ArrowRightLeft size={14}/> 请求接力</button>
      </form>
    </Modal>}
    {review && <Modal title="子任务成果" close={()=>!busy&&setReview(null)}>
      {message && <p role="alert" className="small-note">{message}</p>}
      <p>{labels[review.status || "review"] || review.status} · {review.candidateCommit?.slice(0,8)}</p>
      <pre style={{maxHeight:280,overflow:"auto",fontSize:12,whiteSpace:"pre-wrap"}}>{review.diff || review.details || "没有文件差异"}</pre>
      {(review.integrationChecks || review.checks || []).map(check=><details key={check.id}><summary>{check.passed ? "通过" : "失败"} · {check.id} · 退出码 {check.exitCode}</summary><pre style={{maxHeight:180,overflow:"auto",whiteSpace:"pre-wrap",fontSize:12}}>{check.output || "无输出"}</pre></details>)}
      {review.message && <p role="status">{review.message}</p>}
      {canEdit && review.status!=="integrated" && <div className="comment-actions">
        <button className="button" disabled={!!busy} onClick={async()=>{const result=await run(review.id,"tasks.check",{id:review.id});if(result)setReview({...review,...result,id:review.id});}}><Play size={13}/> 运行检查</button>
        <button className="button primary" disabled={!!busy || review.status!=="checked" || !review.candidateCommit} onClick={async()=>{const result=await run(review.id,"tasks.integrate",{id:review.id,candidateCommit:review.candidateCommit});if(result)setReview({...review,...result,id:review.id,message:result.status==="integrated"?"已集成到父工作树。":result.status==="conflict"?"与父工作树冲突，父代码未改变。":result.status==="stale"?"父版本已更新，请重试检查。":undefined});}}><Check size={13}/> 集成成果</button>
      </div>}
    </Modal>}
  </>;
}
