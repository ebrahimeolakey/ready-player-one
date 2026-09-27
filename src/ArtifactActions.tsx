import { useState } from "react";
import { Download, Github, X } from "lucide-react";
import type { State } from "./types";
import type { ArtifactVersion } from "./project-types";
import type { Call } from "./ui";

type Receipt = {
  id: string;
  status: string;
  number: number;
  hash: string;
  size: number;
  repository: string;
  path: string;
  branch: string;
  private: boolean;
  account: { login: string };
  url?: string;
  message?: string;
  previousSha?: string;
};
export function ArtifactActions({
  version,
  state,
  projectId,
  path,
  driUserId,
  call,
  onError,
}: {
  version: ArtifactVersion;
  state: State;
  projectId: string;
  path: string;
  driUserId?: string;
  call: Call;
  onError: (error: string) => void;
}) {
  const project = state.collaboration?.projects.find((p) => p.id === projectId);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [repository, setRepository] = useState(project?.repository || ""),
    [branch, setBranch] = useState(project?.branch || "main"),
    [target, setTarget] = useState(
      [project?.subPath, path].filter(Boolean).join("/"),
    ),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [history, setHistory] = useState<Receipt[]>([]);
  const item = version.taskId
      ? state.collaboration?.tasks.find(t => t.id === version.taskId)
      : state.collaboration?.outputs?.find(o => o.id === version.outputId),
    dri = driUserId || project?.driUserId,
    canPublish =
      item?.acceptedVersionId === version.id &&
      dri === state.me?.id &&
      version.approval?.by === dri &&
      version.approval?.hash === version.hash;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        title="下载当前版本"
        aria-label="下载当前版本"
        disabled={busy}
        onClick={() =>
          void act(async () => {
            await call("collab.artifact.download", { versionId: version.id });
          })
        }
      >
        <Download size={15} />
      </button>
      {version.approval && <small>DRI 已批准 v{version.number}</small>}
      {canPublish && (
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              setOpen(true);
              setHistory(
                await call("collab.artifact.github.history", {
                  versionId: version.id,
                }),
              );
            })
          }
        >
          <Github size={14} />
          发布到 GitHub
        </button>
      )}
      {open && (
        <div
          className="artifact-release-panel"
          role="dialog"
          aria-label="发布获批版本"
        >
          <header>
            <strong>发布获批版本 v{version.number}</strong>
            <button
              aria-label="关闭发布面板"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              <X size={14} />
            </button>
          </header>
          {!receipt ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () =>
                  setReceipt(
                    await call("collab.artifact.github.preview", {
                      versionId: version.id,
                      repository,
                      branch,
                      path: target,
                    }),
                  ),
                );
              }}
            >
              <label>
                GitHub 仓库
                <input
                  required
                  placeholder="owner/repo"
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                />
              </label>
              <label>
                分支
                <input
                  required
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </label>
              <label>
                文件路径
                <input
                  required
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </label>
              <button disabled={busy}>预览发布</button>
            </form>
          ) : (
            <div>
              <p>
                {receipt.repository} · {receipt.private ? "私有" : "公开"} ·{" "}
                {receipt.branch}
              </p>
              <p>{receipt.path}</p>
              <small>
                账号 {receipt.account.login} · v{receipt.number} ·{" "}
                {receipt.hash.slice(0, 12)} ·{" "}
                {receipt.previousSha ? "更新文件" : "新建文件"}
              </small>
              {receipt.status === "prepared" && (
                <div className="room-actions">
                  <button disabled={busy} onClick={() => setReceipt(null)}>
                    修改目标
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        setReceipt(
                          await call("collab.artifact.github.publish", {
                            id: receipt.id,
                          }),
                        ),
                      )
                    }
                  >
                    确认发布此版本
                  </button>
                </div>
              )}
              {["unknown", "dispatching"].includes(receipt.status) && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      setReceipt(
                        await call("collab.artifact.github.lookup", {
                          id: receipt.id,
                        }),
                      ),
                    )
                  }
                >
                  检查发布状态
                </button>
              )}
              {receipt.status === "published" && <p>已发布获批版本</p>}
              {receipt.message && <p>{receipt.message}</p>}
              {receipt.url && (
                <button
                  onClick={() =>
                    void act(async () => {
                      await call("link.open", { url: receipt.url });
                    })
                  }
                >
                  在 GitHub 查看
                </button>
              )}
            </div>
          )}
          {!!history.length && (
            <details>
              <summary>本机发布记录</summary>
              {history.map((r) => (
                <button key={r.id} onClick={() => setReceipt(r)}>
                  {r.repository} · {r.path} ·{" "}
                  {r.status === "published"
                    ? "已发布"
                    : r.status === "prepared"
                      ? "待确认"
                      : r.status === "verified"
                        ? "远端已核对"
                        : "待核实"}
                </button>
              ))}
            </details>
          )}
        </div>
      )}
    </>
  );
}
