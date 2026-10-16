import SwiftUI
import WebKit

@main
struct ProcessesSpikeApp: App {
    var body: some Scene {
        WindowGroup {
            WebView().ignoresSafeArea()
        }
    }
}

struct WebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView { context.coordinator.makeWebView() }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// One web view. Its page (web/main.js) is the process manager: it starts a
/// worker per process and runs the test programs, then reports JSON.
/// Bridge ops: `log`, `result`.
@MainActor
final class Coordinator: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    lazy var scheme = SchemeHandler(root: Bundle.main.resourceURL!.appendingPathComponent("web"))

    func makeWebView() -> WKWebView {
        try? FileManager.default.removeItem(at: Self.document("result.json"))
        try? FileManager.default.removeItem(at: Self.document("log.txt"))
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(scheme, forURLScheme: SchemeHandler.scheme)
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "bridge")
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true
        webView.navigationDelegate = self
        let options = ProcessInfo.processInfo.environment["PROCS_OPTIONS"] ?? ""
        webView.load(URLRequest(url: URL(string: "app://app/index.html#\(options)")!))
        return webView
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            return replyHandler(nil, "malformed")
        }
        switch op {
        case "log":
            Self.append("log.txt", "\(Date().timeIntervalSince1970) \(body["value"] as? String ?? "")\n")
            replyHandler(true, nil)
        case "result":
            try? (body["value"] as? String ?? "null").write(to: Self.document("result.json"), atomically: true, encoding: .utf8)
            replyHandler(true, nil)
        default:
            replyHandler(nil, "unknown op \(op)")
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Self.append("log.txt", "[host] web content process terminated\n")
        try? #"{"webContentTerminated": true}"#.write(to: Self.document("result.json"), atomically: true, encoding: .utf8)
    }

    static func document(_ name: String) -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
    }

    static func append(_ name: String, _ text: String) {
        let url = document(name)
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(text.utf8))
            try? handle.close()
        } else {
            try? Data(text.utf8).write(to: url)
        }
    }
}
