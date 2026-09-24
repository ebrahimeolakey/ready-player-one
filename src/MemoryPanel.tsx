import { useState, useEffect } from "react";
import { Brain, FileCode2, Pencil, Plus, RefreshCw } from "lucide-react";
import type { State } from "./types";
import { Empty, Modal, type Call } from "./ui";
type Reference = { path: string; hash?: string; commit: string };
type Memory = State["memories"][number] & {
  files?: Reference[];
  stale?: boolean;
  staleFiles?: { path: string }[];
};
export function MemoryPanel({
  state,
  workspaceId,
  call,
}: {
  state: State;
  workspaceId: string;
  call: Call;
}) {
  const [editing, setEditing] = useState<Memory | "new" | null>(null),
    [title, setTitle] = useState(""),
    [text, setText] = useState(""),
    [paths, setPaths] = useState(""),
    [busy, setBusy] = useState(false),
    [showRetired, setShowRetired] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    setEditing(null);
    setNotice("");
  }, [workspaceId]);
  const role = state.me?.host
    ? "owner"
    : state.me?.roles?.[workspaceId] || state.me?.role || "viewer";
  const canEdit = !!workspaceId && ["owner", "editor"].includes(role);
  const mapped = !!state.local.paths[workspaceId];
  const memories = (state.memories as Memory[]).filter(
    (m) => m.workspaceId === workspaceId,
  );
  const visible = memories.filter((m) => showRetired || !m.retired);
  const edit = (memory: Memory | "new") => {
    setEditing(memory);
    setTitle(memory === "new" ? "" : memory.title);
    setText(memory === "new" ? "" : memory.text);
    setPaths(
      memory === "new"
        ? ""
        : (memory.files || []).map((f) => f.path).join("\n"),
    );
    setNotice("");
  };
  const references = async (list: string[]) =>
    list.length
      ? await call("references.files", { workspaceId, paths: list })
      : [];
  const save = async () => {
    if (!editing || !title.trim() || !text.trim()) return;
    setBusy(true);
    try {
      const pathsList = [
        ...new Set(
          paths
            .split("\n")
            .map((p) => p.trim())
            .filter(Boolean),
        ),
      ];
      const oldPaths =
        editing === "new" ? null : (editing.files || []).map((f) => f.path);
      const changed =
        !oldPaths || JSON.stringify(pathsList) !== JSON.stringify(oldPaths);
      const files = changed ? await references(pathsList) : undefined;
      if (changed && !files) return;
      const result = await call(
        editing === "new" ? "memory.add" : "memory.update",
        {
          workspaceId,
          ...(editing === "new" ? {} : { id: editing.id }),
          title,
          text,
          ...(changed ? { files } : {}),
        },
      );
      if (result) setEditing(null);
    } finally {
      setBusy(false);
    }
  };
  const check = async (items: Memory[]) => {
    const refs = [
      ...new Map(
        items.flatMap((m) => m.files || []).map((f) => [f.path, f]),
      ).values(),
    ];
    if (!refs.length) {
      setNotice("没有关联文件");
      return;
    }
    setBusy(true);
    try {
      for (let i = 0; i < refs.length; i += 100) {
        const files = await call("references.check", {
          workspaceId,
          references: refs.slice(i, i + 100),
        });
        if (!files) return;
        const result = await call("memory.check", { workspaceId, files });
        if (!result) return;
      }
      setNotice("已检查本机文件");
    } finally {
      setBusy(false);
    }
  };
  const updateReferences = async (memory: Memory) => {
    setBusy(true);
    try {
      const files = await references((memory.files || []).map((f) => f.path));
      if (!files) return;
      const result = await call("memory.update", {
        workspaceId,
        id: memory.id,
        files,
      });
      if (result) setNotice("引用已更新");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <header className="page-heading">
        <h1>共享记忆</h1>
        <div className="grow" />
        <button
          className="button"
          disabled={!canEdit || !mapped || busy}
          onClick={() => check(memories.filter((m) => !m.retired))}
        >
          <RefreshCw size={14} />
          检查过期
        </button>
        <button
          className="button primary"
          disabled={!canEdit}
          onClick={() => edit("new")}
        >
          <Plus size={14} />
          新建
        </button>
      </header>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(e) => setShowRetired(e.target.checked)}
          />{" "}
          显示停用
        </label>
        {notice && <small role="status">{notice}</small>}
      </div>
      {visible.map((memory) => (
        <article
          className={"memory-card " + (memory.retired ? "retired" : "")}
          key={memory.id}
        >
          <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ flex: 1 }}>{memory.title}</h3>
            {memory.stale && <small className="warning">已过期</small>}
            {memory.retired && <small>已停用</small>}
          </header>
          <p style={{ whiteSpace: "pre-wrap" }}>{memory.text}</p>
          {!!memory.files?.length && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: 12,
              }}
            >
              {memory.files.map((file) => (
                <span
                  key={file.path}
                  title={
                    memory.staleFiles?.some((f) => f.path === file.path)
                      ? "文件已变化或不可用"
                      : "已绑定文件版本"
                  }
                  style={{
                    display: "inline-flex",
                    gap: 4,
                    alignItems: "center",
                    fontSize: 12,
                  }}
                >
                  <FileCode2 size={12} />
                  {file.path}
                </span>
              ))}
            </div>
          )}
          <footer>
            <small>{memory.owner}</small>
            <div style={{ display: "flex", gap: 8 }}>
              {!!memory.files?.length && !memory.retired && (
                <>
                  <button
                    className="text-button"
                    disabled={!canEdit || !mapped || busy}
                    onClick={() => check([memory])}
                  >
                    检查
                  </button>
                  <button
                    className="text-button"
                    disabled={!canEdit || !mapped || busy}
                    title="确认记忆仍适用，并更新到本机文件版本"
                    onClick={() => updateReferences(memory)}
                  >
                    更新引用
                  </button>
                </>
              )}
              <button
                className="text-button"
                disabled={!canEdit}
                onClick={() => edit(memory)}
              >
                <Pencil size={12} />
                编辑
              </button>
              <button
                className="text-button"
                disabled={!canEdit}
                onClick={() =>
                  call("memory.retire", {
                    workspaceId,
                    id: memory.id,
                    retired: !memory.retired,
                  })
                }
              >
                {memory.retired ? "恢复" : "停用"}
              </button>
            </div>
          </footer>
        </article>
      ))}
      {!visible.length && <Empty icon={Brain} title="暂无记忆" />}
      {editing && (
        <Modal
          title={editing === "new" ? "新建记忆" : "编辑记忆"}
          close={() => !busy && setEditing(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              标题
              <input
                autoFocus
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </label>
            <label>
              内容
              <textarea
                value={text}
                maxLength={6000}
                rows={6}
                onChange={(e) => setText(e.target.value)}
                required
              />
            </label>
            <label>
              关联文件
              <textarea
                value={paths}
                rows={3}
                placeholder="每行一个项目内路径，可留空"
                onChange={(e) => setPaths(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={
                  busy ||
                  !title.trim() ||
                  !text.trim() ||
                  (!!paths.trim() && !mapped)
                }
              >
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
