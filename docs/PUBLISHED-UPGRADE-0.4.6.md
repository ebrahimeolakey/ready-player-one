# 已发布 Mac 版本的界面升级验证

2026-09-25，在 Apple Silicon Mac 上，将已发布 0.4.5-beta.1 的应用包复制到独立临时 Applications 目录，使用独立测试数据。未替换用户日常安装的应用，未调用模型或真实账号。

通过真实旧版界面保存测试昵称及编辑器字号 17，然后点击“检查更新”，识别公开发布的 0.4.6-beta.1；点击“下载更新”及“安装并重启”。没有改写更新地址、替换下载文件或模拟更新接口。

结果：

- 从公开 GitHub Release 下载的 Mac arm64 ZIP，SHA256 与发行清单一致。
- 真实独立更新进程替换应用、保留完整旧包备份并自动启动新版。
- 两阶段数据 / Renderer 健康检查成功，持久记录状态为 `confirmed`，HMAC 确认收据通过校验。
- 新应用完整 bundle 摘要等于事务预期；旧备份完整 bundle 摘要等于更新前预期。
- 新包 ASAR SHA256：`52cdb24e4bbfcd836e5cd3bde8eb869a90b9b6e4987e352f2599dabbb2dbf906`。
- 旧包备份 ASAR SHA256：`a0ca42dddd266287a56aab5eb982ebe0ed80fdf300ebe57fd8966995f5414877`。
- 新版 UI 显示 0.4.6-beta.1，测试昵称、字号 17 和预先保存的通用偏好均保留，能正常打开设置。

[结构化证据](evidence/published-upgrade-0.4.6.json)。公开安装包的完整摘要另见 [Mac 包核对](evidence/mac-package-0.4.6.json)。

这次关闭了 Apple Silicon 上 0.4.5 → 0.4.6 正常升级的实际发行包验收缺口。没有在此次真实发行包升级中故意制造失败或触发回滚；失败门禁与恢复仍依据独立自动化 / Electron 实验，不能混为本次实际失败回滚记录。Intel、Windows 安装升级、Gatekeeper 首次安装，以及其他版本/业务数据代际组合仍需分别验证。
