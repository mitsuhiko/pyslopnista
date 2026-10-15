import Foundation

/// The Python versions the app bundles (D37): app/runtimes.json, copied to
/// web/runtimes.json in the bundle. Each has its Pyodide core under
/// web/pyodide/<python>/, its packages' CDN and its docs.
struct Runtime: Decodable, Hashable, Sendable {
    let python: String // "3.14"
    let version: String // "3.14.2"
    let pyodide: String // "314.0.7"
    let cdn: URL
    let prerelease: Bool?

    var label: String { "Python \(python)\(prerelease == true ? " (preview)" : "")" }
}

enum Runtimes {
    private struct File: Decodable {
        let `default`: String
        let runtimes: [Runtime]
    }

    private static let file: File = {
        let url = Bundle.main.resourceURL!.appendingPathComponent("web/runtimes.json")
        guard let data = try? Data(contentsOf: url), let file = try? JSONDecoder().decode(File.self, from: data) else {
            fatalError("web/runtimes.json is missing from the bundle (copy-web.sh)")
        }
        return file
    }()

    static var all: [Runtime] { file.runtimes }
    static var defaultPython: String { file.default }

    static func runtime(_ python: String) -> Runtime? {
        all.first { $0.python == python }
    }
}
