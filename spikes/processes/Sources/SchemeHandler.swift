import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves the spike's pages, Pyodide and the test files under `app://app/`
/// with cross-origin isolation (SharedArrayBuffer, Atomics.wait in workers).
@MainActor
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "app"
    private let root: URL
    private var active = Set<ObjectIdentifier>()

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        active.insert(ObjectIdentifier(task))
        let url = task.request.url!
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            respond(task, status: 404, body: Data("not found: \(path)".utf8), mime: "text/plain")
            return
        }
        respond(task, status: 200, body: data, mime: Self.mime(file))
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        active.remove(ObjectIdentifier(task))
    }

    private func respond(_ task: any WKURLSchemeTask, status: Int, body: Data, mime: String, extra: [String: String] = [:]) {
        guard active.remove(ObjectIdentifier(task)) != nil else { return }
        var headers = [
            "Content-Type": mime,
            "Content-Length": String(body.count),
            "Cache-Control": "no-store",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
        ]
        headers.merge(extra) { _, new in new }
        task.didReceive(HTTPURLResponse(url: task.request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(body)
        task.didFinish()
    }

    private static func mime(_ url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html": "text/html; charset=utf-8"
        case "js", "mjs": "text/javascript; charset=utf-8"
        case "json": "application/json"
        case "wasm": "application/wasm"
        case "py": "text/plain; charset=utf-8"
        case "zip": "application/zip"
        case "whl": "application/zip"
        default: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
