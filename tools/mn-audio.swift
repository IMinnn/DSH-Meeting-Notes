// mn-audio — system-output switcher for dsh-meeting-notes, user-level CoreAudio only.
//
// WHY THIS EXISTS: with headphones on, an online meeting's far side never reaches
// the microphone, so the record needs the machine's own playback captured through
// a loopback driver (BlackHole & friends). A loopback records only what is PLAYED
// INTO it, so the system output must additionally feed the headphones — that is
// exactly a Multi-Output Device. Creating one, making it the default output while
// a recording runs, and putting everything back afterwards is this tool's job.
//
// Subcommands (JSON on stdout, errors on stderr with a non-zero exit):
//   list                       every device: id, uid, name, inputs, outputs
//   ensure                     loopback present -> (re)build "会议录音输出"
//                              (loopback + current default output), make it the
//                              default output, remember the previous default
//   restore                    put the remembered default output back and remove
//                              the aggregate again
//
// No admin rights are needed anywhere: aggregate devices and the default output
// are per-user CoreAudio settings.

import CoreAudio
import Foundation

// MARK: - CoreAudio property helpers

private func deviceName(_ id: AudioDeviceID) -> String {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioObjectPropertyName,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var value: CFString = "" as CFString
  var size = UInt32(MemoryLayout<CFString>.size)
  let status = AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value)
  return status == noErr ? (value as String) : ""
}

private func deviceUID(_ id: AudioDeviceID) -> String {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceUID,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var value: CFString = "" as CFString
  var size = UInt32(MemoryLayout<CFString>.size)
  let status = AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value)
  return status == noErr ? (value as String) : ""
}

private func streamCount(_ id: AudioDeviceID, output: Bool) -> Int {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreams,
    mScope: output ? kAudioDevicePropertyScopeOutput : kAudioDevicePropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(0)
  guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
  return Int(size) / MemoryLayout<AudioStreamID>.size
}

private func allDeviceIDs() -> [AudioDeviceID] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(0)
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr,
        size > 0 else { return [] }
  let count = Int(size) / MemoryLayout<AudioDeviceID>.size
  var ids = [AudioDeviceID](repeating: 0, count: count)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr
  else { return [] }
  return ids
}

private func defaultOutputDevice() -> AudioDeviceID {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var id: AudioDeviceID = 0
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr
  else { return 0 }
  return id
}

private func setDefaultOutputDevice(_ id: AudioDeviceID) -> Bool {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var value = id
  let size = UInt32(MemoryLayout<AudioDeviceID>.size)
  return AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, size, &value) == noErr
}

// MARK: - Device model

/// Mirrors the plugin's client-side judgement: names that mark a loopback, minus
/// remote-control drivers whose "virtual audio" devices carry the FAR side of a
/// remote session (they look like loopbacks but record silence here).
private let loopbackRE = try! NSRegularExpression(
  pattern: "blackhole|loopback|soundflower|stereo\\s*mix|virtual\\s*audio|system\\s*audio|ishowu|内部|内录|系统声",
  options: [.caseInsensitive])
private let remoteDriverRE = try! NSRegularExpression(
  pattern: "oray|sunlogin|向日葵|todesk|parrot|eshare|anyviewer|rustdesk|airdroid",
  options: [.caseInsensitive])

private func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
  let range = NSRange(text.startIndex..<text.endIndex, in: text)
  return regex.firstMatch(in: text, options: [], range: range) != nil
}

struct Device {
  let id: AudioDeviceID
  let uid: String
  let name: String
  let inputs: Int
  let outputs: Int
  var isLoopback: Bool {
    !name.isEmpty && matches(remoteDriverRE, name) == false && matches(loopbackRE, name)
  }
  var json: String {
    """
    {"id":\(id),"uid":\(quoted(uid)),"name":\(quoted(name)),"inputs":\(inputs),"outputs":\(outputs)}
    """
  }
}

private func devices() -> [Device] {
  allDeviceIDs().map { id in
    Device(id: id, uid: deviceUID(id), name: deviceName(id),
           inputs: streamCount(id, output: false), outputs: streamCount(id, output: true))
  }
}

/// The aggregate this tool owns, recognised by its stable UID no matter what id
/// CoreAudio handed it this boot.
private let aggregateUID = "dsh-meeting-notes.multi-output" as CFString
private let aggregateName = "会议录音输出"

// MARK: - State (remembered between ensure and restore)

private func stateURL() -> URL {
  // Overridable so the plugin's tests can run this binary against a scratch
  // state file; the shipped host always uses the default path.
  if let override = ProcessInfo.processInfo.environment["MN_AUDIO_STATE"] {
    return URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
  }
  let home = FileManager.default.homeDirectoryForCurrentUser
  return home.appendingPathComponent(".dsh/meeting-room/bin/audio-output.json")
}

private func readState() -> [String: Any]? {
  guard let data = try? Data(contentsOf: stateURL()),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { return nil }
  return object
}

private func writeState(_ state: [String: Any]) {
  let url = stateURL()
  try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  if let data = try? JSONSerialization.data(withJSONObject: state) { try? data.write(to: url) }
}

private func clearState() { try? FileManager.default.removeItem(at: stateURL()) }

// MARK: - Aggregate create / destroy

/// Build the Multi-Output Device exactly as Audio MIDI Setup would: the partner
/// (headphones or speakers — what the person listens on) drives the clock, the
/// loopback gets drift correction so long meetings stay in sync.
private func createAggregate(partner: Device, loopback: Device) -> AudioDeviceID? {
  let description = [
    kAudioAggregateDeviceNameKey: aggregateName,
    kAudioAggregateDeviceUIDKey: aggregateUID,
    kAudioAggregateDeviceIsPrivateKey: false,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceClockDeviceKey: partner.uid as CFString,
    kAudioAggregateDeviceSubDeviceListKey: [
      [kAudioSubDeviceUIDKey: partner.uid as CFString] as CFDictionary,
      [kAudioSubDeviceUIDKey: loopback.uid as CFString,
       kAudioSubDeviceDriftCompensationKey: 1] as CFDictionary,
    ] as CFArray,
  ] as CFDictionary
  var aggregate: AudioDeviceID = 0
  guard AudioHardwareCreateAggregateDevice(description, &aggregate) == noErr else { return nil }
  return aggregate
}

private func destroyOwnedAggregate(_ list: [Device]) {
  if let owned = list.first(where: { $0.uid == (aggregateUID as String) }) {
    AudioHardwareDestroyAggregateDevice(owned.id)
  }
}

// MARK: - Subcommands

private func quoted(_ text: String) -> String {
  let safe = text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
  return "\"\(safe)\""
}

private func commandList() -> String {
  let entries = devices().map(\.json).joined(separator: ",")
  let current = defaultOutputDevice()
  let currentName = devices().first { $0.id == current }?.name ?? ""
  return "{\"defaultOutput\":\(current),\"defaultOutputName\":\(quoted(currentName)),\"devices\":[\(entries)]}"
}

private func commandEnsure() -> String {
  let list = devices()
  // Test hook: pretend one given device is the loopback, so the whole create /
  // switch / restore path stays verifiable on machines without BlackHole.
  let forced = ProcessInfo.processInfo.environment["MN_AUDIO_LOOPBACK_UID"]
  let loopback: Device?
  if let forced = forced, !forced.isEmpty {
    loopback = list.first { $0.uid == forced && $0.outputs > 0 }
  } else {
    loopback = list.first { $0.isLoopback && $0.outputs > 0 }
  }
  guard let loopback = loopback else {
    return "{\"changed\":false,\"reason\":\"no-loopback\"}"
  }
  let current = defaultOutputDevice()
  let mine = list.first { $0.uid == (aggregateUID as String) }
  let ridingOurs = mine != nil && mine!.id == current
  // While a second ensure runs mid-recording the default is already the aggregate:
  // the partner worth keeping is the remembered one, not the aggregate itself.
  var partner: Device?
  if ridingOurs, let state = readState(), let uid = state["partner"] as? String {
    partner = list.first { $0.uid == uid }
  }
  if partner == nil { partner = list.first { $0.id == current && !$0.isLoopback && !ridingOurs } }
  if partner == nil { partner = list.first { !$0.isLoopback && $0.uid != (aggregateUID as String) && $0.outputs > 0 } }
  guard let partner = partner else { return "{\"changed\":false,\"reason\":\"no-output-device\"}" }

  destroyOwnedAggregate(list)
  guard let aggregate = createAggregate(partner: partner, loopback: loopback) else {
    return "{\"changed\":false,\"reason\":\"create-failed\"}"
  }
  let previous: Int
  if ridingOurs, let state = readState(), let saved = state["previous"] as? Int {
    previous = saved
  } else {
    previous = Int(current)
  }
  guard setDefaultOutputDevice(aggregate) else {
    AudioHardwareDestroyAggregateDevice(aggregate)
    return "{\"changed\":false,\"reason\":\"set-default-failed\"}"
  }
  writeState(["previous": previous, "partner": partner.uid])
  return "{\"changed\":true,\"previous\":\(previous),\"partner\":\(quoted(partner.name)),\"loopback\":\(quoted(loopback.name))}"
}

private func commandRestore() -> String {
  guard let state = readState(), let previous = state["previous"] as? Int else {
    return "{\"restored\":false,\"reason\":\"no-state\"}"
  }
  let list = devices()
  if let back = list.first(where: { $0.id == AudioDeviceID(previous) }) {
    _ = setDefaultOutputDevice(back.id)
  }
  destroyOwnedAggregate(list)
  clearState()
  return "{\"restored\":true,\"previous\":\(previous)}"
}

// MARK: - Entry point (top-level: this file compiles as a standalone script)

let arguments = Array(CommandLine.arguments.dropFirst())
let command = arguments.first ?? ""
let output: String
switch command {
case "list": output = commandList()
case "ensure": output = commandEnsure()
case "restore": output = commandRestore()
default:
  FileHandle.standardError.write("usage: mn-audio (list|ensure|restore)\n".data(using: .utf8)!)
  exit(64)
}
print(output)
