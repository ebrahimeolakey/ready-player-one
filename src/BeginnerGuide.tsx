import {useState} from 'react';
import {ArrowRight,Check,Sparkles,UserPlus,MessageSquare,Columns3,Files} from 'lucide-react';
import {Modal,type Call} from './ui';
import {LocalSetup} from './LocalSetup';
import type {State} from './types';
import type {Project} from './project-types';
export function BeginnerGuide({state,project,call,close,onInvite,onTask,onHelp,onArtifacts}:{state:State;project:Project;call:Call;close:()=>void;onInvite?:()=>void;onTask:()=>void;onHelp:()=>void;onArtifacts:()=>void}){
 const record=state.collaboration?.onboarding?.find(r=>r.projectId===project.id&&r.userId===state.me?.id);
 const [step,setStep]=useState(record?.guideComplete?0:record?.guideStep||0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const own=state.collaboration?.agents.filter(a=>a.projectId===project.id&&a.workerId===state.me?.id&&!a.taskId)||[];
 const agent=own.find(a=>a.name!=='Cindy')||own[0];
 const channel=state.collaboration?.channels.find(c=>c.projectId===project.id);
 const titles=['欢迎来到项目空间','连接工作文件夹','连接 AI 账号','选择第一位搭档','邀请你的同事','在群里和 AI 说句话','交出第一项任务','一起查看成果'];
 async function run(f:()=>Promise<unknown>){setBusy(true);setError('');try{await f();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 async function move(n:number){await call('collab.onboarding.status',{projectId:project.id,guideStep:n,dismissed:false});setStep(n);}
 const finish=async()=>{await call('collab.onboarding.status',{projectId:project.id,guideComplete:true,dismissed:true});close();};
 if(step>=1&&step<=3)return <LocalSetup state={state} project={project} call={call} wizard={{step:step-1,onStep:n=>void run(()=>move(n+1))}} initial={{name:'项目协调',role:'整理群聊目标、拆分任务和跟进进度，执行与复核分别交给其他搭档；最终审批由 DRI 决定。'}} onClose={()=>void run(async()=>{await call('collab.onboarding.status',{projectId:project.id,dismissed:true});close();})} onCreated={async()=>{await move(4);}}/>;
 return <Modal title={`Cindy 带你开始 · 第 ${step+1} / 8 步`} close={()=>void run(async()=>{await call('collab.onboarding.status',{projectId:project.id,dismissed:true});close();})}>
  <div className="beginner-guide"><div className="guide-dots" aria-label={`第 ${step+1} 步，共 8 步`}>{titles.map((_,i)=><i key={i} className={i<=step?'active':''}/>)}</div>
   {step===0?<Sparkles size={32}/>:step===4?<UserPlus size={32}/>:step===5?<MessageSquare size={32}/>:step===6?<Columns3 size={32}/>:<Files size={32}/>}
   <h2>{titles[step]}</h2>
   {step===0&&<><p>你、同事和 AI 在这里一起完成一个项目。</p><div className="guide-three"><span><b>群聊</b>一起讨论</span><span><b>任务</b>让 AI 干活</span><span><b>产物</b>一起看成果</span></div><small>接下来只需几步。随时退出，下次接着来。</small></>}
   {step===4&&<><p>同事加入后，可以带上自己的 AI。你们能讨论同一个项目，一起完成任务。</p>{onInvite&&<button className="button full" onClick={()=>void run(async()=>{await move(4);close();onInvite();})}>打开邀请窗口</button>}<small>当前团队成员能看到项目群、共享任务和产物。个人账号留在自己的电脑。</small></>}
   {step===5&&<><p>在项目群里输入 <b>@{agent?.name||'搭档名字'}</b>，就能向它提问。</p><div className="guide-example">@{agent?.name||'项目协调'} 帮我想想，这个项目第一步应该做什么？</div><button className="button full" disabled={!agent||busy} onClick={()=>void run(async()=>{await call('collab.message.send',{channelId:channel?.id,text:`@${agent?.name} 帮我想想，这个项目第一步应该做什么？`,requestKey:`guide-hello-${project.id}-${state.me?.id}`});await move(6);})}>发送这句试试看</button><small>会实际调用你的 AI 账号。电脑和应用需保持在线。</small></>}
   {step===6&&<><p>把要做的事和“怎样算完成”告诉 AI。每张任务卡里，都能看到执行过程和同伴的分工。</p><div className="guide-example"><b>示例任务</b><br/>整理一页项目方案<br/><small>验收：包含目标、分工和下一步。</small></div><button className="button full" onClick={()=>void run(async()=>{await move(7);close();onTask();})}>创建我的第一项任务</button></>}
   {step===7&&<><p>文件还在制作时，团队就能在「产物」里查看版本。负责人验收后，再决定是否发布到 GitHub。</p><div className="guide-example"><b>DRI 就是最终负责人</b><br/>AI 做和检查，人来确认最终版本。</div><button className="button full" onClick={()=>void run(async()=>{await finish();onArtifacts();})}>去看产物页</button></>}
   <div className="guide-footer">{step>0&&<button className="button" disabled={busy} onClick={()=>void run(()=>move(step===4?0:step-1))}>上一步</button>}<button className="button primary" disabled={busy} onClick={()=>void run(()=>step===7?finish():move(step+1))}>{step===7?<><Check size={15}/>完成</>:<>{step===0?'开始':step===4?'先自己试用':'下一步'}<ArrowRight size={15}/></>}</button></div>
   <button className="inline-link" onClick={onHelp}>有问题？问 Cindy</button>
   {error&&<p className="room-error" role="alert">{error}</p>}
  </div>
 </Modal>;
}
