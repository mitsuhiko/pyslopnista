import UIKit

// Markdown files (D46): the editor page shows a .md as a preview or as its
// source (it reports which with the notebook summary). Links in the preview
// come here: other files open in the app, folders in the browser.

/// A Markdown file, by its name.
func isMarkdown(_ path: String) -> Bool {
    let ext = (path as NSString).pathExtension.lowercased()
    return ext == "md" || ext == "markdown"
}

extension AppModel {
    /// How the focused pane shows its Markdown file: "preview" or "source"; nil for other files.
    var markdownView: String? {
        guard let file, isMarkdown(file) else { return nil }
        guard let n = notebookPanes[focused], n.path == file else { return "preview" }
        return n.view ?? "preview"
    }

    var previewing: Bool { markdownView == "preview" }

    func toggleMarkdownView() {
        guard markdownView != nil else { return }
        haptic()
        notebookCommand("toggleView")
    }

    /// Find in the preview: the web view's own find bar (the editor has CodeMirror's).
    func find() {
        if previewing {
            let webView = editors[focused].webView
            webView.isFindInteractionEnabled = true
            webView.findInteraction?.presentFindNavigator(showingReplace: false)
        } else {
            Task { _ = await editorCall(focused, "command", ["search"]) }
        }
    }

    /// The pane's view changed: only a preview gets the web view's find (⌘F is CodeMirror's otherwise).
    func markdownViewChanged(_ pane: Int, _ view: String?) {
        guard editors.indices.contains(pane) else { return }
        let webView = editors[pane].webView
        let on = view == "preview"
        if !on { webView.findInteraction?.dismissFindNavigator() }
        if webView.isFindInteractionEnabled != on { webView.isFindInteractionEnabled = on }
    }

    /// A link in a preview to a file or folder of the project (`fragment`: what followed `#`).
    func openLink(_ path: String, fragment: String) async {
        guard let isDir = try? await host.onFileQueue({ try $0.stat(path).map { $0["dir"] as? Bool == true } }) else {
            return showToast("“\(basename(path))” doesn't exist")
        }
        if isDir { return showFolder(path) }
        if AppModel.isPreviewable(path) { return quickLook(path) }
        // `#L12` or `#12` is a line (as GitHub writes it); anything else a Markdown heading.
        let line = fragment.wholeMatch(of: /L?(\d+)(?:-L?\d+)?/).flatMap { Int($0.1) }
        await openLocation(path, line: line)
        if line == nil, !fragment.isEmpty, isMarkdown(path) {
            _ = await editorCall(focused, "revealAnchor", [fragment])
        }
    }

    /// A folder in the file browser.
    func showFolder(_ path: String) {
        var next: [Route] = []
        var at = ""
        for part in path.split(separator: "/") {
            at = joinPath(at, String(part))
            next.append(.folder(at))
        }
        route = next
        if wide { sidebarVisible = true }
    }
}
