import { mkdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
const exec = promisify(execFile);
if (process.platform !== "darwin") {
  console.log("Native dictation is macOS-only; skipping.");
  process.exit(0);
}
const source = fileURLToPath(new URL("./dictation.swift", import.meta.url));
const plist = fileURLToPath(new URL("./dictation-info.plist", import.meta.url));
const out = resolve(process.argv[2] || "release/native");
await mkdir(out, { recursive: true });
const universal = join(out, "rpo-dictation");
const newestSource = Math.max(
  (await stat(source)).mtimeMs,
  (await stat(plist)).mtimeMs,
  (await stat(fileURLToPath(import.meta.url))).mtimeMs,
);
try {
  if ((await stat(universal)).mtimeMs >= newestSource) {
    console.log(universal);
    process.exit(0);
  }
} catch {}
const objects = [];
for (const arch of ["arm64", "x86_64"]) {
  const file = join(out, `rpo-dictation-${arch}`);
  await exec("xcrun", [
    "swiftc",
    "-O",
    "-target",
    `${arch}-apple-macos12.0`,
    source,
    "-o",
    file,
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__info_plist",
    "-Xlinker",
    plist,
  ]);
  objects.push(file);
}
const file = join(out, "rpo-dictation");
await exec("lipo", ["-create", ...objects, "-output", file]);
console.log(file);
