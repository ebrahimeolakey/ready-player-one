import { PdfArtifact } from "./PdfArtifact";
import { useEffect, useState } from "react";
import type { ArtifactVersion } from "./project-types";
import { artifactDocument } from "../core/artifact-preview.mjs";
import { officePreview, type OfficeSection } from "./office-preview";

export function ArtifactFile({
  version,
  content,
  name,
  source = false,
}: {
  version: ArtifactVersion;
  content: string;
  name: string;
  source?: boolean;
}) {
  const [url, setURL] = useState(""),
    [sections, setSections] = useState<OfficeSection[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    setSections([]);
    setError("");
    setURL("");
    if (version.encoding !== "base64") return;
    const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
    const objectURL = URL.createObjectURL(
      new Blob([bytes], { type: version.mime || "application/octet-stream" }),
    );
    setURL(objectURL);
    let live = true;
    if (/\.(xlsx|docx|pptx)$/i.test(name))
      void officePreview(bytes, name)
        .then((value) => {
          if (live) setSections(value);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
      URL.revokeObjectURL(objectURL);
    };
  }, [version.id, content, name]);
  if (version.encoding !== "base64") {
    if (source || version.kind === "text")
      return <pre className="artifact-source">{content}</pre>;
    return (
      <iframe
        className="artifact-frame"
        title={`产物 v${version.number}`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={artifactDocument(
          content,
          version.kind === "html" ? "html" : "markdown",
        )}
      />
    );
  }
  if (version.kind === "image")
    return (
      <div className="artifact-file-preview">
        <img src={url} alt={name} />
      </div>
    );
  if (version.kind === "pdf")
    return <PdfArtifact key={version.id} content={content} />;
  return (
    <div className="artifact-file-preview">
      {sections.length ? (
        <>
          <small>内容预览 · 表格显示已保存的计算结果；完整格式请下载查看</small>
          {sections.map((s, i) => (
            <section key={i}>
              <h3>{s.name}</h3>
              {s.rows ? (
                <div className="artifact-sheet-scroll">
                  <table>
                    <tbody>
                      {s.rows.map((row, j) => (
                        <tr key={j}>
                          {row.map((cell, k) => (
                            <td key={k}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                s.paragraphs?.map((p, j) => <p key={j}>{p}</p>)
              )}
            </section>
          ))}
        </>
      ) : (
        <p>{error || "文件已共享，可下载查看完整内容。"}</p>
      )}
    </div>
  );
}
