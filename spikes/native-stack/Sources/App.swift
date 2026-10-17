import SwiftUI
import WebKit

// One web view, hosted like the app's engine page (1×1, opacity 0.01,
// inactiveSchedulingPolicy = .none). The page runs the cases and posts the
// result; it lands in Documents/result.json.
@main
struct NativeStackSpikeApp: App {
    var body: some Scene {
        WindowGroup {
            Root()
        }
    }
}

struct Root: View {
    @State private var coordinator = Coordinator()

    var body: some View {
        ZStack {
            WebViewHost(webView: coordinator.webView)
                .frame(width: 1, height: 1)
                .opacity(0.01)
                .allowsHitTesting(false)
            Text("native-stack spike")
        }
    }
}

struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

@MainActor
final class Coordinator: NSObject, WKScriptMessageHandlerWithReply {
    lazy var scheme = SchemeHandler(root: Bundle.main.resourceURL!.appendingPathComponent("web"))
    lazy var webView: WKWebView = makeWebView()

    func makeWebView() -> WKWebView {
        try? FileManager.default.removeItem(at: Self.document("result.json"))
        try? FileManager.default.removeItem(at: Self.document("log.txt"))
        let config = WKWebViewConfiguration()
        config.preferences.inactiveSchedulingPolicy = .none
        config.setURLSchemeHandler(scheme, forURLScheme: SchemeHandler.scheme)
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "bridge")
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true
        let steps = ProcessInfo.processInfo.environment["NATIVESTACK_STEPS"] ?? ""
        webView.load(URLRequest(url: URL(string: "app://app/index.html#\(steps)")!))
        return webView
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            return replyHandler(nil, "malformed")
        }
        if op == "result" {
            try? (body["value"] as? String ?? "null").write(to: Self.document("result.json"), atomically: true, encoding: .utf8)
        } else if op == "log" {
            let url = Self.document("log.txt")
            let line = Data(((body["value"] as? String ?? "") + "\n").utf8)
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(line)
                try? handle.close()
            } else {
                try? line.write(to: url)
            }
        }
        replyHandler(true, nil)
    }

    static func document(_ name: String) -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
    }
}
