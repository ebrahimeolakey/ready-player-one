import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn) {
  const end = Date.now() + 18000;
  while (!(await fn())) {
    if (Date.now() > end) throw Error("Shared file UI timeout: " + fn);
    await pause(70);
  }
}
// Minimal valid ZIP fixture: checks OOXML parsing without installing a document library.
function zip(entries) {
  let offset = 0;
  const locals = [],
    central = [];
  for (const [name, text] of Object.entries(entries)) {
    const file = Buffer.from(name),
      data = Buffer.from(text),
      compressed = deflateRawSync(data),
      crc = crc32(data),
      local = Buffer.alloc(30),
      record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(file.length, 26);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(file.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(local, file, compressed);
    central.push(record, file);
    offset += local.length + file.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export async function exerciseArtifactFiles({
  invoke,
  js,
  win,
  dir,
  team,
  project,
  dialog,
}) {
  const workbook = zip({
    "xl/sharedStrings.xml":
      '<sst xmlns="urn:sheet"><si><t>活动预算</t></si></sst>',
    "xl/worksheets/sheet1.xml":
      '<worksheet xmlns="urn:sheet"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12000</v></c></row></sheetData></worksheet>',
  });
  const document = zip({
    "word/document.xml":
      '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>团队草稿，还未审批</w:t></w:r></w:p></w:body></w:document>',
  });
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  const pdfObjects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 18 Tf 20 140 Td (Shared PDF draft) Tj ET";
  pdfObjects.push(
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  );
  pdfObjects.forEach((text, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${text}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF`;
  const source = await invoke("session.create", {
      workspaceId: team.id,
      projectId: project.id,
      title: "共享草稿文件",
    }),
    lane = await invoke("lane.create", {
      sessionId: source.id,
      provider: "codex",
    });
  const files = [
    ["预算.xlsx", workbook],
    ["方案.docx", document],
    ["预览.png", image],
    ["草稿.pdf", Buffer.from(pdf)],
  ];
  for (const [name, bytes] of files)
    await writeFile(join(dir, "checkout", name), bytes);
  dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: files.map(([name]) => join(dir, "checkout", name)),
  });
  await invoke("collab.output.track", {
    sessionId: source.id,
    laneId: lane.id,
  });
  await wait(async () => {
    const s = await invoke("bootstrap");
    return files.every(
      ([name]) =>
        s.collaboration.outputs.find((o) => o.name === name)?.previewVersionId,
    );
  });
  await js(
    '[...document.querySelectorAll(".session-topbar button")].find(b=>b.textContent==="返回项目").click()',
  );
  await wait(() => js('!!document.querySelector("#project-artifacts-tab")'));
  await js('document.querySelector("#project-artifacts-tab").click()');
  await js(
    '[...document.querySelectorAll(".project-output-card")].find(b=>b.textContent.includes("预算.xlsx")).click()',
  );
  await wait(() =>
    js(
      'document.querySelector(".artifact-file-preview")?.textContent.includes("12000")',
    ),
  );
  assert.equal(
    await js(
      'document.querySelector(".artifact-file-preview").textContent.includes("活动预算")',
    ),
    true,
  );
  assert.equal(
    await js(
      'document.querySelector(".artifact-toolbar").textContent.includes("创建 GitHub PR")',
    ),
    false,
  );
  const download = join(dir, "downloaded-budget.xlsx");
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: download });
  await js('document.querySelector("[aria-label=下载当前版本]").click()');
  await wait(async () => {
    try {
      return (await readFile(download)).equals(workbook);
    } catch {
      return false;
    }
  });
  await js(
    '[...document.querySelectorAll(".artifact-toolbar button")].find(b=>b.textContent==="DRI 审批").click()',
  );
  await wait(() =>
    js(
      'document.querySelector(".artifact-toolbar").textContent.includes("创建 GitHub PR")',
    ),
  );
  await js(
    '[...document.querySelectorAll(".artifact-toolbar button")].find(b=>b.textContent.includes("创建 GitHub PR")).click()',
  );
  await wait(() => js('!!document.querySelector(".artifact-release-panel")'));
  assert.equal(
    await js(
      'document.querySelector(".artifact-release-panel").textContent.includes("预览 PR")',
    ),
    true,
  );
  await js('document.querySelector("[aria-label=关闭发布面板]").click()');
  await wait(() => js('!document.querySelector(".artifact-release-panel")'));
  win.show();
  win.focus();
  await pause(500);
  await writeFile(
    join(dir, "shared-excel.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  const changed = zip({
    "xl/worksheets/sheet1.xml":
      '<worksheet xmlns="urn:sheet"><sheetData><row><c r="A1"><v>18000</v></c></row></sheetData></worksheet>',
  });
  await writeFile(join(dir, "checkout", "预算.xlsx"), changed);
  await wait(() =>
    js(
      'document.querySelector(".artifact-file-preview")?.textContent.includes("18000")',
    ),
  );
  assert.equal(
    await js(
      'document.querySelector(".artifact-toolbar").textContent.includes("创建 GitHub PR")',
    ),
    false,
  );
  for (const [name, text] of [
    ["方案.docx", "团队草稿，还未审批"],
    ["预览.png", null],
  ]) {
    await js(
      `[...document.querySelectorAll('.project-output-card')].find(b=>b.textContent.includes(${JSON.stringify(name)})).click()`,
    );
    await wait(() =>
      js(
        text
          ? `document.querySelector('.artifact-file-preview')?.textContent.includes(${JSON.stringify(text)})`
          : 'document.querySelector(".artifact-file-preview img")?.naturalWidth===1',
      ),
    );
  }
  await js(
    '[...document.querySelectorAll(".project-output-card")].find(b=>b.textContent.includes("草稿.pdf")).click()',
  );
  await wait(async () => {
    const error = await js(
      'document.querySelector(".artifact-pdf [role=alert]")?.textContent',
    );
    if (error) throw Error(error);
    return js(
      'document.querySelector(".artifact-pdf")?.dataset.pdfReady==="true"',
    );
  });
  assert.equal(
    await js(
      'document.querySelector(".artifact-pdf canvas").getAttribute("aria-label").includes("Shared PDF draft")',
    ),
    true,
  );
  win.show();
  win.focus();
  await pause(1200);
  await writeFile(
    join(dir, "shared-pdf.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  return {
    formats: ["xlsx", "docx", "png", "pdf"],
    exactDownload: true,
    driApproval: true,
    newVersionNeedsApproval: true,
    githubWrites: 0,
  };
}
