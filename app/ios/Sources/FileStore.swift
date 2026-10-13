import Foundation

/// Project files live in the app's Documents folder (visible in the Files app).
/// Paths from the web app are relative to that root; ".." and absolute paths
/// are rejected.
struct FileStore {
    struct StoreError: Error, CustomStringConvertible {
        let description: String
    }

    let root: URL
    let maxTreeBytes = 64 * 1024 * 1024

    init() {
        root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].standardizedFileURL
    }

    func resolve(_ path: String) throws -> URL {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        if path.hasPrefix("/") || parts.contains(where: { $0 == ".." || $0 == "." }) {
            throw StoreError(description: "invalid path: \(path)")
        }
        return parts.reduce(root) { $0.appendingPathComponent(String($1)) }
    }

    func list(_ path: String) throws -> [[String: Any]] {
        let dir = try resolve(path)
        let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
        let urls = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])
        let entries: [[String: Any]] = try urls.map { url in
            let values = try url.resourceValues(forKeys: Set(keys))
            let name = url.lastPathComponent
            return [
                "name": name,
                "path": path.isEmpty ? name : "\(path)/\(name)",
                "dir": values.isDirectory ?? false,
                "size": values.fileSize ?? 0,
                "mtime": (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000,
            ]
        }
        return entries.sorted { a, b in
            let ad = a["dir"] as! Bool, bd = b["dir"] as! Bool
            if ad != bd { return ad }
            return (a["name"] as! String).localizedStandardCompare(b["name"] as! String) == .orderedAscending
        }
    }

    func read(_ path: String, encoding: String) throws -> String {
        let data = try Data(contentsOf: try resolve(path))
        if encoding == "base64" { return data.base64EncodedString() }
        guard let text = String(data: data, encoding: .utf8) else {
            throw StoreError(description: "\(path) is not UTF-8 text")
        }
        return text
    }

    func write(_ path: String, data: String, encoding: String) throws {
        let url = try resolve(path)
        let bytes: Data
        if encoding == "base64" {
            guard let decoded = Data(base64Encoded: data) else { throw StoreError(description: "bad base64") }
            bytes = decoded
        } else {
            bytes = Data(data.utf8)
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: url, options: .atomic)
    }

    func mkdir(_ path: String) throws {
        try FileManager.default.createDirectory(at: try resolve(path), withIntermediateDirectories: true)
    }

    func rename(from: String, to: String) throws {
        let target = try resolve(to)
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: try resolve(from), to: target)
    }

    func delete(_ path: String) throws {
        guard !path.isEmpty else { throw StoreError(description: "refusing to delete the root") }
        try FileManager.default.removeItem(at: try resolve(path))
    }

    func exists(_ path: String) throws -> Bool {
        FileManager.default.fileExists(atPath: try resolve(path).path)
    }

    /// All files below path (recursively), relative to path, base64 encoded.
    func tree(_ path: String) throws -> [[String: String]] {
        let base = try resolve(path)
        var out: [[String: String]] = []
        var total = 0
        guard let walker = FileManager.default.enumerator(
            at: base, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey], options: [.skipsHiddenFiles]
        ) else { return [] }
        let basePath = base.path.hasSuffix("/") ? base.path : base.path + "/"
        for case let url as URL in walker {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            if url.lastPathComponent == "__pycache__" {
                walker.skipDescendants()
                continue
            }
            guard values.isRegularFile == true else { continue }
            total += values.fileSize ?? 0
            if total > maxTreeBytes {
                throw StoreError(description: "project folder is larger than \(maxTreeBytes / 1024 / 1024) MB")
            }
            let rel = String(url.standardizedFileURL.path.dropFirst(basePath.count))
            out.append(["path": rel, "data": try Data(contentsOf: url).base64EncodedString()])
        }
        return out
    }
}
