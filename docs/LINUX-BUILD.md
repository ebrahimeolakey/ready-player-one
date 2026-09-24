# Linux 构建与验收

当前工作机为 macOS arm64。2026-09-24 已检查：没有 Docker、Podman、OrbStack CLI、Colima、Lima、QEMU、Multipass 或 Tart；GitHub Actions 虽允许运行，但仓库没有 workflow，当前登录权限不含 workflow。没有重复尝试已知会被拒绝的 workflow 写入。

因此没有把 Mac 交叉生成的压缩包冒充已验证 Linux 版本。`node-pty 1.1` 目前依赖包只自带 darwin / win32 预编译二进制；Linux 终端必须在 Linux 环境编译原生模块。

## 在 Linux 主机上

要求与目标相同的 x64 / arm64 Linux、Node 22+、npm、Python 3、make、g++、图形库及 AppImage 构建依赖。

```sh
npm ci
npm run distribute:linux
npm run release:manifest
```

脚本会构建 UI、运行 Electron 原生依赖编译，再构建同架构 AppImage 和 ZIP。`package.json` 已配置 `Ready-Player-One-${version}-linux-${arch}.AppImage / .zip`。在非 Linux 上直接退出，避免误发包含 Mac 原生模块的包。

构建后的必要验收：

1. 用 `file` / `readelf -h` 检查 AppImage、ZIP 中主程序及 `pty.node` 均为同一 Linux 架构。
2. 在真实 Linux 或 Xvfb 中启动桌面程序，验证登录、文件编辑与终端交互；检查生产日志没有模块载入错误。
3. 运行终端 `printf LINUX_PTY_OK` 并确认输出，确认 Ctrl+C 和关闭后没有孤儿进程。
4. 验证 AppImage 运行环境所需 FUSE，以及 `APPIMAGE` 路径的原位更新。
5. 最后生成 SHA256 和 manifest，上传 GitHub Release；不要在运行前标记为实机验收通过。

## 容器路径

已提供 `docs/linux-build.Dockerfile`，使用 electron-builder 官方构建镜像并明确复制源码，防止将 Mac node_modules 带进容器。

```sh
docker build --platform linux/amd64 -f docs/linux-build.Dockerfile -t rpo-linux-build .
docker create --name rpo-linux-artifacts rpo-linux-build
docker cp rpo-linux-artifacts:/project/release ./release-linux
docker rm rpo-linux-artifacts
```

目标 arm64 时需有支持 arm64 的相应 Linux 构建镜像/主机；不能仅替换文件名。容器构建并不自动完成真实桌面验收。构建路径参考 [electron-builder 官方跨平台文档](https://www.electron.build/docs/features/multi-platform-build/)。

目前状态：构建配置与脚本已完成；**AppImage / ZIP 尚无可用 Linux 执行环境进行实际构建和验收**。
