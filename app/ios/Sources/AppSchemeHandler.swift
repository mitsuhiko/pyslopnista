import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves bundled web content under `app://app/` with cross-origin isolation
/// headers. `/pkgs/<file>` is a persistent, offline-capable cache in front of
/// the Pyodide package CDN.
@MainActor
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "app"
    static let pyodideVersion = "314.0.7"
    static let packageCDN = URL(string: "https://cdn.jsdelivr.net/pyodide/v\(pyodideVersion)/full/")!

    private let root: URL
    private let packageCache: URL
    private var activeTasks = Set<ObjectIdentifier>()

    init(root: URL) {
        self.root = root.standardizedFileURL
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        self.packageCache = support.appendingPathComponent("pyodide-packages/\(Self.pyodideVersion)", isDirectory: true)
        try? FileManager.default.createDirectory(at: packageCache, withIntermediateDirectories: true)
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        activeTasks.insert(ObjectIdentifier(task))
        guard let url = task.request.url else {
            respond(task, status: 400, body: Data("bad request".utf8), mime: "text/plain")
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        if path.hasPrefix("/pkgs/") {
            servePackage(task, name: String(path.dropFirst("/pkgs/".count)))
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

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        activeTasks.remove(ObjectIdentifier(task))
    }

    private func servePackage(_ task: any WKURLSchemeTask, name: String) {
        guard !name.isEmpty, !name.contains("/"), !name.hasPrefix(".") else {
            respond(task, status: 400, body: Data("bad package name".utf8), mime: "text/plain")
            return
        }
        let cached = packageCache.appendingPathComponent(name)
        if let data = try? Data(contentsOf: cached) {
            respond(task, status: 200, body: data, mime: "application/octet-stream", extra: ["X-Cache": "hit"])
            return
        }
        let remote = Self.packageCDN.appendingPathComponent(name)
        Task { @MainActor in
            do {
                let (data, response) = try await URLSession.shared.data(from: remote)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 500
                if status == 200 {
                    try? data.write(to: cached, options: .atomic)
                }
                self.respond(task, status: status, body: data, mime: "application/octet-stream", extra: ["X-Cache": "miss"])
            } catch {
                self.respond(task, status: 502, body: Data("download failed: \(error)".utf8), mime: "text/plain")
            }
        }
    }

    private func respond(
        _ task: any WKURLSchemeTask, status: Int, body: Data, mime: String, extra: [String: String] = [:]
    ) {
        guard activeTasks.remove(ObjectIdentifier(task)) != nil else { return }
        var headers = [
            "Content-Type": mime,
            "Content-Length": String(body.count),
            "Cache-Control": "no-store",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
        ]
        headers.merge(extra) { _, new in new }
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
        case "zip", "whl": return "application/zip"
        default:
            return UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
