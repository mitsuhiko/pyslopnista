import SwiftUI
import WebKit

@main
struct PyodideSpikeApp: App {
    var body: some Scene {
        WindowGroup {
            WebView().ignoresSafeArea(.container, edges: .bottom)
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
        // Device runs are read back with devicectl; clear old results first.
        if CommandLine.arguments.contains("--selftest") {
            try? FileManager.default.removeItem(at: Self.documentURL("probe-result.json"))
            try? FileManager.default.removeItem(at: Self.documentURL("probe-log.txt"))
        }
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: AppSchemeHandler.scheme)
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "bridge")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true
        webView.navigationDelegate = self
        let args = CommandLine.arguments
        var fragment = ""
        var query = ""
        var page = "index.html"
        if let i = args.firstIndex(of: "--page"), i + 1 < args.count, !args[i + 1].isEmpty {
            page = args[i + 1]
        }
        if let i = args.firstIndex(of: "--query"), i + 1 < args.count {
            query = "?" + args[i + 1]
        }
        if let i = args.firstIndex(of: "--fragment"), i + 1 < args.count {
            fragment = "#" + args[i + 1]
        }
        if let i = args.firstIndex(of: "--selftest") {
            fragment = i + 1 < args.count ? "#selftest=\(args[i + 1])" : "#selftest"
        }
        webView.load(URLRequest(url: URL(string: "\(AppSchemeHandler.scheme)://app/\(page)\(query)\(fragment)")!))
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
        case "haptic":
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            replyHandler(true, nil)
        case "log":
            Self.appendDocument("probe-log.txt", (body["value"] as? String ?? "") + "\n")
            replyHandler(true, nil)
        case "result":
            Self.writeDocument("probe-result.json", body["value"] as? String ?? "null")
            replyHandler(true, nil)
        default:
            replyHandler(nil, "unknown op \(op)")
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if CommandLine.arguments.contains("--selftest") {
            // Reloading would restart the self-test forever; record the crash instead.
            Self.appendDocument("probe-log.txt", "[host] web content process terminated\n")
            Self.writeDocument("probe-result.json", #"{"webContentTerminated": true}"#)
            return
        }
        Self.appendDocument("probe-log.txt", "[host] web content process terminated; reloading\n")
        webView.reload()
    }

    private static func documentURL(_ name: String) -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
    }

    private static func writeDocument(_ name: String, _ text: String) {
        try? text.write(to: documentURL(name), atomically: true, encoding: .utf8)
    }

    private static func appendDocument(_ name: String, _ text: String) {
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
