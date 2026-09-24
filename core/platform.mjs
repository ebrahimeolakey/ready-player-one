import { win32, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

export function platformEnv(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  const windows = platform === "win32";
  const pathKey =
    Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  const result = { ...env };
  for (const key of Object.keys(result))
    if (key.toLowerCase() === "path") delete result[key];
  const paths = windows
    ? [
        win32.join(home, ".local", "bin"),
        win32.join(env.ProgramFiles || "C:\\Program Files", "Git", "cmd"),
        win32.join(env.ProgramFiles || "C:\\Program Files", "GitHub CLI"),
        win32.join(env.SystemRoot || "C:\\Windows", "System32"),
        win32.join(
          env.SystemRoot || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
        ),
      ]
    : [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        join(home, ".local/bin"),
        "/Applications/ChatGPT.app/Contents/Resources",
        "/Applications/Codex.app/Contents/Resources",
      ];
  result.PATH = [
    ...new Set(
      [
        ...(windows && env.RPO_BIN_DIR
          ? [
              win32.join(env.RPO_BIN_DIR, "codex-package", "bin"),
              win32.join(env.RPO_BIN_DIR, "codex-package", "codex-path"),
            ]
          : []),
        env.RPO_BIN_DIR,
        ...(env[pathKey] || "").split(windows ? ";" : ":"),
        ...paths,
      ].filter(Boolean),
    ),
  ].join(windows ? ";" : ":");
  return result;
}

export function shellCommand(command, platform = process.platform) {
  return platform === "win32"
    ? [
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      ]
    : [platform === "darwin" ? "/bin/zsh" : "/bin/bash", ["-lc", command]];
}

export function binaryName(name, platform = process.platform) {
  return platform === "win32" ? `${name}.exe` : name;
}

// Windows has no Unix process groups. taskkill also terminates descendants.
export function stopProcess(
  child,
  signal = "SIGTERM",
  platform = process.platform,
) {
  if (!child) return;
  if (platform === "win32" && Number.isInteger(child.pid) && child.pid > 0) {
    const killer = spawn(
      "taskkill.exe",
      ["/pid", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    killer.on("error", () => child.kill?.());
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill?.(signal);
  }
}
