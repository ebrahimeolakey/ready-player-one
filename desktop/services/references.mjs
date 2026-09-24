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
async function reference(root, path, commit) {
  path = filePath(path);
  await safePath(root, path);
  const value = await read(root, path);
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
