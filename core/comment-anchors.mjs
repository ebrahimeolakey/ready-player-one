/** Pure unified-diff coordinates; metadata is never mistaken for a source line. */
export function diffRows(text) {
  let left=0,right=0,hunk=-1,inHunk=false;
  return String(text).split('\n').map((text,index)=>{
    const header=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if(header){left=Number(header[1]);right=Number(header[3]);hunk++;inHunk=true;return {index,text,hunk,header:true,left:null,right:null};}
    if(text.startsWith('diff --git ')){inHunk=false;}
    const row={index,text,hunk,header:false,left:null,right:null};
    if(inHunk&&text.startsWith(' ')){row.left=left++;row.right=right++;}
    else if(inHunk&&text.startsWith('-'))row.left=left++;
    else if(inHunk&&text.startsWith('+'))row.right=right++;
    return row;
  });
}
export function diffRange(text,{hunk,side,startLine,endLine=startLine}) {
  if(!['left','right'].includes(side))throw Error('请选择差异一侧');
  const rows=diffRows(text).filter(r=>r.hunk===hunk&&r[side]!==null);
  if(!rows.length)throw Error('这一侧没有可评论的代码行');
  if(startLine===undefined){startLine=rows[0][side];endLine=rows.at(-1)[side];}
  if(!Number.isInteger(startLine)||!Number.isInteger(endLine)||endLine<startLine||!rows.some(r=>r[side]===startLine)||!rows.some(r=>r[side]===endLine))throw Error('请选择当前差异中的代码行');
  return {startLine,endLine,rows:rows.filter(r=>r[side]>=startLine&&r[side]<=endLine)};
}
