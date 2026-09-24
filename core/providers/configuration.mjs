import { redactText } from "../secure-store.mjs";

// Public model identifiers only. Never copy an adapter's runtime config or credentials.
export function publicConfiguration(value) {
  const result = {};
  for (const [key, max] of [["model", 150], ["effort", 40]]) {
    const raw = value[key];
    if (raw == null || raw === "") { result[key] = null; continue; }
    if (typeof raw !== "string" || !raw.trim() || raw.length > max) throw Error("模型配置名称无效或过长");
    const label = raw.trim();
    if (/[\x00-\x1f\x7f]/.test(raw) || redactText(label) !== label || /\b(?:sk-|gh[pousr]_|github_pat_|AKIA|ASIA|eyJ)[A-Za-z0-9_.-]*/.test(label) || /(?:https?:\/\/|bearer\s|api[_-]?key\s*[:=])/i.test(label)) throw Error("模型配置只能包含公开名称");
    result[key] = label;
  }
  return result;
}

export function emitReportedConfiguration(run, model, effort = null) {
  let configuration;
  try { configuration = publicConfiguration({ model, effort }); } catch { return; }
  if (!configuration.model && !configuration.effort) return;
  const key = JSON.stringify(configuration);
  if (run.reportedConfigurationKey === key) return;
  run.reportedConfigurationKey = key;
  run.emit({ type: "configuration", ...configuration });
}
