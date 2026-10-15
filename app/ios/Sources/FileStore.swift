import Foundation

/// Project files live in the app's Documents folder (visible in the Files app)
/// and in linked folders (`Locations`). Paths from the web app are relative to
/// Documents, except that a first component `@<name>` stands for the linked
/// folder of that name. ".." and absolute paths are rejected.
///
/// Files in linked folders can belong to another process (iCloud Drive, a file
/// provider, another app), so they are read and written through
/// `NSFileCoordinator`, which also downloads files that are not on the device.
struct FileStore: Sendable {
    struct StoreError: Error, CustomStringConvertible {
        let description: String
    }

    let root: URL
    let locations: Locations
    let maxTreeBytes = 64 * 1024 * 1024

    init(locations: Locations) {
        root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].standardizedFileURL
        self.locations = locations
    }

    /// The URL for a path, and whether it is in a linked folder.
    func locate(_ path: String) throws -> (url: URL, linked: Bool) {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        if path.hasPrefix("/") || parts.contains(where: { $0 == ".." || $0 == "." }) {
            throw StoreError(description: "invalid path: \(path)")
        }
        // Top-level names starting with "@" are reserved for linked folders.
        if let first = parts.first, first.hasPrefix("@") {
            guard let base = try locations.url(named: String(first.dropFirst())) else {
                throw StoreError(description: "“\(first.dropFirst())” is not a linked folder")
            }
            return (parts.dropFirst().reduce(base) { $0.appendingPathComponent(String($1)) }, true)
        }
        return (parts.reduce(root) { $0.appendingPathComponent(String($1)) }, false)
    }

    func resolve(_ path: String) throws -> URL {
        try locate(path).url
    }

    private func isLocationRoot(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        return parts.count == 1 && parts[0].hasPrefix("@") && (try? locations.url(named: String(parts[0].dropFirst()))) != nil
    }

    // MARK: coordination

    private func coordinate<T>(_ url: URL, linked: Bool, writing: NSFileCoordinator.WritingOptions? = nil,
                               reading: NSFileCoordinator.ReadingOptions = [], _ body: (URL) throws -> T) throws -> T {
        guard linked else { return try body(url) }
        var coordinationError: NSError?
        var result: Result<T, Error>?
        let coordinator = NSFileCoordinator(filePresenter: nil)
        if let writing {
            coordinator.coordinate(writingItemAt: url, options: writing, error: &coordinationError) { url in
                result = Result { try body(url) }
            }
        } else {
            coordinator.coordinate(readingItemAt: url, options: reading, error: &coordinationError) { url in
                result = Result { try body(url) }
            }
        }
        if let coordinationError { throw coordinationError }
        return try result!.get()
    }

    /// Read a file, downloading it first if it is only in the cloud.
    private func readData(_ url: URL, linked: Bool) throws -> Data {
        if linked, !FileManager.default.fileExists(atPath: url.path) || Self.isEvicted(url) {
            try? FileManager.default.startDownloadingUbiquitousItem(at: url)
        }
        return try coordinate(url, linked: linked) { try Data(contentsOf: $0) }
    }

    private static func isEvicted(_ url: URL) -> Bool {
        let status = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]).ubiquitousItemDownloadingStatus
        return status != nil && status != .current
    }

    /// iCloud Drive can show a file that is not downloaded as ".name.icloud".
    private static func placeholderName(_ name: String) -> String? {
        guard name.hasPrefix("."), name.hasSuffix(".icloud"), name.count > ".icloud".count + 1 else { return nil }
        return String(name.dropFirst().dropLast(".icloud".count))
    }

    // MARK: operations

    func list(_ path: String) throws -> [[String: Any]] {
        let (dir, linked) = try locate(path)
        let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
        let urls = try coordinate(dir, linked: linked) {
            try FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: keys, options: [])
        }
        var seen = Set<String>()
        var entries: [[String: Any]] = []
        for url in urls {
            var name = url.lastPathComponent
            if name.hasPrefix(".") {
                guard linked, let real = Self.placeholderName(name) else { continue }
                name = real
            }
            if path.isEmpty, name.hasPrefix("@") { continue } // reserved, see locate()
            guard seen.insert(name).inserted else { continue }
            let values = try? url.resourceValues(forKeys: Set(keys))
            entries.append([
                "name": name,
                "path": path.isEmpty ? name : "\(path)/\(name)",
                "dir": values?.isDirectory ?? false,
                "size": values?.fileSize ?? 0,
                "mtime": (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000,
            ])
        }
        return entries.sorted { a, b in
            let ad = a["dir"] as! Bool, bd = b["dir"] as! Bool
            if ad != bd { return ad }
            return (a["name"] as! String).localizedStandardCompare(b["name"] as! String) == .orderedAscending
        }
    }

    func read(_ path: String, encoding: String) throws -> String {
        let (url, linked) = try locate(path)
        let data = try readData(url, linked: linked)
        if encoding == "base64" { return data.base64EncodedString() }
        guard let text = String(data: data, encoding: .utf8) else {
            throw StoreError(description: "\(path) is not UTF-8 text")
        }
        return text
    }

    func write(_ path: String, data: String, encoding: String) throws {
        let (url, linked) = try locate(path)
        let bytes: Data
        if encoding == "base64" {
            guard let decoded = Data(base64Encoded: data) else { throw StoreError(description: "bad base64") }
            bytes = decoded
        } else {
            bytes = Data(data.utf8)
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try coordinate(url, linked: linked, writing: .forReplacing) { try bytes.write(to: $0, options: .atomic) }
    }

    func mkdir(_ path: String) throws {
        let (url, linked) = try locate(path)
        try coordinate(url, linked: linked, writing: []) {
            try FileManager.default.createDirectory(at: $0, withIntermediateDirectories: true)
        }
    }

    func rename(from: String, to: String) throws {
        if isLocationRoot(from) || isLocationRoot(to) { throw StoreError(description: "a linked folder cannot be renamed here") }
        let (source, sourceLinked) = try locate(from)
        let (target, targetLinked) = try locate(to)
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard sourceLinked || targetLinked else { return try FileManager.default.moveItem(at: source, to: target) }
        var coordinationError: NSError?
        var result: Result<Void, Error> = .success(())
        NSFileCoordinator(filePresenter: nil).coordinate(
            writingItemAt: source, options: .forMoving, writingItemAt: target, options: .forReplacing, error: &coordinationError
        ) { source, target in
            result = Result { try FileManager.default.moveItem(at: source, to: target) }
        }
        if let coordinationError { throw coordinationError }
        try result.get()
    }

    func delete(_ path: String) throws {
        guard !path.isEmpty else { throw StoreError(description: "refusing to delete the root") }
        if isLocationRoot(path) { throw StoreError(description: "remove a linked folder from Locations instead") }
        let (url, linked) = try locate(path)
        try coordinate(url, linked: linked, writing: .forDeleting) { try FileManager.default.removeItem(at: $0) }
    }

    func exists(_ path: String) throws -> Bool {
        if path.hasPrefix("@"), !isLocationRoot(String(path.prefix { $0 != "/" })) { return false } // unlinked meanwhile
        let (url, linked) = try locate(path)
        if FileManager.default.fileExists(atPath: url.path) { return true }
        guard linked else { return false }
        let placeholder = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
        return FileManager.default.fileExists(atPath: placeholder.path)
    }

    /// Name, kind, size and modification time of a file or folder; nil if it does not exist.
    func stat(_ path: String) throws -> [String: Any]? {
        guard try exists(path) else { return nil }
        let (url, linked) = try locate(path)
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
        let values = try? coordinate(url, linked: linked) { try $0.resourceValues(forKeys: keys) }
        let name = path.split(separator: "/").last.map(String.init) ?? ""
        return [
            "name": name.hasPrefix("@") ? String(name.dropFirst()) : name,
            "path": path,
            "dir": path.isEmpty || values?.isDirectory == true,
            "size": values?.fileSize ?? 0,
            "mtime": (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000,
        ]
    }

    // MARK: staging for linked folders (HostFS, D35)

    let maxStagingBytes = 512 * 1024 * 1024

    /// Copy a linked folder's files (and folders) into `staging`, with
    /// coordinated reads; files only in the cloud are downloaded first.
    func snapshot(_ base: URL, into staging: URL) throws {
        let keys: [URLResourceKey] = [.isRegularFileKey, .isDirectoryKey, .fileSizeKey]
        guard let walker = FileManager.default.enumerator(at: base, includingPropertiesForKeys: keys, options: []) else { return }
        let basePath = base.standardizedFileURL.path.hasSuffix("/") ? base.standardizedFileURL.path : base.standardizedFileURL.path + "/"
        var total = 0
        for case let url as URL in walker {
            var file = url
            let name = url.lastPathComponent
            let values = try url.resourceValues(forKeys: Set(keys))
            if name == "__pycache__" {
                walker.skipDescendants()
                continue
            }
            if name.hasPrefix(".") {
                guard values.isRegularFile == true, let real = Self.placeholderName(name) else {
                    if values.isDirectory == true { walker.skipDescendants() }
                    continue
                }
                file = url.deletingLastPathComponent().appendingPathComponent(real)
            }
            let rel = String(file.standardizedFileURL.path.dropFirst(basePath.count))
            let target = staging.appendingPathComponent(rel)
            if values.isDirectory == true {
                try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
                continue
            }
            guard values.isRegularFile == true else { continue }
            total += values.fileSize ?? 0
            if total > maxStagingBytes { throw StoreError(description: "the folder is larger than \(maxStagingBytes / 1024 / 1024) MB") }
            if file != url || Self.isEvicted(file) { try? FileManager.default.startDownloadingUbiquitousItem(at: file) }
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try coordinate(file, linked: true) { try FileManager.default.copyItem(at: $0, to: target) }
        }
    }

    /// Write one staged change back into a linked folder, coordinated: a
    /// file (its staged copy), a new folder, or a removal (no source).
    func writeBack(_ source: URL?, to target: URL, isDirectory: Bool) throws {
        if isDirectory {
            try coordinate(target, linked: true, writing: []) {
                try FileManager.default.createDirectory(at: $0, withIntermediateDirectories: true)
            }
        } else if let source {
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try coordinate(target, linked: true, writing: .forReplacing) { url in
                if FileManager.default.fileExists(atPath: url.path) {
                    _ = try FileManager.default.replaceItemAt(url, withItemAt: source)
                } else {
                    try FileManager.default.moveItem(at: source, to: url)
                }
            }
        } else {
            try coordinate(target, linked: true, writing: .forDeleting) { url in
                if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            }
        }
    }

    /// All files below path (recursively), relative to path, base64 encoded.
    func tree(_ path: String) throws -> [[String: String]] {
        let (base, linked) = try locate(path)
        var out: [[String: String]] = []
        var total = 0
        guard let walker = FileManager.default.enumerator(
            at: base, includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .fileSizeKey], options: []
        ) else { return [] }
        let basePath = base.path.hasSuffix("/") ? base.path : base.path + "/"
        var seen = Set<String>()
        let tooLarge = StoreError(description: "project folder is larger than \(maxTreeBytes / 1024 / 1024) MB")
        for case let url as URL in walker {
            var file = url
            let name = url.lastPathComponent
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .fileSizeKey])
            if name.hasPrefix(".") {
                // Hidden files stay out, except files iCloud has not downloaded.
                guard linked, values.isRegularFile == true, let real = Self.placeholderName(name) else {
                    if values.isDirectory == true { walker.skipDescendants() }
                    continue
                }
                file = url.deletingLastPathComponent().appendingPathComponent(real)
            }
            if name == "__pycache__" {
                walker.skipDescendants()
                continue
            }
            guard values.isRegularFile == true else { continue }
            let rel = String(file.standardizedFileURL.path.dropFirst(basePath.count))
            guard seen.insert(rel).inserted else { continue }
            // Check before reading (and downloading); a placeholder's size is only known after.
            let placeholder = file != url
            if !placeholder { total += values.fileSize ?? 0 }
            if total > maxTreeBytes { throw tooLarge }
            let data = try readData(file, linked: linked)
            if placeholder { total += data.count }
            if total > maxTreeBytes { throw tooLarge }
            out.append(["path": rel, "data": data.base64EncodedString()])
        }
        return out
    }
}
