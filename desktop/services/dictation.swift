import Foundation
import AVFoundation
import Speech

// Native, on-device-only speech recognition. The host starts this helper only
// after the user presses its microphone button. --probe never asks permission.
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let text = String(data: data, encoding: .utf8) else { return }
    print(text)
    fflush(stdout)
}
let localeIndex = CommandLine.arguments.firstIndex(of: "--locale")
let locale = localeIndex.flatMap { $0 + 1 < CommandLine.arguments.count ? CommandLine.arguments[$0 + 1] : nil } ?? "zh-CN"
let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
if CommandLine.arguments.contains("--probe") {
    emit(["type": "capability", "locale": locale,
          "available": recognizer?.isAvailable ?? false,
          "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
          "speechAuthorization": SFSpeechRecognizer.authorizationStatus().rawValue,
          "microphoneAuthorization": AVCaptureDevice.authorizationStatus(for: .audio).rawValue])
    exit(0)
}
let engine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
var task: SFSpeechRecognitionTask?
var finished = false
var tapping = false
var stopping = false
func finish(_ message: String? = nil) {
    if finished { return }; finished = true
    engine.stop()
    if tapping { engine.inputNode.removeTap(onBus: 0); tapping = false }
    request.endAudio(); task?.cancel()
    if let message = message { emit(["type": "error", "message": message]) }
    emit(["type": "stopped"])
    exit(message == nil ? 0 : 1)
}
func stopRecording() {
    if stopping { return }; stopping = true
    engine.stop()
    if tapping { engine.inputNode.removeTap(onBus: 0); tapping = false }
    request.endAudio()
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { finish() }
}
func startRecording() {
    guard let recognizer = recognizer, recognizer.isAvailable else { finish("当前语言的语音识别不可用"); return }
    guard recognizer.supportsOnDeviceRecognition else { finish("请先在 macOS 安装当前语言的本机听写资源"); return }
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    let node = engine.inputNode
    let format = node.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { finish("未找到可用麦克风"); return }
    node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
    tapping = true
    task = recognizer.recognitionTask(with: request) { result, error in
      DispatchQueue.main.async {
        if let result = result {
            emit(["type": "transcript", "text": result.bestTranscription.formattedString, "final": result.isFinal])
            if result.isFinal { finish(); return }
        }
        if let error = error, !finished { finish(error.localizedDescription) }
      }
    }
    do { engine.prepare(); try engine.start(); emit(["type": "listening", "locale": locale]) }
    catch { finish("无法启动麦克风：\(error.localizedDescription)") }
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) { stopRecording() }
}
FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty { DispatchQueue.main.async { stopRecording() }; return }
    if String(data: data, encoding: .utf8)?.contains("stop") == true { DispatchQueue.main.async { stopRecording() } }
}
SFSpeechRecognizer.requestAuthorization { status in
    DispatchQueue.main.async {
        guard status == .authorized else { finish("请在系统设置中允许语音识别"); return }
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DispatchQueue.main.async {
                guard granted else { finish("请在系统设置中允许麦克风"); return }
                startRecording()
            }
        }
    }
}
RunLoop.main.run()
