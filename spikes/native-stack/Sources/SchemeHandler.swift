import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves the spike's pages under `app://app/` with cross-origin isolation,
/// and `/pkgs/<python>/<file>`: Pyodide's packages from the jsDelivr CDN,
/// cached in Library/Caches (like the app's package cache, D12).
@MainActor
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "app"
    static let cdn = ["3.14": "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/",
                      "3.15": "https://cdn.jsdelivr.net/pyodide/v315.0.0a2/full/"]
    private let root: URL
    private var active = Set<ObjectIdentifier>()

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        active.insert(ObjectIdentifier(task))
        let url = task.request.url!
        var path = url.path
        if path.hasPrefix("/pkgs/") {
            let parts = path.dropFirst("/pkgs/".count).split(separator: "/", maxSplits: 1).map(String.init)
            guard parts.count == 2, let base = Self.cdn[parts[0]], !parts[1].contains("/") else {
                return respond(task, status: 404, body: Data(), mime: "text/plain")
            }
            let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("pkgs/\(parts[0])", isDirectory: true)
            let cached = cacheDir.appendingPathComponent(parts[1])
            if let data = try? Data(contentsOf: cached) {
                return respond(task, status: 200, body: data, mime: Self.mime(cached))
            }
            Task { @MainActor in
                if let (data, response) = try? await URLSession.shared.data(from: URL(string: base + parts[1])!),
                   (response as? HTTPURLResponse)?.statusCode == 200 {
                    try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
                    try? data.write(to: cached)
                    self.respond(task, status: 200, body: data, mime: Self.mime(cached))
                } else {
                    self.respond(task, status: 502, body: Data(), mime: "text/plain")
                }
            }
            return
        }
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

    private func respond(_ task: any WKURLSchemeTask, status: Int, body: Data, mime: String) {
        guard active.remove(ObjectIdentifier(task)) != nil else { return }
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(body.count),
            "Cache-Control": "no-store",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
        ]
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
        case "zip", "whl": "application/zip"
        default: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
