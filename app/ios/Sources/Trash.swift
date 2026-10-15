import Foundation

/// Deleted files and folders from Documents (D41): kept in Documents/.Trash
/// (hidden from the browser, the Files app shows it as ".Trash") with where
/// they came from, so they can be restored. Items older than 30 days go
/// for good at launch. Deleting in a linked folder uses the provider's own
/// trash where it has one (iCloud Drive's Recently Deleted), else it is final.
struct Trash: Sendable {
    struct Item: Sendable {
        let name: String // the name in .Trash
        let original: String // the app path it had
        let deleted: Date
        let isDirectory: Bool
        let size: Int
    }

    private struct Record: Codable {
        let original: String
        let deleted: Date
    }

    let root: URL
    static let keepDays = 30.0

    init(documents: URL) {
        root = documents.appendingPathComponent(".Trash", isDirectory: true)
    }

    private var indexURL: URL { root.appendingPathComponent(".index.json") }

    private func index() -> [String: Record] {
        guard let data = try? Data(contentsOf: indexURL) else { return [:] }
        return (try? JSONDecoder().decode([String: Record].self, from: data)) ?? [:]
    }

    private func save(_ index: [String: Record]) throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(index).write(to: indexURL, options: .atomic)
    }

    /// Move a file or folder into the trash; returns its name there.
    func add(_ url: URL, original: String) throws -> String {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let name = Self.unique(url.lastPathComponent, in: root)
        try FileManager.default.moveItem(at: url, to: root.appendingPathComponent(name))
        var idx = index()
        idx[name] = Record(original: original, deleted: Date())
        try save(idx)
        return name
    }

    func items() -> [Item] {
        let idx = index()
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return names.filter { !$0.hasPrefix(".") }.map { name in
            let url = root.appendingPathComponent(name)
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey])
            let record = idx[name]
            return Item(name: name, original: record?.original ?? name, deleted: record?.deleted ?? values?.contentModificationDate ?? Date(),
                        isDirectory: values?.isDirectory ?? false, size: values?.fileSize ?? 0)
        }.sorted { $0.deleted > $1.deleted }
    }

    /// Put an item back where it was (with a new name if that is taken); returns the app path.
    func restore(_ name: String, documents: URL) throws -> String {
        var idx = index()
        let original = idx[name]?.original ?? name
        let parent = (original as NSString).deletingLastPathComponent
        let folder = parent.isEmpty ? documents : documents.appendingPathComponent(parent, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let restored = Self.unique((original as NSString).lastPathComponent, in: folder)
        try FileManager.default.moveItem(at: root.appendingPathComponent(name), to: folder.appendingPathComponent(restored))
        idx[name] = nil
        try save(idx)
        return parent.isEmpty ? restored : "\(parent)/\(restored)"
    }

    func remove(_ name: String) throws {
        try FileManager.default.removeItem(at: root.appendingPathComponent(name))
        var idx = index()
        idx[name] = nil
        try save(idx)
    }

    func empty() throws {
        for item in items() { try? FileManager.default.removeItem(at: root.appendingPathComponent(item.name)) }
        try save([:])
    }

    /// Items deleted more than `keepDays` ago go for good.
    func purge() {
        let limit = Date().addingTimeInterval(-Self.keepDays * 86400)
        for item in items() where item.deleted < limit { try? remove(item.name) }
    }

    /// "name", or "name 2", "name 3", … if taken.
    static func unique(_ name: String, in folder: URL) -> String {
        guard FileManager.default.fileExists(atPath: folder.appendingPathComponent(name).path) else { return name }
        let ext = (name as NSString).pathExtension
        let stem = ext.isEmpty ? name : (name as NSString).deletingPathExtension
        var n = 2
        while true {
            let candidate = ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)"
            if !FileManager.default.fileExists(atPath: folder.appendingPathComponent(candidate).path) { return candidate }
            n += 1
        }
    }
}

extension FileStore {
    var trash: Trash { Trash(documents: root) }

    /// Delete from the file browser or the editor: into the Trash for
    /// Documents, the provider's trash (or for good) in linked folders.
    /// Returns whether it can be restored from our Trash.
    func moveToTrash(_ path: String) throws -> Bool {
        guard !path.isEmpty else { throw StoreError(description: "refusing to delete the root") }
        let (url, linked) = try locate(path)
        if !linked {
            _ = try trash.add(url, original: path)
            return true
        }
        do {
            try FileManager.default.trashItem(at: url, resultingItemURL: nil)
        } catch {
            try delete(path)
        }
        return false
    }

    /// Move a file or folder into another folder (keeping its name, or a free one).
    func move(_ path: String, into folder: String) throws -> String {
        let name = (path as NSString).lastPathComponent
        let (target, _) = try locate(folder)
        if folder == path || folder.hasPrefix(path + "/") { throw StoreError(description: "a folder can't go into itself") }
        let free = Trash.unique(name, in: target)
        let to = folder.isEmpty ? free : "\(folder)/\(free)"
        try rename(from: path, to: to)
        return to
    }
}
