import { useEffect, useState } from "react";
import { Plus, Trash2, TerminalSquare } from "lucide-react";
import { Modal, type Call } from "./ui";
function errorText(error: unknown) {
  if (error instanceof SyntaxError) return "参数和环境变量需要使用有效的 JSON";
  const message = (
    error instanceof Error ? error.message : String(error)
  ).replace(/^Error invoking remote method 'rpo:invoke': Error: /, "");
  if (/\bENOENT\b/.test(message))
    return "未找到本机程序。请先安装，或填写程序的完整路径。";
  if (/\bEACCES\b|\bEPERM\b/.test(message))
    return "无法启动此程序，请检查文件的执行权限。";
  return message;
}
type ACP = {
  id?: string;
  name: string;
  command: string;
  args: string[];
  model?: string;
  modeId?: string;
  readOnlyModeId?: string;
  legacyModelApi?: boolean;
  envNames?: string[];
  hasEnvironment?: boolean;
};
export function ACPSetup({ call }: { call: Call }) {
  const [providers, setProviders] = useState<ACP[]>([]),
    [editing, setEditing] = useState<ACP | null>(null),
    [args, setArgs] = useState("[]"),
    [env, setEnv] = useState(""),
    [removeEnv, setRemoveEnv] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState("");
  const refresh = async () => {
    try {
      setProviders(await call("providers.acp.list"));
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const edit = (p: ACP) => {
    setEditing(p);
    setArgs(JSON.stringify(p.args));
    setEnv("");
    setRemoveEnv(false);
    setError("");
    setResult("");
  };
  async function save() {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      await call("providers.acp.save", {
        ...editing,
        args: JSON.parse(args),
        ...(env.trim() ? { env: JSON.parse(env) } : {}),
        removeEnv,
      });
      setEditing(null);
      setEnv("");
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function probe(p: ACP) {
    setBusy(true);
    setError("");
    setResult("");
    try {
      const r = await call("providers.acp.probe", { id: p.id });
      setResult(
        r.requiresAuth
          ? `${p.name}：请先在此 CLI 完成登录`
          : `${p.name}：已连接 · ${r.models.length} 个模型`,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="provider-setup">
      <div className="provider-setup-heading">
        <strong>本机 ACP</strong>
        <button
          className="button"
          onClick={() => edit({ name: "", command: "", args: [] })}
        >
          <Plus size={13} />
          添加
        </button>
      </div>
      {providers.map((p) => (
        <div className="setting-card" key={p.id}>
          <TerminalSquare size={17} />
          <button className="provider-config-row grow" onClick={() => edit(p)}>
            <strong>{p.name}</strong>
            <small>{p.command}</small>
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={() => void probe(p)}
          >
            测试连接
          </button>
          <button
            className="icon-button"
            disabled={busy}
            aria-label={"删除 " + p.name}
            onClick={async () => {
              try {
                await call("providers.acp.remove", { id: p.id });
                await refresh();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {result && (
        <p className="small-note" role="status">
          {result}
        </p>
      )}
      {!editing && error && (
        <p role="alert" className="provider-error">
          {error}
        </p>
      )}
      {editing && (
        <Modal
          title={editing.id ? "编辑 ACP" : "添加 ACP"}
          close={() => {
            if (!busy) {
              setEditing(null);
              setEnv("");
            }
          }}
        >
          <form
            className="provider-config-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {!editing.id && (
              <div className="provider-effort-options">
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    edit({
                      name: "OpenCode",
                      command: "opencode",
                      args: ["acp"],
                    })
                  }
                >
                  OpenCode
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    edit({
                      name: "Hermes",
                      command: "hermes",
                      args: ["acp"],
                      legacyModelApi: true,
                    })
                  }
                >
                  Hermes
                </button>
              </div>
            )}
            <label>
              名称
              <input
                required
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </label>
            <label>
              程序
              <input
                required
                value={editing.command}
                placeholder="opencode 或完整路径"
                onChange={(e) =>
                  setEditing({ ...editing, command: e.target.value })
                }
              />
            </label>
            <label>
              参数
              <input
                required
                value={args}
                placeholder={'["acp"]'}
                onChange={(e) => setArgs(e.target.value)}
              />
            </label>
            <details>
              <summary>高级</summary>
              <div className="provider-config-form">
                <label>
                  默认模型
                  <input
                    value={editing.model || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, model: e.target.value })
                    }
                  />
                </label>
                <label>
                  编辑模式 ID
                  <input
                    value={editing.modeId || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, modeId: e.target.value })
                    }
                  />
                </label>
                <label>
                  只读模式 ID
                  <input
                    title="须由此 Agent 提供真实的只读模式；未配置时不能用只读模式执行"
                    value={editing.readOnlyModeId || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, readOnlyModeId: e.target.value })
                    }
                  />
                </label>
                <label>
                  环境变量
                  <textarea
                    autoComplete="off"
                    placeholder={
                      editing.hasEnvironment
                        ? "已保存；留空保持原配置"
                        : '{"API_KEY":"…"}'
                    }
                    value={env}
                    onChange={(e) => {
                      setEnv(e.target.value);
                      setRemoveEnv(false);
                    }}
                  />
                </label>
                {editing.hasEnvironment && (
                  <label className="provider-checkbox">
                    <input
                      type="checkbox"
                      checked={removeEnv}
                      onChange={(e) => {
                        setRemoveEnv(e.target.checked);
                        if (e.target.checked) setEnv("");
                      }}
                    />
                    清除已保存的环境变量
                  </label>
                )}
                <label className="provider-checkbox">
                  <input
                    type="checkbox"
                    checked={editing.legacyModelApi || false}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        legacyModelApi: e.target.checked,
                      })
                    }
                  />
                  兼容旧模型目录
                </label>
              </div>
            </details>
            <small>使用已安装并登录的本机 CLI。测试连接会启动此程序。</small>
            {error && (
              <p role="alert" className="provider-error">
                {error}
              </p>
            )}
            <button className="button primary" disabled={busy}>
              保存
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
