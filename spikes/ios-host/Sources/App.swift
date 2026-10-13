import SwiftUI
import WebKit

@main
struct HostApp: App {
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

@MainActor
final class Coordinator: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    private let schemeHandler = AppSchemeHandler(
        root: Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
    )

    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: AppSchemeHandler.scheme)
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "bridge")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true
        webView.navigationDelegate = self
        webView.load(URLRequest(url: URL(string: "\(AppSchemeHandler.scheme)://app/index.html")!))
        return webView
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            replyHandler(nil, "malformed bridge message")
            return
        }
        switch op {
        case "echo":
            replyHandler(body["value"], nil)
        case "log":
            Self.appendLog(body["value"] as? String ?? "")
            replyHandler(true, nil)
        case "result":
            let text = body["value"] as? String ?? "null"
            Self.writeResult(text)
            replyHandler(true, nil)
        default:
            replyHandler(nil, "unknown op \(op)")
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        print("[host] web content process terminated; reloading")
        webView.reload()
    }

    private static func appendLog(_ line: String) {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = docs.appendingPathComponent("probe-log.txt")
        let data = Data((line + "\n").utf8)
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }

    private static func writeResult(_ text: String) {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = docs.appendingPathComponent("probe-result.json")
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
            print("[host] wrote \(url.path)")
        } catch {
            print("[host] failed to write result: \(error)")
        }
    }
}
