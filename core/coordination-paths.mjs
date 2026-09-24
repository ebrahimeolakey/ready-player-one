export function filePath(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw Error("文件路径无效");
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").some(v => !v || v === ".." || v === ".git" || v === ".") || /[\x00-\x1f]/.test(path)) throw Error("文件路径无效");
  return path;
}
