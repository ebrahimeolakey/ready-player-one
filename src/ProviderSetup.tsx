import { useEffect, useState } from "react";
import { Globe, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { Modal, type Call } from "./ui";
import "./provider-controls.css";

export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  models: string[];
  hasKey: boolean;
  updatedAt: string;
}
export function ProviderSetup({
  call,
  onChanged,
}: {
  call: Call;
  onChanged?: () => void;
}) {
  const [providers, setProviders] = useState<CustomProvider[]>([]),
    [editing, setEditing] = useState<Partial<CustomProvider> | null>(null),
    [apiKey, setApiKey] = useState(""),
    [removeKey, setRemoveKey] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  async function refresh() {
    try {
      setProviders(await call("providers.custom.list"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  function edit(provider: Partial<CustomProvider>) {
    setApiKey("");
    setRemoveKey(false);
    setError("");
    setEditing(provider);
  }
  async function save() {
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      await call("providers.custom.save", { ...editing, apiKey, removeKey });
      setApiKey("");
      setEditing(null);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }
  async function remove(provider: CustomProvider) {
    setError("");
    try {
      await call("providers.custom.remove", { id: provider.id });
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  }
  return (
    <section className="provider-setup">
      <div className="provider-setup-heading">
        <strong>自定义 API</strong>
        <button
          type="button"
          className="button"
          onClick={() => edit({ name: "", baseUrl: "", model: "", models: [] })}
        >
          <Plus size={13} />
          添加
        </button>
      </div>
      {loading && <LoaderCircle size={16} className="spin" />}
      {providers.map((provider) => (
        <div className="setting-card" key={provider.id}>
          <Globe size={17} />
          <button
            type="button"
            className="provider-config-row grow"
            onClick={() => edit(provider)}
          >
            <strong>{provider.name}</strong>
            <small>
              {provider.model} · {provider.hasKey ? "密钥已保存" : "无密钥"}
            </small>
          </button>
          <button
            type="button"
            className="icon-button"
            title={`删除 ${provider.name}`}
            aria-label={`删除 ${provider.name}`}
            onClick={() => void remove(provider)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {!editing && error && (
        <p className="provider-error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <Modal
          title={editing.id ? "编辑 API" : "添加 API"}
          close={() => {
            if (!saving) {
              setApiKey("");
              setEditing(null);
            }
          }}
        >
          <form
            className="provider-config-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              名称
              <input
                required
                maxLength={80}
                value={editing.name || ""}
                placeholder="我的模型"
                onChange={(event) =>
                  setEditing({ ...editing, name: event.target.value })
                }
              />
            </label>
            <label>
              API 地址
              <input
                required
                type="url"
                value={editing.baseUrl || ""}
                placeholder="https://api.example.com/v1"
                onChange={(event) =>
                  setEditing({ ...editing, baseUrl: event.target.value })
                }
              />
            </label>
            <label>
              默认模型
              <input
                required
                maxLength={200}
                value={editing.model || ""}
                placeholder="模型 ID"
                onChange={(event) =>
                  setEditing({ ...editing, model: event.target.value })
                }
              />
            </label>
            <label>
              其他模型
              <input
                value={(editing.models || []).join(", ")}
                placeholder="多个模型以逗号分隔"
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    models: event.target.value
                      .split(",")
                      .map((model) => model.trim()),
                  })
                }
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                placeholder={
                  editing.hasKey ? "已保存；留空保持原密钥" : "本机加密保存"
                }
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setRemoveKey(false);
                }}
              />
            </label>
            {editing.hasKey && (
              <label className="provider-checkbox">
                <input
                  type="checkbox"
                  checked={removeKey}
                  onChange={(event) => {
                    setRemoveKey(event.target.checked);
                    if (event.target.checked) setApiKey("");
                  }}
                />
                移除已保存的密钥
              </label>
            )}
            <small>兼容 Chat Completions · 请求发送至此 API</small>
            {error && (
              <p role="alert" className="provider-error">
                {error}
              </p>
            )}
            <button type="submit" className="button primary" disabled={saving}>
              {saving ? (
                <>
                  <LoaderCircle size={13} className="spin" />
                  保存中
                </>
              ) : (
                "保存"
              )}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
