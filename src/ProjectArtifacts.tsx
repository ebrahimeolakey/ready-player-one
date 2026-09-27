import { ArtifactActions } from "./ArtifactActions";
import { ArtifactFile } from "./ArtifactFile";
import { useEffect, useState } from "react";
import { FileText, ExternalLink, Plus } from "lucide-react";
import type { State } from "./types";
import type { ArtifactVersion, ProjectTask } from "./project-types";
import { ArtifactPanel } from "./TaskArtifact";
import { artifactDocument } from "../core/artifact-preview.mjs";
import type { Call } from "./ui";

type Output = NonNullable<
  NonNullable<State["collaboration"]>["outputs"]
>[number];
export function ProjectArtifacts({
  state,
  projectId,
  call,
  onOpenTask,
  onOpenSession,
}: {
  state: State;
  projectId: string;
  call: Call;
  onOpenTask?: (id: string) => void;
  onOpenSession?: (id: string) => void;
}) {
  const [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [adding, setAdding] = useState(false),
    [lane, setLane] = useState(""),
    [busy, setBusy] = useState(false);
  const data = state.collaboration,
    versions = data?.artifactVersions || [];
  const tasks = (data?.tasks || []).filter(
    (t) =>
      t.projectId === projectId &&
      t.kind !== "planning" &&
      versions.some((v) => v.taskId === t.id),
  );
  const outputs = (data?.outputs || []).filter(
    (o) => o.projectId === projectId,
  );
  const cards = [
    ...tasks.map((task) => ({
      id: task.id,
      name: task.parentTaskId ? task.goal : task.artifactPath,
      sessionId: task.sessionId,
      task,
      output: undefined as Output | undefined,
    })),
    ...outputs.map((output) => ({
      id: output.id,
      name: output.name,
      sessionId: output.sessionId,
      output,
      task: undefined as ProjectTask | undefined,
    })),
  ];
  const current = cards.find((c) => c.id === selected) || cards[0];
  const me = state.me?.id,
    ownLanes = state.sessions
      .filter((s) => s.projectId === projectId && s.status === "active")
      .flatMap((s) =>
        s.lanes
          .filter((l) => l.ownerId === me)
          .map((l) => ({
            sessionId: s.id,
            laneId: l.id,
            title: s.title,
            provider: l.provider,
          })),
      );
  const chosenLane = ownLanes.find((l) => l.laneId === lane) || ownLanes[0];
  useEffect(() => {
    setSelected("");
    setError("");
    setAdding(false);
  }, [projectId]);
  return (
    <section className="project-artifacts-view" aria-label="项目产物">
      <div className="project-artifacts-list">
        <header>
          <strong>
            全部产物 <small>{cards.length}</small>
          </strong>
          <button
            disabled={!ownLanes.length}
            title="选择会话中的文件，保存后持续共享到项目；单文件最大 8 MB"
            onClick={() => setAdding(!adding)}
          >
            <Plus size={14} />
            共享产物
          </button>
        </header>
        {adding && (
          <div className="artifact-add">
            <select
              aria-label="产物来源会话"
              value={chosenLane?.laneId || ""}
              onChange={(e) => setLane(e.target.value)}
            >
              {ownLanes.map((l) => (
                <option value={l.laneId} key={l.laneId}>
                  {l.title} · {l.provider}
                </option>
              ))}
            </select>
            <button
              disabled={busy || !chosenLane}
              onClick={async () => {
                if (!chosenLane) return;
                setBusy(true);
                setError("");
                try {
                  const o = await call("collab.output.track", chosenLane);
                  if (o) {
                    setSelected(o.id);
                    setAdding(false);
                  }
                } catch (e) {
                  setError(String((e as Error).message));
                } finally {
                  setBusy(false);
                }
              }}
            >
              选择文件
            </button>
          </div>
        )}
        {!cards.length && (
          <div className="room-empty">
            <FileText size={26} />
            <p>项目的成果，集中在这里</p>
            <small>任务产物自动同步；其他会话可选择文件共享。</small>
          </div>
        )}
        {cards.map((card) => {
          const list = versions.filter((v) =>
              card.task ? v.taskId === card.id : v.outputId === card.id,
            ),
            latest = list.at(-1),
            session = state.sessions.find((s) => s.id === card.sessionId),
            worker = card.task?.workerId || card.output?.workerId,
            person = state.members.find((m) => m.id === worker)?.name || "成员",
            sync = state.local.artifactSync?.[card.id];
          return (
            <button
              className={`project-output-card ${current?.id === card.id ? "selected" : ""}`}
              key={card.id}
              onClick={() => setSelected(card.id)}
            >
              <FileText size={17} />
              <span>
                <strong>{card.name}</strong>
                <small>{session?.title || card.task?.goal}</small>
                <small>
                  {person} · {latest ? `v${latest.number}` : "等待文件"}
                  {sync?.status === "error"
                    ? ` · ${sync.message}`
                    : latest?.previewStatus === "failed"
                      ? " · 新版预览失败"
                      : ""}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      {error && (
        <div role="alert" className="room-error">
          {error}
        </div>
      )}
      {current && (
        <div className="project-output-preview">
          <header>
            <strong>{current.name}</strong>
            <button
              onClick={() =>
                current.task
                  ? onOpenTask?.(current.id)
                  : current.sessionId && onOpenSession?.(current.sessionId)
              }
            >
              <ExternalLink size={14} />
              打开来源会话
            </button>
          </header>
          {current.task ? (
            <ArtifactPanel
              key={current.id}
              task={current.task}
              state={state}
              call={call}
              onError={setError}
              canAccept={current.task.driUserId === me}
              worker={current.task.workerId === me}
            />
          ) : (
            current.output && (
              <SessionOutput
                key={current.id}
                output={current.output}
                versions={versions.filter((v) => v.outputId === current.id)}
                state={state}
                call={call}
                onError={setError}
              />
            )
          )}
        </div>
      )}
    </section>
  );
}
function SessionOutput({
  output,
  versions,
  state,
  call,
  onError,
}: {
  output: Output;
  versions: ArtifactVersion[];
  state: State;
  call: Call;
  onError: (v: string) => void;
}) {
  const [cache, setCache] = useState<Record<string, string>>({}),
    [chosen, setChosen] = useState("");
  const latest = versions.at(-1),
    selected =
      versions.find((v) => v.id === chosen) ||
      versions.find((v) => v.id === output.previewVersionId) ||
      latest;
  const editor = ["owner", "editor"].includes(
    state.me?.roles?.[output.teamId] || state.me?.role || "",
  );
  useEffect(() => {
    let live = true;
    for (const v of [latest, selected])
      if (v && !cache[v.id])
        void call("collab.output.read", { versionId: v.id })
          .then((result: ArtifactVersion) => {
            if (live) setCache((c) => ({ ...c, [v.id]: result.content || "" }));
          })
          .catch((e) => live && onError(e.message));
    return () => {
      live = false;
    };
  }, [latest?.id, selected?.id]);
  const check = (loaded: boolean) => {
    if (latest && editor)
      void call("collab.output.check", {
        outputId: output.id,
        versionId: latest.id,
        hash: latest.hash,
        loaded,
      }).catch((e) => onError(e.message));
  };
  return (
    <div className="artifact-panel">
      <div className="artifact-toolbar">
        <select
          aria-label="共享产物版本"
          value={chosen}
          onChange={(e) => setChosen(e.target.value)}
        >
          <option value="">跟随最新版本</option>
          {versions
            .filter((v) => v.previewStatus === "ready")
            .map((v) => (
              <option value={v.id} key={v.id}>
                v{v.number}
              </option>
            ))}
        </select>
        <small>文件保存后自动同步</small>
        {selected && <ArtifactActions key={selected.id} version={selected} state={state} projectId={output.projectId} path={output.path} call={call} onError={onError}/>}
        {selected?.id === latest?.id && selected?.previewStatus === "ready" && !selected.approval && state.collaboration?.projects.find(p=>p.id===output.projectId)?.driUserId === state.me?.id && <button onClick={()=>void call("collab.output.approve",{outputId:output.id,versionId:selected.id}).catch(e=>onError(e.message))}>DRI 审批</button>}
      </div>
      {latest?.previewStatus === "pending" && ["html","markdown"].includes(latest.kind) && cache[latest.id] && editor && (
        <iframe
          className="artifact-check"
          title="共享产物渲染检查"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={artifactDocument(cache[latest.id], latest.kind === "html" ? "html" : "markdown")}
          onLoad={() => check(true)}
          onError={() => check(false)}
        />
      )}
      {latest?.previewStatus === "failed" && (
        <p className="room-error">新版预览失败，保留上一版。</p>
      )}
      {selected && cache[selected.id] ? (
        <ArtifactFile version={selected} content={cache[selected.id]} name={output.path}/>
      ) : (
        <div className="room-empty">等待文件同步…</div>
      )}
    </div>
  );
}
