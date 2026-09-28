import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { GithubRepositoryService } from "./github-repository.mjs";
import { localEnv } from "../../core/local.mjs";
import { projectPath } from "../../core/project-collaboration.mjs";
import { storedBytes } from "../../core/artifact-files.mjs";
import { redactText } from "../../core/secure-store.mjs";
const FILE = "artifact-releases.json";
const blobHash = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
// Only immutable Hub bytes are published. Never stage or push the working tree.
export class ArtifactReleaseService extends GithubRepositoryService {
  constructor(options) {
    super(options);
    this.resolve = options.resolve;
    this.request = options.request;
  }
  data() {
    const s = this.store();
    if (!s) throw Error("本机存储未就绪");
    s.recoverFile(FILE);
    return s.exists(FILE) ? s.readJSON(FILE) : { operations: [] };
  }
  write(data) {
    this.store().writeJSON(FILE, data);
  }
  async api(path, options = {}) {
    if (this.request) return this.request(path, options);
    if (!options.body) return super.api(path, options);
    return new Promise((resolve, reject) => {
      const child = spawn(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          "--method",
          options.method || "PUT",
          path,
          "--input",
          "-",
        ],
        {
          env: {
            ...localEnv(),
            GH_HOST: "github.com",
            GH_PROMPT_DISABLED: "1",
            GH_TOKEN: this.apiToken,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let out = "",
        err = "";
      const timer = setTimeout(() => child.kill(), 30000);
      child.stdout.on("data", (b) => {
        out += b;
        if (out.length > 1024 * 1024) child.kill();
      });
      child.stderr.on("data", (b) => {
        err = (err + b).slice(-2000);
      });
      child.stdin.on("error", () => {});
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(Error("GitHub 发布结果待核实：" + redactText(err)));
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(Error("GitHub 返回结果无法核实"));
        }
      });
      child.stdin.end(JSON.stringify(options.body));
    });
  }
  async source(id) {
    const value = await this.resolve(id);
    return { ...value, bytes: storedBytes(value.version, value.version) };
  }
  async remote(record) {
    try {
      const value = await this.api(
        `repos/${record.repository}/contents/${record.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(record.branch)}`,
        { fields: ["-H", "Accept: application/vnd.github.object+json"] },
      );
      if (value.type !== "file" || !value.sha) throw Error("目标不是普通文件");
      return value;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }
  async repositoryCheck(record) {
    const repo = await this.api(`repos/${record.repository}`);
    if (
      repo.id !== record.repositoryId ||
      repo.full_name?.toLowerCase() !== record.repository.toLowerCase() ||
      repo.private !== record.private ||
      repo.permissions?.push !== true
    )
      throw Error("仓库身份、可见范围或写入权限已改变");
  }
  preview(a) {
    return this.exclusive(async () => {
      const scope = this.currentScope(),
        source = await this.source(a.versionId),
        account = await this.account();
      const repository = String(
        a.repository || source.project.githubTarget?.repository || source.project.repository || "",
      ).trim();
      if (
        !/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i.test(repository) ||
        repository.split("/")[1] === ".."
      )
        throw Error("请输入 owner/repo 格式的 GitHub 仓库");
      const branch = String(a.branch || source.project.githubTarget?.baseBranch || source.project.branch || "main").trim(),
        path = projectPath(
          a.path ||
            [source.project.githubTarget?.pathPrefix ?? source.project.subPath, source.path].filter(Boolean).join("/"),
        );
      if (
        !path ||
        !branch ||
        branch.length > 200 ||
        /[\s~^:?*\[\\\x00-\x1f]/.test(branch) ||
        branch.includes("..")
      )
        throw Error("发布路径或分支无效");
      const record = {
        id: randomUUID(),
        scope,
        versionId: a.versionId,
        hash: source.version.hash,
        number: source.version.number,
        size: source.bytes.length,
        approval: source.version.approval,
        account,
        repository,
        branch,
        path,
        status: "prepared",
        at: new Date().toISOString(),
      };
      await this.verify(record);
      const repo = await this.api(`repos/${repository}`);
      if (
        !repo.id ||
        repo.full_name?.toLowerCase() !== repository.toLowerCase() ||
        !repo.permissions?.push
      )
        throw Error("当前 GitHub 账号没有仓库写入权限");
      Object.assign(record, { repositoryId: repo.id, private: repo.private });
      await this.api(
        `repos/${repository}/branches/${encodeURIComponent(branch)}`,
      );
      const old = await this.remote(record);
      record.previousSha = old?.sha || null;
      record.expectedSha = blobHash(source.bytes);
      if (this.prepare) await this.prepare(record, source);
      const data = this.data();
      const pending = data.operations.find(
        (r) =>
          r.scope === scope &&
          r.repositoryId === repo.id &&
          r.branch === branch &&
          r.path === path &&
          ["dispatching", "unknown"].includes(r.status),
      );
      if (pending) throw Error("此文件有结果待核实的发布，请先检查发布状态");
      if (data.operations.length >= 1000) throw Error("发布记录已达上限");
      if (scope !== this.currentScope()) throw Error("协作身份已切换");
      data.operations.push(record);
      this.write(data);
      return this.public(record);
    });
  }
  publish({ id }) {
    return this.exclusive(async () => {
      const data = this.data(),
        r = this.get(data, id);
      await this.verify(r);
      if (r.status !== "prepared") return this.public(r);
      if (Date.now() - Date.parse(r.at) > 15 * 60 * 1000)
        throw Error("发布预览已过期，请重新预览");
      const source = await this.source(r.versionId);
      if (
        source.version.hash !== r.hash ||
        JSON.stringify(source.version.approval) !== JSON.stringify(r.approval)
      )
        throw Error("审批已改变，请重新审阅");
      await this.repositoryCheck(r);
      const old = await this.remote(r);
      if ((old?.sha || null) !== r.previousSha)
        throw Error("GitHub 文件已改变，请重新预览；没有覆盖远端修改");
      // Recheck membership/approval after network reads, immediately before dispatch.
      await this.source(r.versionId);
      if (r.scope !== this.currentScope()) throw Error("协作身份已切换");
      r.status = "dispatching";
      this.write(data);
      try {
        const result = await this.api(
          `repos/${r.repository}/contents/${r.path.split("/").map(encodeURIComponent).join("/")}`,
          {
            body: {
              message: `Publish approved artifact v${r.number} (${r.hash.slice(0, 12)})`,
              content: source.bytes.toString("base64"),
              branch: r.branch,
              ...(r.previousSha ? { sha: r.previousSha } : {}),
            },
          },
        );
        if (result.content?.sha !== r.expectedSha || !result.commit?.sha)
          throw Error("发布回执不匹配");
        r.status = "published";
        r.commit = result.commit.sha;
        r.url = `https://github.com/${r.repository}/blob/${r.commit}/${r.path.split("/").map(encodeURIComponent).join("/")}`;
      } catch (e) {
        r.status = "unknown";
        r.message = "结果待核实，不会自动重发。" + redactText(e.message);
      }
      this.write(data);
      return this.public(r);
    });
  }
  lookup({ id }) {
    return this.exclusive(async () => {
      const data = this.data(),
        r = this.get(data, id);
      await this.verify(r);
      await this.source(r.versionId);
      await this.repositoryCheck(r);
      if (["dispatching", "unknown"].includes(r.status)) {
        const file = await this.remote(r);
        if (file?.sha === r.expectedSha) {
          r.status = "verified";
          r.url = `https://github.com/${r.repository}/blob/${encodeURIComponent(r.branch)}/${r.path.split("/").map(encodeURIComponent).join("/")}`;
          r.message = "远端内容与获批版本一致；原请求的提交回执未确认";
          this.write(data);
        }
      }
      return this.public(r);
    });
  }
  history({ versionId }) {
    return this.exclusive(async () => {
      await this.source(versionId);
      return this.data()
        .operations.filter(
          (r) => r.scope === this.currentScope() && r.versionId === versionId,
        )
        .slice(-10)
        .reverse()
        .map((r) => this.public(r));
    });
  }
}
