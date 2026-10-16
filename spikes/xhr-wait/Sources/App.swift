import SwiftUI
import WebKit

@main
struct XHRWaitSpikeApp: App {
    var body: some Scene {
        WindowGroup {
            Root()
        }
    }
}

/// How the web view is hosted (XHRWAIT_VIEW):
/// - "visible": full screen, like a normal page;
/// - "engine": 1×1 points at opacity 0.01 behind other content, like the
///   app's engine page (RootView.swift);
/// - "detached": not in the window at all.
/// XHRWAIT_POLICY=none sets inactiveSchedulingPolicy = .none (as the app does).
struct Root: View {
    @State private var coordinator = Coordinator()
    let mode = ProcessInfo.processInfo.environment["XHRWAIT_VIEW"] ?? "engine"

    var body: some View {
        ZStack {
            switch mode {
            case "visible":
                WebViewHost(webView: coordinator.webView).ignoresSafeArea()
            case "detached":
                Text("detached web view").onAppear { _ = coordinator.webView }
            default:
                WebViewHost(webView: coordinator.webView)
                    .frame(width: 1, height: 1)
                    .opacity(0.01)
                    .allowsHitTesting(false)
                Text("engine-like web view (1×1, opacity 0.01)")
            }
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
        let config = WKWebViewConfiguration()
        if ProcessInfo.processInfo.environment["XHRWAIT_POLICY"] == "none" {
            config.preferences.inactiveSchedulingPolicy = .none
        }
        config.setURLSchemeHandler(scheme, forURLScheme: SchemeHandler.scheme)
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "bridge")
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true
        let steps = ProcessInfo.processInfo.environment["XHRWAIT_STEPS"] ?? ""
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
        }
        replyHandler(true, nil)
    }

    static func document(_ name: String) -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
    }
}
