// node-pty 1.1 ships Node-API binaries for Mac/Windows. npm may strip the helper's executable bit.
import { chmod, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("node-pty/package.json"));
if (process.platform !== "win32") {
  for (const arch of await readdir(join(root, "prebuilds"))) {
    if (arch.startsWith("darwin-"))
      await chmod(join(root, "prebuilds", arch, "spawn-helper"), 0o755);
  }
}
