import UIKit

/// Hooks for the self-test (web/src/selftest.ts runs in the engine page and
/// drives the native app through these): app actions as the views call them,
/// the native UI app's tree, typing through UIKit and the turtle view.
@MainActor
enum SelfTest {
    static func handle(_ model: AppModel, _ op: String, _ value: [String: Any], _ reply: @escaping WebHost.Reply) {
        guard model.selftest else { return reply(nil, "self-test only") }
        Task {
            do {
                switch op {
                case "app": reply(try await app(model, value["method"] as? String ?? "", value["args"] as? [Any] ?? []), nil)
                case "test.ui": reply(ui(model, value), nil)
                case "test.type": reply(await type(value["text"] as? String ?? ""), nil)
                case "test.turtle": reply(turtle(model, value), nil)
                case "test.keybar": reply(keyBar(value["keys"] as? [String] ?? []), nil)
                case "test.hideKeyboard": reply(hideKeyboard(), nil)
                case "test.link":
                    // Link a folder outside Documents without the picker.
                    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                    let url = caches.appendingPathComponent("linked/\(value["name"] as? String ?? "x")", isDirectory: true)
                    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                    let entry = try model.host.files.locations.add(url)
                    model.fileListVersion += 1
                    reply(entry, nil)
                default: reply(nil, "unknown test op \(op)")
                }
            } catch {
                reply(nil, "\(error)")
            }
        }
    }

    private static func app(_ model: AppModel, _ method: String, _ args: [Any]) async throws -> Any? {
        func str(_ i: Int) -> String? { args.indices.contains(i) ? args[i] as? String : nil }
        func int(_ i: Int) -> Int? { args.indices.contains(i) ? args[i] as? Int : nil }
        switch method {
        case "openFile":
            await model.openFile(str(0) ?? "")
        case "openLocation":
            await model.openLocation(str(0) ?? "", line: int(1), column: int(2), keepConsole: true)
        case "currentFile":
            return model.file ?? NSNull()
        case "openURL":
            // As iOS delivers a pyslopnista:// link (onOpenURL).
            guard let action = URL(string: str(0) ?? "").flatMap(LaunchAction.init(url:)) else { return false }
            LaunchRouter.send(action)
            return true
        case "runIntent":
            // The Shortcuts action, as the system performs it.
            _ = try await RunProgramIntent(program: ProgramEntity(id: str(0) ?? "")).perform()
        case "programs":
            return try await ProgramQuery().suggestedEntities().map(\.id)
        case "homeScreenSheet":
            model.activeSheet = .homeScreen(str(0) ?? "")
        case "docsState":
            return model.docsState
        case "closeDocs":
            model.closeDocs()
        case "showDocs":
            model.showDocs(DocsTarget(version: str(0) ?? model.defaultPython, ref: str(1)))
        case "docsLink":
            return model.openDocsLink(URL(string: str(0) ?? "")!)
        case "docsSearch":
            // The viewer's own search field, as typing in it would.
            model.docs.browser?.query = str(0) ?? ""
            model.docs.browser?.search(str(0) ?? "")
            try await Task.sleep(for: .milliseconds(600))
            return model.docs.browser?.results.prefix(5).map { $0.ref } ?? []
        case "docsTarget":
            return await model.docsTarget(path: str(0) ?? "", text: str(1) ?? "", line: int(2) ?? 1, column: int(3) ?? 1)
                .map { ["version": $0.version, "ref": $0.ref ?? ""] as [String: Any] } ?? NSNull()
        case "setDefaultPython":
            model.setDefaultPython(str(0) ?? Runtimes.defaultPython)
        case "filePython":
            await model.refreshFilePython()
            return ["python": model.filePython?.python as Any? ?? NSNull(), "pin": model.folderPin as Any? ?? NSNull()] as [String: Any]
        case "setFolderPython":
            await model.setFolderPython(str(0))
        case "editor":
            let inner = args.indices.contains(1) ? args[1] as? [Any] ?? [] : []
            return try await model.editors[model.focused].call(str(0) ?? "", inner) ?? NSNull()
        case "run":
            await model.run()
        case "format":
            await model.format()
        case "goToDefinition":
            return await model.goToDefinition() ?? NSNull()
        case "panes":
            return model.panes.prefix(model.wide ? 2 : 1).map { ["tabs": $0.tabs, "active": $0.active ?? NSNull()] as [String: Any] }
        case "setSplit":
            if model.wide { await model.setSplit(args.first as? Bool ?? false) }
        case "closeTab":
            await model.closeTab(str(0) ?? "")
        case "showPane":
            switch str(0) {
            case "console": if model.wide { model.consoleDocked = true } else if model.consoleDetent == .peek { model.consoleDetent = .half }
            case "files": if !model.wide { model.route = [] }
            default: break
            }
        case "wide":
            return model.wide
        case "tapTraceback":
            let links = ConsoleLinks.all(model.session)
            guard let link = links.first(where: { $0.text.contains(str(0) ?? "") }) else { return 0 }
            await model.openLocation(link.path, line: link.line, keepConsole: true)
            return links.count
        case "focusField":
            if !model.wide && model.consoleDetent == .peek { model.consoleDetent = .half }
            if model.wide { model.consoleDocked = true }
            try? await Task.sleep(for: .milliseconds(200))
            model.focusedField = str(0) == "input" ? .input : .console
        case "fieldValue":
            return str(0) == "input" ? model.programInput : model.consoleInput
        case "submitField":
            if str(0) == "input" { model.submitProgramInput() } else { model.submitConsole() }
        case "clearField":
            if str(0) == "input" { model.programInput = "" } else { model.consoleInput = "" }
        case "blurFields":
            model.focusedField = nil
        case "openAgent":
            model.openAgent(project: str(0))
        case "agentIDEState":
            return await model.ideState()
        case "agentDetent":
            return model.agentDetent == .medium ? "medium" : "large"
        case "showConversations":
            model.agentListShown = true
        case "closeSheet":
            model.activeSheet = nil
        case "agentState":
            // The transcript as the native view has it (AgentMirror).
            let s = model.agent.state
            return ["sheet": model.activeSheet == .agent, "project": s.project ?? NSNull(), "busy": s.busy, "items": s.items.count,
                    "tools": s.items.filter { $0.kind == "tool" }.map { "\($0.tool ?? ""):\($0.status ?? "")" },
                    "last": s.items.last?.text ?? "", "model": s.model?.id ?? NSNull(), "error": s.error ?? NSNull(),
                    "conversations": s.conversations?.count ?? 0] as [String: Any]
        default:
            throw NSError(domain: "selftest", code: 1, userInfo: [NSLocalizedDescriptionKey: "unknown app method \(method)"])
        }
        return nil
    }

    /// The native UI app: its tree, and events as if a view had sent them.
    private static func ui(_ model: AppModel, _ value: [String: Any]) -> Any? {
        let store = model.ui.store
        switch value["action"] as? String {
        case "tree":
            return ["visible": model.ui.visible, "tree": store.snapshot(), "sheets": store.openSheets.map(\.id),
                    "dialogs": store.dialogs.map { ["id": $0.id, "kind": $0.kind] }]
        case "stats":
            return ["ops": store.lastRender.ops, "ms": store.lastRender.ms]
        case "event":
            guard let id = value["id"] as? Int, let node = store.node(id), let event = value["event"] as? String else { return false }
            let args = value["args"] as? [Any] ?? []
            if event == "change", let v = args.first {
                store.emitValue(node, value["prop"] as? String ?? "value", JSONValue(v))
            } else if event == "back" {
                node.parent?.poppedLocally.insert(id)
                store.emit(node, "back")
            } else {
                store.emit(node, event, args)
            }
            return true
        case "dialog":
            guard let dialog = store.dialogs.first else { return false }
            store.replyDialog(dialog, value["value"])
            return true
        case "close":
            store.close()
            return true
        default:
            return nil
        }
    }

    /// Type like the software keyboard does into whatever has focus (a native
    /// text field), one character at a time; reports the field's traits.
    private static func type(_ text: String) async -> String {
        guard let responder = UIResponder.current else { return "no first responder" }
        var notes = ["first responder \(Swift.type(of: responder))"]
        if let traits = responder as? UITextInputTraits {
            let autocap = traits.autocapitalizationType?.rawValue ?? -1
            let autocorrect = traits.autocorrectionType?.rawValue ?? -1
            let quotes = traits.smartQuotesType?.rawValue ?? -1
            notes.append("traits autocap=\(autocap) autocorrect=\(autocorrect) quotes=\(quotes)")
        }
        for ch in text {
            (responder as? UIKeyInput)?.insertText(String(ch))
            try? await Task.sleep(for: .milliseconds(60))
        }
        return notes.joined(separator: ", ")
    }

    /// What the software keyboard's own hide key does (iPad): UIKeyboardImpl's
    /// hideKeyboard, which keeps the field focused (dismissKeyboard resigns it).
    private static func hideKeyboard() -> Any {
        guard let cls = NSClassFromString("UIKeyboardImpl") as? NSObject.Type,
              let impl = cls.perform(NSSelectorFromString("activeInstance"))?.takeUnretainedValue() as? NSObject else { return "no UIKeyboardImpl" }
        let sel = NSSelectorFromString("hideKeyboard")
        guard impl.responds(to: sel) else { return "no hideKeyboard" }
        impl.perform(sel)
        return true
    }

    /// Tap keys on the key bar of whatever has focus, by their labels (also
    /// when it is collapsed for a hardware keyboard); reports whether it shows.
    private static func keyBar(_ labels: [String]) -> Any {
        guard let responder = UIResponder.current else { return "no first responder" }
        guard let bar = responder.inputAccessoryView else { return "no key bar on \(Swift.type(of: responder))" }
        let shown = bar.intrinsicContentSize.height > 0 && !bar.subviews.allSatisfy(\.isHidden)
        func find(_ view: UIView, _ label: String) -> UIButton? {
            if let button = view as? UIButton, button.accessibilityLabel == label { return button }
            for sub in view.subviews { if let hit = find(sub, label) { return hit } }
            return nil
        }
        for label in labels {
            guard let key = find(bar, label) else { return "no key \(label)" }
            key.sendActions(for: .touchDown)
            key.sendActions(for: .touchUpInside)
        }
        return ["shown": shown]
    }

    private static func turtle(_ model: AppModel, _ value: [String: Any]) -> Any? {
        guard let key = value["key"] as? String, let scene = model.turtles[key] else { return NSNull() }
        let x = (value["x"] as? NSNumber)?.doubleValue ?? 0
        let y = (value["y"] as? NSNumber)?.doubleValue ?? 0
        switch value["action"] as? String {
        case "pixel":
            let image = scene.render()
            let p = scene.viewPoint(CGPoint(x: x, y: -y), in: CGSize(width: scene.width, height: scene.height))
            return pixel(image, at: p)
        case "tap":
            for t in ["down", "up"] { model.sendTurtle(scene, ["t": t, "x": x, "y": -y, "b": 1]) }
            return true
        case "key":
            let name = value["name"] as? String ?? ""
            model.sendTurtle(scene, ["t": "key", "k": name])
            model.sendTurtle(scene, ["t": "keyup", "k": name])
            return true
        default:
            return NSNull()
        }
    }

    private static func pixel(_ image: UIImage, at p: CGPoint) -> [Int] {
        guard let cg = image.cgImage else { return [] }
        var data = [UInt8](repeating: 0, count: 4)
        let space = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(data: &data, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return [] }
        let scale = image.scale
        ctx.draw(cg, in: CGRect(x: -p.x * scale, y: -(CGFloat(cg.height) - p.y * scale), width: CGFloat(cg.width), height: CGFloat(cg.height)))
        return data.map(Int.init)
    }
}

extension UIResponder {
    private nonisolated(unsafe) static weak var found: UIResponder?

    /// The current first responder.
    static var current: UIResponder? {
        found = nil
        UIApplication.shared.sendAction(#selector(captureFirstResponder), to: nil, from: nil, for: nil)
        return found
    }

    @objc private func captureFirstResponder() {
        UIResponder.found = self
    }
}
