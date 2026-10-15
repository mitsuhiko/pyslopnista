import Foundation

/// The agent's project folder (Documents/project). Paths are relative to it;
/// anything that escapes it is refused. Contents travel as base64 so the page
/// decides how to decode (BOMs, binary files).
final class ProjectFiles: @unchecked Sendable {
    struct FileError: Error, CustomStringConvertible {
        let code: String
        let message: String
        var description: String { "\(code): \(message)" }
    }

    let root: URL
    let queue = DispatchQueue(label: "spike.files")

    init(root: URL) {
        self.root = root.standardizedFileURL
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func resolve(_ path: String) throws -> URL {
        let parts = path.split(separator: "/").map(String.init).filter { $0 != "." && !$0.isEmpty }
        guard !parts.contains("..") else { throw FileError(code: "permission_denied", message: "outside the project: \(path)") }
        return parts.reduce(root) { $0.appendingPathComponent($1) }
    }

    /// Runs on `queue`.
    func perform(_ op: String, _ body: [String: Any]) throws -> Any {
        let path = body["path"] as? String ?? ""
        let url = try resolve(path)
        let fm = FileManager.default
        switch op {
        case "fs.read":
            guard fm.fileExists(atPath: url.path) else { throw FileError(code: "not_found", message: path) }
            guard !isDirectory(url) else { throw FileError(code: "is_directory", message: path) }
            return try Data(contentsOf: url).base64EncodedString()
        case "fs.write":
            guard let data = Data(base64Encoded: body["data"] as? String ?? "") else {
                throw FileError(code: "invalid", message: "bad base64")
            }
            if isDirectory(url) { throw FileError(code: "is_directory", message: path) }
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return NSNull()
        case "fs.stat":
            guard let attrs = try? fm.attributesOfItem(atPath: url.path) else {
                throw FileError(code: "not_found", message: path)
            }
            return info(url, attrs)
        case "fs.list":
            guard isDirectory(url) else {
                throw FileError(code: fm.fileExists(atPath: url.path) ? "not_directory" : "not_found", message: path)
            }
            return try fm.contentsOfDirectory(atPath: url.path).sorted().compactMap { name -> [String: Any]? in
                let child = url.appendingPathComponent(name)
                guard let attrs = try? fm.attributesOfItem(atPath: child.path) else { return nil }
                return info(child, attrs)
            }
        case "fs.mkdir":
            try fm.createDirectory(at: url, withIntermediateDirectories: body["recursive"] as? Bool ?? true)
            return NSNull()
        case "fs.remove":
            guard fm.fileExists(atPath: url.path) else {
                if body["force"] as? Bool == true { return NSNull() }
                throw FileError(code: "not_found", message: path)
            }
            try fm.removeItem(at: url)
            return NSNull()
        case "fs.rename":
            let to = try resolve(body["to"] as? String ?? "")
            if fm.fileExists(atPath: to.path) { try fm.removeItem(at: to) }
            try fm.moveItem(at: url, to: to)
            return NSNull()
        case "fs.reset":
            try? fm.removeItem(at: root)
            try fm.createDirectory(at: root, withIntermediateDirectories: true)
            return NSNull()
        default:
            throw FileError(code: "invalid", message: "unknown op \(op)")
        }
    }

    private func isDirectory(_ url: URL) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &dir) && dir.boolValue
    }

    private func info(_ url: URL, _ attrs: [FileAttributeKey: Any]) -> [String: Any] {
        let type = attrs[.type] as? FileAttributeType
        let kind = type == .typeDirectory ? "directory" : type == .typeSymbolicLink ? "symlink" : "file"
        let modified = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let relative = String(url.standardizedFileURL.path.dropFirst(root.path.count))
        return [
            "name": url.lastPathComponent,
            "path": relative.isEmpty ? "/" : relative,
            "kind": kind,
            "size": (attrs[.size] as? NSNumber)?.intValue ?? 0,
            "mtimeMs": (modified * 1000).rounded(),
        ]
    }
}
