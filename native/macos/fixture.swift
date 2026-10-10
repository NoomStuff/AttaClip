// Synthetic private CI fixture. This opens no user's files or microphone.
import Cocoa
import AVFoundation
import CoreGraphics

let evidencePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : nil
let frequency = CommandLine.arguments.count > 2 ? Double(CommandLine.arguments[2])! : 997
precondition(frequency >= 100 && frequency <= 20000)
let mode = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : ""
let compact = mode == "compact"
let fullscreenSpace = mode == "fullscreen"
let evidenceOutput: FileHandle = try {
    guard let path = evidencePath else { return FileHandle.standardOutput }
    _ = FileManager.default.createFile(atPath: path, contents: nil)
    return try FileHandle(forWritingTo: URL(fileURLWithPath: path))
}()

final class PatternView: NSView {
    var count = 0
    override func draw(_ dirtyRect: NSRect) {
        let color = count % 2 == 0
            ? NSColor(srgbRed: 228.0 / 255, green: 76.0 / 255, blue: 102.0 / 255, alpha: 1)
            : NSColor(srgbRed: 65.0 / 255, green: 184.0 / 255, blue: 170.0 / 255, alpha: 1)
        color.setFill()
        bounds.fill()
        let attributes: [NSAttributedString.Key: Any] = [.foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 36)]
        "AttaClip synthetic Mac capture \(count)".draw(at: NSPoint(x: 32, y: 32), withAttributes: attributes)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let screen = NSScreen.main!.frame
let frame = compact ? NSRect(x: screen.minX, y: screen.maxY - 120, width: 240, height: 120) : fullscreenSpace ? screen.insetBy(dx: 50, dy: 50) : screen
let view = PatternView(frame: frame)
let mask: NSWindow.StyleMask = fullscreenSpace ? [.titled, .closable, .resizable, .miniaturizable] : [.borderless]
let window = NSWindow(contentRect: frame, styleMask: mask, backing: .buffered, defer: false)
window.title = compact ? "Mac audio decoy" : "Mac capture fixture"
window.backgroundColor = .black
window.contentView = view
window.level = .normal
window.orderFrontRegardless()
app.activate(ignoringOtherApps: true)
if fullscreenSpace {
    window.collectionBehavior = [.fullScreenPrimary]
    window.makeKeyAndOrderFront(nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { window.toggleFullScreen(nil) }
}
let engine = AVAudioEngine()
var phase = 0.0
let renderLock = NSLock()
var renderedFrames: UInt64 = 0
let source = AVAudioSourceNode { _, _, frames, buffers in
    let list = UnsafeMutableAudioBufferListPointer(buffers)
    for frame in 0..<Int(frames) {
        let value = Float(sin(phase) * 0.2)
        phase += 2 * Double.pi * frequency / 48000
        if phase > 2 * Double.pi { phase -= 2 * Double.pi }
        for buffer in list {
            let channels = Int(buffer.mNumberChannels)
            let samples = buffer.mData!.assumingMemoryBound(to: Float.self)
            for channel in 0..<channels { samples[frame * channels + channel] = value }
        }
    }
    renderLock.lock()
    renderedFrames += UInt64(frames)
    renderLock.unlock()
    return noErr
}
engine.attach(source)
engine.connect(source, to: engine.mainMixerNode, format: AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2))
var audio = false
do {
    try engine.start()
    audio = true
} catch {
    FileHandle.standardError.write(Data("Synthetic audio could not start: \(error)\n".utf8))
}
let result: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "windowId": window.windowNumber, "displayId": CGMainDisplayID(), "audioStarted": audio,
    "screenPermission": CGPreflightScreenCaptureAccess(), "microphoneAuthorization": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
    "frequency": frequency, "bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
    "screenFrame": ["x": screen.minX, "y": screen.minY, "width": screen.width, "height": screen.height],
    "displayPixels": ["width": CGDisplayPixelsWide(CGMainDisplayID()), "height": CGDisplayPixelsHigh(CGMainDisplayID())]]
let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
evidenceOutput.write(json + Data([10]))
let timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
    if let path = evidencePath, FileManager.default.fileExists(atPath: path + ".stop") {
        app.terminate(nil)
        return
    }
    view.count += 1
    view.needsDisplay = true
    view.displayIfNeeded()
}
let healthTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    renderLock.lock()
    let frames = renderedFrames
    renderLock.unlock()
    let health: [String: Any] = ["event": "audio-health", "engineRunning": engine.isRunning, "renderedFrames": frames,
        "visualCount": view.count, "bundleIdentifier": Bundle.main.bundleIdentifier ?? "", "foreground": app.isActive,
        "fullscreenSpace": window.styleMask.contains(.fullScreen)]
    if let data = try? JSONSerialization.data(withJSONObject: health, options: [.sortedKeys]) {
        evidenceOutput.write(data + Data([10]))
    }
}
app.run()
timer.invalidate()
healthTimer.invalidate()
engine.stop()
