import Foundation
import Observation

// The Python session as the engine page reports it (D31, engine/state.ts):
// the console transcript, runs, status and the debugger's state.

struct ConsoleLine: Identifiable, Equatable {
    let id: Int
    let runId: Int
    let kind: String // stdout, stderr, system, image, input, prompt, run, turtle
    var text: String
    /// A traceback as data (D45); `text` is its classic form.
    var trace: Trace?
}

struct RunInfo: Codable, Equatable {
    let id: Int
    let file: String?
    let dir: String
    let python: String? // "3.14.2", once chosen (D37)
    let startedAt: Double
    let endedAt: Double?
    let status: String // running, ok, error, stopped, crashed
}

struct DebugFrame: Codable, Equatable, Hashable {
    let name: String
    let file: String
    let line: Int

    var label: String { name == "<module>" ? (file as NSString).lastPathComponent : "\(name)()" }
}

struct DebugVariable: Codable, Equatable, Hashable {
    let name: String
    let value: String
    let type: String
    let ref: Int
}

struct DebugScope: Codable, Equatable {
    let name: String
    let variables: [DebugVariable]
}

/// The interpreter is a notebook's kernel (D44); `cell` is the count of the cell running.
struct KernelInfo: Codable, Equatable {
    let path: String
    let python: String
    let count: Int
    let cell: Int?
}

struct DebugState: Codable, Equatable {
    let stopId: Int
    let firstLineId: Int
    let reason: String
    let postMortem: Bool
    let exception: String?
    let frames: [DebugFrame]
    let selected: Int
    let scopes: [DebugScope]

    var frame: DebugFrame? { frames.indices.contains(selected) ? frames[selected] : frames.first }
}

private struct LinePatch: Codable {
    let id: Int
    let runId: Int
    let kind: String
    let text: String?
    let append: String?
    let trace: Trace?
}

private struct Payload: Codable {
    let changed: [LinePatch]
    let ids: [Int]
    let runs: [String: RunInfo]
    let status: String
    let awaitingInput: Bool
    let uiOpen: Bool
    let runningFile: String?
    let bootMs: Double?
    let runCounter: Int
    let debug: DebugState?
    let pausing: Bool
    let canInspect: Bool
    let kernel: KernelInfo?
}

@MainActor @Observable
final class SessionMirror {
    private(set) var lines: [ConsoleLine] = []
    private(set) var runs: [Int: RunInfo] = [:]
    private(set) var status = "idle" // idle, starting, running
    private(set) var awaitingInput = false
    private(set) var uiOpen = false
    private(set) var runningFile: String?
    private(set) var bootMs: Double?
    private(set) var runCounter = 0
    private(set) var debug: DebugState?
    private(set) var pausing = false
    private(set) var canInspect = false
    private(set) var kernel: KernelInfo?

    var running: Bool { status != "idle" }
    var lastRun: RunInfo? { lines.last.flatMap { runs[$0.runId] } }

    /// Applies a state message; returns false if it could not be read.
    @discardableResult
    func apply(_ json: String) -> Bool {
        guard let data = json.data(using: .utf8), let p = try? JSONDecoder().decode(Payload.self, from: data) else { return false }
        if !p.changed.isEmpty || p.ids.count != lines.count || p.ids != lines.map(\.id) {
            var byID = Dictionary(lines.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            for patch in p.changed {
                if let append = patch.append, var line = byID[patch.id] {
                    line.text += append
                    byID[patch.id] = line
                } else {
                    byID[patch.id] = ConsoleLine(id: patch.id, runId: patch.runId, kind: patch.kind, text: patch.text ?? "", trace: patch.trace)
                }
            }
            lines = p.ids.compactMap { byID[$0] }
        }
        let newRuns = Dictionary(p.runs.compactMap { k, v in Int(k).map { ($0, v) } }, uniquingKeysWith: { a, _ in a })
        if newRuns != runs { runs = newRuns }
        if status != p.status { status = p.status }
        if awaitingInput != p.awaitingInput { awaitingInput = p.awaitingInput }
        if uiOpen != p.uiOpen { uiOpen = p.uiOpen }
        if runningFile != p.runningFile { runningFile = p.runningFile }
        if bootMs != p.bootMs { bootMs = p.bootMs }
        if runCounter != p.runCounter { runCounter = p.runCounter }
        if debug != p.debug { debug = p.debug }
        if pausing != p.pausing { pausing = p.pausing }
        if canInspect != p.canInspect { canInspect = p.canInspect }
        if kernel != p.kernel { kernel = p.kernel }
        return true
    }

    /// The transcript as text, without images and turtle screens.
    var consoleText: String {
        lines.filter { $0.kind != "image" && $0.kind != "turtle" }.map(\.text).joined()
    }
}

extension RunInfo {
    func summary(awaitingInput: Bool, paused: Bool = false) -> String {
        switch status {
        case "running": return paused ? "Paused" : awaitingInput ? "Waiting for input" : "Running…"
        case "ok": return "Finished in \(duration)"
        case "error": return "Exited with an error"
        case "stopped": return "Stopped"
        case "crashed": return "Python crashed"
        default: return status
        }
    }

    var duration: String {
        let ms = Int((endedAt ?? Date().timeIntervalSince1970 * 1000) - startedAt)
        if ms < 1000 { return "\(ms) ms" }
        if ms < 60_000 { return String(format: "%.1f s", Double(ms) / 1000) }
        return "\(ms / 60_000) min \(Int((Double(ms % 60_000) / 1000).rounded())) s"
    }
}
