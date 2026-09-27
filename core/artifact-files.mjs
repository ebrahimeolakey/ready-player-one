import { createHash } from "node:crypto";
import { redactText } from "./secure-store.mjs";
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const textExtensions = new Set([
  "md",
  "html",
  "htm",
  "txt",
  "csv",
  "json",
  "yaml",
  "yml",
  "xml",
  "js",
  "jsx",
  "ts",
  "tsx",
  "css",
  "py",
  "sql",
  "sh",
  "log",
]);
export function fileType(path) {
  const ext = path.split(".").at(-1)?.toLowerCase();
  if (ext === "md") return { kind: "markdown", mime: "text/markdown" };
  if (["html", "htm"].includes(ext)) return { kind: "html", mime: "text/html" };
  if (textExtensions.has(ext)) return { kind: "text", mime: "text/plain" };
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext))
    return { kind: "image", mime: `image/${ext === "jpg" ? "jpeg" : ext}` };
  if (ext === "pdf") return { kind: "pdf", mime: "application/pdf" };
  return { kind: "file", mime: "application/octet-stream" };
}
export function filePayload(bytes, path) {
  if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES)
    throw Error("文件须为 8 MB 以内的非空文件");
  if (["markdown", "html", "text"].includes(fileType(path).kind)) {
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (!content.trim()) throw Error("文件内容为空");
    if (redactText(content) !== content)
      throw Error("文件包含疑似凭据，不能共享");
    return { content };
  }
  if (
    fileType(path).kind === "pdf" &&
    bytes.subarray(0, 5).toString() !== "%PDF-"
  )
    throw Error("PDF 文件格式无效");
  return { encoding: "base64", content: bytes.toString("base64") };
}
export function validateFile(a, path) {
  if (
    typeof a.content !== "string" ||
    a.content.length > MAX_ARTIFACT_BYTES * 1.4
  )
    throw Error("文件内容无效或过大");
  if (a.encoding && a.encoding !== "base64") throw Error("文件编码无效");
  const bytes = Buffer.from(
    a.content,
    a.encoding === "base64" ? "base64" : "utf8",
  );
  if (a.encoding === "base64" && bytes.toString("base64") !== a.content)
    throw Error("文件编码无效");
  const payload = filePayload(bytes, path);
  return {
    ...payload,
    ...fileType(path),
    size: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}
export function storedBytes(value, version) {
  const bytes = Buffer.from(
    value.content,
    value.encoding === "base64" ? "base64" : "utf8",
  );
  if (createHash("sha256").update(bytes).digest("hex") !== version.hash)
    throw Error("产物内容校验失败");
  return bytes;
}
