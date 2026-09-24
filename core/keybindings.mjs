export const KEYBOARD_ACTIONS = [
  { id: "searchSessions", label: "搜索会话", binding: "Mod+KeyK" },
  { id: "newAgent", label: "新建 Agent", binding: "Mod+Shift+KeyL" },
  { id: "toggleTerminal", label: "展开 / 收起终端", binding: "Mod+KeyJ" },
  { id: "searchFiles", label: "查找文件", binding: "Mod+KeyP" },
  { id: "sendPrompt", label: "发送任务", binding: "Mod+Enter" },
  { id: "saveFile", label: "保存文件", binding: "Mod+KeyS" },
  { id: "stopRun", label: "停止当前 Agent", binding: "Escape" },
];
const modifiers = ["Meta", "Control", "Alt", "Shift"];
const keyPattern =
  /^(Key[A-Z]|Digit[0-9]|Enter|Escape|Space|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-2]))$/;
export function defaultBindings(os = "darwin") {
  return Object.fromEntries(
    KEYBOARD_ACTIONS.map((a) => [
      a.id,
      a.binding.replace("Mod", os === "darwin" ? "Meta" : "Control"),
    ]),
  );
}
export function parseBinding(value) {
  if (typeof value !== "string" || value.length > 70)
    throw Error("快捷键格式无效");
  const parts = value.split("+"),
    code = parts.pop();
  if (
    !keyPattern.test(code || "") ||
    parts.some((p) => !modifiers.includes(p)) ||
    new Set(parts).size !== parts.length
  )
    throw Error("快捷键格式无效");
  return { code, modifiers: modifiers.filter((m) => parts.includes(m)) };
}
export function validateBindings(overrides, os = "darwin") {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw Error("快捷键设置无效");
  if (
    Object.keys(overrides).some(
      (id) => !KEYBOARD_ACTIONS.some((a) => a.id === id),
    )
  )
    throw Error("未知快捷键操作");
  const values = { ...defaultBindings(os), ...overrides },
    seen = new Map();
  for (const action of KEYBOARD_ACTIONS) {
    const raw = values[action.id];
    if (raw === "") continue; // Explicitly disabled.
    const { code, modifiers: mods } = parseBinding(raw);
    const hasPrimary = mods.includes(os === "darwin" ? "Meta" : "Control");
    if (code === "Escape" && (action.id !== "stopRun" || mods.length))
      throw Error("Esc 保留用于停止 Agent 和关闭弹窗");
    if (
      code !== "Escape" &&
      !mods.includes("Meta") &&
      !mods.includes("Control")
    )
      throw Error("请使用包含 Command 或 Ctrl 的组合键");
    if (
      (hasPrimary && /^(Key[ACVXYZQWRHM]|Tab)$/.test(code)) ||
      (code === "F4" && mods.includes("Alt")) ||
      (code === "F12" && !mods.length)
    )
      throw Error("此组合键由系统或编辑菜单使用");
    if (os !== "darwin" && mods.includes("Meta"))
      throw Error("Windows / Linux 请使用 Ctrl 组合键");
    const canonical = [...mods, code].join("+");
    if (seen.has(canonical)) throw Error(`与「${seen.get(canonical)}」重复`);
    seen.set(canonical, action.label);
    values[action.id] = canonical;
  }
  return values;
}
export function bindingFromEvent(event) {
  if (
    event.isComposing ||
    event.nativeEvent?.isComposing ||
    event.keyCode === 229 ||
    !keyPattern.test(event.code || "")
  )
    return null;
  return [
    ...modifiers.filter(
      (m) =>
        event[
          {
            Meta: "metaKey",
            Control: "ctrlKey",
            Alt: "altKey",
            Shift: "shiftKey",
          }[m]
        ],
    ),
    event.code,
  ].join("+");
}
export function matchesBinding(event, action, overrides = {}, os = "darwin") {
  if (event.defaultPrevented || event.repeat) return false;
  const value = overrides[action] ?? defaultBindings(os)[action];
  return !!value && bindingFromEvent(event) === value;
}
export function formatBinding(value, os = "darwin") {
  if (!value) return "未设置";
  const { code, modifiers: mods } = parseBinding(value);
  const names =
    os === "darwin"
      ? { Meta: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" }
      : { Meta: "Win", Control: "Ctrl", Alt: "Alt", Shift: "Shift" };
  const key =
    {
      Enter: "↵",
      Escape: "Esc",
      Space: "Space",
      ArrowUp: "↑",
      ArrowDown: "↓",
      ArrowLeft: "←",
      ArrowRight: "→",
    }[code] || code.replace(/^(Key|Digit)/, "");
  return [...mods.map((m) => names[m]), key].join(os === "darwin" ? "" : "+");
}
