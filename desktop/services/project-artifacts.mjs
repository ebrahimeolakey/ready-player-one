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
export async function verifyProjectCheckout(root, binding) {
  const context = await projectContext(root);
  if (
    binding.repository &&
    (context.repository?.toLowerCase() !== binding.repository.toLowerCase() ||
      context.branch !== binding.branch)
  )
    throw Error("本机仓库或分支与项目绑定不一致");
  const target = withinProject(root, binding.subPath);
  if (!statSync(target).isDirectory()) throw Error("项目子目录不存在");
  return target;
}
export async function publishProjectArtifact(client, task, root) {
  const path = withinProject(root, task.artifactPath);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 300000)
    throw Error("产物必须是 300 KB 以内的文件");
  const content = await readFile(path, "utf8");
  return client.call("collab.artifact.publish", {
    taskId: task.id,
    runId: task.runId,
    generation: task.generation,
    content,
  });
}
