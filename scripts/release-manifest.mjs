import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
const root = resolve(process.argv[2] || "release");
const version =
  process.argv[3] ||
  JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
const filenames = (await readdir(root)).filter(
  (name) =>
    name.startsWith(`Ready-Player-One-${version}-`) &&
    /\.(zip|exe|AppImage)$/.test(name),
);
if (!filenames.length)
  throw new Error("No built release assets for selected version");
const artifacts = [];
for (const name of filenames.sort()) {
  const path = join(root, name);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const match =
    /-(mac|windows|linux)-(arm64|x64)(?:-setup)?\.(zip|exe|AppImage)$/.exec(
      name,
    );
  if (!match) throw new Error(`Unsupported asset name: ${name}`);
  artifacts.push({
    name: basename(name),
    platform: match[1],
    arch: match[2],
    format: match[3],
    size: (await stat(path)).size,
    sha256: hash.digest("hex"),
  });
}
const manifest = {
  schemaVersion: 1,
  repository: "ebrahimeolakey/ready-player-one",
  version,
  artifacts,
};
// Never overwrite published/build artifacts or a previous manifest silently.
await writeFile(
  join(root, `updates-${version}.json`),
  JSON.stringify(manifest, null, 2) + "\n",
  { flag: "wx" },
);
await writeFile(
  join(root, `SHA256SUMS-${version}.txt`),
  artifacts.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n") + "\n",
  { flag: "wx" },
);
console.log(`Created manifest for ${artifacts.length} assets (${version})`);
