import Darwin
import Foundation

/// The project folder as POSIX calls, for an Emscripten file system in the
/// Pyodide worker (`web/hostfs.js`). Every call is synchronous for the worker:
/// it arrives over sync XHR (`/__fs`, SchemeHandler) or the page's bridge.
///
/// Paths are relative to `root` and may not leave it. Errors come back as
/// errno names ("ENOENT"), which the worker maps to Emscripten's numbers.
/// Open files are plain file descriptors in a table keyed by a small integer.
final class HostFS: @unchecked Sendable {
    struct Failure: Error {
        let code: String
    }

    let root: URL
    private var handles: [Int: Int32] = [:]
    private var nextHandle = 1
    private(set) var calls = 0
    private let lock = NSLock()

    init(root: URL) {
        self.root = root.standardizedFileURL
        try? FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
    }

    /// One call: `meta` holds the op and its arguments, `data` the bytes to
    /// write. Returns the result's metadata and bytes (for reads).
    func perform(_ meta: [String: Any], data: Data?) -> ([String: Any], Data?) {
        lock.lock()
        defer { lock.unlock() }
        calls += 1
        do {
            return try dispatch(meta, data: data)
        } catch let failure as Failure {
            return (["error": failure.code], nil)
        } catch {
            return (["error": "EIO", "message": "\(error)"], nil)
        }
    }

    private func dispatch(_ m: [String: Any], data: Data?) throws -> ([String: Any], Data?) {
        let op = m["op"] as? String ?? ""
        func path(_ key: String = "path") throws -> String { try resolve(m[key] as? String ?? "") }
        func int(_ key: String) -> Int { (m[key] as? NSNumber)?.intValue ?? 0 }
        switch op {
        case "noop":
            return ([:], nil)
        case "stat", "lstat":
            var st = stat()
            let p = try path()
            let rc = fstatat(AT_FDCWD, p, &st, op == "stat" ? 0 : AT_SYMLINK_NOFOLLOW)
            try check(rc)
            return (Self.encode(st), nil)
        case "fstat":
            var st = stat()
            try check(Darwin.fstat(try fd(int("fd")), &st))
            return (Self.encode(st), nil)
        case "readdir":
            // Names with their stat, so a listing doesn't cost a call per entry.
            let dir = try path()
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
            return (["entries": entries], nil)
        case "mkdir":
            try check(Darwin.mkdir(try path(), mode_t(int("mode") & 0o777)))
            return ([:], nil)
        case "rmdir":
            try check(Darwin.rmdir(try path()))
            return ([:], nil)
        case "unlink":
            try check(Darwin.unlink(try path()))
            return ([:], nil)
        case "rename":
            try check(Darwin.rename(try path("from"), try path("to")))
            return ([:], nil)
        case "truncate":
            try check(Darwin.truncate(try path(), off_t(int("size"))))
            return ([:], nil)
        case "utimes":
            var times = [timespec(tv_sec: int("atime") / 1000, tv_nsec: (int("atime") % 1000) * 1_000_000),
                         timespec(tv_sec: int("mtime") / 1000, tv_nsec: (int("mtime") % 1000) * 1_000_000)]
            try check(utimensat(AT_FDCWD, try path(), &times, 0))
            return ([:], nil)
        case "open":
            let fd = Darwin.open(try path(), Self.flags(int("flags")), mode_t(0o644))
            try check(fd)
            let handle = nextHandle
            nextHandle += 1
            handles[handle] = fd
            return (["fd": handle], nil)
        case "close":
            if let fd = handles.removeValue(forKey: int("fd")) { Darwin.close(fd) }
            return ([:], nil)
        case "read":
            let fd = try fd(int("fd"))
            var buffer = Data(count: int("length"))
            let n = buffer.withUnsafeMutableBytes { pread(fd, $0.baseAddress, int("length"), off_t(int("position"))) }
            try check(Int32(clamping: n))
            buffer.count = n
            return (["n": n], buffer)
        case "write":
            let fd = try fd(int("fd"))
            let bytes = data ?? Data()
            // Writes may carry several runs (a write-back buffer): [[position, length], ...].
            let runs = (m["runs"] as? [[NSNumber]]) ?? [[NSNumber(value: int("position")), NSNumber(value: bytes.count)]]
            var offset = 0
            var total = 0
            try bytes.withUnsafeBytes { raw in
                for run in runs {
                    let position = run[0].intValue, length = run[1].intValue
                    let n = pwrite(fd, raw.baseAddress! + offset, length, off_t(position))
                    try check(Int32(clamping: n))
                    offset += length
                    total += n
                }
            }
            if let size = m["truncate"] as? NSNumber { try check(ftruncate(fd, off_t(size.intValue))) }
            if m["fsync"] as? Bool == true { try check(Darwin.fsync(fd)) }
            return (["n": total], nil)
        case "writev":
            // The worker's write-behind queue: [[handle, position, length], ...] in order.
            let bytes = data ?? Data()
            let runs = m["runs"] as? [[NSNumber]] ?? []
            var offset = 0
            try bytes.withUnsafeBytes { raw in
                for run in runs {
                    let fd = try fd(run[0].intValue), position = run[1].intValue, length = run[2].intValue
                    let n = pwrite(fd, raw.baseAddress! + offset, length, off_t(position))
                    try check(Int32(clamping: n))
                    offset += length
                }
            }
            return (["n": offset], nil)
        case "ftruncate":
            try check(ftruncate(try fd(int("fd")), off_t(int("size"))))
            return ([:], nil)
        case "fsync":
            try check(Darwin.fsync(try fd(int("fd"))))
            return ([:], nil)
        case "readfile":
            // A whole file in one call (copy-in, the way the app works today).
            let url = URL(fileURLWithPath: try path())
            guard let bytes = try? Data(contentsOf: url) else { throw Failure(code: "ENOENT") }
            return (["n": bytes.count], bytes)
        case "writefile":
            try (data ?? Data()).write(to: URL(fileURLWithPath: try path()))
            return ([:], nil)
        case "stats":
            return (["calls": calls], nil)
        default:
            throw Failure(code: "ENOSYS")
        }
    }

    private func fd(_ handle: Int) throws -> Int32 {
        guard let fd = handles[handle] else { throw Failure(code: "EBADF") }
        return fd
    }

    private func resolve(_ relative: String) throws -> String {
        let url = relative.isEmpty || relative == "/" ? root : root.appendingPathComponent(relative).standardizedFileURL
        guard url.path == root.path || url.path.hasPrefix(root.path + "/") else { throw Failure(code: "EACCES") }
        return url.path
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
        default: "EIO"
        }
    }

    /// Emscripten's open flags (Linux values) to Darwin's.
    private static func flags(_ e: Int) -> Int32 {
        var f: Int32 = 0
        switch e & 3 {
        case 1: f |= O_WRONLY
        case 2: f |= O_RDWR
        default: f |= O_RDONLY
        }
        if e & 64 != 0 { f |= O_CREAT }
        if e & 128 != 0 { f |= O_EXCL }
        if e & 512 != 0 { f |= O_TRUNC }
        if e & 1024 != 0 { f |= O_APPEND }
        return f | O_CLOEXEC
    }

    private static func encode(_ st: stat) -> [String: Any] {
        func ms(_ t: timespec) -> Double { Double(t.tv_sec) * 1000 + Double(t.tv_nsec) / 1_000_000 }
        return [
            "mode": Int(st.st_mode), "size": Int(st.st_size), "nlink": Int(st.st_nlink),
            "atime": ms(st.st_atimespec), "mtime": ms(st.st_mtimespec), "ctime": ms(st.st_ctimespec),
            "ino": Int(st.st_ino),
        ]
    }
}
