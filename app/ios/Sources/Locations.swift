import Foundation

/// Folders outside the app that the user picked with the document picker:
/// iCloud Drive, other apps' folders (Working Copy, ...), file providers
/// (Dropbox, ...) or a folder on a USB drive. Each one is a bookmark (iOS
/// bookmarks carry the security scope) kept in the user defaults. The web
/// app addresses them as `@<name>/...` (see `FileStore.resolve`).
final class Locations: @unchecked Sendable {
    struct Location {
        var name: String
        var bookmark: Data
        var url: URL? // nil when the bookmark no longer resolves (e.g. the provider is gone)
    }

    struct LocationError: Error, CustomStringConvertible {
        let description: String
    }

    private static let defaultsKey = "locations"
    private let lock = NSLock()
    private var items: [Location] = []

    init() {
        let saved = UserDefaults.standard.array(forKey: Self.defaultsKey) as? [[String: Any]] ?? []
        for entry in saved {
            guard let name = entry["name"] as? String, let bookmark = entry["bookmark"] as? Data else { continue }
            items.append(Self.open(Location(name: name, bookmark: bookmark)))
        }
        save()
    }

    /// Resolve the bookmark and start accessing it for the rest of the app's life.
    private static func open(_ location: Location) -> Location {
        var location = location
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: location.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else {
            return location
        }
        _ = url.startAccessingSecurityScopedResource()
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            location.bookmark = fresh
        }
        location.url = url.standardizedFileURL
        return location
    }

    private func save() {
        let plist = items.map { ["name": $0.name, "bookmark": $0.bookmark] as [String: Any] }
        UserDefaults.standard.set(plist, forKey: Self.defaultsKey)
    }

    /// The folder for `@name`; nil if there is no such location.
    func url(named name: String) throws -> URL? {
        lock.lock()
        defer { lock.unlock() }
        guard let location = items.first(where: { $0.name == name }) else { return nil }
        guard let url = location.url else { throw LocationError(description: "“\(name)” is not available") }
        return url
    }

    func list() -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return items.map { ["name": $0.name, "path": "@\($0.name)", "available": $0.url != nil] }
    }

    /// Remember a folder the document picker returned; returns its entry.
    func add(_ picked: URL) throws -> [String: Any] {
        let accessing = picked.startAccessingSecurityScopedResource()
        defer { if accessing { picked.stopAccessingSecurityScopedResource() } } // open() holds its own access
        let bookmark = try picked.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        lock.lock()
        defer { lock.unlock() }
        if let existing = items.first(where: { $0.url == picked.standardizedFileURL }) {
            return ["name": existing.name, "path": "@\(existing.name)", "available": true]
        }
        let base = (try? picked.resourceValues(forKeys: [.localizedNameKey]).localizedName) ?? picked.lastPathComponent
        var name = base.replacingOccurrences(of: "/", with: "-")
        var n = 2
        while items.contains(where: { $0.name == name }) {
            name = "\(base) \(n)"
            n += 1
        }
        items.append(Self.open(Location(name: name, bookmark: bookmark)))
        save()
        return ["name": name, "path": "@\(name)", "available": true]
    }

    /// Forget a location (its files stay where they are).
    func remove(named name: String) {
        lock.lock()
        defer { lock.unlock() }
        if let i = items.firstIndex(where: { $0.name == name }) {
            items[i].url?.stopAccessingSecurityScopedResource()
            items.remove(at: i)
            save()
        }
    }
}
