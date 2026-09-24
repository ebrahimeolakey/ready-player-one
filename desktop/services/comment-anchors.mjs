import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { filePath } from '../../core/coordination-paths.mjs';
import { readReferenceText } from './references.mjs';
import { diffRange } from '../../core/comment-anchors.mjs';
import { GitService } from './git.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
const objectId=value=>typeof value==='string'&&/^[a-f0-9]{40,64}$/.test(value);
const excerpt=(text,start,end)=>text.split('\n').slice(start-1,end).join('\n').slice(0,8000);
async function blob(service,root,spec){
  const id=(await service.command(root,['rev-parse','--verify',spec])).stdout.trim();
  if(!objectId(id))throw Error('文件版本不存在');
  const size=Number((await service.command(root,['cat-file','-s',id])).stdout);
  if(!Number.isFinite(size)||size>2*1024*1024)throw Error('文件过大');
  const content=(await service.command(root,['cat-file','blob',id])).stdout;
  if(content.includes('\0'))throw Error('二进制文件不能添加代码评论');
  return {content,hash:sha(content),blob:id};
}
export async function diffPreview(root,args,service=new GitService()){
  const canonicalRoot=await realpath(root),result=await service.diff(canonicalRoot,args);
  return {...result,canonicalRoot,diffHash:sha(result.text)};
}
export async function captureDiffReference(root,args,service=new GitService()){
  if(filePath(args.path)!==args.path)throw Error('文件路径不能被规范化，请重命名后评论');
  const current=await diffPreview(root,args,service);
  if(args.expectedRoot!==current.canonicalRoot||args.expectedDiffHash!==current.diffHash)throw Error('差异或目录已变化，请重新打开后评论');
  if(current.binary)throw Error('二进制差异不能添加代码评论');
  const range=diffRange(current.text,args),status=await service.inspect(current.canonicalRoot);
  const selected=status.files.find(f=>f.path===args.path);
  if(!selected||selected.conflict)throw Error('文件状态已变化或存在冲突，请先解决');
  const path=filePath(args.side==='left'&&args.staged?(selected.originalPath||args.path):args.path);
  if(path!==(args.side==='left'&&args.staged?(selected.originalPath||args.path):args.path))throw Error('原文件路径不能被规范化');
  let source;
  if(args.side==='right'&&!args.staged){source=await readReferenceText(current.canonicalRoot,path);}
  else {
    // Only regular tracked text files. Never follow a symlink or an external diff driver.
    const spec=args.side==='left'&&args.staged?'HEAD':null;
    const entries=(await service.command(current.canonicalRoot,spec?['ls-tree','-z',spec,'--',path]:['ls-files','-s','-z','--',path])).stdout.split('\0').filter(Boolean);
    if(entries.length!==1||!/^100(?:644|755) /.test(entries[0]))throw Error('只能评论普通文件');
    source=await blob(service,current.canonicalRoot,(spec||'')+':'+path);
  }
  const lines=source.content.split('\n');
  for(const row of range.rows)if(lines[row[args.side]-1]?.replace(/\r$/,'')!==row.text.slice(1).replace(/\r$/,''))throw Error('文件内容已变化，请重新打开差异');
  const again=await diffPreview(root,args,service);
  if(again.diffHash!==current.diffHash||again.canonicalRoot!==current.canonicalRoot)throw Error('差异已变化，请重新打开后评论');
  let commit;try{commit=(await service.command(current.canonicalRoot,['rev-parse','HEAD'])).stdout.trim();}catch{}
  return {path,startLine:range.startLine,endLine:range.endLine,side:args.side,kind:'diff',hash:source.hash,commit:objectId(commit)?commit:source.hash,...(source.blob?{blob:source.blob}:{}),excerpt:excerpt(source.content,range.startLine,range.endLine)};
}
export async function openReference(root,location,service=new GitService()){
  const path=filePath(location.path),{startLine,endLine}=location;
  if(!Number.isInteger(startLine)||!Number.isInteger(endLine)||startLine<1||endLine<startLine)throw Error('无效评论位置');
  const matches=source=>source.hash===location.hash&&endLine<=source.content.split('\n').length;
  try{const source=await readReferenceText(root,path);if(matches(source))return {...source,path,startLine,endLine,mode:'current'};}catch{}
  for(const spec of [objectId(location.blob)?location.blob:null,objectId(location.commit)?location.commit+':'+path:null].filter(Boolean)){
    try{const source=await blob(service,root,spec);if(matches(source))return {...source,path,startLine,endLine,mode:'historical'};}catch{}
  }
  if(typeof location.excerpt==='string'&&location.excerpt)return {path,startLine,endLine,content:location.excerpt,mode:'excerpt'};
  return {path,startLine,endLine,content:'',mode:'unavailable'};
}
