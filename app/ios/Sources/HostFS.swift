import Darwin
import Foundation

/// Project folders for Python programs, used directly (D35). A worker mounts
/// the folder of the program it runs; its Emscripten file system
/// (`web/public/runtime/hostfs.js`) turns every file operation into one
/// synchronous `POST /__fs` (AppSchemeHandler), which lands in `perform`.
///
/// - Folders in Documents are used in place: what the program writes is on
///   disk right away, page by page, and SQLite's journal works as usual.
/// - Linked folders (D28: iCloud Drive, file providers, other apps) are copied
///   into a local staging folder first, with coordinated reads. The program
///   works on the copy, and what it changes goes back with coordinated writes
///   when it has been quiet for a moment, when a run ends, when the app goes
///   to the background and at unmount.
///
/// Paths in calls are relative to the mount and may not leave it. Errors are
/// errno names ("ENOENT"). Every reply carries the mount's generation, which
/// goes up when something else changes files (the editor, the agent, another
/// interpreter), so the worker drops its caches.
final class HostFS: @unchecked Sendable {
    struct Failure: Error, CustomStringConvertible {
        let code: String
        var description: String { code }
    }

    final class Mount {
        let token: String
        /// Where the program's files are: the folder itself, or its staging copy.
        let root: URL
        /// The mounted folder as the app addresses it ("Examples", "@Cloud/app").
        let appPath: String
        /// The linked folder a staging copy came from.
        let original: URL?
        var handles: [Int: (fd: Int32, path: String)] = [:]
        var generation = 0
        /// Paths changed since the last notification, and since the mount.
        var changed = Set<String>()
        var touched = Set<String>()
        /// Staged mounts: paths to copy back, and paths removed since the last sync.
        var dirty = Set<String>()
        var removed = Set<String>()
        var lastChange = Date.distantPast
        var firstChange: Date?

        init(token: String, root: URL, appPath: String, original: URL?) {
            self.token = token
            self.root = root
            self.appPath = appPath
            self.original = original
        }
    }

    static let stagingRoot = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Staging", isDirectory: true)

    private let lock = NSLock()
    private var mounts: [String: Mount] = [:]
    private var nextHandle = 1
    /// Called on the main queue with the app paths of changed files.
    var onChange: @MainActor @Sendable ([String]) -> Void = { _ in }
    /// Runs coordinated work (staging, syncing back), off the main thread.
    private let queue: DispatchQueue
    private var timer: DispatchSourceTimer?

    init(queue: DispatchQueue) {
        self.queue = queue
        // Copies left by a previous launch that ended without unmounting.
        try? FileManager.default.removeItem(at: Self.stagingRoot)
    }

    // MARK: mounting (on `queue`)

    /// Mount a folder. `linked` folders are copied to staging with `snapshot`
    /// (coordinated reads, downloads included). With `share` (another mount
    /// of the same folder: a program's child processes, D47) the new mount
    /// uses that mount's files, the staged copy included; it still has its own
    /// handles, generation and changes to write back.
    func mount(appPath: String, url: URL, linked: Bool, share: String? = nil, snapshot: (URL, URL) throws -> Void) throws -> [String: Any] {
        let token = UUID().uuidString
        if let share, let other = lock.withLock({ mounts[share] }), other.appPath == appPath {
            let mount = Mount(token: token, root: other.root, appPath: appPath, original: other.original)
            lock.withLock { mounts[token] = mount }
            startTimer()
            return ["token": token, "staged": other.original != nil]
        }
        var root = url.standardizedFileURL
        if linked {
            let staging = Self.stagingRoot.appendingPathComponent(token, isDirectory: true)
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
            try snapshot(url, staging)
            root = staging
        } else {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        }
        let mount = Mount(token: token, root: root, appPath: appPath, original: linked ? url : nil)
        lock.withLock { mounts[token] = mount }
        startTimer()
        return ["token": token, "staged": linked]
    }

    /// Write a staged mount's changes back and report what changed since the
    /// last notification (app paths).
    func sync(_ token: String, coordinate: Coordinator) -> [String] {
        guard let mount = lock.withLock({ mounts[token] }) else { return [] }
        return flush(mount, coordinate: coordinate)
    }

    /// Sync, close what the program left open and forget the mount. Returns
    /// every file the program changed while mounted (app paths).
    func unmount(_ token: String, coordinate: Coordinator) -> [String] {
        guard let mount = lock.withLock({ mounts[token] }) else { return [] }
        _ = flush(mount, coordinate: coordinate)
        let touched: Set<String> = lock.withLock {
            for (_, h) in mount.handles { Darwin.close(h.fd) }
            mount.handles = [:]
            mounts.removeValue(forKey: token)
            return mount.touched
        }
        // A staged copy goes when the last mount using it does.
        let shared = lock.withLock { mounts.values.contains { $0.root == mount.root } }
        if mount.original != nil && !shared { try? FileManager.default.removeItem(at: mount.root) }
        return touched.sorted().map { Self.join(mount.appPath, $0) }
    }

    func unmountAll(coordinate: Coordinator) {
        for token in lock.withLock({ Array(mounts.keys) }) { _ = unmount(token, coordinate: coordinate) }
    }

    func syncAll(coordinate: Coordinator) {
        for mount in lock.withLock({ Array(mounts.values) }) { _ = flush(mount, coordinate: coordinate) }
    }

    /// Something other than a mount changed project files: workers drop their caches.
    func externalChange() {
        lock.withLock { for mount in mounts.values { mount.generation += 1 } }
    }

    // MARK: files the app reads and writes for a program (the device modules, D40)

    /// Where a path relative to a mount is (nil for an unknown mount or a path leaving it).
    func url(token: String, relative path: String) -> URL? {
        guard let mount = lock.withLock({ mounts[token] }), let rel = try? Self.relative(path) else { return nil }
        return rel.isEmpty ? mount.root : mount.root.appendingPathComponent(rel)
    }

    /// The app wrote a file into a mount (e.g. a recording): the program's
    /// caches drop it, and a linked folder gets it back.
    func wroteNatively(token: String, relative path: String) {
        guard let rel = try? Self.relative(path) else { return }
        lock.withLock {
            guard let mount = mounts[token] else { return }
            changed(mount, rel)
            mount.generation += 1
        }
    }

    // MARK: change notification and sync back

    /// Writing back a staged file: (staged copy or nil for a removal, original URL).
    typealias Coordinator = (_ source: URL?, _ target: URL, _ isDirectory: Bool) throws -> Void

    private func startTimer() {
        lock.lock()
        defer { lock.unlock() }
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
    }

    /// Mounts whose files changed: notify (and sync back) after 0.3 s of quiet,
    /// or at least every 2 s while a program keeps writing.
    var coordinator: Coordinator?
    private func tick() {
        let now = Date()
        let due = lock.withLock {
            mounts.values.filter { m in
                guard let first = m.firstChange else { return false }
                return now.timeIntervalSince(m.lastChange) > 0.3 || now.timeIntervalSince(first) > 2
            }
        }
        guard let coordinator else { return }
        for mount in due { _ = flush(mount, coordinate: coordinator) }
    }

    private func flush(_ mount: Mount, coordinate: Coordinator) -> [String] {
        // Under the lock: take the change sets, and clone the staged files
        // (cheap on APFS) so the program can go on writing meanwhile.
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("sync-\(UUID().uuidString)", isDirectory: true)
        var copies: [(rel: String, copy: URL?, isDirectory: Bool)] = []
        let changed: [String] = lock.withLock {
            let changed = mount.changed.sorted()
            mount.changed = []
            mount.firstChange = nil
            guard mount.original != nil else { return changed }
            // SQLite's order: journals first, then the other files, then removals.
            let journal = { (p: String) in p.hasSuffix("-journal") || p.hasSuffix("-wal") }
            let dirty = mount.dirty.sorted { (journal($0) ? 0 : 1, $0) < (journal($1) ? 0 : 1, $1) }
            for rel in dirty {
                let source = mount.root.appendingPathComponent(rel)
                var isDirectory: ObjCBool = false
                guard FileManager.default.fileExists(atPath: source.path, isDirectory: &isDirectory) else { continue }
                // A directory (made or renamed) goes back with everything in it.
                var files = [rel]
                if isDirectory.boolValue {
                    copies.append((rel, nil, true))
                    files = (FileManager.default.subpaths(atPath: source.path) ?? []).map { "\(rel)/\($0)" }
                }
                for file in files {
                    let from = mount.root.appendingPathComponent(file)
                    var dir: ObjCBool = false
                    guard FileManager.default.fileExists(atPath: from.path, isDirectory: &dir) else { continue }
                    if dir.boolValue {
                        copies.append((file, nil, true))
                        continue
                    }
                    let copy = scratch.appendingPathComponent(file)
                    try? FileManager.default.createDirectory(at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
                    if (try? FileManager.default.copyItem(at: from, to: copy)) != nil { copies.append((file, copy, false)) }
                }
            }
            for rel in mount.removed.sorted().reversed() where !FileManager.default.fileExists(atPath: mount.root.appendingPathComponent(rel).path) {
                copies.append((rel, nil, false))
            }
            mount.dirty = []
            mount.removed = []
            return changed
        }
        if let original = mount.original {
            for (rel, copy, isDirectory) in copies {
                try? coordinate(copy, original.appendingPathComponent(rel), isDirectory)
            }
            try? FileManager.default.removeItem(at: scratch)
        }
        let paths = changed.map { Self.join(mount.appPath, $0) }
        if !paths.isEmpty {
            let onChange = onChange
            DispatchQueue.main.async { onChange(paths) }
        }
        return paths
    }

    // MARK: calls from the worker (any thread; usually the main thread)

    func perform(token: String, _ meta: [String: Any], data: Data?) -> (meta: [String: Any], data: Data?) {
        lock.lock()
        defer { lock.unlock() }
        guard let mount = mounts[token] else { return (["error": "ESTALE", "gen": 0], nil) }
        do {
            var (result, bytes) = try dispatch(mount, meta, data: data)
            result["gen"] = mount.generation
            return (result, bytes)
        } catch let failure as Failure {
            return (["error": failure.code, "gen": mount.generation], nil)
        } catch {
            return (["error": "EIO", "gen": mount.generation], nil)
        }
    }

    private func dispatch(_ mount: Mount, _ m: [String: Any], data: Data?) throws -> ([String: Any], Data?) {
        let op = m["op"] as? String ?? ""
        func rel(_ key: String = "path") throws -> String { try Self.relative(m[key] as? String ?? "") }
        func full(_ r: String) -> String { r.isEmpty ? mount.root.path : mount.root.appendingPathComponent(r).path }
        func int(_ key: String) -> Int { (m[key] as? NSNumber)?.intValue ?? 0 }
        func handle(_ key: String = "fd") throws -> (fd: Int32, path: String) {
            guard let h = mount.handles[int(key)] else { throw Failure(code: "EBADF") }
            return h
        }
        switch op {
        case "stat", "lstat":
            var st = stat()
            try check(fstatat(AT_FDCWD, full(try rel()), &st, op == "stat" ? 0 : AT_SYMLINK_NOFOLLOW))
            return (Self.encode(st), nil)
        case "fstat":
            var st = stat()
            try check(Darwin.fstat(try handle().fd, &st))
            return (Self.encode(st), nil)
        case "readdir":
            // Each entry with its stat, as JSON in the body (names can be long and many).
            let dir = full(try rel())
            guard let d = opendir(dir) else { throw Failure(code: Self.errnoName()) }
            defer { closedir(d) }
            var entries: [[String: Any]] = []
            while let e = readdir(d) {
                let name = withUnsafePointer(to: e.pointee.d_name) {
                    $0.withMemoryRebound(to: CChar.self, capacity: Int(e.pointee.d_namlen) + 1) { String(cString: $0) }
                }
                if name == "." || name == ".." { continue }
                var st = stat()
                guard Darwin.lstat(dir + "/" + name, &st) == 0 else { continue }
                var entry = Self.encode(st)
                entry["name"] = name
                entries.append(entry)
            }
            return ([:], try JSONSerialization.data(withJSONObject: entries))
        case "mkdir":
            let r = try rel()
            try check(Darwin.mkdir(full(r), mode_t(0o755)))
            changed(mount, r)
            return ([:], nil)
        case "rmdir":
            let r = try rel()
            try check(Darwin.rmdir(full(r)))
            changed(mount, r, removed: true)
            return ([:], nil)
        case "unlink":
            let r = try rel()
            try check(Darwin.unlink(full(r)))
            changed(mount, r, removed: true)
            return ([:], nil)
        case "rename":
            let from = try rel("from"), to = try rel("to")
            try check(Darwin.rename(full(from), full(to)))
            for (key, h) in mount.handles where h.path == from { mount.handles[key] = (h.fd, to) }
            changed(mount, from, removed: true)
            changed(mount, to)
            return ([:], nil)
        case "truncate":
            let r = try rel()
            try check(Darwin.truncate(full(r), off_t(int("size"))))
            changed(mount, r)
            return ([:], nil)
        case "utimes":
            let r = try rel()
            var times = [timespec(tv_sec: int("atime") / 1000, tv_nsec: (int("atime") % 1000) * 1_000_000),
                         timespec(tv_sec: int("mtime") / 1000, tv_nsec: (int("mtime") % 1000) * 1_000_000)]
            try check(utimensat(AT_FDCWD, full(r), &times, 0))
            changed(mount, r)
            return ([:], nil)
        case "create":
            // A new, empty file (Emscripten's mknod).
            let r = try rel()
            let fd = Darwin.open(full(r), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode_t(0o644))
            try check(fd)
            Darwin.close(fd)
            changed(mount, r)
            return ([:], nil)
        case "open":
            // Answers with the file's stat, so the worker can check its caches.
            let r = try rel()
            let flags = Self.flags(int("flags"))
            let fd = Darwin.open(full(r), flags, mode_t(0o644))
            try check(fd)
            var st = stat()
            Darwin.fstat(fd, &st)
            let id = nextHandle
            nextHandle += 1
            mount.handles[id] = (fd, r)
            var result = Self.encode(st)
            result["fd"] = id
            return (result, nil)
        case "close":
            if let h = mount.handles.removeValue(forKey: int("fd")) { Darwin.close(h.fd) }
            return ([:], nil)
        case "read":
            let fd = try handle().fd
            let length = int("length")
            var buffer = Data(count: length)
            let n = buffer.withUnsafeMutableBytes { pread(fd, $0.baseAddress, length, off_t(int("position"))) }
            try check(Int32(clamping: n))
            buffer.count = n
            return ([:], buffer)
        case "write":
            let h = try handle()
            let bytes = data ?? Data()
            let n = bytes.withUnsafeBytes { pwrite(h.fd, $0.baseAddress, bytes.count, off_t(int("position"))) }
            try check(Int32(clamping: n))
            changed(mount, h.path)
            return (["n": n], nil)
        case "writev":
            // The worker's write-behind queue: [[fd, position, length], ...], in order.
            let bytes = data ?? Data()
            var offset = 0
            try bytes.withUnsafeBytes { raw in
                for run in m["runs"] as? [[NSNumber]] ?? [] {
                    guard let h = mount.handles[run[0].intValue] else { throw Failure(code: "EBADF") }
                    let length = run[2].intValue
                    guard offset + length <= raw.count else { throw Failure(code: "EINVAL") }
                    let n = pwrite(h.fd, raw.baseAddress! + offset, length, off_t(run[1].intValue))
                    try check(Int32(clamping: n))
                    offset += length
                    changed(mount, h.path)
                }
            }
            return (["n": offset], nil)
        case "ftruncate":
            let h = try handle()
            try check(ftruncate(h.fd, off_t(int("size"))))
            changed(mount, h.path)
            return ([:], nil)
        case "fsync":
            try check(Darwin.fsync(try handle().fd))
            return ([:], nil)
        default:
            throw Failure(code: "ENOSYS")
        }
    }

    /// Record a change (under the lock).
    private func changed(_ mount: Mount, _ rel: String, removed: Bool = false) {
        mount.changed.insert(rel)
        mount.touched.insert(rel)
        if mount.original != nil {
            if removed {
                mount.dirty.remove(rel)
                mount.removed.insert(rel)
            } else {
                mount.removed.remove(rel)
                mount.dirty.insert(rel)
            }
        }
        let now = Date()
        mount.lastChange = now
        if mount.firstChange == nil { mount.firstChange = now }
        // Other interpreters on the same files must not trust their caches.
        for other in mounts.values where other !== mount { other.generation += 1 }
    }

    // MARK: helpers

    static func join(_ base: String, _ rel: String) -> String {
        base.isEmpty ? rel : rel.isEmpty ? base : "\(base)/\(rel)"
    }

    /// A clean relative path: no "..", no absolute paths.
    private static func relative(_ path: String) throws -> String {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true).filter { $0 != "." }
        if parts.contains("..") { throw Failure(code: "EACCES") }
        return parts.joined(separator: "/")
    }

    private func check(_ result: Int32) throws {
        if result < 0 { throw Failure(code: Self.errnoName()) }
    }

    private static func errnoName() -> String {
        switch errno {
        case ENOENT: "ENOENT"
        case EEXIST: "EEXIST"
        case ENOTDIR: "ENOTDIR"
        case EISDIR: "EISDIR"
        case ENOTEMPTY: "ENOTEMPTY"
        case EACCES, EPERM: "EACCES"
        case EBADF: "EBADF"
        case EINVAL: "EINVAL"
        case ENOSPC: "ENOSPC"
        case EXDEV: "EXDEV"
        case EMFILE, ENFILE: "EMFILE"
        case ENAMETOOLONG: "ENAMETOOLONG"
        default: "EIO"
        }
    }

    /// Emscripten's open flags (Linux values) to Darwin's. Emscripten creates
    /// and truncates files itself before it opens them.
    private static func flags(_ e: Int) -> Int32 {
        var f: Int32 = O_CLOEXEC
        switch e & 3 {
        case 1: f |= O_WRONLY
        case 2: f |= O_RDWR
        default: f |= O_RDONLY
        }
        return f
    }

    private static func encode(_ st: stat) -> [String: Any] {
        func ms(_ t: timespec) -> Double { Double(t.tv_sec) * 1000 + Double(t.tv_nsec) / 1_000_000 }
        return [
            "mode": Int(st.st_mode), "size": Int(st.st_size), "nlink": Int(st.st_nlink),
            "atime": ms(st.st_atimespec), "mtime": ms(st.st_mtimespec), "ctime": ms(st.st_ctimespec),
        ]
    }
}
