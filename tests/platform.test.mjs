import test from "node:test";
import assert from "node:assert/strict";
import { platformEnv, shellCommand, binaryName } from "../core/platform.mjs";
import { assetSpec } from "../core/installers.mjs";

test("Windows PATH preserves drive letters, spaces and native Codex package resources", () => {
  const env = platformEnv(
    {
      Path: "C:\\Windows;D:\\Team Tools",
      RPO_BIN_DIR: "C:\\Users\\测试\\.rpo\\bin",
    },
    "win32",
    "C:\\Users\\测试",
  );
  assert.equal(env.Path, undefined);
  const paths = env.PATH.split(";");
  assert.ok(paths.includes("C:\\Windows"));
  assert.ok(paths.includes("D:\\Team Tools"));
  assert.ok(paths.includes("C:\\Users\\测试\\.rpo\\bin\\codex-package\\bin"));
  assert.ok(paths.includes("C:\\Program Files\\Git\\cmd"));
  assert.ok(paths.includes("C:\\Users\\测试\\.local\\bin"));
  assert.equal(
    paths.some((p) => p.includes("/opt/homebrew")),
    false,
  );
});

test("Windows shell passes the full command as one argument without shell interpolation", () => {
  const command = 'Write-Output "hello & world"';
  const [program, args] = shellCommand(command, "win32");
  assert.equal(program, "powershell.exe");
  assert.equal(args.at(-1), command);
  assert.equal(binaryName("cloudflared", "win32"), "cloudflared.exe");
  assert.equal(shellCommand("pwd", "darwin")[0], "/bin/zsh");
});

test("Windows installer selects native complete packages and rejects wrong architecture", () => {
  const codex = assetSpec("codex", "x64", "win32");
  assert.ok(codex.match("codex-package-x86_64-pc-windows-msvc.tar.gz"));
  assert.equal(codex.match("codex-x86_64-pc-windows-msvc.exe"), false);
  assert.ok(codex.bundle);
  assert.ok(
    assetSpec("github", "x64", "win32").match("gh_2.101.0_windows_amd64.zip"),
  );
  assert.ok(
    assetSpec("cloudflared", "x64", "win32").match(
      "cloudflared-windows-amd64.exe",
    ),
  );
  assert.throws(() => assetSpec("codex", "arm64", "win32"));
});
