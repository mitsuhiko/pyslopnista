import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves bundled web content under `app://app/` with the headers needed for
/// cross-origin isolation, and exposes `/__bridge/*` endpoints for synchronous
/// XHR from workers.
@MainActor
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "app"

    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url else {
            respond(task, status: 400, body: Data("bad request".utf8), mime: "text/plain")
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        if path.hasPrefix("/__bridge/") {
            handleBridge(task, endpoint: String(path.dropFirst("/__bridge/".count)), url: url)
            return
        }

        let fileURL = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard fileURL.path.hasPrefix(root.path + "/"),
              let data = try? Data(contentsOf: fileURL)
        else {
            respond(task, status: 404, body: Data("not found: \(path)".utf8), mime: "text/plain")
            return
        }
        respond(task, status: 200, body: data, mime: Self.mimeType(for: fileURL))
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}

    private func handleBridge(_ task: any WKURLSchemeTask, endpoint: String, url: URL) {
        switch endpoint {
        case "echo":
            let body: Data
            if let httpBody = task.request.httpBody {
                body = httpBody
            } else if let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "v" })?.value {
                body = Data(query.utf8)
            } else {
                body = Data()
            }
            respond(task, status: 200, body: body, mime: "application/octet-stream")
        default:
            respond(task, status: 404, body: Data("unknown bridge endpoint".utf8), mime: "text/plain")
        }
    }

    private func respond(_ task: any WKURLSchemeTask, status: Int, body: Data, mime: String) {
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(body.count),
            "Cache-Control": "no-store",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
        ]
        let response = HTTPURLResponse(
            url: task.request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers
        )!
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }

    private static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        case "css": return "text/css; charset=utf-8"
        default:
            return UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
