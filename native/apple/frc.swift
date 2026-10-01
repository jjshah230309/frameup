import Foundation
import VideoToolbox
import CoreVideo
import CoreImage
import AVFoundation
import ImageIO

// Apple VideoToolbox ML frame-rate conversion (GPU / Neural Engine).
// usage: frc <frameDir> <out.mp4> <srcFPS> <dstFPS> <bitrate>
let a = CommandLine.arguments
guard a.count >= 6, let srcFPS = Int(a[3]), let dstFPS = Int(a[4]), let bitrate = Int(a[5]) else { print("usage: frc dir out srcFPS dstFPS bitrate"); exit(2) }
let dir = a[1], outPath = a[2]
let files = try FileManager.default.contentsOfDirectory(atPath: dir)
    .filter { let e = ($0 as NSString).pathExtension.lowercased(); return ["png", "jpg", "jpeg", "webp"].contains(e) }.sorted()
let N = files.count
guard N >= 2 else { print("need at least 2 frames"); exit(2) }
let first = CIImage(contentsOf: URL(fileURLWithPath: dir + "/" + files[0]))!
let W = Int(first.extent.width), H = Int(first.extent.height)

guard VTFrameRateConversionConfiguration.isSupported,
      let cfg = VTFrameRateConversionConfiguration(frameWidth: W, frameHeight: H, usePrecomputedFlow: false,
        qualityPrioritization: .quality, revision: .revision1) else {
    print("Apple ML frame-rate conversion is not supported on this Mac (needs macOS 15.4+ and Apple silicon)."); exit(3) }
let proc = VTFrameProcessor()
try proc.startSession(configuration: cfg)

let ci = CIContext(options: [.workingFormat: CIFormat.RGBAh])
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
func attach(_ pb: CVPixelBuffer) {
    CVBufferSetAttachment(pb, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(pb, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(pb, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
}
func makeHalf() -> CVPixelBuffer {
    var pb: CVPixelBuffer?
    let attrs: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:], kCVPixelBufferMetalCompatibilityKey as String: true]
    CVPixelBufferCreate(nil, W, H, kCVPixelFormatType_64RGBAHalf, attrs as CFDictionary, &pb)
    attach(pb!)
    return pb!
}
func loadHalf(_ i: Int) -> CVPixelBuffer {
    let img = CIImage(contentsOf: URL(fileURLWithPath: dir + "/" + files[i]))!
    let pb = makeHalf()
    ci.render(img, to: pb, bounds: img.extent, colorSpace: srgb)
    return pb
}

try? FileManager.default.removeItem(atPath: outPath)
let writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: outPath), fileType: .mp4)
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.hevc, AVVideoWidthKey: W, AVVideoHeightKey: H,
    AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2],
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: bitrate,
                                      AVVideoProfileLevelKey: kVTProfileLevel_HEVC_Main10_AutoLevel as String,
                                      AVVideoExpectedSourceFrameRateKey: dstFPS,
                                      AVVideoAllowFrameReorderingKey: false]
]
let wIn = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
wIn.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: wIn, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
    kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H])
writer.add(wIn)
writer.startWriting(); writer.startSession(atSourceTime: .zero)

var xfer: VTPixelTransferSession?
VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &xfer)
VTSessionSetProperty(xfer!, key: kVTPixelTransferPropertyKey_DestinationYCbCrMatrix, value: kCVImageBufferYCbCrMatrix_ITU_R_709_2)

var outCount = 0
func emit(_ half: CVPixelBuffer) async {
    while !wIn.isReadyForMoreMediaData { try? await Task.sleep(nanoseconds: 2_000_000) }
    var dst: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &dst)
    attach(dst!)
    let st = VTPixelTransferSessionTransferImage(xfer!, from: half, to: dst!)
    if st != 0 { print("transfer err", st); exit(1) }
    adaptor.append(dst!, withPresentationTime: CMTime(value: CMTimeValue(outCount), timescale: CMTimeScale(dstFPS)))
    outCount += 1
}

let totalOut = N * dstFPS / srcFPS
var cur = loadHalf(0)
for i in 0..<N {
    let kStart = (i * dstFPS + srcFPS - 1) / srcFPS
    let kEnd = i == N - 1 ? totalOut : ((i + 1) * dstFPS + srcFPS - 1) / srcFPS
    if i == N - 1 || kEnd <= kStart {
        if kStart < kEnd { for _ in kStart..<kEnd { await emit(cur) } }
        break
    }
    let next = loadHalf(i + 1)
    var phases: [Float] = []
    for k in kStart..<kEnd { phases.append(Float(k * srcFPS) / Float(dstFPS) - Float(i)) }
    let interp: [Float] = phases.filter { $0 > 0.0001 }
    var dests: [VTFrameProcessorFrame] = []
    var destBufs: [CVPixelBuffer] = []
    for (j, _) in interp.enumerated() {
        let pb = makeHalf(); destBufs.append(pb)
        dests.append(VTFrameProcessorFrame(buffer: pb, presentationTimeStamp: CMTime(value: CMTimeValue(kStart + j + 1), timescale: CMTimeScale(dstFPS)))!)
    }
    if !interp.isEmpty {
        let sf = VTFrameProcessorFrame(buffer: cur, presentationTimeStamp: CMTime(value: CMTimeValue(i), timescale: CMTimeScale(srcFPS)))!
        let nf = VTFrameProcessorFrame(buffer: next, presentationTimeStamp: CMTime(value: CMTimeValue(i + 1), timescale: CMTimeScale(srcFPS)))!
        let params = VTFrameRateConversionParameters(sourceFrame: sf, nextFrame: nf, opticalFlow: nil,
            interpolationPhase: interp, submissionMode: .sequential, destinationFrames: dests)!
        let sem = DispatchSemaphore(value: 0)
        var perr: NSError?
        proc.process(parameters: params, completionHandler: { _, e in perr = e as NSError?; sem.signal() })
        sem.wait()
        if let e = perr { print("process err", e); exit(1) }
    }
    var di = 0
    for p in phases {
        if p <= 0.0001 { await emit(cur) } else { await emit(destBufs[di]); di += 1 }
    }
    cur = next
    if i % 5 == 0 { print("PROGRESS \(outCount) \(totalOut)"); fflush(stdout) }
}
proc.endSession()
wIn.markAsFinished()
await writer.finishWriting()
if writer.status != .completed { print("write failed:", writer.error as Any); exit(1) }
print("PROGRESS \(outCount) \(totalOut)")
