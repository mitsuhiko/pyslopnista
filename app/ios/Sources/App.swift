import SwiftUI
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
final class Coordinator: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    private let schemeHandler = AppSchemeHandler(
        root: Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
    )
    private let files = FileStore()
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
        do {
            switch op {
            case "fs.list": replyHandler(try files.list(str("path")), nil)
            case "fs.read": replyHandler(try files.read(str("path"), encoding: str("encoding")), nil)
            case "fs.write":
                try files.write(str("path"), data: str("data"), encoding: str("encoding"))
                replyHandler(nil, nil)
            case "fs.mkdir":
                try files.mkdir(str("path"))
                replyHandler(nil, nil)
            case "fs.rename":
                try files.rename(from: str("from"), to: str("to"))
                replyHandler(nil, nil)
            case "fs.delete":
                try files.delete(str("path"))
                replyHandler(nil, nil)
            case "fs.exists": replyHandler(try files.exists(str("path")), nil)
            case "fs.tree": replyHandler(try files.tree(str("path")), nil)
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
