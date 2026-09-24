import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ImagePlus,
  Mic,
  Square,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import type { Call } from "./ui";
import "./provider-controls.css";

export interface ProviderModel {
  id: string;
  label?: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
  default?: boolean;
}
export interface ProviderSelection {
  model: string;
  effort: string;
}
export interface ProviderImage {
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
}
const efforts: Record<string, string> = {
  none: "无",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "极高",
};

export function ProviderControls({
  value,
  onChange,
  models: provided,
  loadModels,
  disabled = false,
}: {
  value: ProviderSelection;
  onChange: (value: ProviderSelection) => void;
  models?: ProviderModel[];
  loadModels?: () => Promise<ProviderModel[]>;
  disabled?: boolean;
}) {
  const [models, setModels] = useState<ProviderModel[]>(provided || []),
    [search, setSearch] = useState(""),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const root = useRef<HTMLDetailsElement>(null);
  const active = models.find((model) => model.id === value.model);
  useEffect(() => {
    if (provided) setModels(provided);
  }, [provided]);
  const shown = useMemo(
    () =>
      models.filter((model) =>
        `${model.id} ${model.label || ""}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()),
      ),
    [models, search],
  );
  async function reload() {
    if (!loadModels) return;
    setLoading(true);
    setError("");
    try {
      setModels(await loadModels());
    } catch (e) {
      setError(e instanceof Error ? e.message : "模型读取失败");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="provider-controls">
      <details
        ref={root}
        className="provider-model-picker"
        onToggle={(event) => {
          if (event.currentTarget.open && !models.length && !loading)
            void reload();
        }}
      >
        <summary
          aria-label="选择模型"
          aria-disabled={disabled}
          onClick={(event) => {
            if (disabled) event.preventDefault();
          }}
        >
          {active?.label || value.model || "默认模型"}
          <ChevronDown size={12} />
        </summary>
        <div className="provider-model-popover">
          <label className="provider-search">
            <Search size={14} />
            <input
              autoComplete="off"
              placeholder="搜索模型"
              aria-label="搜索模型"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="provider-model-list" role="listbox" aria-label="模型">
            <button
              type="button"
              role="option"
              aria-selected={!value.model}
              onClick={() => {
                onChange({ model: "", effort: "" });
                if (root.current) root.current.open = false;
              }}
            >
              默认模型{!value.model && <Check size={14} />}
            </button>
            {shown.map((model) => (
              <button
                type="button"
                key={model.id}
                role="option"
                aria-selected={model.id === value.model}
                title={model.description}
                onClick={() => {
                  onChange({
                    model: model.id,
                    effort: model.defaultEffort || "",
                  });
                  if (root.current) root.current.open = false;
                }}
              >
                <span>
                  {model.label || model.id}
                  <small>{model.id}</small>
                </span>
                {model.id === value.model && <Check size={14} />}
              </button>
            ))}
          </div>
          {error && (
            <small role="alert" className="provider-error">
              {error}
            </small>
          )}
          {loadModels && (
            <button
              type="button"
              className="provider-reload"
              disabled={loading}
              onClick={() => void reload()}
            >
              {loading ? (
                <>
                  <LoaderCircle size={12} className="spin" />
                  读取中
                </>
              ) : (
                "刷新模型"
              )}
            </button>
          )}
        </div>
      </details>
      {Boolean(active?.efforts?.length) && (
        <select
          className="provider-effort"
          aria-label="推理强度"
          value={value.effort}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, effort: event.target.value })
          }
        >
          <option value="">默认强度</option>
          {active!.efforts!.map((effort) => (
            <option key={effort} value={effort}>
              {efforts[effort] || effort}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function ImageAttachments({
  images,
  onChange,
  call,
  disabled = false,
}: {
  images: ProviderImage[];
  onChange: (images: ProviderImage[]) => void;
  call: Call;
  disabled?: boolean;
}) {
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  async function pick() {
    setLoading(true);
    setError("");
    try {
      const selected = (await call("providers.images.pick")) as ProviderImage[];
      if (images.length + selected.length > 5)
        throw new Error("最多添加 5 张图片");
      onChange([...images, ...selected]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "图片读取失败");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="provider-image-attachments">
      <button
        className="icon-button"
        type="button"
        title="添加图片"
        aria-label="添加图片"
        disabled={disabled || loading || images.length >= 5}
        onClick={() => void pick()}
      >
        {loading ? (
          <LoaderCircle size={15} className="spin" />
        ) : (
          <ImagePlus size={15} />
        )}
      </button>
      {images.map((image, index) => (
        <div className="provider-image-thumb" key={`${index}-${image.name}`}>
          <img
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={image.name}
          />
          <button
            type="button"
            aria-label={`移除 ${image.name}`}
            title="移除图片"
            disabled={disabled}
            onClick={() => onChange(images.filter((_, i) => i !== index))}
          >
            <X size={10} />
          </button>
        </div>
      ))}
      {error && (
        <small className="provider-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

export function DictationControl({
  supported,
  listening,
  busy = false,
  onStart,
  onStop,
  error,
}: {
  supported: boolean;
  listening: boolean;
  busy?: boolean;
  onStart: () => void;
  onStop: () => void;
  error?: string;
}) {
  if (!supported) return null;
  return (
    <span className="provider-dictation">
      <button
        type="button"
        className="icon-button"
        aria-label={listening ? "停止语音输入" : "语音输入"}
        title={listening ? "停止语音输入" : "语音输入"}
        aria-pressed={listening}
        disabled={busy}
        onClick={listening ? onStop : onStart}
      >
        {busy ? (
          <LoaderCircle size={15} className="spin" />
        ) : listening ? (
          <Square size={13} />
        ) : (
          <Mic size={15} />
        )}
      </button>
      {error && (
        <small className="provider-error" role="alert">
          {error}
        </small>
      )}
    </span>
  );
}
