import CryptoKit
import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves the bundled web app under `app://app/` with cross-origin isolation
/// headers (D9) and acts as an offline-capable cache for package downloads:
///
/// - `/pkgs/<file>`: Pyodide's packages, cache-first from the jsDelivr CDN (D12)
/// - `/pypi/simple/<name>/`: PyPI's Simple JSON API (PEP 691); cached for 10 min,
///   then network-first with the cache as offline fallback; file URLs are
///   rewritten to `/pypi-files/`
/// - `/pypi-files/<path>`: files.pythonhosted.org, cache-first (files are immutable)
@MainActor
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "app"
    static let pyodideVersion = "314.0.7"
    static let packageCDN = URL(string: "https://cdn.jsdelivr.net/pyodide/v\(pyodideVersion)/full/")!
    static let pypiSimple = URL(string: "https://pypi.org/simple/")!
    static let pypiFiles = URL(string: "https://files.pythonhosted.org/")!
    static let simpleJSON = "application/vnd.pypi.simple.v1+json"

    private let root: URL
    private let packageCache: URL
    private let pypiCache: URL
    private var activeTasks = Set<ObjectIdentifier>()

    init(root: URL) {
        self.root = root.standardizedFileURL
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        packageCache = support.appendingPathComponent("pyodide-packages/\(Self.pyodideVersion)", isDirectory: true)
        pypiCache = support.appendingPathComponent("pypi", isDirectory: true)
        for dir in [packageCache, pypiCache.appendingPathComponent("simple"), pypiCache.appendingPathComponent("files")] {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
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
        if path.hasPrefix("/pypi/simple/") {
            serveSimpleIndex(task, project: String(path.dropFirst("/pypi/simple/".count)).trimmingCharacters(in: CharacterSet(charactersIn: "/")))
            return
        }
        if path.hasPrefix("/pypi-files/") {
            servePypiFile(task, path: String(path.dropFirst("/pypi-files/".count)))
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

    // MARK: Pyodide packages (cache-first)

    private func servePackage(_ task: any WKURLSchemeTask, name: String) {
        guard Self.isSafeComponent(name) else {
            respond(task, status: 400, body: Data("bad package name".utf8), mime: "text/plain")
            return
        }
        cacheFirst(task, cached: packageCache.appendingPathComponent(name), remote: Self.packageCDN.appendingPathComponent(name))
    }

    // MARK: PyPI

    private func serveSimpleIndex(_ task: any WKURLSchemeTask, project: String) {
        guard Self.isSafeComponent(project) else {
            respond(task, status: 400, body: Data("bad project name".utf8), mime: "text/plain")
            return
        }
        let normalized = project.lowercased().replacingOccurrences(of: "[-_.]+", with: "-", options: .regularExpression)
        let cached = pypiCache.appendingPathComponent("simple/\(normalized).json")
        var request = URLRequest(url: Self.pypiSimple.appendingPathComponent("\(normalized)/"))
        request.setValue(Self.simpleJSON, forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15
        // Fresh enough: avoid a network round trip on every run.
        if let attrs = try? FileManager.default.attributesOfItem(atPath: cached.path),
           let modified = attrs[.modificationDate] as? Date, Date().timeIntervalSince(modified) < 600,
           let data = try? Data(contentsOf: cached) {
            respond(task, status: 200, body: data, mime: Self.simpleJSON, extra: ["X-Cache": "fresh"])
            return
        }
        Task { @MainActor in
            // Network-first so new releases show up; fall back to the cache offline.
            if let (data, response) = try? await URLSession.shared.data(for: request),
               let http = response as? HTTPURLResponse, http.statusCode == 200 {
                let rewritten = Self.rewriteFileURLs(data)
                try? rewritten.write(to: cached, options: .atomic)
                self.respond(task, status: 200, body: rewritten, mime: Self.simpleJSON, extra: ["X-Cache": "miss"])
            } else if let data = try? Data(contentsOf: cached) {
                self.respond(task, status: 200, body: data, mime: Self.simpleJSON, extra: ["X-Cache": "stale"])
            } else {
                self.respond(task, status: 404, body: Data("not found: \(normalized) (offline?)".utf8), mime: "text/plain")
            }
        }
    }

    private func servePypiFile(_ task: any WKURLSchemeTask, path: String) {
        let parts = path.split(separator: "/")
        guard !parts.isEmpty, parts.allSatisfy({ Self.isSafeComponent(String($0)) }) else {
            respond(task, status: 400, body: Data("bad file path".utf8), mime: "text/plain")
            return
        }
        // Store under a hash of the path: the hashed directory layout is deep.
        let key = SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
        let cached = pypiCache.appendingPathComponent("files/\(key)-\(parts.last!)")
        cacheFirst(task, cached: cached, remote: Self.pypiFiles.appendingPathComponent(path))
    }

    /// Point file URLs in a Simple JSON response at our cache.
    private static func rewriteFileURLs(_ data: Data) -> Data {
        guard let text = String(data: data, encoding: .utf8) else { return data }
        return Data(text.replacingOccurrences(of: "https://files.pythonhosted.org/", with: "\(scheme)://app/pypi-files/").utf8)
    }

    // MARK: helpers

    private func cacheFirst(_ task: any WKURLSchemeTask, cached: URL, remote: URL) {
        if let data = try? Data(contentsOf: cached) {
            respond(task, status: 200, body: data, mime: "application/octet-stream", extra: ["X-Cache": "hit"])
            return
        }
        Task { @MainActor in
            do {
                let (data, response) = try await URLSession.shared.data(from: remote)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 500
                if status == 200 { try? data.write(to: cached, options: .atomic) }
                self.respond(task, status: status, body: data, mime: "application/octet-stream", extra: ["X-Cache": "miss"])
            } catch {
                self.respond(task, status: 502, body: Data("download failed (offline?): \(error.localizedDescription)".utf8), mime: "text/plain")
            }
        }
    }

    private static func isSafeComponent(_ s: String) -> Bool {
        !s.isEmpty && !s.hasPrefix(".") && !s.contains("/") && !s.contains("\\")
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
        case "py": return "text/x-python; charset=utf-8"
        case "zip", "whl": return "application/zip"
        default:
            return UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
