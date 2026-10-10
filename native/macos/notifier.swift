// SPDX-License-Identifier: GPL-2.0-or-later
// This helper owns only a nonactivating native panel. It never captures media.
import Cocoa
import CoreGraphics

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

final class FeedbackPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class FeedbackView: NSView {
    var message = ""
    var failure = false
    var saving = false
    var phase = 0.0
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(srgbRed: 25.0 / 255, green: 23.0 / 255, blue: 31.0 / 255, alpha: 0.98).setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 8, dy: 8), xRadius: 18, yRadius: 18).fill()
        let accent = failure
            ? NSColor(srgbRed: 250.0 / 255, green: 137.0 / 255, blue: 137.0 / 255, alpha: 1)
            : NSColor(srgbRed: 177.0 / 255, green: 151.0 / 255, blue: 252.0 / 255, alpha: 1)
        accent.setStroke()
        let icon = NSBezierPath()
        icon.lineWidth = 2.6
        icon.lineCapStyle = .round
        icon.lineJoinStyle = .round
        if saving {
            icon.appendArc(withCenter: NSPoint(x: 42, y: 51), radius: 14,
                           startAngle: CGFloat(phase * 360), endAngle: CGFloat(phase * 360 + 265))
        } else if failure {
            icon.move(to: NSPoint(x: 42, y: 61)); icon.line(to: NSPoint(x: 42, y: 47))
            icon.move(to: NSPoint(x: 42, y: 40)); icon.line(to: NSPoint(x: 42, y: 39))
        } else {
            icon.move(to: NSPoint(x: 30, y: 51)); icon.line(to: NSPoint(x: 39, y: 42))
            icon.line(to: NSPoint(x: 55, y: 60))
        }
        icon.stroke()
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        "AttaClip".draw(in: NSRect(x: 72, y: 60, width: 268, height: 17), withAttributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: NSColor(srgbRed: 164.0 / 255, green: 160.0 / 255, blue: 177.0 / 255, alpha: 1),
            .paragraphStyle: paragraph,
        ])
        message.draw(in: NSRect(x: 72, y: 22, width: 268, height: 36), withAttributes: [
            .font: NSFont.systemFont(ofSize: 14, weight: .medium),
            .foregroundColor: NSColor(srgbRed: 244.0 / 255, green: 242.0 / 255, blue: 250.0 / 255, alpha: 1),
            .paragraphStyle: paragraph,
        ])
    }
}

final class Feedback {
    let panel: FeedbackPanel
    let view: FeedbackView
    var timer: Timer?
    var started = 0.0
    var lifetime = 2.4
    var target = NSRect.zero
    var reducedMotion = false
    var proofPath: String?
    var proofWritten = false
    var tracking = false
    var shownReported = false
    var messageID: String?
    init() {
        view = FeedbackView(frame: NSRect(x: 0, y: 0, width: 368, height: 100))
        panel = FeedbackPanel(contentRect: view.frame, styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        panel.contentView = view
        panel.title = "AttaClip feedback"
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.worksWhenModal = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        // sharingType.none does not exclude windows from modern macOS capture.
    }
    func metrics(_ event: String, requestID: String? = nil) {
        var result: [String: Any] = [
            "event": event, "windowId": panel.windowNumber, "visible": panel.isVisible,
            "key": panel.isKeyWindow, "main": panel.isMainWindow, "active": NSApp.isActive,
            "foregroundPID": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
            "alpha": panel.alphaValue, "x": panel.frame.minX, "y": panel.frame.minY,
            "width": panel.frame.width, "height": panel.frame.height,
            "reducedMotion": reducedMotion, "timerActive": timer != nil,
            "elapsed": ProcessInfo.processInfo.systemUptime - started,
        ]
        if let id = requestID ?? messageID { result["id"] = id }
        emit(result)
    }
    func show(_ data: [String: Any]) {
        guard let text = data["message"] as? String, !text.isEmpty else { return }
        view.message = String(text.prefix(4000))
        view.failure = data["error"] as? Bool ?? false
        view.saving = data["saving"] as? Bool ?? false
        proofPath = data["proofPath"] as? String
        tracking = data["trackAnimation"] as? Bool ?? false
        messageID = data["id"] as? String
        proofWritten = false
        shownReported = false
        reducedMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        lifetime = view.saving ? 7.0 : view.failure ? 5.0 : 2.4
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main else { return }
        let area = screen.visibleFrame
        target = NSRect(x: area.maxX - 386, y: area.maxY - 118, width: 368, height: 100)
        started = ProcessInfo.processInfo.systemUptime
        panel.setFrame(target.offsetBy(dx: 0, dy: reducedMotion ? 0 : 10), display: false)
        panel.alphaValue = reducedMotion ? 1 : 0
        view.needsDisplay = true
        panel.orderFrontRegardless()
        timer?.invalidate()
        timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer!, forMode: .common)
        tick()
    }
    func tick() {
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        let entering = min(1, elapsed / 0.18)
        let leaving = max(0, min(1, (elapsed - lifetime) / 0.15))
        let ease = 1 - pow(1 - entering, 3)
        panel.alphaValue = reducedMotion ? (leaving > 0 ? 0 : 1) : ease * (1 - leaving)
        let offset = reducedMotion ? 0 : 10 * (1 - ease) + 6 * leaving
        panel.setFrameOrigin(NSPoint(x: target.minX, y: target.minY + offset))
        if view.saving { view.phase = elapsed.truncatingRemainder(dividingBy: 0.85) / 0.85; view.needsDisplay = true }
        if tracking && (elapsed <= 0.25 || leaving > 0) { metrics("animation") }
        if elapsed >= 0.2 && !shownReported {
            shownReported = true
            view.displayIfNeeded()
            if let file = proofPath, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: bitmap)
                if let png = bitmap.representation(using: .png, properties: [:]) {
                    do { try png.write(to: URL(fileURLWithPath: file), options: .atomic); proofWritten = true }
                    catch { FileHandle.standardError.write(Data("Feedback image could not save: \(error)\n".utf8)) }
                }
            }
            metrics("shown")
        }
        if elapsed >= lifetime + 0.15 {
            panel.orderOut(nil)
            timer?.invalidate(); timer = nil
            metrics("hidden")
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let feedback = Feedback()
emit(["event": "ready", "pid": ProcessInfo.processInfo.processIdentifier,
      "bundleIdentifier": Bundle.main.bundleIdentifier ?? ""])
DispatchQueue.global(qos: .utility).async {
    while let line = readLine() {
        guard let bytes = line.data(using: .utf8),
              let data = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { continue }
        DispatchQueue.main.async {
            if data["action"] as? String == "exit" { app.terminate(nil) }
            else if data["action"] as? String == "metrics" { feedback.metrics("metrics", requestID: data["id"] as? String) }
            else { feedback.show(data) }
        }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
