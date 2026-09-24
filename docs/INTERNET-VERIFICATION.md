# 公网协作协议验收

运行：`node scripts/verify-internet.mjs --run`。不带 `--run` 只打印说明，不启动网络服务。

脚本只使用本机已存在的 cloudflared，不安装组件、不登录 Cloudflare、不创建命名隧道或其他持久云资源。每次创建独立临时目录、内存随机加密密钥、加密 Hub、两个 HubClient 和临时 Cloudflare Quick Tunnel。测试数据全部合成，不读取应用真实 Hub、账号或邀请。公开 endpoint、邀请凭据、认证 secret 不输出到日志。

两个客户端（包括房主）都连接同一公网 `wss://*.trycloudflare.com` endpoint；没有将房主客户端走 localhost 当作双端公网。Hub 只监听本机回环地址，由 cloudflared 转发。

测试范围：

1. 两个客户端经公网 WSS 认证；邀请只暴露一个工作区。
2. Viewer 创建计划、评论、Agent 通道被拒，状态没有写入。
3. 房主将成员升级为 Editor；成员创建计划/评论同步到房主。
4. 执行请求未经批准不能领取，批准后只有执行所属成员可领取；工具请求未经决定不能领取，拒绝结果正确传递。
5. 多段流式转录合并；主动断开成员 WebSocket 后由 HubClient 自动重连，身份保留；同一执行 reconcile，重复 eventId 不产生重复转录，完整导出一致。
6. Hub 与转录加密文件不含测试明文或邀请字符串。
7. 撤销邀请使在线成员以 1008 关闭，旧凭据重新认证被拒绝。

测试总时限 180 秒，正常完成/异常/SIGINT/SIGTERM 均清理两个客户端、隧道进程、Hub 和临时目录。不会执行真正的 Codex/Claude 任务或文件工具；任务与工具是用于检查协作协议的合成事件。端点使用 WSS 传输加密，数据在 Cloudflare 转发；这不是端到端加密声明。

## 结果边界

此次验收是**同一台 Mac 上两个独立客户端经真实公网中继**。它不能称为两台实体电脑实测，也不覆盖不同运营商/企业防火墙、Mac/Windows 混合客户端、图形界面操作或房主离线。两个实体设备及不同网络的同事验收仍需另外进行。

## 2026-09-24 实测记录

最终完整运行于北京时间 **15:17:13**（UTC `2026-09-24T07:17:13.755Z`）通过全部 7 组断言，进程退出码为 0。使用本机现有 cloudflared `2026.9.1`，两个独立 HubClient 均通过真实 Cloudflare Quick Tunnel 公网 WSS。

最终输出：

```json
{
  "result": "PASS",
  "checks": 7,
  "transport": "public Cloudflare Quick Tunnel WSS",
  "clients": 2,
  "physicalComputers": 1,
  "providerExecution": false,
  "timestamp": "2026-09-24T07:17:13.755Z"
}
```

撤销邀请的在线连接关闭码实测为 `1008`，旧邀请重新认证被拒。临时客户端、隧道进程、Hub 和加密数据目录均在结束后清理。

过程中第一轮通过重连/转录断言后，验收脚本误读 `hub.json` 而非加密文件路径，导致检查失败；已修正为 `SecureStore.path()`。第二轮发生公网 TLS 握手前连接中断并清理退出。第三轮完成全部检查。以上记录保留网络不稳定事实，不把重试后的通过解释为公网连接永不失败。
