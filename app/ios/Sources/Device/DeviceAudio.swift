import AVFoundation
import Speech
import UIKit

/// Sound and speech for the device modules (D40): sound effects (built-in
/// ones are synthesized), audio files, recording, MIDI, text to speech and
/// speech recognition.
@MainActor
final class DeviceAudio: NSObject, AVAudioPlayerDelegate, AVAudioRecorderDelegate {
    unowned let bridge: DeviceBridge
    private var effects: [Int: AVAudioPlayer] = [:]
    private var players: [Int: AVAudioPlayer] = [:]
    private var finished = Set<Int>()
    private var recorders: [Int: (recorder: AVAudioRecorder, done: () -> Void)] = [:]
    private var midis: [Int: AVMIDIPlayer] = [:]
    private var nextID = 1
    private var honorsSilentSwitch = true
    private let synthesizer = AVSpeechSynthesizer()
    private var builtins: [String: Data] = [:]

    init(bridge: DeviceBridge) {
        self.bridge = bridge
    }

    func perform(_ op: String, _ v: [String: Any]) async throws -> Any? {
        switch op {
        case "sound.effect.play":
            guard effects.count < 32 else { return nil }
            activate()
            let player = try AVAudioPlayer(data: try sourceData(v["source"], mount: v.mount))
            player.enableRate = true
            apply(player, v)
            player.delegate = self
            player.play()
            return keep(player, in: &effects)
        case "sound.effect.set":
            if let p = effects[v.int("id") ?? -1] { apply(p, v) }
            return nil
        case "sound.effect.stop":
            if let id = v.int("id") { effects.removeValue(forKey: id)?.stop() }
            return nil
        case "sound.effect.stopAll":
            for (_, p) in effects { p.stop() }
            effects = [:]
            return nil
        case "sound.silentSwitch":
            honorsSilentSwitch = v.bool("honors") ?? true
            activate()
            return nil
        case "sound.player.create":
            activate()
            let player: AVAudioPlayer
            if let ref = v["source"] as? [String: Any], ref["project"] != nil {
                player = try AVAudioPlayer(contentsOf: try bridge.fileURL(ref, mount: v.mount))
            } else {
                player = try AVAudioPlayer(data: try sourceData(v["source"], mount: v.mount))
            }
            player.delegate = self
            player.prepareToPlay()
            return keep(player, in: &players)
        case "sound.player.play", "sound.player.pause", "sound.player.stop", "sound.player.state", "sound.player.set":
            guard let id = v.int("id"), let p = players[id] else { throw DeviceBridge.Failure.value("no such player") }
            switch op {
            case "sound.player.play": activate(); finished.remove(id); p.play()
            case "sound.player.pause": p.pause()
            case "sound.player.stop": p.stop(); p.currentTime = 0
            case "sound.player.set":
                if let t = v.double("current_time") { p.currentTime = t }
                if let n = v.int("number_of_loops") { p.numberOfLoops = n }
                if let pan = v.double("pan") { p.pan = Float(pan) }
                if let vol = v.double("volume") { p.volume = Float(vol) }
            default:
                return ["current_time": p.currentTime, "duration": p.duration, "playing": p.isPlaying, "number_of_loops": p.numberOfLoops,
                        "pan": p.pan, "volume": p.volume, "finished": finished.contains(id)]
            }
            return nil
        case "sound.recorder.create":
            guard await AVAudioApplication.requestRecordPermission() else { throw DeviceBridge.Failure.permission("Recording from the microphone") }
            let (url, done) = try bridge.target(v["target"], mount: v.mount)
            let wav = ["wav", "aiff", "caf"].contains(v.string("format") ?? "")
            let settings: [String: Any] = wav
                ? [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                   AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
                : [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue]
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.delegate = self
            let id = nextID
            nextID += 1
            recorders[id] = (recorder, done)
            return id
        case "sound.recorder.record", "sound.recorder.pause", "sound.recorder.stop", "sound.recorder.state":
            guard let id = v.int("id"), let (r, done) = recorders[id] else { throw DeviceBridge.Failure.value("no such recorder") }
            switch op {
            case "sound.recorder.record":
                try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
                try AVAudioSession.sharedInstance().setActive(true)
                if let d = v.double("duration") { r.record(forDuration: d) } else { r.record() }
            case "sound.recorder.pause": r.pause()
            case "sound.recorder.stop": r.stop(); done()
            default:
                var state: [String: Any] = ["current_time": r.currentTime, "recording": r.isRecording]
                if v.bool("meters") == true {
                    r.isMeteringEnabled = true
                    r.updateMeters()
                    let avg = r.averagePower(forChannel: 0), peak = r.peakPower(forChannel: 0)
                    state["meters"] = ["average": [avg, avg], "peak": [peak, peak]]
                }
                return state
            }
            return nil
        case "sound.midi.create":
            let midi = try AVMIDIPlayer(contentsOf: try bridge.fileURL(v["source"], mount: v.mount),
                                        soundBankURL: try v["bank"].flatMap { $0 is NSNull ? nil : try bridge.fileURL($0, mount: v.mount) })
            midi.prepareToPlay()
            let id = nextID
            nextID += 1
            midis[id] = midi
            return id
        case "sound.midi.play", "sound.midi.stop", "sound.midi.state", "sound.midi.set":
            guard let m = midis[v.int("id") ?? -1] else { throw DeviceBridge.Failure.value("no such MIDI player") }
            switch op {
            case "sound.midi.play": activate(); m.play(nil)
            case "sound.midi.stop": m.stop()
            case "sound.midi.set":
                if let t = v.double("current_time") { m.currentPosition = t }
                if let r = v.double("rate") { m.rate = Float(r) }
            default: return ["current_time": m.currentPosition, "duration": m.duration, "rate": m.rate]
            }
            return nil
        case "speech.say":
            activate()
            let u = AVSpeechUtterance(string: v.string("text") ?? "")
            if let lang = v.string("language") { u.voice = AVSpeechSynthesisVoice(language: lang.replacingOccurrences(of: "_", with: "-")) }
            let rate = Float(v.double("rate") ?? 0.5)
            u.rate = AVSpeechUtteranceMinimumSpeechRate + (AVSpeechUtteranceMaximumSpeechRate - AVSpeechUtteranceMinimumSpeechRate) * rate
            synthesizer.speak(u)
            return nil
        case "speech.stop":
            synthesizer.stopSpeaking(at: .immediate)
            return nil
        case "speech.speaking":
            return synthesizer.isSpeaking
        case "speech.languages":
            return Set(AVSpeechSynthesisVoice.speechVoices().map(\.language)).sorted()
        case "speech.recognitionLanguages":
            return SFSpeechRecognizer.supportedLocales().map { $0.identifier.replacingOccurrences(of: "_", with: "-") }.sorted()
        case "speech.recognize":
            return try await recognize(try bridge.fileURL(v["file"], mount: v.mount), language: v.string("language"))
        default:
            throw DeviceBridge.Failure(kind: "NotImplementedError", message: "device.\(op)")
        }
    }

    /// The next program starts in silence.
    func reset() {
        for (_, p) in effects { p.stop() }
        for (_, p) in players { p.stop() }
        for (_, r) in recorders where r.recorder.isRecording { r.recorder.stop(); r.done() }
        for (_, m) in midis { m.stop() }
        effects = [:]
        players = [:]
        recorders = [:]
        midis = [:]
        finished = []
        synthesizer.stopSpeaking(at: .immediate)
    }

    // MARK: helpers

    private func activate() {
        let session = AVAudioSession.sharedInstance()
        if session.category != .playAndRecord || recorders.isEmpty {
            try? session.setCategory(honorsSilentSwitch ? .ambient : .playback, mode: .default, options: [.mixWithOthers])
        }
        try? session.setActive(true)
    }

    private func keep(_ player: AVAudioPlayer, in table: inout [Int: AVAudioPlayer]) -> Int {
        let id = nextID
        nextID += 1
        table[id] = player
        return id
    }

    private func apply(_ p: AVAudioPlayer, _ v: [String: Any]) {
        if let vol = v.double("volume") { p.volume = Float(max(0, min(1, vol))) }
        if let pan = v.double("pan") { p.pan = Float(max(-1, min(1, pan))) }
        if let pitch = v.double("pitch") { p.rate = Float(max(0.5, min(2, pitch))) }
        if let looping = v.bool("looping") { p.numberOfLoops = looping ? -1 : 0 }
    }

    private func sourceData(_ ref: Any?, mount: String?) throws -> Data {
        if let name = (ref as? [String: Any])?.string("builtin") {
            if let data = builtins[name] { return data }
            guard let data = SoundSynth.effect(name) else { throw DeviceBridge.Failure.value("no built-in sound effect \(name)") }
            builtins[name] = data
            return data
        }
        return try bridge.fileData(ref, mount: mount)
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        MainActor.assumeIsolated {
            if let id = effects.first(where: { $0.value === player })?.key { effects.removeValue(forKey: id) }
            if let id = players.first(where: { $0.value === player })?.key, flag { finished.insert(id) }
        }
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        MainActor.assumeIsolated { recorders.first(where: { $0.value.recorder === recorder })?.value.done() }
    }

    private func recognize(_ url: URL, language: String?) async throws -> Any? {
        let status = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        guard status == .authorized else { throw DeviceBridge.Failure.permission("Speech recognition") }
        let recognizer = language.map { SFSpeechRecognizer(locale: Locale(identifier: $0)) } ?? SFSpeechRecognizer()
        guard let recognizer else { throw DeviceBridge.Failure.value("speech recognition doesn't support \(language ?? "this language")") }
        guard recognizer.isAvailable else { throw DeviceBridge.Failure(kind: "RuntimeError", message: "speech recognition is not available right now") }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false
        let result: Unchecked = try await withCheckedThrowingContinuation { c in
            var resumed = false
            recognizer.recognitionTask(with: request) { result, error in
                guard !resumed else { return }
                if let error {
                    resumed = true
                    c.resume(throwing: DeviceBridge.Failure(kind: "RuntimeError", message: error.localizedDescription))
                } else if let result, result.isFinal {
                    resumed = true
                    // Plain values cross back, not the result object.
                    c.resume(returning: Unchecked(value: result.transcriptions.map { t in
                        [
                            "text": t.formattedString,
                            "segments": t.segments.map {
                                ["text": $0.substring, "timestamp": $0.timestamp, "duration": $0.duration, "confidence": $0.confidence] as [String: Any]
                            },
                        ] as [String: Any]
                    }))
                }
            }
        }
        return result.value
    }
}

/// The built-in sound effects, synthesized as 16-bit mono WAV.
enum SoundSynth {
    static let rate = 44_100.0

    static func effect(_ name: String) -> Data? {
        var s: [Double]
        switch name {
        case "beep": s = tone(880, 0.15, wave: sine) * envelope(0.15, attack: 0.005, release: 0.05)
        case "click": s = noise(0.012) * decay(0.012, 300)
        case "tick": s = tone(2000, 0.03, wave: sine) * decay(0.03, 120)
        case "pop": s = sweep(400, 1200, 0.06, wave: sine) * decay(0.06, 50)
        case "ding": s = (tone(1320, 0.9, wave: sine) + tone(2640, 0.9, wave: sine) * 0.3) * decay(0.9, 5) * 0.8
        case "coin": s = Array([tone(988, 0.08, wave: square) * 0.5, tone(1319, 0.3, wave: square) * decay(0.3, 9) * 0.5].joined())
        case "error": s = Array([tone(220, 0.15, wave: square) * 0.4, tone(165, 0.25, wave: square) * envelope(0.25, attack: 0.005, release: 0.08) * 0.4].joined())
        case "jump": s = sweep(300, 900, 0.22, wave: square) * envelope(0.22, attack: 0.005, release: 0.06) * 0.45
        case "laser": s = sweep(1600, 200, 0.25, wave: square) * decay(0.25, 8) * 0.45
        case "hit": s = (noise(0.15) * 0.6 + tone(110, 0.15, wave: sine)) * decay(0.15, 25)
        case "explosion": s = lowpass(noise(1.0), 0.08) * decay(1.0, 3.5) * 1.6
        case "powerup":
            s = [523.0, 659, 784, 1047].flatMap { tone($0, 0.07, wave: square) * envelope(0.07, attack: 0.003, release: 0.02) * 0.4 }
        default: return nil
        }
        return wav(s)
    }

    private static func count(_ duration: Double) -> Int { Int(duration * rate) }
    private static func sine(_ phase: Double) -> Double { sin(2 * .pi * phase) }
    private static func square(_ phase: Double) -> Double { phase.truncatingRemainder(dividingBy: 1) < 0.5 ? 1 : -1 }

    private static func tone(_ freq: Double, _ duration: Double, wave: (Double) -> Double) -> [Double] {
        (0..<count(duration)).map { wave(Double($0) * freq / rate) }
    }

    private static func sweep(_ from: Double, _ to: Double, _ duration: Double, wave: (Double) -> Double) -> [Double] {
        var phase = 0.0
        let n = count(duration)
        return (0..<n).map { i in
            phase += (from + (to - from) * Double(i) / Double(n)) / rate
            return wave(phase)
        }
    }

    private static func noise(_ duration: Double) -> [Double] {
        var g = SystemRandomNumberGenerator()
        return (0..<count(duration)).map { _ in Double.random(in: -1...1, using: &g) }
    }

    private static func decay(_ duration: Double, _ speed: Double) -> [Double] {
        (0..<count(duration)).map { exp(-speed * Double($0) / rate) }
    }

    private static func envelope(_ duration: Double, attack: Double, release: Double) -> [Double] {
        let n = count(duration), a = count(attack), r = count(release)
        return (0..<n).map { i in min(1, Double(i) / Double(max(a, 1)), Double(n - i) / Double(max(r, 1))) }
    }

    private static func lowpass(_ s: [Double], _ k: Double) -> [Double] {
        var y = 0.0
        return s.map { x in y += k * (x - y); return y }
    }

    private static func wav(_ samples: [Double]) -> Data {
        var data = Data()
        func put<T>(_ v: T) { withUnsafeBytes(of: v) { data.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); put(UInt32(36 + bytes).littleEndian)
        data.append(contentsOf: Array("WAVEfmt ".utf8)); put(UInt32(16).littleEndian); put(UInt16(1).littleEndian); put(UInt16(1).littleEndian)
        put(UInt32(rate).littleEndian); put(UInt32(rate * 2).littleEndian); put(UInt16(2).littleEndian); put(UInt16(16).littleEndian)
        data.append(contentsOf: Array("data".utf8)); put(bytes.littleEndian)
        for s in samples { put(Int16(max(-1, min(1, s)) * 32_000).littleEndian) }
        return data
    }
}

private func * (a: [Double], b: [Double]) -> [Double] { zip(a, b).map { $0 * $1 } }
private func * (a: [Double], k: Double) -> [Double] { a.map { $0 * k } }
private func + (a: [Double], b: [Double]) -> [Double] {
    let n = max(a.count, b.count)
    return (0..<n).map { (($0 < a.count) ? a[$0] : 0) + (($0 < b.count) ? b[$0] : 0) }
}
