import SwiftUI

// The editor area: tabs, CodeMirror panes (web views, D31), the navigation
// bar with Run and the ⋯ menu, and where the console goes.

/// iPhone: one pane, the console as a panel at the bottom.
struct EditorScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                if model.panes[0].tabs.count > 1 { TabStrip(pane: 0) }
                ZStack(alignment: .bottom) {
                    EditorPaneView(pane: 0)
                        .padding(.bottom, model.editorFocused ? 0 : ConsolePanel.peek)
                    if !model.editorFocused {
                        ConsolePanel(maxHeight: geo.size.height)
                    }
                }
            }
        }
        .modifier(EditorChrome())
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.visible, for: .navigationBar)
    }
}

/// iPad: one or two panes and the docked console (right in landscape, below otherwise).
struct WorkspaceView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        GeometryReader { geo in
            let landscape = geo.size.width > geo.size.height * 1.2 && !model.split
            let layout = landscape ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(VStackLayout(spacing: 0))
            layout {
                editors(width: geo.size.width)
                if model.consoleDocked {
                    Divider()
                    ConsoleView(showHeader: true)
                        .frame(width: landscape ? max(320, geo.size.width * 0.38) : nil, height: landscape ? nil : geo.size.height * 0.36)
                }
            }
        }
        .modifier(EditorChrome())
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func editors(width: CGFloat) -> some View {
        if model.split {
            GeometryReader { geo in
                HStack(spacing: 0) {
                    PaneColumn(pane: 0).frame(width: geo.size.width * model.splitRatio)
                    SplitDivider(width: geo.size.width)
                    PaneColumn(pane: 1)
                }
            }
        } else {
            PaneColumn(pane: model.focused)
        }
    }
}

private struct SplitDivider: View {
    let width: CGFloat
    @Environment(AppModel.self) private var model
    @State private var start: CGFloat?

    var body: some View {
        Rectangle()
            .fill(Color(.separator))
            .frame(width: 1)
            .overlay(Color.clear.frame(width: 16).contentShape(Rectangle()))
            .gesture(DragGesture(coordinateSpace: .global).onChanged { g in
                let base = start ?? model.splitRatio
                if start == nil { start = base }
                model.splitRatio = min(0.75, max(0.25, base + g.translation.width / max(1, width)))
            }.onEnded { _ in start = nil })
            .onTapGesture(count: 2) { model.splitRatio = 0.5 }
            .accessibilityLabel("Resize split view")
    }
}

private struct PaneColumn: View {
    let pane: Int
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            TabStrip(pane: pane)
            EditorPaneView(pane: pane)
        }
        .overlay(alignment: .top) {
            if model.split && model.focused == pane {
                Rectangle().fill(.tint).frame(height: 2)
            }
        }
        .simultaneousGesture(TapGesture().onEnded { if model.focusedPane != pane { model.focusedPane = pane } })
    }
}

/// One CodeMirror page, with the popovers that point into it.
struct EditorPaneView: View {
    let pane: Int
    @Environment(AppModel.self) private var model

    var body: some View {
        let empty = !model.panes.indices.contains(pane) || model.panes[pane].active == nil
        ZStack {
            WebViewHost(webView: model.editors[pane].webView)
            if empty { EmptyEditor() }
        }
        .background(Color(.systemBackground))
        .popover(item: Binding(
            get: { model.popover?.pane == pane ? model.popover : nil },
            set: { model.popover = $0 }
        ), attachmentAnchor: .rect(.rect(model.popover?.rect ?? .zero))) { popover in
            Group {
                switch popover.kind {
                case .value(let expr): ValuePopover(expr: expr)
                case .info(let markdown): InfoPopover(markdown: markdown, docs: popover.docs)
                }
            }
            .environment(model)
            .presentationCompactAdaptation(.popover)
        }
    }
}

private struct EmptyEditor: View {
    @Environment(AppModel.self) private var model
    @State private var naming = false
    @State private var name = "untitled.py"

    var body: some View {
        ContentUnavailableView {
            Label { Text("No File Open") } icon: { FileIcon(name: "x.py", size: 64) }
        } description: {
            Text("Pick a file or create a new one.")
        } actions: {
            Button("New File") { naming = true }.buttonStyle(.borderedProminent)
            if model.wide && !model.sidebarVisible {
                Button("Browse Files") { model.sidebarVisible = true }
            }
        }
        .background(Color(.systemBackground))
        .alert("New File", isPresented: $naming) {
            TextField("Name", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                Task { if let path = await model.newFile(in: model.currentDir, name: name) { await model.openFile(path) } }
            }
        }
    }
}

/// Open files of one pane. Tap to switch, × to close, long-press for more.
struct TabStrip: View {
    let pane: Int
    @Environment(AppModel.self) private var model

    var body: some View {
        let p = model.panes.indices.contains(pane) ? model.panes[pane] : Pane()
        HStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(p.tabs, id: \.self) { path in
                            tab(path, active: path == p.active).id(path)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                }
                .onChange(of: p.active) { _, active in withAnimation { proxy.scrollTo(active) } }
                .onAppear { if let active = p.active { proxy.scrollTo(active) } }
            }
            if model.wide {
                Button {
                    Task { await model.setSplit(!(model.split && pane == 1) && !model.split) }
                } label: {
                    Image(systemName: model.split && pane == 1 ? "xmark" : "rectangle.split.2x1")
                        .frame(width: 34, height: 34)
                }
                .foregroundStyle(.secondary)
                .opacity(model.split && pane == 0 ? 0 : 1)
                .accessibilityLabel(model.split ? "Close Split View" : "Split View")
            }
        }
        .frame(height: 40)
        .background(Color(.secondarySystemBackground))
        .overlay(alignment: .bottom) { Divider() }
    }

    private func tab(_ path: String, active: Bool) -> some View {
        let running = model.session.running && model.session.runningFile == path
        return HStack(spacing: 6) {
            if running { Circle().fill(.green).frame(width: 6, height: 6) }
            if isExternal(path) { Image(systemName: "lock.fill").font(.caption2).foregroundStyle(.secondary) }
            Text(tabLabel(path)).font(.subheadline).lineLimit(1)
            Button {
                Task { await model.closeTab(path, pane: pane) }
            } label: {
                Image(systemName: "xmark").font(.caption2.weight(.semibold)).frame(width: 18, height: 18)
            }
            .foregroundStyle(.secondary)
            .accessibilityLabel("Close \(tabLabel(path))")
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .frame(height: 30)
        .background(active ? Color(.systemBackground) : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { Task { await model.selectTab(path, pane: pane) } }
        .contextMenu {
            Button { Task { await model.closeTab(path, pane: pane) } } label: { Label("Close Tab", systemImage: "xmark") }
            Button { Task { await model.closeOtherTabs(path, pane: pane) } } label: { Label("Close Other Tabs", systemImage: "xmark.square") }
                .disabled(model.panes[pane].tabs.count < 2)
            if model.wide {
                Button {
                    Task { await model.openInOtherPane(path, from: pane) }
                } label: {
                    Label(model.panes.count > 1 ? (pane == 0 ? "Open on the Right" : "Open on the Left") : "Open in Split View",
                          systemImage: "rectangle.split.2x1")
                }
            }
        }
    }
}

/// The navigation bar: file name (opens "Go to"), status, the ⋯ menu, Run.
private struct EditorChrome: ViewModifier {
    @Environment(AppModel.self) private var model
    @State private var renaming = false
    @State private var newName = ""
    @State private var deleting = false

    func body(content: Content) -> some View {
        let file = model.file
        let external = file.map(isExternal) ?? false
        let debug = model.session.debug
        content
            .toolbar {
                ToolbarItem(placement: .principal) { title(file) }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if model.wide, let debug {
                        DebugBar(debug: debug)
                    }
                    if model.wide {
                        Button { withAnimation { model.consoleDocked.toggle() } } label: { Image(systemName: "terminal") }
                            .accessibilityLabel("Toggle console")
                    }
                    AgentButton()
                    menu(file, external: external)
                    RunButton()
                }
            }
            .alert("Rename “\(file.map(basename) ?? "")”", isPresented: $renaming) {
                TextField("Name", text: $newName).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    if let file, !newName.isEmpty, newName != basename(file), !newName.contains("/") {
                        Task { _ = await model.rename(file, to: newName) }
                    }
                }
            }
            .confirmationDialog("Delete “\(file.map(basename) ?? "")”?", isPresented: $deleting, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { if let file { Task { await model.delete(file) } } }
            } message: {
                Text("This cannot be undone.")
            }
    }

    /// Room for the title on iPhone: between the back button and the buttons
    /// on the right (about 250 pt together).
    private var titleWidth: CGFloat {
        model.wide ? min(420, model.windowWidth * 0.4) : max(90, model.windowWidth - 250)
    }

    /// The file name, cut in the middle when it doesn't fit. Toolbar buttons
    /// keep their label's ideal size (it would run under the other buttons),
    /// so the text gets an exact width: its own, or what is left.
    private func fileName(_ name: String) -> some View {
        let natural = ceil((name as NSString).size(withAttributes: [.font: UIFont.preferredFont(forTextStyle: .headline)]).width)
        return Text(name).font(.headline).lineLimit(1).truncationMode(.middle)
            .frame(width: min(natural, titleWidth - 16))
    }

    private func title(_ file: String?) -> some View {
        VStack(spacing: 0) {
            if let file {
                Button { model.activeSheet = .jump("") } label: {
                    HStack(spacing: 3) {
                        fileName(tabLabel(file))
                        Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                    }
                }
                .tint(.primary)
                .accessibilityLabel("\(tabLabel(file)): go to a symbol or line")
            } else {
                Text("Pyslopnista").font(.headline)
            }
            subtitle(file).lineLimit(1)
        }
    }

    @ViewBuilder
    private func subtitle(_ file: String?) -> some View {
        let s = model.session
        let counts = model.problems[min(model.focused, 1)]
        if let debug = s.debug, let frame = debug.frames.first {
            Text(debug.postMortem ? "Error in \(frame.label)" : "Paused · line \(frame.line)")
                .font(.caption).foregroundStyle(debug.postMortem ? .red : .green)
        } else if s.running && s.runningFile == file, let run = s.lastRun {
            Text(run.summary(awaitingInput: s.awaitingInput)).font(.caption).foregroundStyle(.green)
        } else if let file, isExternal(file) {
            Text("Read only").font(.caption).foregroundStyle(.secondary)
        } else if counts.total > 0 {
            Button { model.activeSheet = .problems } label: {
                Label(counts.total == 1 ? "1 problem" : "\(counts.total) problems", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
            }
            .tint(counts.errors > 0 ? .red : .orange)
        } else if model.wide, let file, !dirname(file).isEmpty {
            Text(displayName(dirname(file))).font(.caption).foregroundStyle(.secondary)
        }
    }

    /// Which Python the file runs on; picking one pins its folder (`.python-version`, D37).
    private func pythonMenu(_ file: String) -> some View {
        let current = model.filePython
        let title = current.map { "Python \($0.version)" } ?? "Python \(model.defaultPython)"
        return Menu {
            Picker("Python for “\(displayName(dirname(file)))”", selection: Binding(
                get: { model.folderPin ?? "" },
                set: { value in Task { await model.setFolderPython(value.isEmpty ? nil : value) } }
            )) {
                Text("Default (Python \(model.defaultPython))").tag("")
                ForEach(Runtimes.all, id: \.python) { Text($0.label).tag($0.python) }
            }
            .pickerStyle(.inline)
        } label: {
            Label(title, systemImage: "chevron.left.forwardslash.chevron.right")
            if let current, current.reason != "default" {
                Text("from \(current.reason)")
            }
        }
    }

    private func menu(_ file: String?, external: Bool) -> some View {
        let bps = file.map { model.breakpoints[$0]?.count ?? 0 } ?? 0
        return Menu {
            Section {
                Button { model.activeSheet = .jump("") } label: { Label("Go to…", systemImage: "list.bullet") }
                Button { Task { _ = await model.goToDefinition() } } label: { Label("Jump to Definition", systemImage: "arrow.forward.to.line") }
                    .disabled(external)
                Button { Task { _ = await model.showInfo() } } label: { Label("Show Info", systemImage: "info.circle") }
                    .disabled(external)
                Button { model.showDocs() } label: { Label("Python Documentation", systemImage: "book") }
            }
            Section {
                Button { Task { _ = await model.editorCall(model.focused, "command", ["search"]) } } label: { Label("Find", systemImage: "magnifyingglass") }
                Button { model.activeSheet = .find } label: {
                    Label("Find in \(file.map { displayName(dirname($0)) } ?? "Files")…", systemImage: "doc.text.magnifyingglass")
                }
                Button { Task { await model.format() } } label: { Label("Format Code", systemImage: "wand.and.stars") }
                    .disabled(external)
                Button { model.activeSheet = .problems } label: { Label("Show Problems", systemImage: "exclamationmark.triangle") }
                    .disabled(model.problems[min(model.focused, 1)].total == 0)
            }
            if bps > 0, let file {
                Section {
                    Button { model.clearBreakpoints(file) } label: {
                        Label(bps == 1 ? "Remove Breakpoint" : "Remove \(bps) Breakpoints", systemImage: "arrowshape.right")
                    }
                }
            }
            if let file, !external {
                Section {
                    pythonMenu(file)
                }
            }
            Section {
                if model.wide {
                    Button { Task { await model.setSplit(!model.split) } } label: {
                        Label(model.split ? "Close Split View" : "Split View", systemImage: "rectangle.split.2x1")
                    }
                }
                Button { model.activeSheet = .settings } label: { Label("Settings…", systemImage: "gearshape") }
            }
            if let file {
                if external {
                    Button { Task { await model.closeTab(file) } } label: { Label("Close Tab", systemImage: "xmark") }
                } else {
                    Section {
                        Button {
                            newName = basename(file)
                            renaming = true
                        } label: { Label("Rename…", systemImage: "pencil") }
                        Button {
                            Task {
                                if let copy = await model.duplicate(file) {
                                    await model.openFile(copy)
                                    model.showToast("Duplicated as “\(basename(copy))”")
                                }
                            }
                        } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
                        if file.hasSuffix(".py") {
                            Button { model.activeSheet = .homeScreen(file) } label: { Label("Add to Home Screen…", systemImage: "apps.iphone.badge.plus") }
                        }
                    }
                    Section {
                        Button(role: .destructive) { deleting = true } label: { Label("Delete", systemImage: "trash") }
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel("More")
        .disabled(file == nil)
    }
}

/// Opens the coding agent for the current project; shows when one of its conversations is working.
struct AgentButton: View {
    var project: String?
    @Environment(AppModel.self) private var model

    var body: some View {
        Button { model.openAgent(project: project) } label: {
            let state = model.agent.state
            let working = state.busy || (state.conversations?.contains(where: \.running) ?? false)
            Image(systemName: working ? "sparkles.rectangle.stack.fill" : "sparkles")
                .symbolEffect(.pulse, isActive: working)
        }
        .accessibilityLabel("Agent")
    }
}

/// Run, Stop or Continue.
struct RunButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let s = model.session
        let file = model.file
        if let debug = s.debug, !debug.postMortem {
            Button { model.resume("continue") } label: { Image(systemName: "play.fill") }
                .buttonStyle(.borderedProminent)
                .tint(.green)
                .accessibilityLabel("Continue")
        } else if (s.running && s.runningFile == file) || (s.running && file == nil) {
            Button { model.stop() } label: { Image(systemName: "stop.fill") }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .accessibilityLabel("Stop")
        } else {
            Button { Task { await model.run() } } label: { Image(systemName: "play.fill") }
                .buttonStyle(.borderedProminent)
                .disabled(file == nil || s.running || file.map(isExternal) == true)
                .accessibilityLabel("Run")
        }
    }
}
