import SQLite3
import SwiftUI
import WebKit

@main
struct HostFSSpikeApp: App {
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

/// One web view. The page runs the benchmark (web/main.js) and reports JSON.
/// Bridge ops: `fs` (HostFS over the page's bridge, the second transport),
/// `sqlite` (open a database natively: integrity check and a count, to prove
/// the real file is right), `reset`, `log`, `result`.
@MainActor
final class Coordinator: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    let project = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("project", isDirectory: true)
    lazy var fs = HostFS(root: project)
    lazy var scheme = SchemeHandler(root: Bundle.main.resourceURL!.appendingPathComponent("web"), fs: fs)

    func makeWebView() -> WKWebView {
        try? FileManager.default.removeItem(at: Self.document("result.json"))
        try? FileManager.default.removeItem(at: Self.document("log.txt"))
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(scheme, forURLScheme: SchemeHandler.scheme)
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "bridge")
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true
        webView.navigationDelegate = self
        let steps = ProcessInfo.processInfo.environment["HOSTFS_STEPS"] ?? "all"
        webView.load(URLRequest(url: URL(string: "app://app/index.html#\(steps)")!))
        return webView
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            return replyHandler(nil, "malformed")
        }
        switch op {
        case "fs":
            let meta = body["meta"] as? [String: Any] ?? [:]
            var data: Data?
            if let b64 = body["data"] as? String { data = Data(base64Encoded: b64) }
            else if let raw = body["data"] as? Data { data = raw }
            let (result, bytes) = fs.perform(meta, data: data)
            var reply = result
            if let bytes { reply["data"] = bytes.base64EncodedString() }
            replyHandler(reply, nil)
        case "probe":
            // What a typed array becomes on the way in.
            let value = body["value"]
            replyHandler(value.map { String(describing: type(of: $0)) } ?? "nil", nil)
        case "sqlite":
            replyHandler(Self.checkSqlite(project.appendingPathComponent(body["path"] as? String ?? "").path,
                                          table: body["table"] as? String ?? ""), nil)
        case "reset":
            try? FileManager.default.removeItem(at: project)
            try? FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
            replyHandler(true, nil)
        case "listing":
            let names = (try? FileManager.default.contentsOfDirectory(atPath: project.appendingPathComponent(body["path"] as? String ?? "").path)) ?? []
            replyHandler(names.sorted(), nil)
        case "log":
            Self.append("log.txt", (body["value"] as? String ?? "") + "\n")
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

    /// Opens the file with the system SQLite (which recovers a hot journal),
    /// runs integrity_check and counts the rows of `table`.
    static func checkSqlite(_ path: String, table: String) -> [String: Any] {
        let hotJournal = FileManager.default.fileExists(atPath: path + "-journal")
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            return ["error": "open failed"]
        }
        defer { sqlite3_close(db) }
        func scalar(_ sql: String) -> String {
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return "error: \(String(cString: sqlite3_errmsg(db)))" }
            defer { sqlite3_finalize(stmt) }
            guard sqlite3_step(stmt) == SQLITE_ROW, let text = sqlite3_column_text(stmt, 0) else { return "error: \(String(cString: sqlite3_errmsg(db)))" }
            return String(cString: text)
        }
        return ["integrity": scalar("PRAGMA integrity_check"), "count": table.isEmpty ? "" : scalar("SELECT count(*) FROM \(table)"),
                "journalBefore": hotJournal, "journalAfter": FileManager.default.fileExists(atPath: path + "-journal")]
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
