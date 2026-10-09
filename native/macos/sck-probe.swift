// Diagnostic only. Reads the private CI fixture, never exports captured images.
import Cocoa
import ScreenCaptureKit
import CoreMedia
import CoreVideo

final class Samples: NSObject, SCStreamOutput {
    private let lock = NSLock()
    private var colors = Set<String>()
    private var statuses: [Int: Int] = [:]
    private var audioBuffers = 0
    private var peak: Float = 0

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        lock.lock()
        defer { lock.unlock() }
        if type == .screen {
            if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
               let status = attachments.first?[.status] as? Int { statuses[status, default: 0] += 1 }
            guard let image = CMSampleBufferGetImageBuffer(sample) else { return }
            CVPixelBufferLockBaseAddress(image, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
            if let base = CVPixelBufferGetBaseAddress(image) {
                let x = CVPixelBufferGetWidth(image) / 2
                let y = CVPixelBufferGetHeight(image) / 2
                let pixel = base.advanced(by: y * CVPixelBufferGetBytesPerRow(image) + x * 4).assumingMemoryBound(to: UInt8.self)
                colors.insert("\(pixel[2]),\(pixel[1]),\(pixel[0])")
            }
        } else if type == .audio, let block = CMSampleBufferGetDataBuffer(sample) {
            audioBuffers += 1
            let size = CMBlockBufferGetDataLength(block)
            guard size > 0 else { return }
            var bytes = [UInt8](repeating: 0, count: size)
            let copied = bytes.withUnsafeMutableBytes { raw in
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: size, destination: raw.baseAddress!)
            }
            guard copied == noErr else { return }
            bytes.withUnsafeBytes { raw in
                for value in raw.bindMemory(to: Float.self) { peak = max(peak, abs(value)) }
            }
        }
    }

    func result() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return ["centerColors": colors.sorted(), "frameStatuses": statuses.mapKeys(), "audioBuffers": audioBuffers, "audioPeak": peak]
    }
}

extension Dictionary where Key == Int, Value == Int {
    func mapKeys() -> [String: Int] { Dictionary<String, Int>(uniqueKeysWithValues: map { (String($0.key), $0.value) }) }
}

@main struct Probe {
    static func main() async throws {
        let displayID = UInt32(CommandLine.arguments[1])!
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw NSError(domain: "AttaClip-probe", code: 1, userInfo: [NSLocalizedDescriptionKey: "Exact display unavailable"])
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = 640
        configuration.height = 360
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.queueDepth = 5
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = false
        configuration.channelCount = 2
        let samples = Samples()
        let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
        let queue = DispatchQueue(label: "AttaClip.private-sck-proof")
        try stream.addStreamOutput(samples, type: .screen, sampleHandlerQueue: queue)
        try stream.addStreamOutput(samples, type: .audio, sampleHandlerQueue: queue)
        try await stream.startCapture()
        try await Task.sleep(nanoseconds: 2_500_000_000)
        try await stream.stopCapture()
        let data = try JSONSerialization.data(withJSONObject: samples.result(), options: [.sortedKeys])
        FileHandle.standardOutput.write(data + Data([10]))
    }
}
