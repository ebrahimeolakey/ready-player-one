import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  GitBranch,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";
import {useGeneralSettings} from "./GeneralSettings";
import "./git-review-controls.css";
import {DiffReview} from "./DiffReview";
import type { Call } from "./ui";
import "./git-panel.css";
interface GitFile {
  path: string;
  originalPath?: string;
  index: string;
  worktree: string;
  untracked: boolean;
  conflict: boolean;
  staged: boolean;
  unstaged: boolean;
}
interface GitState {
  branch: string | null;
  dirty: boolean;
  operation: string | null;
  conflicts: string[];
  files: GitFile[];
}
interface Branch {
  name: string;
  current: boolean;
  upstream: string | null;
}
export function GitPanel({
  call,
  context,
  rootRevision = "",
  busy = false,
  canComment = false,
  canWrite = false,
}: {
  call: Call;
  context: Record<string, unknown>;
  rootRevision?: string;
  busy?: boolean;
  canComment?: boolean;
  canWrite?: boolean;
}) {
  const {reviewControlLocation}=useGeneralSettings();
  const [status, setStatus] = useState<GitState | null>(null),
    [branches, setBranches] = useState<Branch[]>([]),
    [remotes, setRemotes] = useState<string[]>([]),
    [remote, setRemote] = useState("origin"),
    [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [branchName, setBranchName] = useState(""),
    [creating, setCreating] = useState(false),
    [selected, setSelected] = useState<{
      path: string;
      staged: boolean;
    } | null>(null),
    [diff, setDiff] = useState("");
  const [reviewReady,setReviewReady]=useState(false);
  const [diffPreview,setDiffPreview]=useState<{diffHash:string;canonicalRoot:string}|null>(null);
  const contextKey = JSON.stringify([context, rootRevision]);
  const activeContext = useRef(contextKey);
  const previewVersion = useRef(0);
  const mutationActive = useRef(false);
  activeContext.current = contextKey;
  async function refresh() {
    const [state, refs] = await Promise.all([
      call("git.status", context),
      call("git.branches", context),
    ]);
    if (activeContext.current !== contextKey) return state as GitState;
    setStatus(state);
    setBranches(refs.branches);
    setRemotes(refs.remotes);
    if (!refs.remotes.includes(remote)) setRemote(refs.remotes[0] || "");
    return state as GitState;
  }
  async function load() {
    setWorking(true);
    setError("");
    try {
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Git 读取失败");
    } finally {
      setWorking(false);
    }
  }
  useEffect(() => {
    previewVersion.current++;
    setStatus(null);
    setBranches([]);
    setSelected(null);
    setReviewReady(false);
    setDiff("");
    void load();
  }, [contextKey]);
  async function preview(file: GitFile, staged: boolean) {
    const version = ++previewVersion.current;
    setSelected({ path: file.path, staged });
    setDiff("加载中…");
    setDiffPreview(null);
    setReviewReady(false);
    setError("");
    try {
      const result = await call("git.diff", {
        ...context,
        path: file.path,
        staged,
      });
      if (
        version === previewVersion.current &&
        activeContext.current === contextKey
      )
        {setReviewReady(!!result.text||!!result.binary);setDiff(result.text || "没有文本差异");setDiffPreview(result.binary?null:result);}
    } catch (e) {
      if (
        version === previewVersion.current &&
        activeContext.current === contextKey
      )
        setError(e instanceof Error ? e.message : "差异读取失败");
    }
  }
  async function action(method: string, args: Record<string, unknown> = {}) {
    if(disabled || mutationActive.current)return;
    mutationActive.current=true;
    previewVersion.current++;
    setWorking(true);
    setError("");
    try {
      await call(`git.${method}`, { ...context, ...args });
      if (method === "commit") setMessage("");
      if (method === "createBranch") {
        setBranchName("");
        setCreating(false);
      }
      await refresh();
      if(activeContext.current!==contextKey)return;
      setSelected(null);
      setDiff("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Git 操作失败");
    } finally {
      mutationActive.current=false;
      setWorking(false);
    }
  }
  const disabled = working || busy || !canWrite;
  const staged = status?.files.filter((file) => file.staged) || [],
    unstaged = status?.files.filter((file) => file.unstaged) || [];
  function list(files: GitFile[], isStaged: boolean) {
    return (
      <div className="git-file-group">
        <div className="git-group-label">
          {isStaged ? "已暂存" : "更改"}
          <span>{files.length}</span>
        </div>
        {files.map((file) => (
          <div
            className={`git-file-row ${selected?.path === file.path && selected.staged === isStaged ? "selected" : ""}`}
            key={`${isStaged}-${file.path}`}
          >
            <button
              type="button"
              className="git-file-name"
              title={
                file.originalPath
                  ? `${file.originalPath} → ${file.path}`
                  : file.path
              }
              disabled={working}
              onClick={() => void preview(file, isStaged)}
            >
              <span className={file.conflict ? "git-conflict-code" : ""}>
                {file.conflict
                  ? "!"
                  : isStaged
                    ? file.index
                    : file.untracked
                      ? "U"
                      : file.worktree}
              </span>
              {file.path}
            </button>
            {canWrite && !(reviewReady && selected?.path===file.path && selected.staged===isStaged) && <button
              type="button"
              className="icon-button"
              title={isStaged ? "取消暂存" : "暂存"}
              aria-label={`${isStaged ? "取消暂存" : "暂存"} ${file.path}`}
              disabled={disabled}
              onClick={() =>
                void action(isStaged ? "unstage" : "stage", {
                  paths: [file.path],
                })
              }
            >
              {isStaged ? <Minus size={13} /> : <Plus size={13} />}
            </button>}
          </div>
        ))}
      </div>
    );
  }
  return (
    <section className="git-panel">
      <div className="git-toolbar">
        <GitBranch size={14} />
        <select
          aria-label="当前分支"
          value={status?.branch || ""}
          disabled={disabled || Boolean(status?.dirty)}
          onChange={(event) =>
            void action("switchBranch", { name: event.target.value })
          }
        >
          <option value="" disabled>
            {status?.branch ? "选择分支" : "分离 HEAD"}
          </option>
          {branches.map((branch) => (
            <option key={branch.name} value={branch.name}>
              {branch.name}
            </option>
          ))}
          {status?.branch &&
            !branches.some((branch) => branch.name === status.branch) && (
              <option value={status.branch}>{status.branch}</option>
            )}
        </select>
        <button
          type="button"
          className="icon-button"
          title="新建分支"
          aria-label="新建分支"
          disabled={disabled}
          onClick={() => setCreating(!creating)}
        >
          <Plus size={13} />
        </button>
        <span className="grow" />
        <button
          type="button"
          className="icon-button"
          title="刷新 Git"
          aria-label="刷新 Git"
          disabled={working}
          onClick={() => void load()}
        >
          {working ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <RefreshCw size={13} />
          )}
        </button>
      </div>
      {creating && (
        <form
          className="git-create-branch"
          onSubmit={(event) => {
            event.preventDefault();
            void action("createBranch", { name: branchName });
          }}
        >
          <input
            aria-label="新分支名"
            placeholder="分支名称"
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            required
          />
          <button
            className="button"
            type="submit"
            disabled={disabled || !branchName.trim()}
          >
            新建并切换
          </button>
        </form>
      )}
      {remotes.length > 0 && (
        <div className="git-network">
          <select
            aria-label="远程仓库"
            value={remote}
            onChange={(event) => setRemote(event.target.value)}
            disabled={disabled}
          >
            {remotes.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button
            className="button"
            type="button"
            disabled={disabled}
            onClick={() => void action("fetch", { remote })}
          >
            获取
          </button>
          <button
            className="button"
            type="button"
            disabled={disabled || Boolean(status?.dirty) || !status?.branch}
            onClick={() =>
              void action("pull", { remote, branch: status?.branch })
            }
          >
            <ArrowDown size={12} />
            拉取
          </button>
          <button
            className="button"
            type="button"
            disabled={disabled || !status?.branch}
            onClick={() => void action("push", { remote })}
          >
            <ArrowUp size={12} />
            推送
          </button>
        </div>
      )}
      {busy && <small className="git-notice">Agent 运行中 · 可审阅</small>}
      {status && Boolean(status.operation || status.conflicts.length) && (
        <small className="git-notice">
          {status.conflicts.length
            ? "存在冲突，请在编辑器中解决后暂存"
            : "正在进行合并或变基，请先完成"}
        </small>
      )}
      {error && (
        <p className="git-error" role="alert">
          {error}
        </p>
      )}
      <div className="git-review-body">
        <div className="git-file-list">
          {list(staged, true)}
          {list(unstaged, false)}
          {status && !status.files.length && (
            <div className="git-clean">
              <Check size={16} />
              没有未提交改动
            </div>
          )}
        </div>
        {selected && (
          <div className={`git-diff review-${reviewControlLocation}`}>
            <header>
              <strong title={selected.path}>{selected.path}</strong>
              <span>{selected.staged ? "已暂存" : "未暂存"}</span>
            </header>
            <div className="git-diff-content"><DiffReview text={diff} preview={diffPreview} context={context} path={selected.path} staged={selected.staged} call={call} canComment={canComment}/></div>
            {canWrite && reviewReady && status?.files.some(file=>file.path===selected.path && (selected.staged?file.staged:file.unstaged)) && <div className="git-review-controls" role="toolbar" aria-label="当前文件 Git 审阅按钮">
              <button type="button" className="button" disabled={disabled} aria-label={`${selected.staged?"取消暂存":"暂存"} ${selected.path}`} title={selected.path} onClick={()=>void action(selected.staged?"unstage":"stage",{paths:[selected.path]})}>{selected.staged?<Minus size={13}/>:<Plus size={13}/>} {selected.staged?"取消暂存":"暂存"}</button>
            </div>}
          </div>
        )}
      </div>
      <form
        className="git-commit"
        onSubmit={(event) => {
          event.preventDefault();
          void action("commit", { message });
        }}
      >
        <textarea
          aria-label="提交说明"
          placeholder="提交说明"
          rows={2}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          maxLength={20000}
        />
        <button
          className="button primary"
          type="submit"
          disabled={
            disabled ||
            !staged.length ||
            !message.trim() ||
            Boolean(status?.conflicts.length)
          }
        >
          提交 {staged.length ? `(${staged.length})` : ""}
        </button>
      </form>
    </section>
  );
}
