import SwiftUI

/// Pyslopnista: a native SwiftUI app (D31). Python and code analysis run in a
/// web view without UI (the engine page), the editor is CodeMirror in one web
/// view per pane, and ui apps are native views (D30).
@main
struct PyslopnistaApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
