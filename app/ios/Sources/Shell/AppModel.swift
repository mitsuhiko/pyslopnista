import Observation
import SwiftUI
import WebKit

// The native IDE's state and actions (D31). Files, tabs, panes, breakpoints
// and settings live here; Python and the analysis run in the engine page,
// editing in one editor page per pane.

struct Pane: Codable, Equatable {
    var tabs: [String] = []
    var active: String?
}

struct Breakpoint: Codable, Equatable, Hashable {
    var line: Int
    var enabled: Bool
}

struct ProblemCounts: Equatable {
    var errors = 0
    var warnings = 0
    var total: Int { errors + warnings }
}

struct EditorSettings: Codable, Equatable {
    var fontSize = 15
    var wrap = true
    static let fontSizes = 11...24
}

enum ConsoleDetent: String {
    case peek, half, full
}

enum ActiveSheet: Identifiable, Equatable {
    case find, settings, problems, jump(String), agent
    var id: String {
        switch self {
        case .find: "find"
        case .settings: "settings"
        case .problems: "problems"
        case .jump: "jump"
        case .agent: "agent"
        }
    }
}

/// A popover anchored in an editor pane (rect in the pane's coordinates).
struct EditorPopover: Identifiable, Equatable {
    enum Kind: Equatable {
        case value(String) // the debugger's value of an expression
        case info(String?) // ty's hover text (nil while loading)
    }
    let id = UUID()
    let pane: Int
    let rect: CGRect
    var kind: Kind
    /// Show Info: the docs of what is at the cursor (D37), once looked up.
    var docs: DocsTarget?
}

struct BreakpointMenu: Identifiable, Equatable {
    let id = UUID()
    let path: String
    let line: Int
    let enabled: Bool
    let count: Int
}

enum ConsoleField: Hashable {
    case console, input
}

enum Route: Hashable {
    case folder(String)
    case editor
}

func isExternal(_ path: String) -> Bool { path.hasPrefix("ext:") }
func dirname(_ path: String) -> String { path.contains("/") ? String(path[..<path.lastIndex(of: "/")!]) : "" }
func basename(_ path: String) -> String { path.split(separator: "/").last.map(String.init) ?? path }
func joinPath(_ parts: String...) -> String { parts.filter { !$0.isEmpty }.joined(separator: "/") }
func isLocationRoot(_ path: String) -> Bool { path.hasPrefix("@") && !path.contains("/") }
func displayName(_ path: String) -> String {
    if path.isEmpty { return "Files" }
    return isLocationRoot(path) ? String(path.dropFirst()) : basename(path)
}
func tabLabel(_ path: String) -> String { basename(path.replacingOccurrences(of: "ext:", with: "")) }

@MainActor @Observable
final class AppModel {
    // services
    @ObservationIgnored let host: WebHost
    @ObservationIgnored private(set) var engine: PageController!
    @ObservationIgnored private(set) var editors: [PageController] = []
    @ObservationIgnored var engineView: WKWebView { engine.webView }
    let ui = UIHost()
    let session = SessionMirror()
    var turtles: [String: TurtleScene] = [:]

    // the coding agent (D34, AppModel+Agent.swift)
    let agent = AgentMirror()
    let agentHost = AgentHost()
    var agentAccounts: [AgentAccount] = []
    var agentModels: [AgentModelOption] = []
    var agentLoginError: String?
    var agentAccountsShown = false
    var agentListShown = false
    /// The agent sheet's height on iPhone: it makes room when the agent opens a file.
    var agentDetent: PresentationDetent = .large
    /// When the user last typed in each pane (the agent's ide_open does not switch away then).
    @ObservationIgnored var lastTyped: [Int: Date] = [:]

    // workspace
    var panes: [Pane] = [Pane()]
    var focusedPane = 0
    var route: [Route] = [] // iPhone: folders and the editor; iPad: folders in the sidebar
    var wide = false
    var problems = [ProblemCounts(), ProblemCounts()]
    var editorFocused = false
    var fileListVersion = 0
    var breakpoints: [String: [Breakpoint]] = [:]
    var settings = EditorSettings()
    var consoleDetent: ConsoleDetent = .peek
    var consoleDocked = true
    var sidebarVisible = true
    var splitRatio: CGFloat = 0.5
    var activeSheet: ActiveSheet?
    var popover: EditorPopover?
    var breakpointMenu: BreakpointMenu?
    var toast: String?
    var focusedField: ConsoleField?
    var consoleInput = ""
    var programInput = ""
    var consoleHistory: [String] = []
    /// Python versions (D37): the default (Settings), and what the current file runs on.
    var defaultPython = Runtimes.defaultPython
    var filePython: PythonChoice?
    /// The Python the current file's folder pins in its own `.python-version`.
    var folderPin: String?
    @ObservationIgnored let docs = DocsPresenter()

    @ObservationIgnored private var lastUsed: [String: Date] = [:]
    @ObservationIgnored private var writes: Task<Void, Never>?
    @ObservationIgnored private var rootSync: Task<Void, Never>?
    @ObservationIgnored private var rootDir: String?
    @ObservationIgnored private var lastStop: (Int, Int)?
    @ObservationIgnored private var lastRunCounter = 0
    @ObservationIgnored private var lastTurtleLine = 0
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var restored = false
    @ObservationIgnored let selftest = CommandLine.arguments.contains("--selftest")

    static let maxTabs = 10

    init() {
        let files = FileStore(locations: Locations())
        host = WebHost(files: files)
        let args = CommandLine.arguments
        if selftest {
            try? FileManager.default.removeItem(at: WebHost.documentURL(".probe-result.json"))
            try? FileManager.default.removeItem(at: WebHost.documentURL(".probe-log.txt"))
        }
        if args.contains("--reset") {
            for url in (try? FileManager.default.contentsOfDirectory(at: files.root, includingPropertiesForKeys: nil)) ?? [] {
                try? FileManager.default.removeItem(at: url)
            }
        }
        loadDefaults()
        var fragment = selftest ? "#selftest" : ""
        if let i = args.firstIndex(of: "--fragment"), i + 1 < args.count { fragment = "#" + args[i + 1] }
        var query = ""
        if let i = args.firstIndex(of: "--query"), i + 1 < args.count, !args[i + 1].isEmpty { query = "?" + args[i + 1] }
        // The engine runs the self-test (it has the session); launch hooks are ours.
        let engineFragment = fragment.hasPrefix("#selftest") ? fragment : ""
        engine = PageController(
            webView: host.makeWebView(role: .engine, page: "engine.html\(query)\(engineFragment)"),
            script: "return await window.__engine.command(name, args)"
        )
        agentHost.engineView = engine.webView
        editors = (0..<2).map { i in
            PageController(webView: host.makeWebView(role: .editor(i), page: "editor.html"), script: "return await window.__editor.call(name, args)")
        }
        // Files a program changed (D35) show up in the browser and in open tabs.
        host.hostFS.onChange = { [weak self] paths in self?.filesChanged(paths) }
        host.handler = { [weak self] op, value, role, reply in
            guard let self else { return reply(nil, "gone") }
            self.handle(op, value, role, reply)
        }
        host.onTerminate = { [weak self] role in
            switch role {
            case .engine:
                self?.engine.markNotReady()
                self?.agentHost.engineTerminated()
                self?.host.unmountAll() // its interpreters are gone
            case .editor(let i): self?.editors[i].markNotReady()
            }
        }
        ui.store.send = { [weak self] id, args in
            Task { _ = try? await self?.engine.call("uiEvent", ["id": id, "args": args]) }
        }
        ui.store.close = { [weak self] in
            Task { _ = try? await self?.engine.call("closeUI", [:]) }
        }
        Task { await self.restoreTabs(fragment: fragment) }
    }

    // MARK: persistence

    private func loadDefaults() {
        let d = UserDefaults.standard
        if let data = d.data(forKey: "settings"), let s = try? JSONDecoder().decode(EditorSettings.self, from: data) { settings = s }
        if let python = d.string(forKey: "python.default"), Runtimes.runtime(python) != nil { defaultPython = python }
        if let data = d.data(forKey: "breakpoints"), let b = try? JSONDecoder().decode([String: [Breakpoint]].self, from: data) { breakpoints = b }
        if let data = d.data(forKey: "tabs"), let saved = try? JSONDecoder().decode([Pane].self, from: data), !saved.isEmpty {
            panes = Array(saved.prefix(2)).map { Pane(tabs: $0.tabs.filter { !isExternal($0) }, active: $0.active.flatMap { isExternal($0) ? nil : $0 }) }
            focusedPane = min(d.integer(forKey: "focusedPane"), panes.count - 1)
        }
    }

    func saveTabs() {
        let clean = panes.map { Pane(tabs: $0.tabs.filter { !isExternal($0) }, active: $0.active.flatMap { isExternal($0) ? nil : $0 }) }
        UserDefaults.standard.set(try? JSONEncoder().encode(clean), forKey: "tabs")
        UserDefaults.standard.set(focusedPane, forKey: "focusedPane")
    }

    func updateSettings(_ change: (inout EditorSettings) -> Void) {
        var s = settings
        change(&s)
        s.fontSize = min(max(s.fontSize, EditorSettings.fontSizes.lowerBound), EditorSettings.fontSizes.upperBound)
        settings = s
        UserDefaults.standard.set(try? JSONEncoder().encode(s), forKey: "settings")
        for editor in editors { Task { _ = try? await editor.call("settings", [["fontSize": s.fontSize, "wrap": s.wrap]]) } }
    }

    // MARK: derived

    var split: Bool { wide && panes.count > 1 }
    var focused: Int { split ? focusedPane : wide ? min(focusedPane, panes.count - 1) : 0 }
    var file: String? { panes.indices.contains(focused) ? panes[focused].active : nil }
    var currentDir: String {
        if case .folder(let dir) = route.last(where: { if case .folder = $0 { true } else { false } }) { return dir }
        return ""
    }
    var editorShown: Bool { wide || route.last == .editor }

    func showToast(_ text: String) {
        toastTask?.cancel()
        withAnimation { toast = text }
        toastTask = Task {
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { withAnimation { self.toast = nil } }
        }
    }

    func haptic() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    // MARK: engine calls

    @discardableResult
    func command(_ name: String, _ args: [String: Any] = [:]) async -> Any? {
        do {
            return try await engine.call(name, args)
        } catch {
            WebHost.appendDocument(".probe-log.txt", "[engine] \(name) failed: \(error)\n")
            return nil
        }
    }

    func analysis(_ method: String, _ args: [Any]) async throws -> Any? {
        try await engine.call("analysis", ["method": method, "args": args])
    }

    @discardableResult
    func editorCall(_ pane: Int, _ method: String, _ args: [Any] = []) async -> Any? {
        guard editors.indices.contains(pane) else { return nil }
        return try? await editors[pane].call(method, args)
    }

    // MARK: bridge ops from the pages

    private func handle(_ op: String, _ value: [String: Any], _ role: WebHost.Role, _ reply: @escaping WebHost.Reply) {
        switch (role, op) {
        case (.engine, "engine.ready"):
            engine.markReady()
            host.unmountAll() // left by a page that reloaded
            Task {
                await command("setDefaultPython", ["python": defaultPython])
                await command("setBreakpoints", ["data": breakpointsJSON()])
                await syncAnalysisRoot(force: true)
                await refreshFilePython()
            }
            reply(nil, nil)
        case (.engine, "session.state"):
            if let json = value["json"] as? String { session.apply(json) }
            sessionChanged()
            reply(nil, nil)
        case (.engine, "ui.render"):
            ui.render(value["json"] as? String)
            reply(nil, nil)
        case (.engine, "files.changed"):
            filesChanged(value["paths"] as? [String] ?? [])
            reply(nil, nil)
        case (.engine, "breakpoints.changed"):
            setBreakpointsFromEngine(value["data"] as? [String: Any] ?? [:])
            reply(nil, nil)
        case (.engine, "turtle.ops"):
            if let key = value["key"] as? String, let ops = value["ops"] as? String { turtle(key).apply(ops) }
            reply(nil, nil)
        case (.engine, "turtle.state"):
            if let key = value["key"] as? String {
                turtle(key).setState(live: value["live"] as? Bool ?? false, active: value["active"] as? Bool ?? false,
                                     pointer: value["pointer"] as? Bool ?? false, keys: value["keys"] as? Bool ?? false)
            }
            reply(nil, nil)
        case (.engine, "test.link"), (.engine, "test.ui"), (.engine, "test.type"), (.engine, "test.turtle"), (.engine, "test.keybar"), (.engine, "test.hideKeyboard"), (.engine, "app"):
            SelfTest.handle(self, op, value, reply)
        case (.editor(let pane), "editor.event"):
            editorEvent(pane, value)
            reply(nil, nil)
        case (.editor, "analysis"):
            Task {
                do {
                    reply(try await analysis(value["method"] as? String ?? "", value["args"] as? [Any] ?? []), nil)
                } catch {
                    reply(nil, "\(error)")
                }
            }
        case (.engine, "agent.state"):
            if let json = value["json"] as? String { agent.apply(json) }
            reply(nil, nil)
        case (.engine, "ide"):
            Task {
                do {
                    reply(try await ideOperation(value) ?? NSNull(), nil)
                } catch {
                    reply(nil, error.localizedDescription)
                }
            }
        case (.engine, _) where op.hasPrefix("docs."):
            handleDocs(op, value, reply)
        case (.engine, "agent.flushEditors"):
            // The agent is about to read files: what was typed must be on disk.
            Task {
                await saveAll()
                reply(nil, nil)
            }
        case (.engine, _) where op.hasPrefix("agent."):
            if !agentHost.handle(op, value, reply) { reply(nil, "unknown op \(op)") }
        default:
            reply(nil, "unknown op \(op)")
        }
    }

    private func turtle(_ key: String) -> TurtleScene {
        if let scene = turtles[key] { return scene }
        let scene = TurtleScene(key: key)
        turtles[key] = scene
        return scene
    }

    func sendTurtle(_ scene: TurtleScene, _ event: [String: Any]) {
        Task { _ = await command("turtle", ["key": scene.key, "event": event]) }
    }

    // MARK: session changes

    private func sessionChanged() {
        let debug = session.debug
        // UI apps are on screen while they run, except while the debugger is paused.
        let showUI = session.uiOpen && debug == nil
        if showUI != ui.visible {
            if showUI { ui.show() } else { ui.hide() }
        }
        // A new run or a pending input() brings the console up.
        if session.runCounter != lastRunCounter {
            lastRunCounter = session.runCounter
            if consoleDetent == .peek { consoleDetent = .half }
            if wide { consoleDocked = true }
        }
        if session.awaitingInput {
            if consoleDetent == .peek { consoleDetent = .half }
            if focusedField != .input { focusedField = .input }
        } else if focusedField == .input {
            focusedField = nil
        }
        // A new turtle drawing gets the whole height on iPhone.
        let lastTurtle = session.lines.last(where: { $0.kind == "turtle" })?.id ?? 0
        if lastTurtle > lastTurtleLine {
            lastTurtleLine = lastTurtle
            if !wide { consoleDetent = .full }
        }
        // Turtle scenes that left the transcript are forgotten.
        if turtles.count > 4 {
            let shown = Set(session.lines.filter { $0.kind == "turtle" }.map(\.text))
            for key in turtles.keys where !shown.contains(key) && !(turtles[key]?.live ?? false) { turtles.removeValue(forKey: key) }
        }
        // The debugger: follow the paused frame.
        let stop = debug.map { ($0.stopId, $0.selected) }
        if stop?.0 != lastStop?.0 || stop?.1 != lastStop?.1 {
            let isNewStop = stop?.0 != lastStop?.0
            lastStop = stop
            if let debug, let frame = debug.frame {
                if isNewStop && !debug.postMortem { haptic() }
                if !wide, route.last != .editor { route.append(.editor) }
                if isNewStop && !wide && consoleDetent == .full { consoleDetent = .half }
                if !panes.enumerated().contains(where: { $0.element.active == frame.file && (split || $0.offset == focused) }) {
                    Task { await openLocation(frame.file, keepConsole: true) }
                }
            }
            popover = nil
            for i in editors.indices { Task { await syncEditorDebug(i) } }
        }
    }

    private func syncEditorDebug(_ pane: Int) async {
        let debug = session.debug
        let path = panes.indices.contains(pane) ? panes[pane].active : nil
        await editorCall(pane, "setPaused", [debug != nil, debug?.postMortem ?? false])
        let line: Any = (debug?.frame).flatMap { $0.file == path ? $0.line : nil } ?? NSNull()
        await editorCall(pane, "setDebugLine", [line, visibleFraction])
    }

    var visibleFraction: Double {
        wide ? 0.9 : consoleDetent == .peek ? 0.85 : consoleDetent == .half ? 0.45 : 0.15
    }

    /// Files written by a program show up in the browser and in open tabs.
    private func filesChanged(_ paths: [String]) {
        fileListVersion += 1
        for path in paths where panes.contains(where: { $0.tabs.contains(path) }) {
            Task {
                guard let text = try? await host.onFileQueue({ try $0.read(path, encoding: "utf8") }) else { return }
                for i in editors.indices { await editorCall(i, "replaceText", [path, text]) }
            }
        }
        // A UI app saving its data every second should not make ty re-read the folder.
        if paths.contains(where: { $0.hasSuffix(".py") || $0.hasSuffix(".pyi") }) { Task { await syncAnalysisRoot(force: true) } }
    }

    // MARK: editor events

    private func editorEvent(_ pane: Int, _ value: [String: Any]) {
        let type = value["type"] as? String ?? ""
        switch type {
        case "ready":
            editors[pane].markReady()
            Task {
                await editorCall(pane, "settings", [["fontSize": settings.fontSize, "wrap": settings.wrap]])
                if pane < panes.count, let active = panes[pane].active, restored { await show(active, in: pane) }
            }
        case "changes":
            guard let path = value["path"] as? String, let changes = value["changes"] as? String else { return }
            lastTyped[pane] = Date()
            for other in editors.indices where other != pane && panes.indices.contains(other) && panes[other].tabs.contains(path) {
                Task { _ = await editorCall(other, "applyRemote", [path, changes]) }
            }
        case "text":
            guard let path = value["path"] as? String, let text = value["text"] as? String, !isExternal(path) else { return }
            write(path, text)
        case "focus":
            let focused = value["focused"] as? Bool ?? false
            editorFocused = focused
            if focused {
                if focusedPane != pane, pane < panes.count { focusedPane = pane }
                KeyboardAccessory.shared.webView = editors[pane].webView
                focusedField = nil
            }
        case "problems":
            problems[pane] = ProblemCounts(errors: value["errors"] as? Int ?? 0, warnings: value["warnings"] as? Int ?? 0)
        case "longPress":
            guard let path = value["path"] as? String, let line = value["line"] as? Int, !isExternal(path) else { return }
            gutterLongPress(pane, path, line)
        case "breakpoints":
            guard let path = value["path"] as? String, let list = value["breakpoints"] as? [[String: Any]] else { return }
            setBreakpoints(path, list.map { Breakpoint(line: $0["line"] as? Int ?? 0, enabled: $0["enabled"] as? Bool ?? true) }, fromEditor: pane)
        case "inspect":
            guard session.debug != nil, let expr = value["expr"] as? String else { return }
            popover = EditorPopover(pane: pane, rect: rect(value["rect"]), kind: .value(expr))
        case "definition":
            Task { _ = await goToDefinition() }
        case "info":
            Task { _ = await showInfo() }
        case "showProblems":
            activeSheet = .problems
        default:
            break
        }
    }

    private func rect(_ v: Any?) -> CGRect {
        let r = v as? [String: Any] ?? [:]
        func n(_ k: String) -> CGFloat { CGFloat((r[k] as? NSNumber)?.doubleValue ?? 0) }
        return CGRect(x: n("x"), y: n("y"), width: max(1, n("width")), height: max(1, n("height")))
    }

    // MARK: files and saving

    /// Write a file (in order with other writes).
    func write(_ path: String, _ text: String) {
        let previous = writes
        writes = Task {
            await previous?.value
            do {
                try await host.onFileQueue { try $0.write(path, data: text, encoding: "utf8") }
            } catch {
                showToast("Could not save \(basename(path)): \(error)")
            }
        }
    }

    /// Everything typed so far is on disk.
    func saveAll() async {
        for i in editors.indices where i < panes.count {
            guard let path = panes[i].active, !isExternal(path) else { continue }
            if let text = await editorCall(i, "flush") as? String { write(path, text) }
        }
        await writes?.value
    }

    func readText(_ path: String) async throws -> String {
        if isExternal(path) { return try await analysis("source", [path]) as? String ?? "" }
        await writes?.value
        return try await host.onFileQueue { try $0.read(path, encoding: "utf8") }
    }

    // MARK: opening files

    private func restoreTabs(fragment: String) async {
        // Tabs of files that are gone close.
        var next = panes
        for i in next.indices {
            var tabs: [String] = []
            for t in next[i].tabs where (try? await host.onFileQueue({ try $0.exists(t) })) == true { tabs.append(t) }
            next[i].tabs = tabs
            if let a = next[i].active, !tabs.contains(a) { next[i].active = tabs.first }
        }
        if next.count > 1 && next[1].tabs.isEmpty { next = [next[0]] }
        panes = next
        focusedPane = min(focusedPane, panes.count - 1)
        restored = true
        for (i, p) in panes.enumerated() { if let a = p.active { await show(a, in: i) } }
        await launchHooks(fragment)
    }

    /// Shows `path` in an editor pane (loading its text if the pane has no state for it).
    private func show(_ path: String, in pane: Int) async {
        let editor = pane
        // Shows can overlap (restoring tabs, launch hooks, the debugger): only
        // the pane's current file may be opened.
        let current = { self.panes.indices.contains(pane) && self.panes[pane].active == path }
        if await editorCall(editor, "has", [path]) as? Bool != true {
            guard let text = try? await readText(path), current() else { return }
            await editorCall(editor, "open", [path, text, isExternal(path)])
        } else {
            guard current() else { return }
            await editorCall(editor, "open", [path, "", isExternal(path)])
        }
        await editorCall(editor, "setBreakpoints", [breakpointList(path)])
        await syncEditorDebug(editor)
        await syncAnalysisRoot()
    }

    func openFile(_ path: String) async {
        await openLocation(path)
    }

    /// Show a file, optionally at a line: in the pane where it is already the
    /// active tab, else as a tab in the focused pane.
    func openLocation(_ path: String, line: Int? = nil, column: Int? = nil, pane: Int? = nil, keepConsole: Bool = false) async {
        let shownIn = panes.indices.first { panes[$0].active == path && (split || $0 == focused) }
        let target = pane ?? shownIn ?? focused
        let previous = file
        if target >= panes.count { panes.append(Pane()) }
        var p = panes[target]
        let dropped = withTab(&p, path)
        panes[target] = p
        focusedPane = target
        for t in dropped { await editorCall(target, "forget", [t]) }
        guard panes.indices.contains(target) else { return }
        await show(path, in: target)
        if let line { await editorCall(target, "reveal", [line, column ?? 1, visibleFraction]) }
        if !wide, route.last != .editor { route.append(.editor) }
        if !keepConsole && path != previous { consoleDetent = .peek } else if consoleDetent == .full { consoleDetent = .half }
        saveTabs()
    }

    /// Insert a tab right after the active one, like Safari; returns tabs closed by the limit.
    private func withTab(_ pane: inout Pane, _ path: String) -> [String] {
        lastUsed[path] = Date()
        if pane.tabs.contains(path) {
            pane.active = path
            return []
        }
        let at = pane.active.flatMap { pane.tabs.firstIndex(of: $0) }.map { $0 + 1 } ?? pane.tabs.count
        pane.tabs.insert(path, at: at)
        var dropped: [String] = []
        while pane.tabs.count > Self.maxTabs {
            let oldest = pane.tabs.filter { $0 != path }.min { (lastUsed[$0] ?? .distantPast) < (lastUsed[$1] ?? .distantPast) }!
            pane.tabs.removeAll { $0 == oldest }
            dropped.append(oldest)
        }
        pane.active = path
        return dropped
    }

    func selectTab(_ path: String, pane: Int) async {
        lastUsed[path] = Date()
        guard panes.indices.contains(pane) else { return }
        panes[pane].active = path
        focusedPane = pane
        await show(path, in: pane)
        saveTabs()
    }

    func closeTab(_ path: String, pane: Int? = nil) async {
        let index = pane ?? focused
        await saveAll()
        await editorCall(index, "forget", [path])
        guard panes.indices.contains(index) else { return }
        var p = panes[index]
        guard let i = p.tabs.firstIndex(of: path) else { return }
        p.tabs.remove(at: i)
        if p.active == path { p.active = p.tabs.isEmpty ? nil : p.tabs[min(i, p.tabs.count - 1)] }
        panes[index] = p
        if panes.count > 1, panes[1].tabs.isEmpty {
            panes = [panes[0]]
            focusedPane = 0
        } else if panes.count > 1, panes[0].tabs.isEmpty {
            panes = [panes[1]]
            focusedPane = 0
            if let a = panes[0].active { await show(a, in: 0) }
        }
        if let active = panes[min(index, panes.count - 1)].active { await show(active, in: min(index, panes.count - 1)) }
        else { await editorCall(index, "open", [NSNull(), "", false]) }
        saveTabs()
    }

    func closeOtherTabs(_ path: String, pane: Int) async {
        guard panes.indices.contains(pane) else { return }
        for t in panes[pane].tabs where t != path { await editorCall(pane, "forget", [t]) }
        guard panes.indices.contains(pane) else { return }
        panes[pane] = Pane(tabs: [path], active: path)
        saveTabs()
    }

    func setSplit(_ on: Bool) async {
        if on && panes.count == 1 {
            panes.append(Pane(tabs: file.map { [$0] } ?? [], active: file))
            focusedPane = 1
            if let f = file { await show(f, in: 1) }
        } else if !on && panes.count > 1 {
            let active = panes[focused].active ?? panes[0].active
            var tabs = panes[0].tabs
            for t in panes[1].tabs where !tabs.contains(t) { tabs.append(t) }
            panes = [Pane(tabs: tabs, active: active)]
            focusedPane = 0
            if let active { await show(active, in: 0) }
        }
        saveTabs()
    }

    func openInOtherPane(_ path: String, from pane: Int) async {
        if panes.count == 1 {
            if panes[0].tabs.count > 1 { await closeTab(path, pane: 0) }
            panes.append(Pane(tabs: [path], active: path))
            focusedPane = 1
            await show(path, in: 1)
        } else {
            await openLocation(path, pane: pane == 0 ? 1 : 0)
        }
        saveTabs()
    }

    // MARK: file operations

    func rename(_ path: String, to name: String) async -> Bool {
        let to = joinPath(dirname(path), name)
        if (try? await host.onFileQueue({ try $0.exists(to) })) == true {
            showToast("“\(name)” already exists")
            return false
        }
        await saveAll()
        do {
            try await host.onFileQueue { try $0.rename(from: path, to: to) }
        } catch {
            showToast("Could not rename: \(error)")
            return false
        }
        renamed(path, to)
        return true
    }

    func renamed(_ from: String, _ to: String) {
        let moved = { (p: String) in p == from || p.hasPrefix(from + "/") ? to + p.dropFirst(from.count) : p }
        var next: [String: [Breakpoint]] = [:]
        for (p, list) in breakpoints { next[moved(p)] = list }
        if next != breakpoints { commitBreakpoints(next) }
        for i in editors.indices { Task { _ = await editorCall(i, "renamePath", [from, to]) } }
        panes = panes.map { Pane(tabs: $0.tabs.map(moved), active: $0.active.map(moved)) }
        fileListVersion += 1
        saveTabs()
        // The agent's conversations of a renamed folder work in the new one (D36).
        Task { _ = await agentCall("renamed", [from, to]) }
    }

    func delete(_ path: String) async {
        do {
            try await host.onFileQueue { try $0.delete(path) }
        } catch {
            showToast("Could not delete: \(error)")
            return
        }
        deleted(path)
    }

    func deleted(_ path: String) {
        let gone = { (p: String) in p == path || p.hasPrefix(path + "/") }
        let next = breakpoints.filter { !gone($0.key) }
        if next.count != breakpoints.count { commitBreakpoints(next) }
        for i in editors.indices { Task { _ = await editorCall(i, "forget", [path]) } }
        var next2 = panes.map { pane -> Pane in
            var p = pane
            let wasActive = p.active.map(gone) ?? false
            p.tabs.removeAll(where: gone)
            if wasActive { p.active = p.tabs.first }
            return p
        }
        if next2.count > 1, next2[1].tabs.isEmpty { next2 = [next2[0]] }
        panes = next2
        focusedPane = min(focusedPane, panes.count - 1)
        for i in panes.indices {
            if let a = panes[i].active { Task { await show(a, in: i) } } else { Task { _ = await editorCall(i, "open", [NSNull(), "", false]) } }
        }
        if !wide, route.last == .editor, file == nil { route.removeLast() }
        fileListVersion += 1
        saveTabs()
    }

    func duplicate(_ path: String) async -> String? {
        await saveAll()
        let name = basename(path)
        let dot = name.lastIndex(of: ".").flatMap { $0 == name.startIndex ? nil : $0 }
        let stem = dot.map { String(name[..<$0]) } ?? name
        let ext = dot.map { String(name[$0...]) } ?? ""
        var n = 2
        while (try? await host.onFileQueue({ [n] in try $0.exists(joinPath(dirname(path), "\(stem) \(n)\(ext)")) })) == true { n += 1 }
        let copy = joinPath(dirname(path), "\(stem) \(n)\(ext)")
        do {
            let text = try await readText(path)
            try await host.onFileQueue { try $0.write(copy, data: text, encoding: "utf8") }
        } catch {
            showToast("Could not duplicate: \(error)")
            return nil
        }
        fileListVersion += 1
        return copy
    }

    func newFile(in dir: String, name: String) async -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !trimmed.contains("/") else { return nil }
        let path = joinPath(dir, trimmed.contains(".") ? trimmed : "\(trimmed).py")
        if (try? await host.onFileQueue({ try $0.exists(path) })) == true {
            showToast("“\(basename(path))” already exists")
            return nil
        }
        try? await host.onFileQueue { try $0.write(path, data: "", encoding: "utf8") }
        fileListVersion += 1
        return path
    }

    func newFolder(in dir: String, name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !trimmed.contains("/") else { return }
        try? await host.onFileQueue { try $0.mkdir(joinPath(dir, trimmed)) }
        fileListVersion += 1
    }

    func linkFolder(_ url: URL) -> String? {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        do {
            let entry = try host.files.locations.add(url)
            fileListVersion += 1
            return entry["path"] as? String
        } catch {
            showToast("Could not open the folder: \(error)")
            return nil
        }
    }

    func unlink(_ path: String) async {
        await saveAll()
        host.files.locations.remove(named: String(path.dropFirst()))
        deleted(path)
    }

    // MARK: running

    func run() async {
        guard let file, !isExternal(file) else { return }
        haptic()
        await saveAll()
        var code = await editorCall(focused, "text") as? String
        if code == nil { code = try? await readText(file) }
        await editorCall(focused, "blur")
        if wide { consoleDocked = true }
        await command("runFile", ["path": file, "code": code ?? ""])
    }

    func stop() {
        haptic()
        Task { _ = await command("stop") }
    }

    func pause() {
        haptic()
        Task { _ = await command("pause") }
    }

    func resume(_ op: String) {
        haptic()
        Task { _ = await command("resume", ["op": op]) }
    }

    func selectFrame(_ index: Int) {
        Task { _ = await command("selectFrame", ["index": index]) }
    }

    func debugVariables(_ ref: Int) async -> [DebugVariable] {
        guard let raw = await command("debugVariables", ["ref": ref]),
              let data = try? JSONSerialization.data(withJSONObject: raw) else { return [] }
        return (try? JSONDecoder().decode([DebugVariable].self, from: data)) ?? []
    }

    func debugEvaluate(_ expr: String) async -> (DebugVariable?, String?) {
        guard let raw = await command("debugEvaluate", ["expr": expr]) as? [String: Any] else { return (nil, "No answer") }
        if let error = raw["error"] as? String { return (nil, error) }
        guard let value = raw["value"], let data = try? JSONSerialization.data(withJSONObject: value) else { return (nil, "No value") }
        return (try? JSONDecoder().decode(DebugVariable.self, from: data), nil)
    }

    func inspectError() {
        Task { _ = await command("inspectError") }
    }

    func clearConsole() {
        Task { _ = await command("clear") }
    }

    /// Counts Return in the console fields; the console scrolls to the end.
    var consoleSubmits = 0

    func submitConsole() {
        consoleSubmits += 1
        let source = consoleInput
        guard !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        consoleHistory.removeAll { $0 == source }
        consoleHistory.append(source)
        consoleInput = ""
        if session.debug != nil {
            Task { _ = await command("debugConsole", ["source": source]) }
        } else {
            Task { _ = await command("runConsole", ["source": source]) }
        }
    }

    func submitProgramInput() {
        consoleSubmits += 1
        let text = programInput
        programInput = ""
        Task { _ = await command("submitInput", ["text": text]) }
    }

    func appWillResignActive() {
        Task { await saveAll() }
        Task {
            // The program's queued writes first, then staged copies back to their folders.
            _ = await command("background")
            host.syncMounts()
        }
    }

    // MARK: code intelligence

    func format() async {
        guard let file, !isExternal(file) else { return }
        do {
            let changed = try await editors[focused].call("format", [])
            showToast((changed as? Bool) == true ? "Formatted" : "Already formatted")
        } catch {
            showToast("Could not format: \(error.localizedDescription)")
        }
    }

    private struct Cursor {
        let path: String
        let text: String
        let line: Int
        let column: Int
        let rect: CGRect?
    }

    private func cursor() async -> Cursor? {
        guard let c = await editorCall(focused, "cursor") as? [String: Any], let path = c["path"] as? String, path == file else { return nil }
        return Cursor(path: path, text: c["text"] as? String ?? "", line: c["line"] as? Int ?? 1, column: c["column"] as? Int ?? 1,
                      rect: c["rect"] is [String: Any] ? rect(c["rect"]) : nil)
    }

    func goToDefinition() async -> Any? {
        guard let c = await cursor() else { return ["skipped": true] }
        if isExternal(c.path) {
            showToast("Not available in library files")
            return nil
        }
        await rootSync?.value // the folder's modules must be known first
        do {
            let targets = try await analysis("definition", [c.path, c.text, c.line, c.column]) as? [[String: Any]] ?? []
            guard let target = targets.first, let path = target["path"] as? String else {
                showToast("No definition found")
                return ["targets": targets]
            }
            let start = target["start"] as? [String: Any] ?? [:]
            haptic()
            await openLocation(path, line: start["line"] as? Int, column: start["column"] as? Int, keepConsole: true)
            return ["file": c.path, "line": c.line, "column": c.column, "targets": targets]
        } catch {
            showToast("Could not find the definition: \(error.localizedDescription)")
            return nil
        }
    }

    func showInfo() async -> String? {
        guard let c = await cursor(), !isExternal(c.path) else { return nil }
        let pop = EditorPopover(pane: focused, rect: c.rect ?? CGRect(x: 40, y: 80, width: 1, height: 1), kind: .info(nil))
        popover = pop
        let markdown = (try? await analysis("hover", [c.path, c.text, c.line, c.column])) as? String ?? ""
        if popover?.id == pop.id { popover?.kind = .info(markdown) }
        // A standard library name gets a link into the docs.
        if let docs = await docsTarget(path: c.path, text: c.text, line: c.line, column: c.column), popover?.id == pop.id {
            popover?.docs = docs
        }
        return markdown
    }

    /// ty sees the folder the program runs in: its modules import like top-level ones.
    func syncAnalysisRoot(force: Bool = false) async {
        guard let file, !isExternal(file) else { return }
        let dir = dirname(file)
        if !force && dir == rootDir { return }
        rootDir = dir
        let previous = rootSync
        let task = Task {
            await previous?.value
            guard let tree = try? await host.onFileQueue({ try $0.tree(dir) }) else { return }
            var files: [[String: String]] = []
            for f in tree.prefix(2000) {
                guard let rel = f["path"], rel.hasSuffix(".py") || rel.hasSuffix(".pyi"),
                      let data = f["data"].flatMap({ Data(base64Encoded: $0) }), let text = String(data: data, encoding: .utf8) else { continue }
                files.append(["path": joinPath(dir, rel), "text": text])
                if files.count >= 300 { break }
            }
            // Files on screen may have edits that are not saved yet.
            for i in editors.indices where i < panes.count {
                guard let path = panes[i].active, let j = files.firstIndex(where: { $0["path"] == path }),
                      let text = await editorCall(i, "text") as? String else { continue }
                files[j]["text"] = text
            }
            _ = try? await analysis("sync", [files])
            _ = try? await analysis("setRoot", [dir])
            // Imports of those modules may have been flagged before ty knew them.
            for i in editors.indices { await editorCall(i, "relint") }
        }
        rootSync = task
        await task.value
    }

    // MARK: breakpoints (D23)

    func breakpointList(_ path: String) -> [[String: Any]] {
        (breakpoints[path] ?? []).map { ["line": $0.line, "enabled": $0.enabled] }
    }

    private func breakpointsJSON() -> [String: Any] {
        breakpoints.mapValues { list in list.map { ["line": $0.line, "enabled": $0.enabled] } }
    }

    private func commitBreakpoints(_ next: [String: [Breakpoint]], fromEditor: Int? = nil, toEngine: Bool = true) {
        let cleaned = next.filter { !$0.value.isEmpty }
        let changed = cleaned.filter { breakpoints[$0.key] != $0.value }.map(\.key) + breakpoints.keys.filter { cleaned[$0] == nil }
        breakpoints = cleaned
        UserDefaults.standard.set(try? JSONEncoder().encode(cleaned), forKey: "breakpoints")
        if toEngine { Task { _ = await command("setBreakpoints", ["data": breakpointsJSON()]) } }
        for i in editors.indices where i != fromEditor && i < panes.count {
            if let active = panes[i].active, changed.contains(active) {
                let list = breakpointList(active)
                Task { _ = await editorCall(i, "setBreakpoints", [list]) }
            }
        }
    }

    func setBreakpoints(_ path: String, _ list: [Breakpoint], fromEditor: Int? = nil) {
        var byLine: [Int: Breakpoint] = [:]
        for bp in list where bp.line > 0 && byLine[bp.line] == nil { byLine[bp.line] = bp }
        let sorted = byLine.values.sorted { $0.line < $1.line }
        guard sorted != (breakpoints[path] ?? []) else { return }
        var next = breakpoints
        next[path] = sorted
        commitBreakpoints(next, fromEditor: fromEditor)
    }

    private func setBreakpointsFromEngine(_ data: [String: Any]) {
        var next: [String: [Breakpoint]] = [:]
        for (path, value) in data {
            next[path] = (value as? [[String: Any]] ?? []).map { Breakpoint(line: $0["line"] as? Int ?? 0, enabled: $0["enabled"] as? Bool ?? true) }
        }
        commitBreakpoints(next, toEngine: false)
    }

    func toggleBreakpoint(_ path: String, line: Int, text: String) {
        var list = breakpoints[path] ?? []
        if list.contains(where: { $0.line == line }) {
            list.removeAll { $0.line == line }
        } else {
            list.append(Breakpoint(line: Self.codeLine(text, from: line), enabled: true))
        }
        setBreakpoints(path, list)
    }

    func setBreakpointEnabled(_ path: String, line: Int, _ enabled: Bool) {
        setBreakpoints(path, (breakpoints[path] ?? []).map { $0.line == line ? Breakpoint(line: line, enabled: enabled) : $0 })
    }

    func removeBreakpoint(_ path: String, line: Int) {
        setBreakpoints(path, (breakpoints[path] ?? []).filter { $0.line != line })
    }

    func clearBreakpoints(_ path: String) {
        setBreakpoints(path, [])
    }

    private func gutterLongPress(_ pane: Int, _ path: String, _ line: Int) {
        let list = breakpoints[path] ?? []
        if let existing = list.first(where: { $0.line == line }) {
            breakpointMenu = BreakpointMenu(path: path, line: line, enabled: existing.enabled, count: list.count)
            return
        }
        haptic()
        Task {
            let text = await editorCall(pane, "text") as? String ?? ""
            toggleBreakpoint(path, line: line, text: text)
        }
    }

    /// A breakpoint on a blank or comment line moves to the next line of code.
    static func codeLine(_ text: String, from line: Int) -> Int {
        let lines = text.components(separatedBy: "\n")
        var i = line - 1
        while i < lines.count {
            let t = lines[max(0, i)].trimmingCharacters(in: .whitespaces)
            if !t.isEmpty && !t.hasPrefix("#") { return i + 1 }
            i += 1
        }
        return line
    }

    func toggleBreakpointAtCursor() async {
        guard let c = await cursor(), !isExternal(c.path) else { return }
        toggleBreakpoint(c.path, line: c.line, text: c.text)
    }

    // MARK: launch hooks for screenshots: open=<path>[&bp=<lines>][&split=<path>][&run][&pane=files|editor|console][&focus[=console]][&agent[=accounts|conversations]][&ask=<prompt>][&docs=<version>/<ref, # as %23>]

    private func launchHooks(_ fragment: String) async {
        guard !fragment.hasPrefix("#selftest") else { return }
        var hook: [String: String] = [:]
        for part in fragment.dropFirst().split(separator: "&") {
            let kv = part.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? String($0) }
            hook[kv[0]] = kv.count > 1 ? kv[1] : ""
        }
        await engine.whenReady()
        if let open = hook["open"] {
            if let bp = hook["bp"] {
                setBreakpoints(open, bp.split(separator: ",").compactMap { Int($0) }.map { Breakpoint(line: $0, enabled: true) })
            }
            await openFile(open)
        }
        if let other = hook["split"] {
            await setSplit(true)
            await openFile(other)
        }
        if hook["run"] != nil {
            try? await Task.sleep(for: .milliseconds(300))
            await run()
        }
        switch hook["pane"] {
        case "console": if wide { consoleDocked = true } else { consoleDetent = .half }
        case "files": if !wide { route = [] }
        default: break
        }
        if let agentHook = hook["agent"] {
            openAgent()
            if agentHook == "accounts" { agentAccountsShown = true }
            if agentHook == "conversations" { agentListShown = true }
            if let prompt = hook["ask"] {
                // A fresh conversation in the folder, then the prompt as if typed.
                for _ in 0..<50 where agent.state.root == nil { try? await Task.sleep(for: .milliseconds(200)) }
                if let project = agent.state.root { _ = await agentCall("newConversation", [project, NSNull()]) }
                agentSend(prompt)
            }
        }
        if let target = hook["docs"], let url = URL(string: "docs:\(target.replacingOccurrences(of: "#", with: "%23"))") {
            try? await Task.sleep(for: .milliseconds(300))
            _ = openDocsLink(url)
        }
        if hook["focus"] == "console" {
            try? await Task.sleep(for: .milliseconds(600))
            focusedField = .console
        } else if hook["focus"] != nil {
            try? await Task.sleep(for: .milliseconds(600))
            for _ in 0..<5 {
                await editorCall(focused, "focus")
                if KeyboardAccessory.shared.focusForTesting() { break }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
    }
}
