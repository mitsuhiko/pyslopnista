import Foundation
import Network

/// A one-shot HTTP server on the loopback interface for OAuth redirects
/// (`http://localhost:<port>/callback`). The page's `node:http` shim drives
/// it, so pi-ai's callback servers run unmodified: `listen` binds (port 0
/// picks one), every request goes to the page (`onRequest`), and the page
/// answers it with `respond`. Bound to the loopback interface only, both
/// 127.0.0.1 and ::1 (Safari may resolve `localhost` to either).
@MainActor
final class Loopback {
    struct ListenError: Error, CustomStringConvertible {
        let code: String
        let message: String
        var description: String { "\(code): \(message)" }
    }

    var onRequest: (_ server: Int, _ connection: Int, _ method: String, _ target: String) -> Void = { _, _, _, _ in }
    private var listeners: [Int: NWListener] = [:]
    private var connections: [Int: (server: Int, connection: NWConnection)] = [:]
    private var pending: [Int: (Result<UInt16, ListenError>) -> Void] = [:]
    private var nextId = 1

    func listen(port: UInt16, reply: @escaping (Result<(id: Int, port: UInt16), ListenError>) -> Void) {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        let listener: NWListener
        do {
            listener = try NWListener(using: params, on: port == 0 ? .any : NWEndpoint.Port(rawValue: port)!)
        } catch {
            return reply(.failure(ListenError(code: "EINVAL", message: "\(error)")))
        }
        let id = nextId
        nextId += 1
        listeners[id] = listener
        pending[id] = { result in reply(result.map { (id, $0) }) }
        listener.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated { self?.listenerChanged(id, state) }
        }
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.accept(connection, server: id) }
        }
        listener.start(queue: .main)
    }

    private func listenerChanged(_ id: Int, _ state: NWListener.State) {
        switch state {
        case .ready:
            pending.removeValue(forKey: id)?(.success(listeners[id]?.port?.rawValue ?? 0))
        case .failed(let error), .waiting(let error):
            let inUse: Bool
            if case .posix(let code) = error, code == .EADDRINUSE { inUse = true } else { inUse = false }
            listeners.removeValue(forKey: id)?.cancel()
            pending.removeValue(forKey: id)?(.failure(ListenError(code: inUse ? "EADDRINUSE" : "EIO", message: "\(error)")))
        default:
            break
        }
    }

    func close(_ server: Int) {
        listeners.removeValue(forKey: server)?.cancel()
        closeConnections(server)
    }

    /// Drop connections that have not sent a request (browsers open spare ones).
    func closeConnections(_ server: Int) {
        for (id, entry) in connections where entry.server == server {
            entry.connection.cancel()
            connections[id] = nil
        }
    }

    private func accept(_ connection: NWConnection, server: Int) {
        let id = nextId
        nextId += 1
        connections[id] = (server, connection)
        connection.start(queue: .main)
        receive(connection, id: id, server: server, buffer: Data())
    }

    private func receive(_ connection: NWConnection, id: Int, server: Int, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                var buffer = buffer
                if let data { buffer.append(data) }
                if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                    let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
                    let parts = head.split(separator: "\r\n", maxSplits: 1).first?.split(separator: " ") ?? []
                    guard parts.count >= 2 else { return self.drop(id) }
                    self.onRequest(server, id, String(parts[0]), String(parts[1]))
                } else if isComplete || error != nil || buffer.count > 64 * 1024 {
                    self.drop(id)
                } else {
                    self.receive(connection, id: id, server: server, buffer: buffer)
                }
            }
        }
    }

    private func drop(_ id: Int) {
        connections.removeValue(forKey: id)?.connection.cancel()
    }

    func respond(_ id: Int, status: Int, headers: [String: String], body: String) {
        guard let (_, connection) = connections.removeValue(forKey: id) else { return }
        let bytes = Data(body.utf8)
        var head = "HTTP/1.1 \(status) \(HTTPURLResponse.localizedString(forStatusCode: status).capitalized)\r\n"
        for (name, value) in headers where !["content-length", "connection"].contains(name.lowercased()) {
            head += "\(name): \(value)\r\n"
        }
        head += "Content-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + bytes, completion: .contentProcessed { _ in connection.cancel() })
    }
}
