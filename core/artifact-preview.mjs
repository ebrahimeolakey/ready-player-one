const escape = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
export function artifactDocument(content, kind) {
  if (typeof content !== "string" || !content.trim()) throw Error("产物为空");
  let body = content;
  if (kind === "markdown") {
    let code = false;
    body =
      content
        .split("\n")
        .map((line) => {
          if (line.startsWith("```")) {
            code = !code;
            return code ? "<pre><code>" : "</code></pre>";
          }
          if (code) return escape(line) + "\n";
          const heading = /^(#{1,6})\s+(.*)$/.exec(line);
          if (heading)
            return `<h${heading[1].length}>${escape(heading[2])}</h${heading[1].length}>`;
          return line.trim()
            ? `<p>${escape(line).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</p>`
            : "";
        })
        .join("\n") + (code ? "</code></pre>" : "");
  } else if (kind !== "html") throw Error("不支持的产物类型");
  // First beta previews static documents. Scripts, network, forms, navigation
  // popups and same-origin privileges are not granted to artifact content.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><style>body{font:15px/1.65 system-ui,sans-serif;margin:28px;color:#20242b;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#f3f4f6;padding:14px;border-radius:8px}img{max-width:100%}</style></head><body>${body}</body></html>`;
}
