import { useState } from "react";
import { Plus } from "lucide-react";
import { ProjectRoom } from "./ProjectRoom";
import { Modal, type Call } from "./ui";
import type { State } from "./types";

export function ProjectHub({
  state,
  workspace,
  onWorkspace,
  call,
}: {
  state: State;
  workspace: string;
  onWorkspace: (id: string) => void;
  call: Call;
}) {
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const current =
    state.workspaces.find((w) => w.id === workspace) || state.workspaces[0];
  return (
    <div className="studio-shell">
      <nav className="studio-mode">
        <strong>团队</strong>
        <select
          aria-label="团队"
          value={current?.id || ""}
          onChange={(e) => onWorkspace(e.target.value)}
        >
          {state.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        {state.me?.host && (
          <button
            title="新建团队"
            aria-label="新建团队"
            onClick={() => setCreating(true)}
          >
            <Plus size={16} />
          </button>
        )}
      </nav>
      {current ? (
        <ProjectRoom
          key={`${state.identity?.audience}:${state.me?.id}:${current.id}`}
          teamId={current.id}
          state={state}
          call={call}
        />
      ) : (
        <div className="room-empty">
          <p>创建团队，开始协作</p>
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
