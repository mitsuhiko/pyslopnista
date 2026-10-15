import Foundation

// The coding agent's actions (D34). The agent runs in the engine page
// (agent/service.ts); the app remembers which conversation belongs to which
// project folder and the model picked last.

extension AppModel {
    /// The folder the agent works on: the open file's, else the folder on screen.
    var agentProject: String {
        if let file, !isExternal(file) { return dirname(file) }
        return currentDir
    }

    func openAgent(project: String? = nil) {
        let project = project ?? agentProject
        activeSheet = .agent
        Task { await agentOpen(project) }
    }

    @discardableResult
    func agentCall(_ method: String, _ args: [Any] = []) async -> Any? {
        await command("agent", ["method": method, "args": args])
    }

    private var agentConversations: [String: Int] {
        get { UserDefaults.standard.dictionary(forKey: "agent.conversations") as? [String: Int] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: "agent.conversations") }
    }

    private var agentPreferredModel: Any {
        guard let saved = UserDefaults.standard.dictionary(forKey: "agent.model") else { return NSNull() }
        return saved
    }

    func agentOpen(_ project: String) async {
        let saved: Any = agentConversations[project] ?? NSNull()
        if let id = await agentCall("open", [project, saved, agentPreferredModel]) as? Int {
            agentConversations[project] = id
        }
    }

    func agentNewConversation() {
        let project = agent.state.project ?? agentProject
        Task {
            if let id = await agentCall("newConversation", [project, agentPreferredModel]) as? Int {
                agentConversations[project] = id
            }
        }
    }

    func agentSend(_ text: String) {
        Task {
            await saveAll()
            await agentCall("submit", [text, await agentEditorContext()])
        }
    }

    /// Where the user is: the open file, the cursor or selection, and how the file's last run failed.
    func agentEditorContext() async -> [String: Any] {
        guard let file, !isExternal(file) else { return [:] }
        var context: [String: Any] = ["file": file]
        if let c = await editorCall(focused, "cursor") as? [String: Any], c["path"] as? String == file {
            context["line"] = c["line"]
            if let selection = c["selection"] as? [String: Any] { context["selection"] = selection }
        }
        if let run = session.lastRun, run.file == file, run.status == "error" || run.status == "crashed" {
            let output = session.lines.filter { $0.runId == run.id && ($0.kind == "stderr" || $0.kind == "stdout") }.map(\.text).joined()
            context["error"] = String(output.suffix(2000))
        }
        return context
    }

    func agentStop() {
        haptic()
        Task { _ = await agentCall("abort") }
    }

    func agentSetModel(_ option: AgentModelOption) {
        UserDefaults.standard.set(["provider": option.provider, "modelId": option.model], forKey: "agent.model")
        Task { _ = await agentCall("setModel", [option.provider, option.model]) }
    }

    func loadAgentAccounts() async {
        let raw = await agentCall("accounts") as? [[String: Any]] ?? []
        agentAccounts = raw.map { a in
            let oauth = a["oauth"] as? [String: Any]
            let apiKey = a["apiKey"] as? [String: Any]
            return AgentAccount(
                id: a["id"] as? String ?? "", name: a["name"] as? String ?? "", featured: a["featured"] as? Bool ?? false,
                oauthName: oauth?["name"] as? String, oauthLabel: oauth?["label"] as? String,
                subscription: oauth?["subscription"] as? Bool ?? false,
                apiKeyName: apiKey?["name"] as? String, signedIn: a["signedIn"] as? String)
        }
    }

    func loadAgentModels() async {
        let raw = await agentCall("availableModels") as? [[String: Any]] ?? []
        agentModels = raw.map {
            AgentModelOption(provider: $0["provider"] as? String ?? "", providerName: $0["providerName"] as? String ?? "",
                             model: $0["id"] as? String ?? "", name: $0["name"] as? String ?? "")
        }
    }

    /// Sign in (type "oauth" or "api_key"); the flow's prompts show in LoginFlowView.
    func agentLogin(_ provider: String, _ type: String) async {
        agentLoginError = nil
        agentHost.beginLogin(provider)
        do {
            _ = try await engine.call("agent", ["method": "login", "args": [provider, type]])
        } catch {
            let message = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
            if !message.contains("cancelled") { agentLoginError = message }
        }
        agentHost.endLogin()
        await loadAgentAccounts()
        await loadAgentModels()
        // A first sign-in gives the current conversation a model.
        if agent.state.model == nil, let project = agent.state.project { await agentOpen(project) }
    }

    func agentCancelLogin() {
        agentHost.answerPrompt(nil)
        Task { _ = await agentCall("cancelLogin") }
    }

    func agentLogout(_ provider: String) async {
        await agentCall("logout", [provider])
        await loadAgentAccounts()
        await loadAgentModels()
    }
}
