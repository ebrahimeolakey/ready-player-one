import WebSocket from "ws";
import { randomUUID } from "node:crypto";
export async function requestIdentityChallenge(url,{token,secret}) {
  const endpoint=new URL(url);
  if(!["ws:","wss:"].includes(endpoint.protocol)||(endpoint.protocol==="ws:"&&!["127.0.0.1","localhost","[::1]"].includes(endpoint.hostname)))throw Error("GitHub 身份连接需要 WSS 或本机 WS");
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(url,{handshakeTimeout:10000,maxPayload:65536}),id=randomUUID();
    const timer=setTimeout(()=>{socket.close();reject(Error("登录挑战响应超时"));},10000);
    socket.on("open",()=>socket.send(JSON.stringify({id,method:"identity.begin",args:{token,secret}})));
    socket.on("message",raw=>{try{const message=JSON.parse(raw);if(message.id!==id)return;clearTimeout(timer);socket.close();message.error?reject(Error(message.error)):resolve(message.result);}catch{clearTimeout(timer);socket.close();reject(Error("身份服务响应无效"));}});
    socket.on("error",error=>{clearTimeout(timer);reject(error);});
    socket.on("close",()=>{clearTimeout(timer);reject(Error("身份挑战连接已关闭"));});
  });
}
