import { MAX_ARTIFACT_BYTES, filePayload } from "../../core/artifact-files.mjs";
import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { projectPath } from "../../core/project-collaboration.mjs";
import { projectContext } from "./project-context.mjs";

export function withinProject(root, path = "") {
  const base = realpathSync(root),
    target = realpathSync(resolve(base, projectPath(path)));
  const rel = relative(base, target);
  if (
    rel === ".." ||
    rel.startsWith("../") ||
    isAbsolute(rel) ||
    rel.split(/[\\/]/).includes(".git")
  )
    throw Error("项目路径越过授权目录");
  return target;
}
export function projectWorkingDirectory(root, binding, mode = "repository") {
  if (!["folder", "repository"].includes(mode)) throw Error("请选择工作文件夹或代码仓库");
  const target = withinProject(root, mode === "folder" ? "" : binding.subPath);
  if (!statSync(target).isDirectory()) throw Error("项目工作目录不存在");
  return target;
}
export async function verifyProjectCheckout(root, binding, mode = "repository") {
  if (mode === "folder") return projectWorkingDirectory(root, binding, mode);
  if (mode !== "repository") throw Error("请选择工作文件夹或代码仓库");
  const context = await projectContext(root);
  if (binding.repository) {
    if (context.repository?.toLowerCase() !== binding.repository.toLowerCase())
      throw Error(`此项目的代码仓库是 ${binding.repository}；所选文件夹${context.repository ? `属于 ${context.repository}` : "不是该仓库的本机副本"}。只做文档或方案，请选择「本地工作文件夹」；修改代码请选择正确的仓库。`);
    if (context.branch !== binding.branch)
      throw Error(`需要分支 ${binding.branch}，当前是 ${context.branch || "未检出分支"}。请选择该分支的本机副本；不会自动切换分支或改动文件。`);
  }
  return projectWorkingDirectory(root, binding, mode);
}
// A bound project subfolder may be selected directly, but never a different
// subfolder that would silently broaden the user's chosen working directory.
export async function resolveProjectCheckoutSelection(selected, binding, mode = "repository") {
  let root = realpathSync(selected);
  if (mode === "repository" && binding.repository) {
    const context = await projectContext(root);
    if (context.gitRoot) {
      const gitRoot = realpathSync(context.gitRoot);
      if (root !== gitRoot) {
        const target = projectWorkingDirectory(gitRoot, binding, mode);
        if (root !== target) throw Error("请选择仓库根目录或此项目绑定的子目录");
        root = gitRoot;
      }
    }
  }
  const directory = await verifyProjectCheckout(root, binding, mode);
  return { root, directory, mode };
}
export async function publishProjectArtifact(client, task, root) {
  const path = withinProject(root, task.artifactPath);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES)
    throw Error("产物必须是 8 MB 以内的文件");
  const content = await readFile(path);
  return client.call("collab.artifact.publish", {
    taskId: task.id,
    runId: task.runId,
    generation: task.generation,
    ...filePayload(content, task.artifactPath),
  });
}
