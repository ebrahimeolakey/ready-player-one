import { createContext, useContext, useState } from "react";
import {
  KEYBOARD_ACTIONS,
  defaultBindings,
  matchesBinding,
  formatBinding,
  bindingFromEvent,
  validateBindings,
  type KeyboardInput,
} from "../core/keybindings.mjs";
import type { Call } from "./ui";
export const KeyboardContext = createContext<{
  os?: string;
  bindings?: Record<string, string>;
}>({});
export function shortcutsAllowed(target: EventTarget | null) {
  return (
    !document.querySelector('[role="dialog"]') &&
    !(
      target instanceof Element &&
      target.closest(".xterm, [data-shortcut-capture]")
    )
  );
}
export function useKeyboard() {
  const { os = "darwin", bindings = {} } = useContext(KeyboardContext);
  return {
    matches: (event: KeyboardInput, action: string) =>
      matchesBinding(event, action, bindings, os),
    label: (action: string) =>
      formatBinding(bindings[action] ?? defaultBindings(os)[action], os),
    bindings,
    os,
  };
}
export function KeyboardSettings({
  bindings = {},
  os = "darwin",
  call,
}: {
  bindings?: Record<string, string>;
  os?: string;
  call: Call;
}) {
  const [capturing, setCapturing] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const current = { ...defaultBindings(os), ...bindings };
  async function save(next: Record<string, string>) {
    setBusy(true);
    setError("");
    try {
      await call("settings.keyboard", { bindings: validateBindings(next, os) });
      setCapturing("");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(
              /^Error invoking remote method 'rpo:invoke': Error: /,
              "",
            )
          : String(e),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="keyboard-settings" data-shortcut-capture>
      {KEYBOARD_ACTIONS.map((action) => (
        <div className="setting-card" key={action.id}>
          <span className="grow">{action.label}</span>
          <button
            className="button keyboard-capture"
            aria-label={`修改${action.label}快捷键`}
            disabled={busy}
            onClick={() => {
              setCapturing(action.id);
              setError("");
            }}
            onBlur={() => setCapturing("")}
            onKeyDown={(e) => {
              if (capturing !== action.id) return;
              if (e.key === "Tab") {
                setCapturing("");
                return;
              }
              e.preventDefault();
              e.stopPropagation();
              const value = bindingFromEvent(e);
              if (value) void save({ ...current, [action.id]: value });
            }}
          >
            <kbd>
              {capturing === action.id
                ? "按组合键…"
                : formatBinding(current[action.id], os)}
            </kbd>
          </button>
          <button
            className="button"
            disabled={busy || !current[action.id]}
            onClick={() => void save({ ...current, [action.id]: "" })}
            aria-label={`停用${action.label}快捷键`}
          >
            停用
          </button>
        </div>
      ))}
      <div className="setting-card">
        <span className="grow">关闭弹窗</span>
        <kbd>Esc</kbd>
      </div>
      {error && (
        <p className="provider-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="button"
        disabled={busy}
        onClick={() => void save(defaultBindings(os))}
      >
        恢复默认
      </button>
    </section>
  );
}
