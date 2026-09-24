import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
if (process.platform !== "linux")
  throw new Error(
    "Linux packages require a Linux build host: node-pty has no bundled Linux binary. Run this script on Linux or in the documented container.",
  );
const arch = process.argv[2] || process.arch;
if (!["x64", "arm64"].includes(arch) || arch !== process.arch)
  throw new Error("Build on a Linux host matching the target architecture");
// Linux node-pty requires compilation for Electron, not the host Node ABI.
await exec("npm", ["run", "build"], { maxBuffer: 8 * 1024 * 1024 });
await exec("npx", ["electron-builder", "install-app-deps", `--arch=${arch}`], {
  env: { ...process.env, npm_config_build_from_source: "true" },
  maxBuffer: 16 * 1024 * 1024,
});
await exec(
  "npx",
  [
    "electron-builder",
    "--linux",
    "AppImage",
    "zip",
    `--${arch}`,
    "--publish",
    "never",
  ],
  { maxBuffer: 16 * 1024 * 1024 },
);
console.log(
  `Linux ${arch} AppImage and ZIP built. Run the native and desktop smoke tests before publishing.`,
);
