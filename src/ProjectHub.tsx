import { useState } from "react";
import { Plus, UserPlus } from "lucide-react";
import { ProjectRoom } from "./ProjectRoom";
import { Modal, type Call } from "./ui";
import type { State } from "./types";

export function ProjectHub({
  state,
  workspace,
  onWorkspace,
  call,
  onInvite,
  onProviders,
  onOpenTask,
  onOpenSession,
  initialProjectId,
}: {
  state: State;
  workspace: string;
  onWorkspace: (id: string) => void;
  call: Call;
  onInvite: (teamId: string) => void;
  onProviders: () => void;
  onOpenTask: (id: string) => void;
  onOpenSession: (id: string) => void;
  initialProjectId?: string;
}) {
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const current =
    state.workspaces.find((w) => w.id === workspace) || state.workspaces[0];
  return (
    <div className="studio-shell">
      <nav className="studio-mode project-hub-bar" aria-label="当前团队">
        <span className="room-eyebrow">团队</span>
        <strong>{current?.name || "我的团队"}</strong>
        {state.me?.host && (
          <button className="team-create" onClick={() => setCreating(true)}>
            <Plus size={14} />
            新建团队
          </button>
        )}
        <span className="grow" />
        {current &&
          (state.me?.host || state.me?.roles?.[current.id] === "owner") && (
            <button className="button" onClick={() => onInvite(current.id)}>
              <UserPlus size={14} />
              邀请同事
            </button>
          )}
      </nav>
      {current ? (
        <ProjectRoom
          key={`${state.identity?.audience}:${state.me?.id}:${current.id}`}
          teamId={current.id}
          state={state}
          call={call}
          onInvite={
            state.me?.host || state.me?.roles?.[current.id] === "owner"
              ? () => onInvite(current.id)
              : undefined
          }
          onProviders={onProviders}
          onOpenTask={onOpenTask}
          onOpenSession={onOpenSession}
          initialProjectId={initialProjectId}
        />
      ) : (
        <div className="room-empty">
          <h3>和同事、AI 一起做一个项目</h3>
          <p>先给团队起个名字。</p>
          {state.me?.host && (
            <button onClick={() => setCreating(true)}>新建团队</button>
          )}
        </div>
      )}
      {creating && (
        <Modal title="新建团队" close={() => setCreating(false)}>
          <form
            className="room-form"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              void call("workspace.create", { name })
                .then((w) => {
                  onWorkspace(w.id);
                  setCreating(false);
                  setName("");
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <label>
              名称
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <button className="button primary" disabled={busy}>
              创建
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
