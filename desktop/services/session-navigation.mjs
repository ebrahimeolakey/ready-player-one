import {createHash} from 'node:crypto';
import {resolveGeneralSettings} from '../../core/general-settings.mjs';

const text=value=>typeof value==='string'&&value.length>0&&value.length<=512;
/** UI location only. No provider, connection or runtime execution dependencies. */
export class SessionNavigation {
 constructor({client,online,config,saveConfig}) {Object.assign(this,{client,online,config,saveConfig});this.epoch=0;}
 context() {
  const c=this.client(),s=c?.state;
  if(!text(s?.identity?.audience)||!text(s?.me?.id)||!text(c?.auth?.secret))return null;
  const github=s.me.github?.id==null?null:String(s.me.github.id);
  const scope=createHash('sha256').update(JSON.stringify([s.identity.audience,s.me.id,c.auth.secret,s.me.sessionId||null,github])).digest('hex');
  return {scope,state:s,ready:this.online()===true&&c.ws?.readyState===1};
 }
 metadata(){const c=this.context();return {scope:c?.scope||null,ready:!!c?.ready,epoch:this.epoch};}
 visible(c,record){return c.state.workspaces?.some(w=>w.id===record.workspaceId)&&c.state.sessions?.some(s=>s.id===record.sessionId&&s.workspaceId===record.workspaceId&&s.status==='active')&&(!c.state.me.sessionId||c.state.me.sessionId===record.sessionId);}
 commit(record){const previous=this.config.lastOpenedSession;try{if(record)this.config.lastOpenedSession=record;else delete this.config.lastOpenedSession;this.saveConfig();}catch(error){if(previous===undefined)delete this.config.lastOpenedSession;else this.config.lastOpenedSession=previous;throw error;}}
 clear(){this.commit(null);this.epoch++;return true;}
 observe(){const c=this.context(),record=this.config.lastOpenedSession;if(c?.ready&&record?.scope===c.scope&&!this.visible(c,record))this.commit(null);}
 checked(args,keys){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!keys.includes(key)))throw Error('会话导航参数无效');const c=this.context();if(!c?.ready||args.scope!==c.scope)throw Error('房间或身份已变化，请刷新后重试');return c;}
 open(args){const c=this.checked(args,['scope','workspaceId','sessionId']);if(!text(args.workspaceId)||!text(args.sessionId)||!this.visible(c,args))throw Error('会话不可见或已归档');if(resolveGeneralSettings(this.config.generalSettings).restoreLastSession)this.commit({version:1,scope:c.scope,workspaceId:args.workspaceId,sessionId:args.sessionId});return true;}
 restore(args){const c=this.checked(args,['scope']);if(!resolveGeneralSettings(this.config.generalSettings).restoreLastSession)return null;const record=this.config.lastOpenedSession;if(record?.version!==1||record.scope!==c.scope)return null;if(!this.visible(c,record)){this.commit(null);return null;}return {scope:c.scope,workspaceId:record.workspaceId,sessionId:record.sessionId};}
}
