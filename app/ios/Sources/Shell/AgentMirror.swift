import Foundation
import Observation

// The agent's conversation as the engine reports it (agent/service.ts): a
// compact transcript of messages and tool calls, sent whole on each change.

struct AgentItem: Codable, Identifiable, Equatable {
    var id: String
    let kind: String // user, assistant, tool, error, note
    let text: String
    var thinking: String?
    var streaming: Bool?
    var tool: String?
    var summary: String?
    var status: String? // pending, running, done, error
    var output: String?
    var diff: String?
    var path: String?
    var line: Int?
    var images: Int?
}

struct AgentModelRef: Codable, Equatable {
    let provider: String
    let id: String
    let name: String
}

struct AgentState: Codable, Equatable {
    var project: String?
    var conversationId: Int?
    var items: [AgentItem]
    var busy: Bool
    var status: String?
    var error: String?
    var model: AgentModelRef?
    var signedIn: Bool

    static let empty = AgentState(project: nil, conversationId: nil, items: [], busy: false, status: nil, error: nil, model: nil, signedIn: false)
}

/// A provider and how to sign in to it (the engine's `accounts`).
struct AgentAccount: Identifiable, Equatable {
    let id: String
    let name: String
    let featured: Bool
    let oauthName: String?
    let oauthLabel: String?
    let subscription: Bool
    let apiKeyName: String?
    let signedIn: String? // "oauth", "api_key"
}

struct AgentModelOption: Identifiable, Hashable {
    var id: String { "\(provider)/\(model)" }
    let provider: String
    let providerName: String
    let model: String
    let name: String
}

@MainActor @Observable
final class AgentMirror {
    private(set) var state = AgentState.empty

    func apply(_ json: String) {
        guard let data = json.data(using: .utf8), var next = try? JSONDecoder().decode(AgentState.self, from: data) else { return }
        // ForEach needs unique IDs.
        var seen = Set<String>()
        for i in next.items.indices where !seen.insert(next.items[i].id).inserted {
            next.items[i].id += "#\(i)"
            seen.insert(next.items[i].id)
        }
        if next != state { state = next }
    }
}
