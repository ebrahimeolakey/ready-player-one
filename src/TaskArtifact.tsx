import { ArtifactActions } from "./ArtifactActions";
import { ArtifactFile } from "./ArtifactFile";
import { useEffect, useRef, useState } from "react";
import { Check, Code, RefreshCw, FileText } from "lucide-react";
import type { State } from "./types";
import type { ArtifactVersion, ProjectTask } from "./project-types";
import { artifactDocument } from "../core/artifact-preview.mjs";
import type { Call } from "./ui";

export function ArtifactPanel({
  task,
  state,
  call,
  onError,
  canAccept,
  worker,
}: {
  task: ProjectTask;
  state: State;
  call: Call;
  onError: (s: string) => void;
  canAccept: boolean;
  worker: boolean;
}) {
  const versions =
      state.collaboration?.artifactVersions.filter(
        (v) => v.taskId === task.id,
      ) || [],
    latest = versions.at(-1);
  const [chosen, setChosen] = useState(""),
    [cache, setCache] = useState<Record<string, string>>({}),
    [source, setSource] = useState(false),
    [comment, setComment] = useState(""),
    [anchor, setAnchor] = useState(""),
    [pending, setPending] = useState(false);
  const selected = versions.find(
      (v) => v.id === (chosen || task.previewVersionId),
    ),
    checking =
      latest?.previewStatus === "pending" && ["html","markdown"].includes(latest.kind) &&
      latest.runId === task.runId &&
      ["running", "review"].includes(task.status)
        ? latest
        : undefined;
  const reported = useRef(new Set<string>());
  useEffect(() => {
    if (checking) reported.current.delete(checking.id);
  }, [checking?.id]);
  const action = async (fn: () => Promise<unknown>) => {
    setPending(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    let live = true;
    for (const v of [selected, checking])
      if (v && !cache[v.id])
        void call("collab.artifact.read", { versionId: v.id })
          .then((value: ArtifactVersion) => {
            if (live) setCache((c) => ({ ...c, [v.id]: value.content || "" }));
          })
          .catch((e) => {
            if (live) onError(e.message);
          });
    return () => {
      live = false;
    };
  }, [selected?.id, checking?.id, state.local.online]);
  const check = (version: ArtifactVersion, loaded: boolean) => {
    if (reported.current.has(version.id)) return;
    reported.current.add(version.id);
    void call("collab.artifact.check", {
      taskId: task.id,
      versionId: version.id,
      hash: version.hash,
      loaded,
    }).catch((e) => {
      reported.current.delete(version.id);
      onError(e.message);
    });
  };
  const comments =
    state.collaboration?.artifactComments.filter((c) => c.taskId === task.id) ||
    [];
  return (
    <div className="artifact-panel">
      <div className="artifact-toolbar">
        <select
          aria-label="产物版本"
          value={selected?.id || ""}
          onChange={(e) => setChosen(e.target.value)}
        >
          <option value="" disabled>
            {versions.length ? "预览准备中" : "尚无产物"}
          </option>
          {versions
            .filter((v) => v.previewStatus === "ready")
            .map((v) => (
              <option key={v.id} value={v.id}>
                v{v.number}
                {v.id === task.acceptedVersionId ? " · 已验收" : ""}
              </option>
            ))}
        </select>
        {selected?.encoding !== "base64" && <button
          title={source ? "查看预览" : "查看源文件"}
          aria-label={source ? "查看预览" : "查看源文件"}
          onClick={() => setSource(!source)}
        >
          <Code size={15} />
        </button>}
        {selected && <ArtifactActions key={selected.id} version={selected} state={state} projectId={task.projectId} path={task.artifactPath} driUserId={task.driUserId} call={call} onError={onError}/>}
        {worker && task.runId && ["running","review"].includes(task.status) && (
          <button
            disabled={pending}
            title="更新产物"
            aria-label="更新产物"
            onClick={() =>
              void action(() =>
                call("collab.artifact.capture", { taskId: task.id }),
              )
            }
          >
            <RefreshCw size={15} />
          </button>
        )}
        {canAccept &&
          task.status === "review" &&
          selected?.id === task.previewVersionId && selected?.id === latest?.id &&
          selected?.runId === task.runId && (
            <button
              disabled={pending}
              onClick={() =>
                void action(() =>
                  call("collab.task.accept", {
                    taskId: task.id,
                    revision: task.revision,
                    versionId: selected?.id,
                  }),
                )
              }
            >
              <Check size={14} />
              验收
            </button>
          )}
      </div>
      {checking && cache[checking.id] && (
        <iframe
          className="artifact-check"
          title="产物渲染检查"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={artifactDocument(cache[checking.id], checking.kind === "html" ? "html" : "markdown")}
          onLoad={() => check(checking, true)}
          onError={() => check(checking, false)}
        />
      )}
      {latest?.previewStatus === "failed" && (
        <p className="room-error">新版本预览失败，保留上一版。</p>
      )}
      {selected && cache[selected.id] ? (
        <ArtifactFile version={selected} content={cache[selected.id]} name={task.artifactPath} source={source}/>
      ) : (
        <div className="room-empty">
          <FileText size={24} />
          <p>{checking ? "正在检查预览" : `等待 ${task.artifactPath}`}</p>
        </div>
      )}
      {selected && (
        <div className="artifact-comments">
          {comments.map((c) => (
            <p key={c.id}>
              <small>
                {c.anchor}
                {c.versionId !== selected.id ? " · 旧版本，待重新定位" : ""}
              </small>
              {c.text}
            </p>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await call("collab.artifact.comment", {
                  taskId: task.id,
                  versionId: selected.id,
                  anchor: anchor || "整份产物",
                  text: comment,
                  requestKey: crypto.randomUUID(),
                });
                setComment("");
              });
            }}
          >
            <input
              aria-label="评论位置"
              placeholder="位置，例如：页面标题"
              value={anchor}
              onChange={(e) => setAnchor(e.target.value)}
            />
            <div className="room-actions">
              <input
                aria-label="产物评论"
                placeholder={`评论 v${selected.number}…`}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <button disabled={pending || !comment.trim()}>评论</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
