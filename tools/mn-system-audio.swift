// System playback capture using public Core Audio process taps (macOS 14.2+).
// Requires system audio recording consent, NOT screen/video capture consent.
// Microphone capture is separate and requires microphone consent in the browser.
// The host app must provide NSAudioCaptureUsageDescription in its Info.plist.
// A successful graph setup does not prove consent or non-silent audio delivery.
// stdout: one JSON handshake followed by 16 kHz mono Int16 little-endian PCM.
// probe only checks graph setup; it never writes PCM to stdout.

import Foundation
import CoreAudio
import AudioToolbox

let outRate: Double = 16_000

// MARK: - Core Audio property helpers

private func defaultOutputUID() -> String {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var devID: AudioDeviceID = 0
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &devID) == noErr
  else { return "" }
  var uidAddr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var uid: CFString = "" as CFString
  size = UInt32(MemoryLayout<CFString>.size)
  let result = withUnsafeMutablePointer(to: &uid) { pointer in
    AudioObjectGetPropertyData(devID, &uidAddr, 0, nil, &size, pointer)
  }
  guard result == noErr else { return "" }
  return uid as String
}

/// A sane default for the rare case the aggregate's input stream cannot be
/// queried: Float32 non-interleaved stereo at 48 kHz is what taps deliver.
private let fallbackFormat = AudioStreamBasicDescription(
  mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
  mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsNonInterleaved,
  mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2, mBitsPerChannel: 32,
  mReserved: 0)

/// Format of the aggregate's input stream (what the tap delivers).
private func aggregateInputFormat(_ aggID: AudioDeviceID) -> AudioStreamBasicDescription {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain)
  var needed = UInt32(0)
  guard AudioObjectGetPropertyDataSize(aggID, &addr, 0, nil, &needed) == noErr,
        needed >= UInt32(MemoryLayout<AudioStreamID>.size)
  else { return fallbackFormat }
  let count = Int(needed) / MemoryLayout<AudioStreamID>.size
  var ids = [AudioStreamID](repeating: 0, count: count)
  guard AudioObjectGetPropertyData(aggID, &addr, 0, nil, &needed, &ids) == noErr, let stream = ids.first
  else { return fallbackFormat }
  var fmtAddr = AudioObjectPropertyAddress(
    mSelector: kAudioStreamPropertyVirtualFormat, mScope: kAudioObjectPropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain)
  var asbd = AudioStreamBasicDescription()
  var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
  guard AudioObjectGetPropertyData(stream, &fmtAddr, 0, nil, &fmtSize, &asbd) == noErr,
        asbd.mSampleRate > 0
  else { return fallbackFormat }
  return asbd
}

// MARK: - Mono mixdown + windowed-sinc resampler (Float in -> Int16 @ 16 kHz)

/// Streaming resampler: mono Float32 at `inputRate`, emitted as little-endian
/// Int16 at 16 kHz. A 32-tap windowed-sinc kernel keeps the speech band clean
/// while downsampling; arbitrary rates (44.1k, 48k, 96k) all land on the same
/// grid. Missing history at the very start is zero-padded, the standard FIR
/// warm-up.
final class MonoResampler {
  private let ratio: Double      // input samples per output sample
  private let cutoff: Double     // cycles per input sample
  private var buf: [Float] = []  // recent input, absolute index bufStart…
  private var bufStart = 0
  private var nextOut = 0        // next output index to produce
  private let half = 16          // taps on each side (32 total)

  init(inputRate: Double) {
    ratio = inputRate / outRate
    // A little under the anti-aliasing limit leaves a transition band.
    cutoff = min(0.5, 0.5 / ratio) * 0.92
  }

  private func sinc(_ x: Double) -> Double {
    if x >= -1e-8 && x <= 1e-8 { return 1 }
    let p = Double.pi * x
    return sin(p) / p
  }

  /// Blackman window over the tap offsets, applied to the sinc kernel.
  private func windowFactor(_ k: Int, _ frac: Double) -> Double {
    let x = (Double(k) - frac) / Double(half + 1)
    return 0.42 + 0.5 * cos(Double.pi * x) + 0.08 * cos(2 * Double.pi * x)
  }

  func push(_ samples: [Float], into out: inout [Int16]) {
    buf.append(contentsOf: samples)
    while true {
      let t = Double(nextOut) * ratio
      let base = Int(t)
      let frac = t - Double(base)
      if base + half >= bufStart + buf.count { break } // need more input first
      var acc = 0.0
      for k in -half + 1...half {
        let idx = base + k
        let sample = idx < bufStart ? 0 : Double(buf[idx - bufStart])
        acc += sample * (2 * cutoff) * sinc(2 * cutoff * (Double(k) - frac)) * windowFactor(k, frac)
      }
      out.append(Int16(max(-32768, min(32767, Int(acc * 32767)))))
      nextOut += 1
    }
    // Everything before the next output's window is history now.
    let needStart = Int(Double(nextOut) * ratio) - half - 1
    if needStart > bufStart {
      buf.removeFirst(needStart - bufStart)
      bufStart = needStart
    }
  }
}

// MARK: - The tap graph

private func note(_ text: String) {
  FileHandle.standardError.write((text + "\n").data(using: .utf8)!)
}

/// One global process tap plus (re-bindable) private aggregate delivering the
/// tapped mix. `attach()` is idempotent-safe to call again after `detach()`.
final class TapGraph {
  private(set) var tapID: AudioObjectID = kAudioObjectUnknown
  private var tapUUID = ""
  private(set) var aggregateID: AudioDeviceID = 0
  private var ioProc: AudioDeviceIOProcID?
  private let queue: DispatchQueue
  private var resampler: MonoResampler?
  private var emitting = false
  private var rebuildTimer: DispatchSourceTimer?

  func enableOutput() { queue.sync { emitting = true } }

  private let rebuildQueue = DispatchQueue(label: "mn.system.audio.rebuild")
  private var rebuildPending = false
  private var rebuildFailures = 0

  init(label: String) {
    queue = DispatchQueue(label: label)
  }

  /// Create the global tap and bind a first aggregate to it.
  func start() throws {
    let tap = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    tap.uuid = UUID()
    tap.muteBehavior = CATapMuteBehavior.unmuted
    tap.isPrivate = true
    var id: AudioObjectID = kAudioObjectUnknown
    let status = AudioHardwareCreateProcessTap(tap, &id)
    guard status == noErr, id != kAudioObjectUnknown else {
      throw NSError(domain: "mn-system-audio", code: 5,
                    userInfo: [NSLocalizedDescriptionKey: "tap-create-\(status)"])
    }
    tapID = id
    tapUUID = tap.uuid.uuidString
    try attach()
  }

  /// Bind the tap to a fresh private aggregate clocked by the CURRENT default
  /// output, install the IOProc and start it. The aggregate's input format
  /// tells the channels and rate; input arrives as non-interleaved Float32.
  func attach() throws {
    let uid = defaultOutputUID()
    guard uid != "" else {
      throw NSError(domain: "mn-system-audio", code: 6,
                    userInfo: [NSLocalizedDescriptionKey: "no-output-device"])
    }
    let description: [String: Any] = [
      kAudioAggregateDeviceNameKey: "会议录音内录",
      kAudioAggregateDeviceUIDKey: "dsh-meeting-notes.tap.\(UUID().uuidString)",
      kAudioAggregateDeviceMainSubDeviceKey: uid,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: uid]],
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUUID, kAudioSubTapDriftCompensationKey: 1]],
    ]
    var aggID: AudioDeviceID = 0
    let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggID)
    guard status == noErr else {
      throw NSError(domain: "mn-system-audio", code: 7,
                    userInfo: [NSLocalizedDescriptionKey: "aggregate-\(status)"])
    }
    aggregateID = aggID

    let format = aggregateInputFormat(aggID)
    let channels = max(1, Int(format.mChannelsPerFrame))
    let interleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    let resampler = MonoResampler(inputRate: Double(format.mSampleRate))
    self.resampler = resampler

    var proc: AudioDeviceIOProcID?
    let statusIO = AudioDeviceCreateIOProcIDWithBlock(&proc, aggID, queue) { [weak self] _, inInputData, _, _, _ in
      guard let self, self.emitting else { return }
      var mono = [Float]()
      let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
      if interleaved {
        // One buffer, frames interleaved across channels.
        guard let data = buffers.first?.mData else { return }
        let floats = data.assumingMemoryBound(to: Float.self)
        let frames = Int(buffers[0].mDataByteSize) / (MemoryLayout<Float>.size * channels)
        guard frames > 0 else { return }
        mono.reserveCapacity(frames)
        for f in 0..<frames {
          var sum = 0.0
          for c in 0..<channels { sum += Double(floats[f * channels + c]) }
          mono.append(Float(sum / Double(channels)))
        }
      } else {
        // One buffer per channel, all the same frame count.
        var frames = 0
        for buffer in buffers {
          guard buffer.mData != nil else { continue }
          frames = max(frames, Int(buffer.mDataByteSize) / MemoryLayout<Float>.size)
        }
        guard frames > 0 else { return }
        mono = [Float](repeating: 0, count: frames)
        var present = 0
        for buffer in buffers {
          guard let data = buffer.mData else { continue }
          let floats = data.assumingMemoryBound(to: Float.self)
          let n = min(frames, Int(buffer.mDataByteSize) / MemoryLayout<Float>.size)
          for i in 0..<n { mono[i] += floats[i] }
          present += 1
        }
        if present > 1 { for i in 0..<frames { mono[i] /= Float(present) } }
      }
      var pcm = [Int16]()
      pcm.reserveCapacity(mono.count / 2)
      resampler.push(mono, into: &pcm)
      guard !pcm.isEmpty else { return }
      var bytes = Data(capacity: pcm.count * 2)
      for value in pcm { withUnsafeBytes(of: value.littleEndian) { bytes.append(contentsOf: $0) } }
      try? FileHandle.standardOutput.write(contentsOf: bytes)
    }
    guard statusIO == noErr, let proc = proc else {
      AudioHardwareDestroyAggregateDevice(aggID)
      aggregateID = 0
      throw NSError(domain: "mn-system-audio", code: 8,
                    userInfo: [NSLocalizedDescriptionKey: "ioproc-\(statusIO)"])
    }
    ioProc = proc
    let statusStart = AudioDeviceStart(aggID, proc)
    guard statusStart == noErr else {
      AudioDeviceDestroyIOProcID(aggID, proc)
      ioProc = nil
      AudioHardwareDestroyAggregateDevice(aggID)
      aggregateID = 0
      throw NSError(domain: "mn-system-audio", code: 9,
                    userInfo: [NSLocalizedDescriptionKey: "start-\(statusStart)"])
    }
  }

  func detach() {
    if aggregateID != 0 {
      if let ioProc { AudioDeviceStop(aggregateID, ioProc) }
      if let ioProc { AudioDeviceDestroyIOProcID(aggregateID, ioProc) }
      ioProc = nil
      AudioHardwareDestroyAggregateDevice(aggregateID)
      aggregateID = 0
    }
  }

  func stop() {
    rebuildTimer?.cancel()
    rebuildTimer = nil
    detach()
    if tapID != kAudioObjectUnknown {
      AudioHardwareDestroyProcessTap(tapID)
      tapID = kAudioObjectUnknown
    }
  }

  // MARK: default-output following

  /// Watch the default output device: when it changes (headphones, HDMI, …)
  /// the aggregate must re-bind, or the IO cycle stops with the old clock.
  func watchDefaultOutput() {
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, rebuildQueue) { [weak self] _, _ in
      self?.rebuildPending = true
    }
    let timer = DispatchSource.makeTimerSource(queue: rebuildQueue)
    timer.schedule(deadline: .now() + 2, repeating: 2)
    timer.setEventHandler { [weak self] in self?.rebuildIfPending() }
    rebuildTimer = timer
    timer.resume()
  }

  private func rebuildIfPending() {
    guard rebuildPending else { return }
    rebuildPending = false
    detach()
    do {
      try attach()
      rebuildFailures = 0
      note("default output changed; aggregate re-bound")
    } catch {
      rebuildFailures += 1
      note("aggregate re-bind failed (\(error.localizedDescription)); retry \(rebuildFailures)")
      if rebuildFailures > 30 {
        // Unrecoverable on this machine: exit so the host reports the end
        // instead of a zombie that streams nothing.
        exit(3)
      }
      rebuildPending = true
    }
  }
}

// MARK: - probe

/// Check graph setup, not permission status or actual audio delivery.
/// Starting a tapped aggregate may trigger system audio recording consent.
private func probe() -> Int32 {
  let graph = TapGraph(label: "mn.system.audio.probe")
  do {
    try graph.start()
    Thread.sleep(forTimeInterval: 0.3)
    graph.stop()
    print("{\"tap\":\"ok\"}")
    return 0
  } catch {
    graph.stop()
    print("{\"error\":\"\(error.localizedDescription)\"}")
    return 1
  }
}

// MARK: - capture

private var liveGraph: TapGraph?
private var terminationSources: [DispatchSourceSignal] = []

private func capture() {
  let graph = TapGraph(label: "mn.system.audio.capture")
  do {
    try graph.start()
  } catch {
    print("{\"error\":\"\(error.localizedDescription)\"}")
    exit(2)
  }
  print("{\"ready\":true}")
  fflush(stdout)
  graph.enableOutput()
  liveGraph = graph
  graph.watchDefaultOutput()
  for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
      liveGraph?.stop()
      liveGraph = nil
      exit(0)
    }
    terminationSources.append(source)
    source.resume()
  }
  dispatchMain()
}

// MARK: - entry

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first ?? "" {
case "probe":
  exit(probe())
case "capture":
  capture()
default:
  note("usage: mn-system-audio (probe|capture)")
  exit(64)
}
