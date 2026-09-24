import { useState } from "react";
import { Modal } from "./ui";
export function toolSummary(text: string) {
  try {
    const item = JSON.parse(text);
    if (item.type === "agentMessage") return item.text || "Agent 已启动";
    if (item.type === "commandExecution") return item.command || "运行命令";
    if (item.type === "fileChange")
      return (
        "修改文件 · " + (item.changes || []).map((c: any) => c.path).join("、")
      );
    return (
      item.title ||
      item.name ||
      item.tool ||
      item.input?.command ||
      (item.tool_use_id && "工具结果") ||
      "工具执行"
    );
  } catch {
    return text.split("\n")[0].slice(0, 100) || "工具输出";
  }
}
export function MessageText({
  text,
  onBrowse,
}: {
  text: string;
  onBrowse?: (url: string) => void;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  const pieces = text.split(
    /(https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;!?，。；！？])/g,
  );
  return (
    <>
      <div className="message-text">
        {pieces.map((piece, index) => {
          let valid = false;
          if (/^https?:\/\//.test(piece)) {
            try {
              const u = new URL(piece);
              valid = !u.username && !u.password;
            } catch {}
          }
          return valid ? (
            <button
              key={index}
              type="button"
              className="message-link"
              onClick={() => {
                setUrl(piece);
                setError("");
              }}
            >
              {piece}
            </button>
          ) : (
            piece
          );
        })}
      </div>
      {url && (
        <Modal title="打开链接" close={() => setUrl("")}>
          <p className="message-link-target">{url}</p>
          <div className="modal-actions">
            {onBrowse && (
              <button
                className="button"
                onClick={() => {
                  onBrowse(url);
                  setUrl("");
                }}
              >
                在应用内打开
              </button>
            )}
            <button
              className="button primary"
              onClick={async () => {
                try {
                  await window.rpo.invoke("link.open", { url });
                  setUrl("");
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              系统浏览器
            </button>
          </div>
          {error && (
            <p role="alert" className="provider-error">
              {error}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
