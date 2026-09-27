import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
export function PdfArtifact({ content }: { content: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(1),
    [error, setError] = useState(""),
    [text, setText] = useState(""),
    [ready, setReady] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true,
      loading:
        | ReturnType<
            typeof import("pdfjs-dist/legacy/build/pdf.mjs").getDocument
          >
        | undefined;
    setDoc(null);
    setPage(1);
    setError("");
    setReady(false);
    void import("pdfjs-dist/legacy/build/pdf.mjs")
      .then(async (pdf) => {
        if (!live) return;
        pdf.GlobalWorkerOptions.workerSrc = new URL(
          "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
          import.meta.url,
        ).toString();
        const base = new URL("pdfjs/", window.location.href).toString();
        loading = pdf.getDocument({
          data: Uint8Array.from(atob(content), (c) => c.charCodeAt(0)),
          enableXfa: false,
          maxImageSize: 16000000,
          cMapUrl: base + "cmaps/",
          cMapPacked: true,
          standardFontDataUrl: base + "standard_fonts/",
          wasmUrl: base + "wasm/",
          iccUrl: base + "iccs/",
        });
        const value = await loading.promise;
        if (live) setDoc(value);
        else await loading.destroy();
      })
      .catch((e) => {
        if (live) setError("PDF 预览不可用，可下载原文件。");
      });
    return () => {
      live = false;
      void loading?.destroy();
    };
  }, [content]);
  useEffect(() => {
    if (!doc) return;
    let live = true,
      render: RenderTask | undefined;
    setReady(false);
    setText("");
    void (async () => {
      const pdfPage = await doc.getPage(page);
      if (!live || !canvas.current) return;
      const raw = pdfPage.getViewport({ scale: 1 }),
        viewport = pdfPage.getViewport({
          scale: Math.min(1.5, 1400 / raw.width, 1800 / raw.height),
        }),
        node = canvas.current;
      node.width = Math.ceil(viewport.width);
      node.height = Math.ceil(viewport.height);
      render = pdfPage.render({ canvas: node, viewport });
      await render.promise;
      const words = await pdfPage.getTextContent();
      if (live) {
        setText(
          words.items.map((item) => ("str" in item ? item.str : "")).join(" "),
        );
        setReady(true);
      }
    })().catch((e) => {
      if (live && e.name !== "RenderingCancelledException")
        setError("PDF 页面加载失败，可下载原文件。");
    });
    return () => {
      live = false;
      render?.cancel();
    };
  }, [doc, page]);
  return (
    <div className="artifact-file-preview artifact-pdf" data-pdf-ready={ready}>
      {doc && (
        <div className="room-actions">
          <button
            disabled={page <= 1 || !ready}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </button>
          <span>
            {page} / {doc.numPages}
          </span>
          <button
            disabled={page >= doc.numPages || !ready}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      )}
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <canvas ref={canvas} aria-label={text || "PDF 页面"} />
          {!ready && <p>正在载入 PDF…</p>}
        </>
      )}
    </div>
  );
}
