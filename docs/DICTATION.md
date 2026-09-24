# 原生 Mac 语音输入

实现使用 Apple `SFSpeechRecognizer` + `AVAudioEngine`，**只启用本机识别**（`requiresOnDeviceRecognition=true`），不使用不可靠的 Web Speech 占位按钮，也不自动把录音发送到服务商。用户点击开始才请求语音识别和麦克风授权；状态探测不请求授权、不录音。

## 构建与集成

```sh
node desktop/services/build-dictation.mjs
```

在 Mac 上用 Xcode Command Line Tools 编译，产物 `release/native/rpo-dictation` 为 arm64/x86_64 通用二进制。打包时放进 `extraResources`，实际运行从 `process.resourcesPath` 找到 helper。无需要求使用者安装 Swift。发布签名/公证必须把 helper 一起签入应用。

主应用 Info.plist 需包含 `NSMicrophoneUsageDescription` 和 `NSSpeechRecognitionUsageDescription`（helper 自身也嵌入了用途说明）；Hardened Runtime 签名需为麦克风加入 `com.apple.security.device.audio-input`。安装包缺这些项目时不能宣称语音可用。

```js
const dictation = new DictationService({ helperPath, onEvent });
const capability = await dictation.probe("zh-CN"); // 无录音
await dictation.start("zh-CN"); // 仅在用户点击麦克风后调用
// 事件 listening / transcript {text,final} / error / stopped / closed
// transcript 是本轮完整文字，输入框应替换本轮听写段，不逐条重复追加。
dictation.stop();
dictation.close(); // 应用退出时终止子进程
```

最多单次 60 秒，停止后等待最终转写最多 5 秒。没有本机语言资源时返回不可用，不偷偷改为云端。Windows 当前不提供此原生语音组件。

## 验证边界

2026-09-24 在当前 Mac 上实际 swiftc 编译通过；`--probe --locale zh-CN` 返回 `available=true / onDevice=true`，语音授权仍为未决定。没有主动录音或代替用户授予系统权限，因此 **尚未验收真实麦克风转写**。需要在安装包内由用户主动点击后完成首次授权，再验证识别、停止和撤销权限状态。Intel 二进制交叉编译不等于 Intel Mac 实机验证。

依据 Apple 官方文档：[本机识别支持](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition)、[授权要求](<https://developer.apple.com/documentation/speech/sfspeechrecognizer/requestauthorization(_:)>)、[SpeechRecognizer](https://developer.apple.com/documentation/speech/sfspeechrecognizer)。新 `SpeechAnalyzer` 要求更高系统版本，本版选择覆盖更多 Mac 的 Speech API。

## IPC 与订阅

建议 `dictation.probe({locale})`、`dictation.start({locale,targetId})`、`dictation.stop()`；调用服务 `start(locale, {targetId})`。返回 `{started,sessionId}` 表示子进程已启动，只有收到 `listening` 才表示麦克风实际开始录音。首次系统授权等待期间显示 busy。所有事件带 `sessionId / targetId`，避免多个通道输入框误收同一段转写。

主进程将服务 `onEvent` 发送到专用 `rpo:dictation` channel；preload 暴露 `subscribeDictation(callback)`，只转发此 channel 并返回取消订阅函数。不要放入共享 Hub 状态。开发态用 `dictationHelperPath({appPath:app.getAppPath(),resourcesPath:process.resourcesPath,isPackaged:app.isPackaged})` 自动定位 `release/native/rpo-dictation`。`npm start` / `npm run desktop` / Mac 打包脚本会自动增量编译；Windows 自动跳过。
