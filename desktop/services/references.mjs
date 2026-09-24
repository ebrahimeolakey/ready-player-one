import {lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import { read, safePath, git } from "../../core/local.mjs";
import { filePath } from "../../core/coordination.mjs";
const MISSING = "0".repeat(64);
async function head(root) {
  try {
    const value = (await git(root, ["rev-parse", "HEAD"])).trim();
    return /^[a-f0-9]{40,64}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}
export async function readReferenceText(root,path){
  if(filePath(path)!==path)throw Error('文件路径不能被规范化');
  let current=await realpath(root);
  for(const component of path.split('/')){current=join(current,component);if((await lstat(current)).isSymbolicLink())throw Error('符号链接不能作为代码引用');}
  if(!(await lstat(current)).isFile())throw Error('只能引用普通文件');
  return read(root,path);
}
async function reference(root, path, commit) {
  if(filePath(path)!==path)throw Error("文件路径不能被规范化");
  await safePath(root, path);
  const value = await readReferenceText(root, path);
  return {
    path,
    hash: value.hash,
    commit: commit || value.hash,
    content: value.content,
    lineCount: value.content.split("\n").length,
  };
}
export async function captureReference(
  root,
  { path, startLine, endLine = startLine, expectedHash },
) {
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    throw Error("请选择有效的代码行");
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash))
    throw Error("需要已读取磁盘文件的版本");
  const value = await reference(root, path, await head(root));
  if (value.hash !== expectedHash)
    throw Error("磁盘文件已变化，请重新打开后再评论");
  if (endLine > value.lineCount) throw Error("所选行超出磁盘文件范围");
  return {
    path: value.path,
    startLine,
    endLine,
    hash: value.hash,
    commit: value.commit,
    side: "right",
    excerpt: value.content.split("\n").slice(startLine-1,endLine).join("\n").slice(0,8000),
  };
}
export async function fileReferences(root, { paths }) {
  if (!Array.isArray(paths) || paths.length > 100)
    throw Error("最多关联 100 个文件");
  const commit = await head(root),
    result = [];
  for (const path of [...new Set(paths.map(filePath))]) {
    const value = await reference(root, path, commit);
    result.push({ path: value.path, hash: value.hash, commit: value.commit });
  }
  return result;
}
export async function checkReferences(root, { references }) {
  if (!Array.isArray(references) || references.length > 100)
    throw Error("最多检查 100 个文件");
  const commit = await head(root),
    result = [];
  for (const path of [
    ...new Set(references.map((value) => filePath(value.path))),
  ]) {
    try {
      const value = await reference(root, path, commit);
      result.push({ path: value.path, hash: value.hash, commit: value.commit });
    } catch {
      // A deleted, unreadable, binary, or escaped file must never be treated as still current.
      result.push({ path, hash: MISSING, commit: MISSING, unavailable: true });
    }
  }
  return result;
}
