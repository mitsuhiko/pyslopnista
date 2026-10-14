import Foundation

/// A JSON value as it comes from Python's op stream (ui.py).
enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(_ any: Any?) {
        switch any {
        case nil, is NSNull: self = .null
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map { JSONValue($0) })
        case let o as [String: Any]: self = .object(o.mapValues { JSONValue($0) })
        default: self = .null
        }
    }

    static func parse(_ text: String) -> JSONValue? {
        guard let data = text.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        else { return nil }
        return JSONValue(any)
    }

    var isNull: Bool { if case .null = self { true } else { false } }

    var string: String? {
        switch self {
        case .string(let s): s
        case .number(let n): n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .bool(let b): b ? "True" : "False"
        default: nil
        }
    }

    var double: Double? {
        switch self {
        case .number(let n): n
        case .bool(let b): b ? 1 : 0
        case .string(let s): Double(s)
        default: nil
        }
    }

    var int: Int? { double.map { Int($0) } }

    /// Python-style truthiness.
    var truthy: Bool {
        switch self {
        case .null: false
        case .bool(let b): b
        case .number(let n): n != 0
        case .string(let s): !s.isEmpty
        case .array(let a): !a.isEmpty
        case .object(let o): !o.isEmpty
        }
    }

    var array: [JSONValue]? { if case .array(let a) = self { a } else { nil } }
    var object: [String: JSONValue]? { if case .object(let o) = self { o } else { nil } }

    subscript(key: String) -> JSONValue? { object?[key] }

    /// Plain Foundation objects, for JSONSerialization.
    var foundation: Any {
        switch self {
        case .null: NSNull()
        case .bool(let b): b
        case .number(let n): n
        case .string(let s): s
        case .array(let a): a.map(\.foundation)
        case .object(let o): o.mapValues(\.foundation)
        }
    }
}

/// JSON text for event arguments (`[1]`, `["text"]`, `[{"x": 1}]`).
func jsonText(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value) || value is String || value is NSNumber,
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
    else { return "null" }
    return String(decoding: data, as: UTF8.self)
}
