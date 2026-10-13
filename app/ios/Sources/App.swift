import SwiftUI
import UniformTypeIdentifiers
import WebKit

@main
struct PyslopnistaApp: App {
    var body: some Scene {
        WindowGroup {
            // Extend under the status bar and home indicator, but not under the
            // keyboard: SwiftUI shrinks the web view above the keyboard, its
            // accessory row and the iPad shortcut bar, so nothing is covered.
            WebView().ignoresSafeArea(.container)
        }
    }
}

struct WebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView { context.coordinator.makeWebView() }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

@MainActor
final class Coordinator: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate, UIDocumentPickerDelegate {
    private let schemeHandler = AppSchemeHandler(
        root: Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
    )
    private let files = FileStore(locations: Locations())
    /// File operations run here, off the main thread: reading a file in iCloud
    /// Drive may have to download it first. One queue keeps them in order.
    private let fileQueue = DispatchQueue(label: "eu.ronacher.Pyslopnista.files", qos: .userInitiated)
    private var pickerReply: (@MainActor @Sendable (Any?, String?) -> Void)?
    private weak var webView: WKWebView?

    func makeWebView() -> WKWebView {
        let args = CommandLine.arguments
        if args.contains("--selftest") {
            try? FileManager.default.removeItem(at: Self.documentURL(".probe-result.json"))
            try? FileManager.default.removeItem(at: Self.documentURL(".probe-log.txt"))
        }
        if args.contains("--reset") {
            for url in (try? FileManager.default.contentsOfDirectory(at: files.root, includingPropertiesForKeys: nil)) ?? [] {
                try? FileManager.default.removeItem(at: url)
            }
        }

        let config = WKWebViewConfiguration()
        Self.renderAtDisplayRate(config.preferences)
        config.setURLSchemeHandler(schemeHandler, forURLScheme: AppSchemeHandler.scheme)
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "bridge")

        let webView = CodeWebView(frame: .zero, configuration: config)
        webView.isInspectable = true
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .systemGroupedBackground
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        self.webView = webView
        KeyboardAccessory.shared.install(on: webView)

        var query = ""
        if let i = args.firstIndex(of: "--query"), i + 1 < args.count, !args[i + 1].isEmpty { query = "?" + args[i + 1] }
        var fragment = args.contains("--selftest") ? "#selftest" : ""
        if let i = args.firstIndex(of: "--fragment"), i + 1 < args.count { fragment = "#" + args[i + 1] }
        webView.load(URLRequest(url: URL(string: "\(AppSchemeHandler.scheme)://app/index.html\(query)\(fragment)")!))
        return webView
    }

    // MARK: bridge

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            replyHandler(nil, "malformed bridge message")
            return
        }
        let value = body["value"] as? [String: Any] ?? [:]
        let str = { (key: String) in value[key] as? String ?? "" }
        if op.hasPrefix("fs.") {
            fileOperation(op, value.compactMapValues { $0 as? String }, reply: replyHandler)
            return
        }
        do {
            switch op {
            case "locations.list": replyHandler(files.locations.list(), nil)
            case "locations.add": pickFolder(reply: replyHandler)
            case "locations.remove":
                files.locations.remove(named: String(str("path").dropFirst()))
                replyHandler(nil, nil)
            case "test.link" where CommandLine.arguments.contains("--selftest"):
                // Self-test only: link a folder outside Documents without the picker.
                let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                let url = caches.appendingPathComponent("linked/\(str("name"))", isDirectory: true)
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                replyHandler(try files.locations.add(url), nil)
            case "keyboard.mode":
                KeyboardAccessory.shared.setMode(KeyboardAccessory.Mode(rawValue: str("mode")) ?? .plain)
                replyHandler(nil, nil)
            case "test.type":
                // Self-test only: type through the software keyboard's own path.
                let text = str("text"), via = str("via")
                Task { @MainActor in
                    let result = await KeyboardAccessory.shared.typeForTesting(text, via: via)
                    replyHandler(result, nil)
                }
            case "echo": replyHandler(body["value"], nil)
            case "haptic":
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                replyHandler(nil, nil)
            case "log":
                Self.appendDocument(".probe-log.txt", "\(body["value"] ?? "")\n")
                replyHandler(nil, nil)
            case "result":
                try? (body["value"] as? String ?? "null").write(to: Self.documentURL(".probe-result.json"), atomically: true, encoding: .utf8)
                replyHandler(nil, nil)
            default:
                replyHandler(nil, "unknown op \(op)")
            }
        } catch {
            replyHandler(nil, "\(error)")
        }
    }

    private struct Reply: @unchecked Sendable {
        let value: Any?
        let error: String?
    }

    private func fileOperation(_ op: String, _ args: [String: String], reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let files = files
        fileQueue.async {
            let result: Reply
            do {
                result = Reply(value: try Self.perform(files, op, args), error: nil)
            } catch {
                result = Reply(value: nil, error: "\(error)")
            }
            Task { @MainActor in reply(result.value, result.error) }
        }
    }

    nonisolated private static func perform(_ files: FileStore, _ op: String, _ args: [String: String]) throws -> Any? {
        let str = { (key: String) in args[key] ?? "" }
        switch op {
        case "fs.list": return try files.list(str("path"))
        case "fs.read": return try files.read(str("path"), encoding: str("encoding"))
        case "fs.write": try files.write(str("path"), data: str("data"), encoding: str("encoding"))
        case "fs.mkdir": try files.mkdir(str("path"))
        case "fs.rename": try files.rename(from: str("from"), to: str("to"))
        case "fs.delete": try files.delete(str("path"))
        case "fs.exists": return try files.exists(str("path"))
        case "fs.tree": return try files.tree(str("path"))
        default: throw FileStore.StoreError(description: "unknown op \(op)")
        }
        return nil
    }

    // MARK: linked folders

    /// Let the user pick a folder (iCloud Drive, another app's, a file
    /// provider's); replies with its location entry, or nil if cancelled.
    private func pickFolder(reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let presenter else { return reply(nil, "nothing to present the picker on") }
        pickerReply?(nil, nil)
        pickerReply = reply
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.delegate = self
        presenter.present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let reply = pickerReply
        pickerReply = nil
        guard let url = urls.first else { return reply?(nil, nil) ?? () }
        do {
            reply?(try files.locations.add(url), nil)
        } catch {
            reply?(nil, "\(error)")
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickerReply?(nil, nil)
        pickerReply = nil
    }

    // MARK: lifecycle

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The content view can be replaced on navigation; make sure it has our accessory.
        KeyboardAccessory.shared.install(on: webView)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Usually memory pressure (D16/Q15). Reload; files are on disk.
        Self.appendDocument(".probe-log.txt", "[host] web content process terminated\n")
        if CommandLine.arguments.contains("--selftest") {
            try? #"{"webContentTerminated": true}"#.write(to: Self.documentURL(".probe-result.json"), atomically: true, encoding: .utf8)
            return
        }
        webView.reload()
    }

    // MARK: native dialogs for alert/confirm/prompt

    private var presenter: UIViewController? {
        var vc = webView?.window?.rootViewController
        while let presented = vc?.presentedViewController { vc = presented }
        return vc
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        guard let presenter else { return completionHandler() }
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        let destructive = message.lowercased().hasPrefix("delete")
        alert.addAction(UIAlertAction(title: destructive ? "Delete" : "OK", style: destructive ? .destructive : .default) { _ in
            completionHandler(true)
        })
        guard let presenter else { return completionHandler(false) }
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void) {
        let alert = UIAlertController(title: prompt, message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = defaultText
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.clearButtonMode = .whileEditing
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text)
        })
        guard let presenter else { return completionHandler(nil) }
        presenter.present(alert, animated: true) {
            // Select the file name without its extension, like Finder.
            if let field = alert.textFields?.first, let text = field.text,
               let dot = text.lastIndex(of: "."), dot != text.startIndex,
               let end = field.position(from: field.beginningOfDocument, offset: text.distance(from: text.startIndex, to: dot)) {
                field.selectedTextRange = field.textRange(from: field.beginningOfDocument, to: end)
            }
        }
    }

    // MARK: helpers

    /// WebKit renders pages (requestAnimationFrame, CSS animations, scrolling
    /// updates) near 60 fps by default, even on 120 Hz displays. Turn that off
    /// through the experimental-features SPI (WKPreferencesPrivate.h) so the app
    /// runs at the display's rate; together with CADisableMinimumFrameDurationOnPhone.
    private static func renderAtDisplayRate(_ preferences: WKPreferences) {
        let featuresSel = NSSelectorFromString("_features")
        let setSel = NSSelectorFromString("_setEnabled:forFeature:")
        guard WKPreferences.responds(to: featuresSel), preferences.responds(to: setSel),
              let features = WKPreferences.perform(featuresSel)?.takeUnretainedValue() as? [NSObject],
              let feature = features.first(where: { ($0.value(forKey: "key") as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" })
        else {
            appendDocument(".probe-log.txt", "[display] PreferPageRenderingUpdatesNear60FPSEnabled not found\n")
            return
        }
        typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        let set = unsafeBitCast(preferences.method(for: setSel), to: SetEnabled.self)
        set(preferences, setSel, false, feature)
    }

    static func documentURL(_ name: String) -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
    }

    static func appendDocument(_ name: String, _ text: String) {
        let url = documentURL(name)
        let data = Data(text.utf8)
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }
}
