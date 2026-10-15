import Observation
import SwiftUI

/// The native renderer for ui apps (D30) and whether it is on screen. Ops
/// arrive from the engine page; the app model wires `store.send` and
/// `store.close` to it.
@MainActor @Observable
final class UIHost {
    let store = UIStore()
    /// The app view is on screen (hidden while the debugger is paused).
    private(set) var visible = false
    /// The app's program is being run again (Restart): the view shows a spinner.
    var restarting = false

    func show() {
        store.reset()
        withAnimation(.smooth(duration: 0.3)) { visible = true }
        store.resync()
    }

    func hide() {
        withAnimation(.smooth(duration: 0.25)) { visible = false }
    }

    func render(_ json: String?) {
        if let json { store.render(json) } else { store.reset() }
    }
}
