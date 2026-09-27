// Read a bounded subset of OOXML for display. No formulas, macros, links or embedded objects execute.
export type OfficeSection = {
  name: string;
  rows?: string[][];
  paragraphs?: string[];
};
async function zipEntries(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    result = new Map<string, string>();
  let end = bytes.length - 22;
  while (
    end >= Math.max(0, bytes.length - 65557) &&
    view.getUint32(end, true) !== 0x06054b50
  )
    end--;
  if (end < 0 || end < bytes.length - 65557)
    throw Error("文档预览不可用，请下载原文件");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true),
    total = 0;
  if (count > 3000) throw Error("文档内容过多，请下载查看");
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw Error("文档目录无效");
    const method = view.getUint16(at + 10, true),
      size = view.getUint32(at + 20, true),
      length = view.getUint16(at + 28, true),
      extra = view.getUint16(at + 30, true),
      comment = view.getUint16(at + 32, true),
      offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(at + 46, at + 46 + length),
    );
    at += 46 + length + extra + comment;
    if (
      !/^(xl\/(sharedStrings|workbook|worksheets\/sheet\d+)\.xml|word\/document\.xml|ppt\/slides\/slide\d+\.xml)$/.test(
        name,
      )
    )
      continue;
    if (view.getUint32(offset, true) !== 0x04034b50)
      throw Error("文档数据无效");
    const start =
      offset +
      30 +
      view.getUint16(offset + 26, true) +
      view.getUint16(offset + 28, true);
    const data = bytes.slice(start, start + size);
    let decoded: Uint8Array;
    if (method === 0) decoded = data;
    else if (method === 8) {
      const reader = new Blob([data])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw"))
          .getReader(),
        chunks: Uint8Array[] = [];
      let len = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        len += value.length;
        if (len + total > 16 * 1024 * 1024) {
          await reader.cancel();
          throw Error("文档展开内容过大，请下载查看");
        }
        chunks.push(value);
      }
      decoded = new Uint8Array(len);
      let p = 0;
      for (const chunk of chunks) {
        decoded.set(chunk, p);
        p += chunk.length;
      }
    } else throw Error("文档压缩格式不支持预览");
    total += decoded.length;
    if (total > 16 * 1024 * 1024) throw Error("文档内容过大，请下载查看");
    result.set(name, new TextDecoder().decode(decoded));
  }
  return result;
}
function xml(text: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw Error("文档 XML 无法预览");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw Error("文档 XML 无法预览");
  return doc;
}
const tags = (node: Document | Element, name: string) =>
  Array.from(node.getElementsByTagNameNS("*", name));
export async function officePreview(
  bytes: Uint8Array,
  name: string,
): Promise<OfficeSection[]> {
  const files = await zipEntries(bytes);
  if (/\.xlsx$/i.test(name)) {
    const shared = files.has("xl/sharedStrings.xml")
      ? tags(xml(files.get("xl/sharedStrings.xml")!), "si").map((si) =>
          tags(si, "t")
            .map((t) => t.textContent || "")
            .join(""),
        )
      : [];
    return [...files]
      .filter(([path]) => /^xl\/worksheets\//.test(path))
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .slice(0, 10)
      .map(([path, text]) => ({
        name: path.split("/").at(-1)!.replace(".xml", ""),
        rows: tags(xml(text), "row")
          .slice(0, 200)
          .map((row) => {
            const cells: string[] = [];
            for (const c of tags(row, "c")) {
              const ref = c.getAttribute("r") || "",
                letters = ref.match(/^[A-Z]+/)?.[0];
              let index = letters
                ? [...letters].reduce(
                    (n, l) => n * 26 + l.charCodeAt(0) - 64,
                    0,
                  ) - 1
                : cells.length;
              if (index > 99) continue;
              while (cells.length < index) cells.push("");
              const v = tags(c, "v")[0]?.textContent || "";
              cells[index] = (
                c.getAttribute("t") === "s"
                  ? shared[Number(v)] || ""
                  : c.getAttribute("t") === "inlineStr"
                    ? tags(c, "t")
                        .map((t) => t.textContent || "")
                        .join("")
                    : v
              ).slice(0, 10000);
            }
            return cells;
          }),
      }));
  }
  return [...files]
    .filter(
      ([path]) =>
        path === "word/document.xml" || path.startsWith("ppt/slides/"),
    )
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, 100)
    .map(([path, text]) => ({
      name:
        path === "word/document.xml"
          ? "文档"
          : path.split("/").at(-1)!.replace(".xml", ""),
      paragraphs: tags(xml(text), "p")
        .slice(0, 1000)
        .map((p) =>
          tags(p, "t")
            .map((t) => t.textContent || "")
            .join(""),
        )
        .filter(Boolean),
    }));
}
